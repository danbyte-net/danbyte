"""Scheduled email digest — a periodic monitoring/status summary per tenant.

A daily systemd timer runs ``manage.py send_digest`` →
``run_scheduled_digests()``: for each active tenant whose *effective* digest
config is enabled and due (daily, or weekly on the configured weekday, and not
already sent today), it builds and emails the digest, then records the send on
that tenant's ``TenantSettings.digest_last_run`` so each tenant is gated
independently.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.db.models import Count
from django.utils import timezone
from django.utils.html import escape

logger = logging.getLogger("danbyte.digest")

WINDOW_DAYS = {"daily": 1, "weekly": 7}
_SEV_RANK = {"critical": 0, "warning": 1, "info": 2}


def _deployment_name() -> str:
    from core.models import DeploymentSettings

    return DeploymentSettings.load().deployment_name or "Danbyte"


def build_digest(tenant, since) -> dict:
    """Gather the digest data for one tenant over the window [since, now]."""
    from monitoring.models import Alert, CheckState, StateTransition

    states = CheckState.objects.filter(tenant=tenant)
    by_status = {
        r["status"]: r["n"]
        for r in states.values("status").annotate(n=Count("id"))
    }
    total = sum(by_status.values())
    reachable_pct = round(100 * (by_status.get("up", 0) / total)) if total else None

    firing = Alert.objects.filter(tenant=tenant, status="firing")
    by_severity = {
        r["severity"]: r["n"]
        for r in firing.values("severity").annotate(n=Count("id"))
    }
    top_alerts = sorted(
        firing.select_related("target_ip", "template"),
        key=lambda a: (_SEV_RANK.get(a.severity, 9), -a.opened_at.timestamp()),
    )[:10]

    transitions = list(
        StateTransition.objects.filter(tenant=tenant, at__gte=since)
        .select_related("target_ip", "template")
        .order_by("-at")[:20]
    )

    changes = 0
    try:
        from audit.models import ChangeLogEntry

        changes = ChangeLogEntry.objects.filter(
            tenant=tenant, timestamp__gte=since
        ).count()
    except Exception:  # noqa: BLE001
        pass

    return {
        "tenant": tenant,
        "since": since,
        "now": timezone.now(),
        "by_status": by_status,
        "total": total,
        "reachable_pct": reachable_pct,
        "down": by_status.get("down", 0) + by_status.get("stale", 0),
        "by_severity": by_severity,
        "firing_total": sum(by_severity.values()),
        "top_alerts": top_alerts,
        "transitions": transitions,
        "changes": changes,
    }


def _target_label(obj) -> str:
    ip = getattr(obj, "target_ip", None)
    tpl = getattr(obj, "template", None)
    ip_s = ip.ip_address if ip else "—"
    tpl_s = f" · {tpl.name}" if tpl else ""
    return f"{ip_s}{tpl_s}"


def render_text(data: dict) -> str:
    d = data
    lines = [
        f"Monitoring digest — {d['tenant'].name}",
        f"Window: {d['since']:%Y-%m-%d} → {d['now']:%Y-%m-%d}",
        "",
        f"Checks: {d['total']} total"
        + (f", {d['reachable_pct']}% reachable" if d["reachable_pct"] is not None else ""),
    ]
    for status, n in sorted(d["by_status"].items(), key=lambda kv: -kv[1]):
        lines.append(f"  {status}: {n}")
    lines += ["", f"Firing alerts: {d['firing_total']}"]
    for sev, n in d["by_severity"].items():
        lines.append(f"  {sev}: {n}")
    if d["top_alerts"]:
        lines.append("")
        lines.append("Top open alerts:")
        for a in d["top_alerts"]:
            lines.append(f"  [{a.severity}] {_target_label(a)}")
    if d["transitions"]:
        lines.append("")
        lines.append(f"Recent status changes ({len(d['transitions'])}):")
        for t in d["transitions"]:
            lines.append(
                f"  {t.at:%Y-%m-%d %H:%M} {_target_label(t)}: "
                f"{t.from_status} → {t.to_status}"
            )
    lines += ["", f"Configuration changes in window: {d['changes']}"]
    return "\n".join(lines)


def _stat(label: str, value: str) -> str:
    return (
        f'<td style="padding:8px 12px;border:1px solid #e4e4e7;border-radius:8px;">'
        f'<div style="font-size:20px;font-weight:600;color:#18181b;">{escape(value)}</div>'
        f'<div style="font-size:12px;color:#71717a;">{escape(label)}</div></td>'
    )


def render_html(data: dict, deployment_name: str) -> str:
    from core.email import render_layout

    d = data
    reach = f"{d['reachable_pct']}%" if d["reachable_pct"] is not None else "—"
    parts = [
        '<table role="presentation" cellspacing="8" cellpadding="0" style="margin:-8px 0 8px;"><tr>',
        _stat("checks", str(d["total"])),
        _stat("reachable", reach),
        _stat("down/stale", str(d["down"])),
        _stat("firing alerts", str(d["firing_total"])),
        "</tr></table>",
    ]

    if d["top_alerts"]:
        parts.append('<h2 style="font-size:14px;margin:20px 0 8px;">Open alerts</h2>')
        rows = "".join(
            f'<tr><td style="padding:6px 8px;border-bottom:1px solid #f4f4f5;">'
            f'<span style="font-weight:600;">{escape(a.severity)}</span></td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #f4f4f5;">'
            f'{escape(_target_label(a))}</td></tr>'
            for a in d["top_alerts"]
        )
        parts.append(f'<table role="presentation" width="100%" cellspacing="0">{rows}</table>')

    if d["transitions"]:
        parts.append(
            f'<h2 style="font-size:14px;margin:20px 0 8px;">Recent status changes '
            f'({len(d["transitions"])})</h2>'
        )
        rows = "".join(
            f'<tr><td style="padding:6px 8px;border-bottom:1px solid #f4f4f5;color:#71717a;'
            f'white-space:nowrap;">{escape(f"{t.at:%b %d %H:%M}")}</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #f4f4f5;">'
            f'{escape(_target_label(t))}</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #f4f4f5;">'
            f'{escape(t.from_status)} → <strong>{escape(t.to_status)}</strong></td></tr>'
            for t in d["transitions"]
        )
        parts.append(f'<table role="presentation" width="100%" cellspacing="0">{rows}</table>')

    parts.append(
        f'<p style="margin:20px 0 0;color:#71717a;font-size:13px;">'
        f'{d["changes"]} configuration change(s) recorded in this window.</p>'
    )

    title = f"Monitoring digest — {d['tenant'].name}"
    return render_layout(title, "".join(parts), deployment_name=deployment_name)


def send_tenant_digest(tenant, *, force: bool = False, recipients=None) -> bool:
    """Build + email one tenant's digest. ``force`` ignores the enabled flag
    (for the test/send-now path). Returns True if a send was attempted."""
    from core.effective_settings import effective_digest
    from core.email import parse_recipients, send_html_email

    cfg = effective_digest(tenant)
    if not force and not cfg.digest_enabled:
        return False
    to = recipients or parse_recipients(cfg.digest_recipients)
    if not to:
        return False

    window = WINDOW_DAYS.get(cfg.digest_frequency, 7)
    since = timezone.now() - timedelta(days=window)
    data = build_digest(tenant, since)
    name = _deployment_name()
    subject = f"{name} monitoring digest — {tenant.name}"
    return send_html_email(
        subject,
        to,
        html_body=render_html(data, name),
        text_body=render_text(data),
        tenant=tenant,
    )


def run_scheduled_digests(now=None) -> int:
    """Send digests for every active tenant that is due. Returns the count sent.

    Due = effective config enabled, frequency matches today (weekly → the
    configured weekday), and not already sent today (per-tenant last_run).
    """
    from core.effective_settings import effective_digest
    from core.models import Tenant, TenantSettings

    now = now or timezone.now()
    sent = 0
    for tenant in Tenant.objects.filter(is_active=True):
        cfg = effective_digest(tenant)
        if not cfg.digest_enabled:
            continue
        if cfg.digest_frequency == "weekly" and now.weekday() != cfg.digest_weekday:
            continue
        row = TenantSettings.objects.filter(tenant=tenant).first()
        if row and row.digest_last_run and row.digest_last_run.date() == now.date():
            continue  # already sent today
        if send_tenant_digest(tenant):
            row, _ = TenantSettings.objects.get_or_create(tenant=tenant)
            row.digest_last_run = now
            row.save(update_fields=["digest_last_run", "updated_at"])
            sent += 1
    return sent
