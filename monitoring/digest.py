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
from collections import OrderedDict
from datetime import timedelta

from django.db.models import Count
from django.utils import timezone
from django.utils.html import escape

logger = logging.getLogger("danbyte.digest")

WINDOW_DAYS = {"daily": 1, "weekly": 7}
_SEV_RANK = {"critical": 0, "warning": 1, "info": 2}

# Cap the transition chains so a heavily-flapping network can't produce a
# multi-megabyte email; older changes drop off the (time-ordered) tail.
_MAX_CHAIN_TRANSITIONS = 1500

# Status → email-safe colour, mirroring the app's STATUS_COLOR/STATUS_TEXT
# (frontend/src/components/monitoring/charts.tsx) so the digest badges read as
# the same green/red/amber the UI uses. Email clients can't resolve CSS vars,
# so these are the resolved Tailwind hex values.
_STATUS_BG = {
    "up": "#10b981",       # emerald-500
    "down": "#ef4444",     # red-500
    "stale": "#991b1b",    # red-800
    "degraded": "#f59e0b",  # amber-500
    "unknown": "#a1a1aa",  # zinc-400
    "skipped": "#d4d4d8",  # zinc-300
}
_STATUS_FG = {
    "up": "#ffffff",
    "down": "#ffffff",
    "stale": "#ffffff",
    "degraded": "#422006",
    "unknown": "#ffffff",
    "skipped": "#3f3f46",
}
_STATUS_TEXT = {
    "up": "Up", "down": "Down", "stale": "Stale",
    "degraded": "Degraded", "unknown": "Unknown", "skipped": "Skipped",
}


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

    # Window activity counters (NetBox-Ping style) + the per-prefix transition
    # "chains": every IP that changed state in the window, grouped by prefix,
    # each rendered as an ordered sequence of status badges.
    win = StateTransition.objects.filter(tenant=tenant, at__gte=since)
    tally = {
        r["to_status"]: r["n"]
        for r in win.values("to_status").annotate(n=Count("id"))
    }
    chains = _build_chains(win)

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
        "went_down": tally.get("down", 0),
        "came_up": tally.get("up", 0),
        "went_stale": tally.get("stale", 0),
        "chains": chains,
        "changes": changes,
    }


def _ip_label(ip) -> str:
    """``10.0.0.5`` or ``10.0.0.5 (host.example.net)`` when a DNS name is known."""
    if ip is None:
        return "—"
    dns = (getattr(ip, "dns_name", "") or "").strip()
    return f"{ip.ip_address} ({dns})" if dns else str(ip.ip_address)


def _build_chains(win_qs):
    """Group a window of transitions into ordered per-IP badge chains, keyed by
    prefix. Returns ``[(prefix_cidr, [{"label", "segments"}, …]), …]`` where each
    chain's ``segments`` are ``[{"status", "at"}]`` — the first segment is the
    IP's status entering the window (no timestamp), each following segment a
    transition's resulting status + time.
    """
    rows = (
        win_qs.select_related("target_ip", "target_ip__prefix")
        .order_by("target_ip__prefix__cidr", "target_ip__ip_address", "at")
        [:_MAX_CHAIN_TRANSITIONS]
    )
    groups: OrderedDict = OrderedDict()
    for t in rows:
        ip = t.target_ip
        pfx = ip.prefix.cidr if (ip and ip.prefix_id) else "—"
        chains = groups.setdefault(pfx, OrderedDict())
        entry = chains.get(ip.id)
        if entry is None:
            entry = {
                "label": _ip_label(ip),
                "segments": [{"status": t.from_status, "at": None}],
            }
            chains[ip.id] = entry
        entry["segments"].append({"status": t.to_status, "at": t.at})
    return [(pfx, list(chains.values())) for pfx, chains in groups.items()]


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
    lines += [
        "",
        f"Went down: {d['went_down']}   Came up: {d['came_up']}   "
        f"Went stale: {d['went_stale']}",
    ]
    lines += ["", f"Firing alerts: {d['firing_total']}"]
    for sev, n in d["by_severity"].items():
        lines.append(f"  {sev}: {n}")
    if d["top_alerts"]:
        lines.append("")
        lines.append("Top open alerts:")
        for a in d["top_alerts"]:
            lines.append(f"  [{a.severity}] {_target_label(a)}")
    if d["chains"]:
        lines += ["", "State changes:"]
        for pfx, chain_list in d["chains"]:
            lines.append(f"  [{pfx}]")
            for c in chain_list:
                lines.append(f"    {c['label']}: {_chain_text(c['segments'])}")
    lines += ["", f"Configuration changes in window: {d['changes']}"]
    return "\n".join(lines)


def _chain_text(segments) -> str:
    parts = []
    for seg in segments:
        label = _STATUS_TEXT.get(seg["status"], seg["status"])
        if seg["at"] is not None:
            parts.append(f"{label} ({seg['at']:%b %d %H:%M})")
        else:
            parts.append(label)
    return " -> ".join(parts)


def _stat(label: str, value: str) -> str:
    return (
        f'<td style="padding:8px 12px;border:1px solid #e4e4e7;border-radius:8px;">'
        f'<div style="font-size:20px;font-weight:600;color:#18181b;">{escape(value)}</div>'
        f'<div style="font-size:12px;color:#71717a;">{escape(label)}</div></td>'
    )


def _badge(status: str, at) -> str:
    """One status pill in a chain: a coloured label with the transition time
    beneath it (the leading 'entering' segment has no time)."""
    bg = _STATUS_BG.get(status, _STATUS_BG["unknown"])
    fg = _STATUS_FG.get(status, "#ffffff")
    label = _STATUS_TEXT.get(status, status)
    time_html = (
        f'<div style="font-size:10px;color:#71717a;margin-top:2px;'
        f'white-space:nowrap;">{escape(f"{at:%b %d %H:%M}")}</div>'
        if at is not None else ""
    )
    return (
        f'<td style="vertical-align:top;text-align:center;padding:2px 0;">'
        f'<span style="display:inline-block;background:{bg};color:{fg};'
        f'font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;'
        f'white-space:nowrap;">{escape(label)}</span>{time_html}</td>'
    )


def _arrow() -> str:
    return (
        '<td style="vertical-align:top;text-align:center;color:#a1a1aa;'
        'padding:2px 4px;font-size:12px;">&rarr;</td>'
    )


def _chain_html(segments) -> str:
    """A horizontal chain of status badges (wraps across rows on narrow screens
    via one inline-block table per pair)."""
    cells = []
    for i, seg in enumerate(segments):
        if i:
            cells.append(_arrow())
        cells.append(_badge(seg["status"], seg["at"]))
    # A table per chain keeps badge+arrow baselines aligned in every client.
    return (
        '<table role="presentation" cellspacing="0" cellpadding="0" '
        'style="display:inline-block;"><tr>' + "".join(cells) + "</tr></table>"
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
        '<table role="presentation" cellspacing="8" cellpadding="0" style="margin:0 0 8px;"><tr>',
        _stat("went down", str(d["went_down"])),
        _stat("came up", str(d["came_up"])),
        _stat("went stale", str(d["went_stale"])),
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

    if d["chains"]:
        parts.append('<h2 style="font-size:14px;margin:20px 0 8px;">State changes</h2>')
        for pfx, chain_list in d["chains"]:
            parts.append(
                f'<div style="margin:14px 0 4px;font-size:12px;font-weight:600;'
                f'color:#3f3f46;">[{escape(pfx)}]</div>'
            )
            rows = "".join(
                f'<tr>'
                f'<td style="padding:8px;border-bottom:1px solid #f4f4f5;'
                f'vertical-align:top;white-space:nowrap;font-size:13px;">'
                f'{escape(c["label"])}</td>'
                f'<td style="padding:8px;border-bottom:1px solid #f4f4f5;">'
                f'{_chain_html(c["segments"])}</td>'
                f'</tr>'
                for c in chain_list
            )
            parts.append(
                f'<table role="presentation" width="100%" cellspacing="0" '
                f'cellpadding="0">{rows}</table>'
            )

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
