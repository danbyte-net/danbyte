"""Scheduled SLA reports: weekly or monthly, per agreement or the overview.

Run by the SLA timer after the figures are computed (``manage.py
sla_compute``). A schedule is due once its latest slot - the weekday or day
of the month at its hour, in the agreement's timezone (the tenant's for the
overview) - is later than its last successful send. The send is claimed with
one conditional UPDATE first, so two runs never send the same slot twice; a
failure gives the claim back and records the error, and the next run tries
again, like the notification channels since 0.17.2.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from . import sla

log = logging.getLogger("monitoring.sla")

#: Error text kept on a schedule.
ERROR_MAX = 500


def schedule_tz(schedule) -> str:
    if schedule.agreement_id:
        return sla.agreement_tz(schedule.agreement)
    return sla.agreement_tz_for_tenant(schedule.tenant)


def last_slot(schedule, now: datetime) -> datetime:
    """The latest moment at or before ``now`` the schedule is meant to send."""
    zone = ZoneInfo(schedule_tz(schedule))
    local = now.astimezone(zone)
    at = time(schedule.hour)
    if schedule.frequency == "weekly":
        day = local.date() - timedelta(days=(local.weekday() - schedule.weekday) % 7)
        slot = datetime.combine(day, at, zone)
        if slot > local:
            slot = datetime.combine(day - timedelta(days=7), at, zone)
        return slot
    day = date(local.year, local.month, schedule.day_of_month)
    slot = datetime.combine(day, at, zone)
    if slot > local:
        y, m = (local.year, local.month - 1) if local.month > 1 else (local.year - 1, 12)
        slot = datetime.combine(date(y, m, schedule.day_of_month), at, zone)
    return slot


def next_slot(schedule, now: datetime) -> datetime:
    """The first slot after ``now``."""
    zone = ZoneInfo(schedule_tz(schedule))
    last = last_slot(schedule, now).astimezone(zone)
    if schedule.frequency == "weekly":
        return datetime.combine(last.date() + timedelta(days=7), time(schedule.hour), zone)
    y, m = (last.year, last.month + 1) if last.month < 12 else (last.year + 1, 1)
    return datetime.combine(date(y, m, schedule.day_of_month), time(schedule.hour), zone)


def is_due(schedule, now: datetime) -> bool:
    if not schedule.enabled:
        return False
    slot = last_slot(schedule, now)
    # A new schedule waits for its first slot rather than sending at once.
    if slot < schedule.created_at:
        return False
    return schedule.report_sent_at is None or schedule.report_sent_at < slot


def _claim(schedule, now) -> bool:
    """Stamp ``report_sent_at = now`` only if no other run moved it since the
    row was read."""
    from .models import SlaReportSchedule

    prev = schedule.report_sent_at
    qs = SlaReportSchedule.objects.filter(pk=schedule.pk)
    qs = qs.filter(report_sent_at__isnull=True) if prev is None else qs.filter(
        report_sent_at=prev)
    return bool(qs.update(report_sent_at=now))


def _release(schedule, now, prev, error: str) -> None:
    """A claimed send failed: put the previous stamp back, so the slot stays
    due, and keep the error."""
    from django.db.models import F

    from .models import SlaReportSchedule

    SlaReportSchedule.objects.filter(pk=schedule.pk, report_sent_at=now).update(
        report_sent_at=prev,
    )
    SlaReportSchedule.objects.filter(pk=schedule.pk).update(
        last_error=error[:ERROR_MAX], last_attempt_at=now, failures=F("failures") + 1,
    )


def _period_label(schedule, now) -> str:
    return "this period" if schedule.period == "current" else "last period"


def _result(agreement, want: str, now):
    from .models import SlaPeriodResult

    if want == "previous":
        prev = sla.previous_period(agreement, now)
        key = prev[0] if prev else None
    else:
        key = sla.period_for(agreement, now)[0]
    if key is None:
        return None
    return SlaPeriodResult.objects.filter(agreement=agreement, period_key=key).first()


def _send(schedule, now) -> None:
    """Send one schedule's report. Raises when it could not be sent."""
    from .models import SlaAgreement
    from .sla_notify import send_overview, send_report

    if not schedule.recipients:
        raise ValueError("No recipients.")
    if schedule.agreement_id:
        a = schedule.agreement
        if a.status != "active":
            raise ValueError("The agreement is not active.")
        res = _result(a, schedule.period, now)
        if res is None:
            raise ValueError("No figures for that period yet.")
        # The whole report, service credit included: who may set the
        # recipients is gated on the API like the agreement's own recipients.
        send_report(a, res, now, recipients=list(schedule.recipients), mark=False,
                    fmt=schedule.report_format, fail_silently=False)
        return
    rows = []
    agreements = SlaAgreement.objects.filter(tenant_id=schedule.tenant_id).exclude(
        status="draft").order_by("name")
    for a in agreements:
        res = _result(a, schedule.period, now)
        rows.append((a, res, res.figures if res else None))
    send_overview(schedule.tenant, rows, _period_label(schedule, now),
                  list(schedule.recipients), schedule.report_format)


def send_now(schedule, now=None) -> bool:
    """Send regardless of the slot, claimed like a due send. False when
    another run holds the claim; raises when the send failed."""
    now = now or timezone.now()
    prev = schedule.report_sent_at
    if not _claim(schedule, now):
        return False
    try:
        _send(schedule, now)
    except Exception as e:
        _release(schedule, now, prev, str(e) or e.__class__.__name__)
        raise
    _sent(schedule, now)
    return True


def _sent(schedule, now) -> None:
    from .models import SlaReportSchedule

    SlaReportSchedule.objects.filter(pk=schedule.pk).update(
        last_error="", last_attempt_at=now, failures=0,
    )


def run_due(now=None) -> dict:
    """Send every due schedule, every tenant. One failing schedule never
    stops the others."""
    from .models import SlaReportSchedule

    now = now or timezone.now()
    sent = failed = 0
    for s in SlaReportSchedule.objects.filter(enabled=True).select_related(
        "agreement", "agreement__tenant", "tenant",
    ):
        try:
            if not is_due(s, now):
                continue
        except Exception:  # noqa: BLE001 - a bad row must not stop the rest
            log.exception("SLA schedule %s: cannot work out the slot", s.pk)
            continue
        try:
            sent += send_now(s, now)
        except Exception:  # noqa: BLE001
            failed += 1
            log.exception("SLA report schedule %s failed", s.pk)
    return {"reports_sent": sent, "reports_failed": failed}
