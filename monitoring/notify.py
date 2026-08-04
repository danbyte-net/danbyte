"""Notification dispatch — alerts and opt-in raw status changes.

Two independent notification paths feed ``NotificationChannel`` rows:

1. **Alerts** (the primary path) — :mod:`monitoring.alerts` opens/resolves
   ``Alert`` rows from an AlertRule and routes them via ``notify_alert`` /
   ``notify_alert_group`` (severity + status gated, silence-aware).

2. **Raw status changes** (opt-in, no alert rules) — a channel with
   ``send_status_changes=True`` receives every status transition for the IPs it
   matches (``on_statuses`` + ``match_prefix`` subnet scope). Either **instant**
   (``dispatch_status_changes``, coalesced per check batch) or **batched**
   (``run_due_status_change_digests``, a periodic mini-digest driven by the
   minute beat). This is for operators who want transition emails without the
   full alert-rule machinery.

All sends are **best-effort**: a failing channel is logged, never raised — a
notification error must not fail the check run.
"""
from __future__ import annotations

import ipaddress
import logging
from collections import defaultdict

from django.conf import settings

from core.ssrf import safe_post  # SSRF-guarded outbound

log = logging.getLogger("monitoring.notify")


# ─── payload building ─────────────────────────────────────────────────────


def _enrich(transitions: list) -> list[dict]:
    """Turn StateTransition rows into serialisable dicts with target/template
    names, in one query (the rows were just bulk-created)."""
    from .models import StateTransition

    ids = [t.id for t in transitions if getattr(t, "id", None)]
    rows = (
        StateTransition.objects.filter(id__in=ids)
        .select_related("target_ip", "template")
        if ids
        else transitions
    )
    out = []
    for t in rows:
        out.append(
            {
                "tenant_id": str(t.tenant_id),
                "target_ip_id": str(t.target_ip_id),
                "target_ip": getattr(getattr(t, "target_ip", None), "ip_address", None),
                "template_id": str(t.template_id) if t.template_id else None,
                "template": getattr(getattr(t, "template", None), "name", None),
                "kind": t.kind,
                "from_status": t.from_status,
                "to_status": t.to_status,
                "at": t.at.isoformat() if t.at else None,
                "detail": t.detail or {},
            }
        )
    return out


# ─── built-in channels ────────────────────────────────────────────────────


def _send_webhook(channel, events: list[dict]) -> None:
    import requests

    url = (channel.config or {}).get("url")
    if not url:
        return
    timeout = getattr(settings, "MONITORING_WEBHOOK_TIMEOUT", 5)
    payload = {
        "tenant_id": str(channel.tenant_id),
        "channel": channel.name,
        "count": len(events),
        "transitions": events,
    }
    resp = safe_post(url, json=payload, timeout=timeout)
    log.info("webhook %s → %s (%s changes)", channel.name, resp.status_code, len(events))


def resolve_recipients(channel) -> list[str]:
    """Every email address a channel delivers to: its free-text
    ``config.recipients`` plus each subscription — a subscribed user's email, and
    every member email of a subscribed group. Deduped, blanks dropped, order
    stable (config first). Subscriptions only add *people*, so this is meaningful
    for email channels; other transports ignore it.
    """
    seen: set[str] = set()
    out: list[str] = []

    def _add(addr):
        a = (addr or "").strip()
        if a and a.lower() not in seen:
            seen.add(a.lower())
            out.append(a)

    for addr in (channel.config or {}).get("recipients") or []:
        _add(addr)
    subs = channel.subscriptions.select_related("user", "group")
    for sub in subs:
        if sub.user_id:
            _add(getattr(sub.user, "email", ""))
        elif sub.group_id:
            for email in sub.group.user_set.exclude(email="").values_list(
                "email", flat=True
            ):
                _add(email)
    return out


def _send_email(channel, events: list[dict]) -> None:
    from core import email as ek

    recipients = resolve_recipients(channel)
    if not recipients:
        return
    lines = [
        f"  {e['target_ip']} · {e['template'] or e['kind']}: "
        f"{e['from_status']} → {e['to_status']}"
        for e in events
    ]
    body = (
        f"{len(events)} monitoring status change(s):\n\n" + "\n".join(lines) + "\n"
    )
    subject = f"{_deployment_name()} — {len(events)} monitoring status change(s)"
    rows = [
        [
            ek.escape(str(e["target_ip"])),
            ek.escape(str(e["template"] or e["kind"])),
            ek.pill(e["from_status"], e["from_status"]) + " &rarr; "
            + ek.pill(e["to_status"], e["to_status"]),
        ]
        for e in events
    ]
    html = ek.render_layout(
        f"{len(events)} status change(s)",
        ek.lead("The following monitored targets changed status.")
        + ek.data_table(["Target", "Check", "Change"], rows),
        deployment_name=_deployment_name(),
        kicker="Monitoring",
        preheader=f"{len(events)} status change(s)",
    )
    ek.send_html_email(
        subject, recipients, html_body=html, text_body=body,
        tenant=channel.tenant_id,
    )
    log.info("email digest %s → %s recipients (%s changes)", channel.name, len(recipients), len(events))


def _device_ip_ids(channel) -> set[str]:
    """The IP ids a device-scoped channel covers (assigned to the device),
    resolved once per channel instance and cached on it for the batch."""
    cached = getattr(channel, "_device_ip_ids", None)
    if cached is None:
        from api.models import IPAddress

        cached = {
            str(pk)
            for pk in IPAddress.objects.filter(
                assigned_device_id=channel.match_device_id
            ).values_list("id", flat=True)
        }
        channel._device_ip_ids = cached
    return cached


def _scope_allows(channel, ip_addr, ip_id=None) -> bool:
    """Whether a channel's scope admits this IP. A channel may be scoped to a
    single IP (``match_ip``), a device (``match_device`` — any IP assigned to
    it), or a subnet (``match_prefix``); with none it matches everything.
    Applies to both status changes and alerts, so a scoped channel only ever
    fires for its own target."""
    if channel.match_ip_id:
        if ip_id is not None:
            return str(ip_id) == str(channel.match_ip_id)
        served = getattr(channel.match_ip, "ip_address", None)
        return bool(ip_addr) and str(served) == str(ip_addr)
    if channel.match_device_id:
        return ip_id is not None and str(ip_id) in _device_ip_ids(channel)
    if channel.match_prefix_id:
        net = getattr(channel.match_prefix, "network", None)
        if net is None or not ip_addr:
            return False
        try:
            return ipaddress.ip_address(str(ip_addr)) in net
        except (ValueError, TypeError):
            return False
    return True


def _status_channels(tenant_id, mode):
    from .models import NotificationChannel

    return NotificationChannel.objects.filter(
        tenant_id=tenant_id, enabled=True, send_status_changes=True,
        status_change_mode=mode,
    ).select_related("match_prefix", "match_ip")


def dispatch_status_changes(transitions: list, now=None) -> None:
    """Instant path: email/post the just-observed status changes to every
    ``send_status_changes`` channel in **instant** mode. Coalesced per batch:
    one message per channel carrying all of the batch's matching changes.

    Called at the end of ``process_transitions`` (every check batch). Best-effort
    per channel — a delivery error can never fail the batch.
    """
    if not transitions:
        return
    events = _enrich(transitions)
    by_tenant: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        by_tenant[e["tenant_id"]].append(e)

    for tenant_id, tenant_events in by_tenant.items():
        for ch in _status_channels(tenant_id, "instant"):
            wanted = ch.on_statuses or []
            relevant = [
                e for e in tenant_events
                if (not wanted or e["to_status"] in wanted)
                and _scope_allows(ch, e["target_ip"], e["target_ip_id"])
            ]
            if not relevant:
                continue
            try:
                if ch.kind == "webhook":
                    _send_webhook(ch, relevant)
                elif ch.kind == "email":
                    _send_email(ch, relevant)
            except Exception:  # noqa: BLE001 — one channel must not break others
                log.exception("status channel %s (%s) failed", ch.name, ch.kind)


def run_due_status_change_digests(now=None) -> int:
    """Batched path: for each ``send_status_changes`` channel in **batched**
    mode whose interval has elapsed, send a mini-digest of the status changes in
    the window and stamp ``status_change_last_run``. Driven by the minute beat.
    """
    from datetime import timedelta

    from django.utils import timezone

    from .models import NotificationChannel, StateTransition

    now = now or timezone.now()
    sent = 0
    channels = NotificationChannel.objects.filter(
        enabled=True, send_status_changes=True,
        status_change_mode="batched",
    ).select_related("match_prefix", "match_ip")
    for ch in channels:
        interval = timedelta(minutes=ch.status_change_interval_minutes or 30)
        if ch.status_change_last_run and now - ch.status_change_last_run < interval:
            continue
        since = ch.status_change_last_run or (now - interval)
        qs = (
            StateTransition.objects.filter(
                tenant_id=ch.tenant_id, at__gt=since, at__lte=now
            )
            .select_related("target_ip", "target_ip__prefix", "template")
            .order_by("at")
        )
        wanted = ch.on_statuses or []
        if wanted:
            qs = qs.filter(to_status__in=wanted)
        rows = [
            t for t in qs
            if _scope_allows(
                ch, getattr(t.target_ip, "ip_address", None), t.target_ip_id
            )
        ]
        if rows:
            try:
                _send_status_digest(ch, rows, since, now)
                sent += 1
            except Exception:  # noqa: BLE001 — one channel must not break others
                log.exception("status digest %s (%s) failed", ch.name, ch.kind)
        ch.status_change_last_run = now
        ch.save(update_fields=["status_change_last_run", "updated_at"])
    return sent


def _send_status_digest(channel, rows: list, since, now) -> None:
    """Deliver a batched mini-digest of status changes for one channel."""
    if channel.kind == "webhook":
        events = _enrich(rows)
        _send_webhook(channel, events)
        return
    if channel.kind != "email":
        return
    recipients = resolve_recipients(channel)
    if not recipients:
        return
    from core.email import send_html_email
    from monitoring.digest import render_status_digest, render_status_digest_text

    name = _deployment_name()
    html, text = (
        render_status_digest(rows, since, now, name),
        render_status_digest_text(rows, since, now),
    )
    subject = f"{name} — {len(rows)} status change(s) in the last window"
    send_html_email(
        subject, recipients, html_body=html, text_body=text,
        tenant=channel.tenant_id,
    )


def notify_event(
    tenant_id, subject: str, body: str, payload: dict, site_id=None
) -> None:
    """Send a one-off alert (not a status transition) to a tenant's enabled
    channels — e.g. a prefix-utilization warning. Best-effort per channel.

    ``site_id``: when the event concerns a single site-bound object, pass its
    site so the email transport resolves the SITE's SMTP override
    (site → tenant → deployment). Channels and recipients stay tenant-level.
    """
    from .models import NotificationChannel

    channels = NotificationChannel.objects.filter(tenant_id=tenant_id, enabled=True)
    for ch in channels:
        try:
            if ch.kind == "webhook":
                url = (ch.config or {}).get("url")
                if url:
                    import requests

                    safe_post(
                        url,
                        json={"channel": ch.name, "event": payload},
                        timeout=getattr(settings, "MONITORING_WEBHOOK_TIMEOUT", 5),
                    )
            elif ch.kind == "email":
                recipients = resolve_recipients(ch)
                if recipients:
                    from core import email as ek

                    html = ek.render_layout(
                        subject,
                        ek.callout(body, "warning"),
                        deployment_name=_deployment_name(),
                        kicker="Monitoring",
                        preheader=body[:120],
                    )
                    ek.send_html_email(
                        subject, recipients, html_body=html, text_body=body + "\n",
                        tenant=tenant_id, site=site_id,
                    )
        except Exception:  # noqa: BLE001 — one channel must not break others
            log.exception("notify_event channel %s (%s) failed", ch.name, ch.kind)


# ─── alert routing (A3) ────────────────────────────────────────────────────
# Alerts (not raw transitions) are the notification source. Each firing/resolved
# alert is routed to the tenant's channels that pass the severity + status gate,
# and rendered for the channel's transport (Slack/Teams/Discord/PagerDuty/
# webhook/email).

_SEV_RANK = {"info": 0, "warning": 1, "critical": 2}
_PD_SEV = {"critical": "critical", "warning": "warning", "info": "info"}


_EVENT_VERB = {
    "resolved": "RESOLVED",
    "reminder": "STILL FIRING",
    "escalated": "ESCALATED",
}


# Detail keys worth forwarding verbatim on cert/SSH alert payloads, so a webhook
# or PagerDuty event carries the specifics (CN, fingerprint, expiry) rather than
# just "tls_cert is down".
_RICH_DETAIL_KEYS = (
    "subject_cn", "issuer_cn", "fingerprint_sha256", "not_after",
    "days_until_expiry", "cert_state", "certificate_id", "endpoint",
    "drift", "key_type", "served", "expected", "object_type", "object_id",
)


def _cert_summary(detail: dict) -> str | None:
    """A human line for a TLS-certificate alert, or None if this isn't one."""
    cn = detail.get("subject_cn") or detail.get("endpoint") or "certificate"
    fp = (detail.get("fingerprint_sha256") or "")[:12]
    tail = f" [{fp}…]" if fp else ""
    state = detail.get("cert_state")
    days = detail.get("days_until_expiry")
    when = (detail.get("not_after") or "")[:10]
    date = f" ({when})" if when else ""
    if state == "expired":
        ago = f"expired {abs(round(days))}d ago" if isinstance(days, (int, float)) else "expired"
        return f'TLS cert "{cn}" {ago}{date}{tail}'
    if state in ("expiring_critical", "expiring_warning"):
        left = f"{round(days)}d" if isinstance(days, (int, float)) else "soon"
        return f'TLS cert "{cn}" expires in {left}{date}{tail}'
    if detail.get("drift") == "cert_mismatch":
        return f'TLS cert served differs from the declared one ("{cn}"){tail}'
    return None


def _ssh_summary(detail: dict) -> str | None:
    if detail.get("drift") != "ssh_host_key_mismatch":
        return None
    kt = detail.get("key_type") or "host key"
    served = detail.get("served") or "unknown"
    return f"SSH host-key mismatch ({kt}) — served {served}"


def _alert_specific(alert) -> str | None:
    """The cert/SSH-specific line for an alert, if it is one; else None."""
    detail = getattr(alert, "detail", None) or {}
    drift = detail.get("drift") or ""
    if alert.kind == "tls_cert" or drift.startswith("cert_"):
        return _cert_summary(detail)
    if alert.kind == "ssh" or drift == "ssh_host_key_mismatch":
        return _ssh_summary(detail)
    return None


def _alert_summary(alert, event: str, ip: str) -> str:
    verb = _EVENT_VERB.get(event, "FIRING")
    specific = _alert_specific(alert)
    if specific:
        return f"[{verb}] {alert.severity.upper()}: {ip} — {specific}"
    name = alert.template.name if alert.template_id else alert.kind
    return f"[{verb}] {alert.severity.upper()}: {ip} — {name} is {alert.check_status}"


def _alert_payload(alert, event: str, ip: str) -> dict:
    payload = {
        "event": event,
        "alert_id": str(alert.id),
        "severity": alert.severity,
        "status": alert.check_status,
        "kind": alert.kind,
        "ip": ip,
        "template": alert.template.name if alert.template_id else None,
        "opened_at": alert.opened_at.isoformat() if alert.opened_at else None,
    }
    detail = getattr(alert, "detail", None) or {}
    for key in _RICH_DETAIL_KEYS:
        if key in detail:
            payload[key] = detail[key]
    return payload


def _deployment():
    """The deployment-wide Email & Delivery settings singleton."""
    from core.models import DeploymentSettings

    return DeploymentSettings.load()


def _timeout(dep=None) -> int:
    dep = dep or _deployment()
    return dep.webhook_timeout or getattr(settings, "MONITORING_WEBHOOK_TIMEOUT", 5)


def _proxies(dep=None) -> dict | None:
    dep = dep or _deployment()
    if dep.outbound_proxy:
        return {"http": dep.outbound_proxy, "https": dep.outbound_proxy}
    return None


def _alert_url(dep) -> str | None:
    base = (dep.public_base_url or "").rstrip("/")
    return f"{base}/alerts" if base else None


def build_email_connection(dep):
    """Build an SMTP connection from a settings object — the deployment
    singleton or a TenantSettings override (same field names) — falling back to
    Django's configured backend when SMTP host is unset.

    A bounded socket timeout is essential: without it a wrong/unreachable
    ``smtp_host`` makes ``send()`` block until the OS TCP timeout (minutes),
    which outlives the gunicorn worker timeout and surfaces to the user as an
    nginx **502** on the "send test email" button. With the timeout the send
    fails fast and the caller can report the SMTP error instead.
    """
    from django.core.mail import get_connection

    if not dep.smtp_host:
        return get_connection()  # console/env backend — dev default
    timeout = getattr(settings, "EMAIL_SMTP_TIMEOUT", 10)
    # TENANT and SITE admins (untrusted customers / local IT) control their
    # smtp_host/port via overrides — SSRF-guard those so the connect can't
    # scan internal services or reach cloud metadata. A DEPLOYMENT admin is a
    # trusted operator who may legitimately use an internal relay
    # (self-hosted), so their singleton is not guarded here (use
    # DANBYTE_SSRF_ALLOWLIST if you want it).
    from core.models import SiteSettings, TenantSettings

    if isinstance(dep, (TenantSettings, SiteSettings)):
        from core.ssrf import assert_public_host

        assert_public_host(dep.smtp_host, dep.smtp_port or 587)
    password = (dep.secrets or {}).get("password", "")
    use_tls = dep.smtp_security == "starttls"
    use_ssl = dep.smtp_security == "ssl"
    return get_connection(
        backend="django.core.mail.backends.smtp.EmailBackend",
        host=dep.smtp_host,
        port=dep.smtp_port,
        username=dep.smtp_username or None,
        password=password or None,
        use_tls=use_tls,
        use_ssl=use_ssl,
        timeout=timeout,
    )


_EVENT_KIND = {
    "resolved": "success",
    "reminder": "warning",
    "escalated": "critical",
    "firing": "critical",
}


def _severity_kind(severity: str) -> str:
    return {"critical": "critical", "warning": "warning"}.get(severity, "info")


def _deployment_name() -> str:
    return _deployment().deployment_name or "Danbyte"


def _alert_detail_rows(alert, ip: str):
    """Label/value rows for one alert, as email HTML (values pre-escaped)."""
    from core import email as ek

    detail = getattr(alert, "detail", None) or {}
    rows = [("Target", ek.escape(ip))]
    name = alert.template.name if getattr(alert, "template_id", None) else alert.kind
    rows.append(("Check", ek.escape(str(name))))
    rows.append(("Severity", ek.pill(alert.severity, _severity_kind(alert.severity))))
    rows.append(("Status", ek.pill(alert.check_status, alert.check_status)))
    if detail.get("subject_cn"):
        rows.append(("Certificate", ek.escape(detail["subject_cn"])))
    if detail.get("not_after"):
        rows.append(("Expires", ek.escape(str(detail["not_after"])[:19])))
    if detail.get("fingerprint_sha256"):
        rows.append(("Fingerprint",
                     ek.escape(detail["fingerprint_sha256"][:24] + "…")))
    return rows


def _alert_lead(alert, event: str) -> str:
    """One plain sentence describing the alert — no severity/verb prefix (the
    title and the Severity pill already carry those)."""
    specific = _alert_specific(alert)
    name = alert.template.name if getattr(alert, "template_id", None) else alert.kind
    desc = specific or f"{name} is {alert.check_status}"
    if event == "resolved":
        return f"This alert has resolved — {desc}."
    if event in ("reminder", "escalated"):
        return f"{_EVENT_VERB[event].title().replace('_', ' ')} — {desc}."
    return f"{desc}."


def _alert_email_html(alert, event: str, ip: str, url: str | None) -> str:
    from core import email as ek

    parts = [
        ek.lead(_alert_lead(alert, event)),
        ek.kv_table(_alert_detail_rows(alert, ip)),
    ]
    if url:
        parts.append(ek.email_button(url, "View in Danbyte"))
    verb = _EVENT_VERB.get(event, "FIRING").title()
    return ek.render_layout(
        f"Alert {verb.lower()}: {ip}",
        "".join(parts),
        deployment_name=_deployment_name(),
        kicker="Monitoring alert",
        preheader=_alert_summary(alert, event, ip),
    )


def _alert_group_email_html(alerts: list, event: str, url: str | None) -> str:
    from core import email as ek

    worst = max((a.severity for a in alerts), key=lambda s: _SEV_RANK.get(s, 0))
    verb_word = {"resolved": "resolved", "reminder": "still firing",
                 "escalated": "escalated"}.get(event, "firing")
    lead_text = (
        f"{len(alerts)} alert{'s' if len(alerts) != 1 else ''} {verb_word} — "
        f"worst severity {worst}."
    )
    rows = [
        [
            ek.escape(a.target_ip.ip_address),
            ek.pill(a.severity, _severity_kind(a.severity)),
            ek.escape(_alert_specific(a) or f"{a.kind} {a.check_status}"),
        ]
        for a in alerts
    ]
    parts = [ek.lead(lead_text),
             ek.data_table(["Target", "Severity", "Detail"], rows)]
    if url:
        parts.append(ek.email_button(url, "View in Danbyte"))
    verb = _EVENT_VERB.get(event, "FIRING").title()
    return ek.render_layout(
        f"{len(alerts)} alerts {verb.lower()}",
        "".join(parts),
        deployment_name=_deployment_name(),
        kicker="Monitoring alerts",
        preheader=_group_summary(alerts, event),
    )


def _dispatch_to_channel(channel, alert, event: str, ip: str) -> None:
    import requests

    dep = _deployment()
    cfg = channel.config or {}
    text = _alert_summary(alert, event, ip)
    kind = channel.kind
    timeout = _timeout(dep)
    proxies = _proxies(dep)
    url = _alert_url(dep)
    linked = f"{text}\n{url}" if url else text

    if kind == "email":
        from core.effective_settings import effective_email
        from core.email import send_html_email

        eff = effective_email(channel.tenant_id)  # tenant SMTP override or dep
        recipients = resolve_recipients(channel)
        if recipients and eff.email_enabled:
            send_html_email(
                text,
                recipients,
                html_body=_alert_email_html(alert, event, ip, url),
                text_body=(linked + "\n"),
                tenant=channel.tenant_id,
            )
    elif kind == "slack":
        if cfg.get("url"):
            safe_post(
                cfg["url"], json={"text": linked}, timeout=timeout, proxies=proxies
            )
    elif kind == "teams":
        if cfg.get("url"):
            safe_post(
                cfg["url"], json={"text": linked}, timeout=timeout, proxies=proxies
            )
    elif kind == "discord":
        if cfg.get("url"):
            safe_post(
                cfg["url"], json={"content": linked}, timeout=timeout, proxies=proxies
            )
    elif kind == "pagerduty":
        key = cfg.get("routing_key")
        if key:
            safe_post(
                "https://events.pagerduty.com/v2/enqueue",
                json={
                    "routing_key": key,
                    "event_action": "resolve" if event == "resolved" else "trigger",
                    "dedup_key": alert.dedup_key,
                    "payload": {
                        "summary": text,
                        "severity": _PD_SEV.get(alert.severity, "warning"),
                        "source": ip,
                        "component": alert.kind,
                    },
                    **({"links": [{"href": url, "text": "View in Danbyte"}]} if url else {}),
                },
                timeout=timeout,
                proxies=proxies,
            )
    elif kind == "webhook":
        if cfg.get("url"):
            payload = _alert_payload(alert, event, ip)
            if url:
                payload["url"] = url
            safe_post(
                cfg["url"],
                json={"channel": channel.name, "alert": payload},
                timeout=timeout,
                proxies=proxies,
            )


def active_silence(alert, now=None):
    """The active Silence covering this alert, or None. A silence mutes
    notifications while its window is open and its matchers cover the alert."""
    from django.utils import timezone

    from .alerts import _ip_matches
    from .models import Silence

    now = now or timezone.now()
    silences = Silence.objects.filter(
        tenant_id=alert.tenant_id, starts_at__lte=now, ends_at__gt=now
    ).select_related("match_prefix", "match_ip")
    ip = alert.target_ip
    for s in silences:
        if s.match_kinds and alert.kind not in s.match_kinds:
            continue
        if s.match_statuses and alert.check_status not in s.match_statuses:
            continue
        if s.match_ip_id and s.match_ip_id != alert.target_ip_id:
            continue
        if not _ip_matches(s, ip):
            continue
        return s
    return None


def notify_alert(alert, event: str) -> None:
    """Route one alert (event = 'firing' | 'resolved') to matching channels.

    Suppressed entirely when an active Silence / maintenance window covers the
    alert — the alert is still tracked, just not delivered.
    """
    from .models import NotificationChannel

    if active_silence(alert) is not None:
        log.info("alert %s suppressed by active silence", alert.dedup_key)
        return

    ip = alert.target_ip.ip_address
    channels = NotificationChannel.objects.filter(
        tenant_id=alert.tenant_id, enabled=True
    ).select_related("match_prefix", "match_ip")
    for ch in channels:
        if _SEV_RANK.get(alert.severity, 0) < _SEV_RANK.get(ch.min_severity, 0):
            continue
        if ch.on_statuses and alert.check_status not in ch.on_statuses:
            continue
        if not _scope_allows(ch, ip, alert.target_ip_id):
            continue
        try:
            _dispatch_to_channel(ch, alert, event, ip)
        except Exception:  # noqa: BLE001 — one channel must not break others
            log.exception("alert channel %s (%s) failed", ch.name, ch.kind)


def _group_summary(alerts: list, event: str) -> str:
    verb = _EVENT_VERB.get(event, "FIRING")
    worst = max((a.severity for a in alerts), key=lambda s: _SEV_RANK.get(s, 0))
    ips = [a.target_ip.ip_address for a in alerts]
    head = ", ".join(ips[:5])
    more = f" +{len(ips) - 5} more" if len(ips) > 5 else ""
    return f"[{verb}] {worst.upper()}: {len(alerts)} alerts — {head}{more}"


def _dispatch_group_to_channel(channel, alerts: list, event: str, dep) -> None:
    """Send one summary message for a batch of alerts. PagerDuty has its own
    dedup, so it still gets one event per alert."""
    import requests

    if channel.kind == "pagerduty":
        for a in alerts:
            _dispatch_to_channel(channel, a, event, a.target_ip.ip_address)
        return

    cfg = channel.config or {}
    text = _group_summary(alerts, event)
    url = _alert_url(dep)
    linked = f"{text}\n{url}" if url else text
    timeout, proxies = _timeout(dep), _proxies(dep)

    if channel.kind == "email":
        from core.effective_settings import effective_email
        from core.email import send_html_email

        eff = effective_email(channel.tenant_id)  # tenant SMTP override or dep
        recipients = resolve_recipients(channel)
        if recipients and eff.email_enabled:
            body = linked + "\n\n" + "\n".join(
                f"- {a.target_ip.ip_address}: "
                f"{_alert_specific(a) or f'{a.kind} {a.check_status}'}"
                for a in alerts
            )
            send_html_email(
                text,
                recipients,
                html_body=_alert_group_email_html(alerts, event, url),
                text_body=body + "\n",
                tenant=channel.tenant_id,
            )
    elif channel.kind in ("slack", "teams"):
        if cfg.get("url"):
            safe_post(cfg["url"], json={"text": linked}, timeout=timeout, proxies=proxies)
    elif channel.kind == "discord":
        if cfg.get("url"):
            safe_post(cfg["url"], json={"content": linked}, timeout=timeout, proxies=proxies)
    elif channel.kind == "webhook":
        if cfg.get("url"):
            safe_post(
                cfg["url"],
                json={
                    "channel": channel.name,
                    "event": event,
                    "count": len(alerts),
                    "alerts": [
                        _alert_payload(a, event, a.target_ip.ip_address) for a in alerts
                    ],
                },
                timeout=timeout,
                proxies=proxies,
            )


def notify_alert_group(tenant_id, alerts: list, event: str) -> None:
    """Send ONE grouped notification per channel for a burst of alerts. Silenced
    alerts are dropped; each channel only sees alerts that pass its gates."""
    from .models import NotificationChannel

    live = [a for a in alerts if active_silence(a) is None]
    if not live:
        return
    dep = _deployment()
    channels = NotificationChannel.objects.filter(
        tenant_id=tenant_id, enabled=True
    ).select_related("match_prefix", "match_ip")
    for ch in channels:
        matched = [
            a
            for a in live
            if _SEV_RANK.get(a.severity, 0) >= _SEV_RANK.get(ch.min_severity, 0)
            and (not ch.on_statuses or a.check_status in ch.on_statuses)
            and _scope_allows(ch, a.target_ip.ip_address, a.target_ip_id)
        ]
        if not matched:
            continue
        try:
            _dispatch_group_to_channel(ch, matched, event, dep)
        except Exception:  # noqa: BLE001 — one channel must not break others
            log.exception("grouped channel %s (%s) failed", ch.name, ch.kind)


def send_test(channel) -> None:
    """Send a synthetic test alert through a channel (for the 'Send test'
    button). Raises on failure so the UI can show WHY a channel is silent —
    for email that means surfacing the actual SMTP error instead of the
    best-effort swallow the production paths use."""

    class _Fake:
        id = "00000000-0000-0000-0000-000000000000"
        dedup_key = "danbyte-test"
        severity = "warning"
        check_status = "down"
        kind = "icmp"
        template_id = None
        template = None
        opened_at = None
        detail = {}
        target_ip_id = None

    if channel.kind == "email":
        from django.core.mail import EmailMultiAlternatives

        from core.effective_settings import effective_email

        eff = effective_email(channel.tenant_id)
        if not eff.email_enabled:
            raise RuntimeError(
                "Email delivery is disabled (Settings → Email & Delivery)."
            )
        recipients = resolve_recipients(channel)
        if not recipients:
            raise RuntimeError(
                "No recipients: add addresses or subscriptions to this channel."
            )
        alert = _Fake()
        ip = "203.0.113.1 (test)"
        subject = f"[Test] {_alert_summary(alert, 'firing', ip)}"
        # No fail_silently here — a bad SMTP host/credential must surface.
        msg = EmailMultiAlternatives(
            subject,
            _alert_summary(alert, "firing", ip) + "\n",
            getattr(eff, "email_from", "") or None,
            recipients,
            connection=build_email_connection(eff),
        )
        msg.attach_alternative(
            _alert_email_html(alert, "firing", ip, _alert_url(_deployment())),
            "text/html",
        )
        msg.send(fail_silently=False)
        log.info("test email for channel %s → %s", channel.name, recipients)
        return

    _dispatch_to_channel(channel, _Fake(), "firing", "203.0.113.1 (test)")
