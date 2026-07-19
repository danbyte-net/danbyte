"""Notification dispatch — pluggable registry + built-in channels.

After every batch that produced status changes, the worker calls
``dispatch_transitions(transitions)``. Each registered notifier gets the whole
batch; the built-in ``channel_notifier`` groups it by tenant and fans out to
that tenant's enabled ``NotificationChannel`` rows (webhook + email digest).

Channels are a registry so websocket push / MCP / chat can be added later
without touching the worker. All sends are **best-effort**: a failing channel is
logged, never raised — a notifier error must not fail the check run.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Callable

from django.conf import settings
from django.core.mail import send_mail

from core.ssrf import safe_get, safe_post, safe_request  # SSRF-guarded outbound

log = logging.getLogger("monitoring.notify")

# name -> callable(list[StateTransition]) -> None
NOTIFIERS: dict[str, Callable] = {}


def register_notifier(name: str, fn: Callable) -> None:
    NOTIFIERS[name] = fn


def dispatch_transitions(transitions: list) -> None:
    """Fan a batch of status changes out to every registered notifier."""
    if not transitions:
        return
    for name, fn in NOTIFIERS.items():
        try:
            fn(transitions)
        except Exception:  # noqa: BLE001
            log.exception("notifier %s failed", name)


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


def _send_email(channel, events: list[dict]) -> None:
    from core.effective_settings import effective_email

    recipients = (channel.config or {}).get("recipients") or []
    if not recipients:
        return
    # Per-tenant SMTP override, else the deployment default (issue: settings split).
    eff = effective_email(channel.tenant_id)
    lines = [
        f"  {e['target_ip']} · {e['template'] or e['kind']}: "
        f"{e['from_status']} → {e['to_status']}"
        for e in events
    ]
    body = (
        f"{len(events)} monitoring status change(s):\n\n" + "\n".join(lines) + "\n"
    )
    subject = f"[Danbyte] {len(events)} monitoring status change(s)"
    from django.core.mail import EmailMessage

    EmailMessage(
        subject=subject,
        body=body,
        from_email=eff.email_from
        or getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@danbyte.com"),
        to=recipients,
        connection=build_email_connection(eff),
    ).send(fail_silently=True)
    log.info("email digest %s → %s recipients (%s changes)", channel.name, len(recipients), len(events))


def channel_notifier(transitions: list) -> None:
    """Group transitions by tenant and dispatch to each tenant's channels."""
    from .models import NotificationChannel

    events = _enrich(transitions)
    by_tenant: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        by_tenant[e["tenant_id"]].append(e)

    for tenant_id, tenant_events in by_tenant.items():
        channels = NotificationChannel.objects.filter(
            tenant_id=tenant_id, enabled=True
        )
        for ch in channels:
            wanted = ch.on_statuses or []
            relevant = (
                [e for e in tenant_events if e["to_status"] in wanted]
                if wanted
                else tenant_events
            )
            if not relevant:
                continue
            try:
                if ch.kind == "webhook":
                    _send_webhook(ch, relevant)
                elif ch.kind == "email":
                    _send_email(ch, relevant)
            except Exception:  # noqa: BLE001 — one channel must not break others
                log.exception("channel %s (%s) failed", ch.name, ch.kind)


register_notifier("channels", channel_notifier)


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
                recipients = (ch.config or {}).get("recipients") or []
                if recipients:
                    from django.core.mail import EmailMessage

                    from core.effective_settings import effective_email

                    eff = effective_email(tenant_id, site=site_id)
                    EmailMessage(
                        subject=subject,
                        body=body,
                        from_email=eff.email_from
                        or getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@danbyte.com"),
                        to=recipients,
                        connection=build_email_connection(eff),
                    ).send(fail_silently=True)
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


def _alert_summary(alert, event: str, ip: str) -> str:
    verb = _EVENT_VERB.get(event, "FIRING")
    name = alert.template.name if alert.template_id else alert.kind
    return f"[{verb}] {alert.severity.upper()}: {ip} — {name} is {alert.check_status}"


def _alert_payload(alert, event: str, ip: str) -> dict:
    return {
        "event": event,
        "alert_id": str(alert.id),
        "severity": alert.severity,
        "status": alert.check_status,
        "kind": alert.kind,
        "ip": ip,
        "template": alert.template.name if alert.template_id else None,
        "opened_at": alert.opened_at.isoformat() if alert.opened_at else None,
    }


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
    Django's configured backend when SMTP host is unset."""
    from django.core.mail import get_connection

    if not dep.smtp_host:
        return get_connection()  # console/env backend — dev default
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

        eff = effective_email(channel.tenant_id)  # tenant SMTP override or dep
        recipients = cfg.get("recipients") or []
        if recipients and eff.email_enabled:
            from django.core.mail import EmailMessage

            EmailMessage(
                subject=text,
                body=(linked + "\n"),
                from_email=eff.email_from or None,
                to=recipients,
                connection=build_email_connection(eff),
            ).send(fail_silently=True)
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
    ).select_related("match_prefix")
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
    )
    for ch in channels:
        if _SEV_RANK.get(alert.severity, 0) < _SEV_RANK.get(ch.min_severity, 0):
            continue
        if ch.on_statuses and alert.check_status not in ch.on_statuses:
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

        eff = effective_email(channel.tenant_id)  # tenant SMTP override or dep
        recipients = cfg.get("recipients") or []
        if recipients and eff.email_enabled:
            from django.core.mail import EmailMessage

            body = linked + "\n\n" + "\n".join(
                f"- {a.target_ip.ip_address}: {a.kind} {a.check_status}" for a in alerts
            )
            EmailMessage(
                subject=text,
                body=body,
                from_email=eff.email_from or None,
                to=recipients,
                connection=build_email_connection(eff),
            ).send(fail_silently=True)
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
    channels = NotificationChannel.objects.filter(tenant_id=tenant_id, enabled=True)
    for ch in channels:
        matched = [
            a
            for a in live
            if _SEV_RANK.get(a.severity, 0) >= _SEV_RANK.get(ch.min_severity, 0)
            and (not ch.on_statuses or a.check_status in ch.on_statuses)
        ]
        if not matched:
            continue
        try:
            _dispatch_group_to_channel(ch, matched, event, dep)
        except Exception:  # noqa: BLE001 — one channel must not break others
            log.exception("grouped channel %s (%s) failed", ch.name, ch.kind)


def send_test(channel) -> None:
    """Send a synthetic test alert through a channel (for the 'Send test' button)."""

    class _Fake:
        id = "00000000-0000-0000-0000-000000000000"
        dedup_key = "danbyte-test"
        severity = "warning"
        check_status = "down"
        kind = "icmp"
        template_id = None
        template = None
        opened_at = None

    _dispatch_to_channel(channel, _Fake(), "firing", "203.0.113.1 (test)")
