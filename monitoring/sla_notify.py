"""SLA alerts and report delivery.

After each computation (monitoring.sla.refresh_agreement) an agreement's
open period is checked for four events - at risk, breached, coverage low, a
latency objective missed - and each goes to the agreement's notification
channels at most once per period (a rolling agreement: once a day). When a
period freezes, its report is emailed to the agreement's recipients.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

log = logging.getLogger("monitoring.sla")

#: A rolling agreement never closes a period; repeat a standing alert daily.
ROLLING_REPEAT = timedelta(days=1)
#: Coverage is meaningless in the first hours of a period.
COVERAGE_MIN_ELAPSED_PCT = 10


def _fmt(p) -> str:
    return "-" if p is None else f"{p:.3f}%" if p >= 99.95 else f"{p:.2f}%"


def latency_p95_by_kind(agreement, since, until) -> dict:
    """``{kind: p95 ms}`` over the agreement's members' checks, from the
    rollups (daily rows for whole days, hourly for the rest)."""
    from .figures import figures, span_window, sums
    from .sla import member_ip_ids

    ips = member_ip_ids([agreement.id])
    if not ips:
        return {}
    win = span_window(since, until)
    got = sums(
        win,
        lambda qs: qs.filter(tenant_id=agreement.tenant_id, target_ip_id__in=ips),
        ("kind",),
    )
    return {k[0]: figures(r)["p95"] for k, r in got.items() if r.get("lat_n")}


def events_for(agreement, result) -> list[tuple[str, str, str, str]]:
    """``[(key, severity, subject, text)]`` true for this result now."""
    f = result.figures or {}
    if f.get("availability") is None:
        return []
    name = agreement.name
    out = []
    target = f.get("target")
    # Objectives can make the agreement's state worse; these two alerts are
    # about availability, and the objectives have their own below.
    avail_state = f.get("availability_state", f.get("state"))
    if avail_state == "breached":
        out.append((
            "breached", "critical", f"SLA breached: {name}",
            f"{name} is at {_fmt(f['availability'])} against a target of {_fmt(target)} "
            f"for {result.period_key}. Budget left: {f.get('budget_left_s', 0) // 60} min.",
        ))
    else:
        burn = f.get("burn_rate")
        fast = agreement.alert_burn_rate is not None and burn is not None and (
            burn >= agreement.alert_burn_rate
        )
        if avail_state == "at_risk" or fast:
            why = (
                f"burning budget {burn}x as fast as time passes" if fast
                else f"{f.get('budget_spent_pct')}% of the budget spent"
            )
            out.append((
                "at_risk", "warning", f"SLA at risk: {name}",
                f"{name} is at {_fmt(f['availability'])} against {_fmt(target)} for "
                f"{result.period_key}: {why}, {f.get('elapsed_pct')}% of the period gone.",
            ))
    if (
        agreement.alert_coverage_pct is not None and f.get("coverage") is not None
        and (f.get("elapsed_pct") or 0) >= COVERAGE_MIN_ELAPSED_PCT
        and f["coverage"] < float(agreement.alert_coverage_pct)
    ):
        out.append((
            "coverage", "warning", f"SLA coverage low: {name}",
            f"Only {f['coverage']}% of {name}'s service time was measured in "
            f"{result.period_key} (alert below {agreement.alert_coverage_pct}%). "
            "Its figure may not reflect the service.",
        ))
    for o in f.get("objectives") or []:
        if o["state"] != "breached":
            continue
        out.append((
            f"objective:{o['kind']}:{o['threshold_ms']}", "warning",
            f"SLA latency objective breached: {name} ({o['kind']})",
            f"{o['pct']}% of {o['kind']} probes answered within {o['threshold_ms']} ms "
            f"for {result.period_key}, against an objective of {o['target_pct']:g}%.",
        ))
    objectives = agreement.latency_objectives or {}
    if objectives:
        from datetime import datetime

        p95s = latency_p95_by_kind(
            agreement, datetime.fromisoformat(f["since"]), datetime.fromisoformat(f["until"])
        )
        for kind, limit in objectives.items():
            p95 = p95s.get(kind)
            if p95 is not None and p95 > float(limit):
                out.append((
                    f"latency:{kind}", "warning",
                    f"SLA p95 latency above the alert: {name} ({kind})",
                    f"{kind} p95 is {p95} ms, above the alert at {limit} ms, "
                    f"for {result.period_key}.",
                ))
    return out


def send_alerts(agreement, result, now=None, only=None) -> int:
    """Send the events not yet sent for this period (``only`` these keys, if
    given). Returns how many."""
    now = now or timezone.now()
    channels = list(agreement.notify_channels.filter(enabled=True))
    if not channels:
        return 0
    from .notify import notify_plain

    sent = dict(result.alerts_sent or {})
    n = 0
    for key, severity, subject, text in events_for(agreement, result):
        if only is not None and key not in only:
            continue
        last = sent.get(key)
        if last and (result.state != "rolling" or now - _parse(last) < ROLLING_REPEAT):
            continue
        for ch in channels:
            notify_plain(ch, subject, text, {
                "severity": severity, "kind": "sla", "kicker": "SLA",
                "dedup_key": f"sla:{agreement.id}:{result.period_key}:{key}",
                "agreement": str(agreement.id), "period": result.period_key,
                "event": key, "figures": result.figures,
            })
        sent[key] = now.isoformat()
        n += 1
    if n:
        result.alerts_sent = sent
        result.save(update_fields=["alerts_sent"])
    return n


def _parse(iso):
    from datetime import datetime

    return datetime.fromisoformat(iso)


def send_report(agreement, result, now=None, recipients=None, view=None,
                mark: bool = True) -> bool:
    """Email the period's report to the agreement's recipients (or the given
    ones). ``view`` narrows it for a scoped sender; ``mark`` records the send
    so a freeze reports once."""
    from core import email as ek

    from .sla_report import report_csv, report_pdf

    recipients = recipients if recipients is not None else list(agreement.report_recipients or [])
    if not recipients:
        return False
    fmt = agreement.report_format
    files = []
    stem = f"sla-{agreement.name}-{result.period_key}".replace(" ", "-").lower()
    if fmt in ("pdf", "both"):
        files.append((f"{stem}.pdf", report_pdf(agreement, result, view), "application/pdf"))
    if fmt in ("csv", "both"):
        files.append((f"{stem}.csv", report_csv(agreement, result, view).encode(), "text/csv"))
    f = view["figures"] if view else (result.figures or {})
    text = (
        f"{agreement.name}, {result.period_key}: {_fmt(f.get('availability'))} against "
        f"{_fmt(f.get('target'))} ({f.get('state', '-')}), coverage "
        f"{f.get('coverage', '-')}%, {f.get('incidents', 0)} incident(s)."
    )
    html = ek.render_layout(
        f"SLA report: {agreement.name} {result.period_key}",
        ek.paragraph(text) + ek.muted("The full report is attached."),
        kicker="SLA",
        preheader=text[:120],
    )
    ok = ek.send_html_email(
        f"SLA report: {agreement.name} {result.period_key}", recipients,
        html_body=html, text_body=text + "\n", tenant=agreement.tenant_id,
        attachments=files,
    )
    if ok and mark:
        result.report_sent_at = now or timezone.now()
        result.save(update_fields=["report_sent_at"])
    return ok


def after_refresh(agreement, results, now=None, was_open=frozenset()) -> None:
    """Alerts for the running period; "breached" once more for a period that
    closes breached (it may have tipped between two runs); the report for a
    period that was open, closed and has now frozen. Best-effort: a failed
    send never stops the computation."""
    for res in results:
        try:
            if res.state in ("open", "rolling"):
                send_alerts(agreement, res, now)
            elif res.state == "closed" and res.period_key in was_open:
                send_alerts(agreement, res, now, only=("breached",))
            elif res.state == "frozen" and res.report_sent_at is None and res.closed_at:
                # Only a period that was open and closed here: an agreement
                # created today freezes its past periods at once, unreported.
                send_report(agreement, res, now)
        except Exception:  # noqa: BLE001
            log.exception("SLA notify failed for %s %s", agreement.pk, res.period_key)
