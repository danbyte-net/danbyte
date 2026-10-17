"""Support & warranty coverage (#421): status rules, query helpers, serial
matching, notifications and the digest section.

A device's coverage ends on the latest of

* the end dates of the support contracts covering it (a contract with no end
  date is open-ended), and
* its own hardware warranty end (``Device.warranty_end``).

Dates are the last covered day. The status is worked out when it is read, never
stored, so *Expiring* moves with the calendar:

``covered``   coverage ends after the warning window, or is open-ended;
``expiring``  coverage ends today or within the warning window;
``expired``   every contract and the warranty ended before today;
``none``      no contract and no warranty date.

The start date of a contract is informational: a renewal that starts the day
the old contract ends keeps the device covered without a gap.

The warning window is a tenant setting (``coverage_warning_days``, default 90).
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from django.db.models import (
    Count,
    DateField,
    F,
    Max,
    OuterRef,
    Q,
    Subquery,
    Value,
)
from django.db.models.functions import Coalesce, Greatest, Upper
from django.utils import timezone

STATUSES = ("covered", "expiring", "expired", "none")
STATUS_LABELS = {
    "covered": "Covered",
    "expiring": "Expiring",
    "expired": "Expired",
    "none": "Not covered",
}
CONTRACT_STATES = ("active", "expiring", "expired")
CONTRACT_STATE_LABELS = {
    "active": "Active",
    "expiring": "Expiring",
    "expired": "Expired",
}

#: Stands in for an open-ended contract inside SQL, so MAX() picks it.
OPEN_ENDED = date(9999, 12, 31)

#: Most serials one paste may carry.
MAX_SERIALS = 5000


# ─── the rules ───────────────────────────────────────────────────────────────


def status_for(end: date | None, warning_days: int, today: date | None = None) -> str:
    """The coverage status of a device whose coverage ends on ``end``
    (``None`` = no contract and no warranty)."""
    if end is None:
        return "none"
    today = today or timezone.localdate()
    if end < today:
        return "expired"
    if end <= today + timedelta(days=warning_days):
        return "expiring"
    return "covered"


def contract_state(end_date: date | None, warning_days: int,
                   today: date | None = None) -> str:
    """``active`` · ``expiring`` · ``expired`` - same window as devices."""
    if end_date is None:
        return "active"
    today = today or timezone.localdate()
    if end_date < today:
        return "expired"
    if end_date <= today + timedelta(days=warning_days):
        return "expiring"
    return "active"


def public_end(end: date | None) -> date | None:
    """The end date as the API shows it: ``None`` for open-ended."""
    return None if end == OPEN_ENDED else end


# ─── the warning window ──────────────────────────────────────────────────────


def warning_days_for(request=None, tenant=None) -> int:
    """The tenant's window, read once per request however many rows ask."""
    from core.effective_settings import coverage_warning_days

    if request is not None:
        cached = getattr(request, "_coverage_warning_days", None)
        if cached is not None:
            return cached
        if tenant is None:
            from api.views import _get_active_tenant

            tenant = _get_active_tenant(request)
    days = coverage_warning_days(tenant)
    if request is not None:
        try:
            request._coverage_warning_days = days
        except AttributeError:
            pass
    return days


# ─── query helpers ───────────────────────────────────────────────────────────


def _contract_end_subquery():
    from .models import SupportCoverage

    return Subquery(
        SupportCoverage.objects.filter(device=OuterRef("pk"))
        .order_by()
        .values("device")
        .annotate(
            m=Max(Coalesce("contract__end_date", Value(OPEN_ENDED), output_field=DateField()))
        )
        .values("m"),
        output_field=DateField(),
    )


def _contract_count_subquery():
    from .models import SupportCoverage

    return Coalesce(
        Subquery(
            SupportCoverage.objects.filter(device=OuterRef("pk"))
            .order_by()
            .values("device")
            .annotate(n=Count("pk"))
            .values("n")
        ),
        0,
    )


def device_annotations() -> dict:
    """Annotations for a Device queryset: ``coverage_end_annotated`` (the
    latest covered day, ``OPEN_ENDED`` for an open-ended contract, NULL when
    nothing covers the device) and ``coverage_contracts_annotated``. Two
    correlated subqueries - a page of devices costs no extra query."""
    return {
        # GREATEST ignores NULLs in PostgreSQL: a device with only a warranty
        # or only contracts takes that one; NULL only when it has neither.
        "coverage_end_annotated": Greatest(
            _contract_end_subquery(), F("warranty_end"), output_field=DateField()
        ),
        "coverage_contracts_annotated": _contract_count_subquery(),
    }


def annotate_devices(qs):
    if "coverage_end_annotated" in qs.query.annotations:
        return qs
    return qs.annotate(**device_annotations())


def status_q(status: str, warning_days: int, field: str = "coverage_end_annotated",
             today: date | None = None) -> Q:
    """Rows of an annotated Device queryset with ``status``."""
    today = today or timezone.localdate()
    edge = today + timedelta(days=warning_days)
    if status == "none":
        return Q(**{f"{field}__isnull": True})
    if status == "expired":
        return Q(**{f"{field}__lt": today})
    if status == "expiring":
        return Q(**{f"{field}__gte": today, f"{field}__lte": edge})
    if status == "covered":
        return Q(**{f"{field}__gt": edge})
    raise ValueError(status)


def parse_statuses(raw: str | None, allowed=STATUSES, key="coverage") -> list[str]:
    """``a,b`` → ``["a", "b"]``; an unknown value is a 400."""
    from rest_framework.exceptions import ValidationError

    wanted = [s.strip() for s in (raw or "").split(",") if s.strip()]
    bad = [s for s in wanted if s not in allowed]
    if bad:
        raise ValidationError({key: f"One of {', '.join(allowed)}."})
    return wanted


def apply_device_filter(qs, request):
    """``?coverage=<status>[,<status>]`` on a device list."""
    wanted = parse_statuses(request.query_params.get("coverage"))
    if not wanted:
        return qs
    days = warning_days_for(request)
    q = Q()
    for s in wanted:
        q |= status_q(s, days)
    return annotate_devices(qs).filter(q)


def contract_state_q(state: str, warning_days: int, today: date | None = None) -> Q:
    today = today or timezone.localdate()
    edge = today + timedelta(days=warning_days)
    if state == "expired":
        return Q(end_date__lt=today)
    if state == "expiring":
        return Q(end_date__gte=today, end_date__lte=edge)
    if state == "active":
        return Q(end_date__isnull=True) | Q(end_date__gt=edge)
    raise ValueError(state)


def device_end(device) -> date | None:
    """The annotated coverage end, or one query for a row that came without
    the annotation (a create or update response)."""
    if hasattr(device, "coverage_end_annotated"):
        return device.coverage_end_annotated
    from .models import Device

    return (
        annotate_devices(Device.objects.filter(pk=device.pk))
        .values_list("coverage_end_annotated", flat=True)
        .first()
    )


def device_payload(device, request=None, fresh: bool = False) -> dict:
    """The ``coverage`` block on a device: status, end date (``None`` =
    open-ended or none), how many contracts cover it. ``fresh`` ignores the
    annotations - a write response, whose row was read before the save."""
    if fresh:
        for attr in ("coverage_end_annotated", "coverage_contracts_annotated"):
            device.__dict__.pop(attr, None)
    end = device_end(device)
    count = getattr(device, "coverage_contracts_annotated", None)
    if count is None:
        count = device.support_coverage.count()
    return {
        "status": status_for(end, warning_days_for(request)),
        "end": public_end(end),
        "contracts": count,
    }


# ─── the combined lifecycle view ─────────────────────────────────────────────


def lifecycle_flags(device, contract_end: date | None, has_active_contract: bool,
                    today: date | None = None) -> list[dict]:
    """What is worth flagging when the device's coverage sits next to its
    model's vendor lifecycle:

    * ``contract_after_eol`` - a contract runs past the hardware's end of
      support, so part of it may buy nothing;
    * ``eol_under_contract`` - the hardware is past end of support and still
      under a paid contract."""
    today = today or timezone.localdate()
    dt = getattr(device, "device_type", None)
    eos = getattr(dt, "end_of_support", None) if dt is not None else None
    flags = []
    if eos is None:
        return flags
    if eos <= today and has_active_contract:
        flags.append({
            "code": "eol_under_contract",
            "label": "End-of-life hardware under contract",
        })
    elif contract_end is not None and contract_end > eos:
        flags.append({
            "code": "contract_after_eol",
            "label": "Contract runs past end of support",
        })
    return flags


# ─── serial matching ─────────────────────────────────────────────────────────

_SPLIT = re.compile(r"[\s,;]+")


def parse_serials(text) -> list[str]:
    """A pasted list - one per line, or separated by commas, semicolons or
    spaces - as unique serials in the order given."""
    if isinstance(text, (list, tuple)):
        parts = [str(p) for p in text]
    else:
        parts = _SPLIT.split(str(text or ""))
    seen, out = set(), []
    for p in parts:
        s = p.strip()
        if s and s.upper() not in seen:
            seen.add(s.upper())
            out.append(s)
    return out


def match_serials(devices, serials: list[str]) -> dict:
    """Match ``serials`` against ``devices`` (already scoped to the tenant and
    to what the caller may act on), ignoring case.

    Returns ``{"devices": [...], "unmatched": [...], "ambiguous": [...]}`` - a
    serial two devices share is reported, never guessed at."""
    by_serial: dict[str, list] = {}
    upper = [s.upper() for s in serials]
    if upper:
        rows = devices.annotate(_serial_u=Upper("serial_number")).filter(
            _serial_u__in=upper
        )
        for d in rows:
            by_serial.setdefault(d._serial_u, []).append(d)
    matched, unmatched, ambiguous = [], [], []
    for s in serials:
        hits = by_serial.get(s.upper(), [])
        if not hits:
            unmatched.append(s)
        elif len(hits) > 1:
            ambiguous.append(s)
        else:
            matched.append(hits[0])
    return {"devices": matched, "unmatched": unmatched, "ambiguous": ambiguous}


# ─── notifications ───────────────────────────────────────────────────────────


def _contract_text(contract, state: str, today: date) -> tuple[str, str, str]:
    mfr = contract.manufacturer.name
    if state == "expired":
        severity = "critical"
        subject = f"Support contract expired: {mfr} {contract.contract_number}"
        when = f"ended on {contract.end_date:%Y-%m-%d}"
    else:
        severity = "warning"
        days = (contract.end_date - today).days
        subject = f"Support contract expiring: {mfr} {contract.contract_number}"
        when = (
            "ends today" if days == 0
            else f"ends on {contract.end_date:%Y-%m-%d}, in {days} day{'s' if days != 1 else ''}"
        )
    n = contract.coverage.count()
    text = (
        f"{mfr} contract {contract.contract_number} {when}. "
        f"It covers {n} device{'s' if n != 1 else ''}."
    )
    return severity, subject, text


def notify_contracts(now=None) -> int:
    """Announce each contract that entered its tenant's warning window or
    expired since the last run, to the contract's channels. Returns how many
    announcements went out.

    Each state is announced once: the row's ``notified_state`` is claimed with
    a conditional update before anything is sent, so a second run - or two
    running at once - sends nothing new. A contract whose end date moves back
    out of the window (renewed) is reset quietly and is announced again when
    it next nears its end."""
    from monitoring.notify import notify_plain

    from .models import SupportContract

    today = timezone.localdate(now) if now else timezone.localdate()
    sent = 0
    windows: dict = {}
    rows = (
        SupportContract.objects.filter(tenant__is_active=True)
        .filter(Q(end_date__isnull=False) | ~Q(notified_state=""))
        .select_related("manufacturer", "tenant")
        .order_by("tenant_id", "end_date")
    )
    for c in rows:
        days = windows.get(c.tenant_id)
        if days is None:
            from core.effective_settings import coverage_warning_days

            days = windows[c.tenant_id] = coverage_warning_days(c.tenant)
        state = contract_state(c.end_date, days, today)
        want = "" if state == "active" else state
        if want == c.notified_state:
            continue
        claimed = SupportContract.objects.filter(
            pk=c.pk, notified_state=c.notified_state
        ).update(notified_state=want)
        if not claimed or not want:
            continue
        channels = list(c.notify_channels.filter(enabled=True, tenant_id=c.tenant_id))
        if not channels:
            continue
        severity, subject, text = _contract_text(c, state, today)
        for ch in channels:
            notify_plain(ch, subject, text, {
                "severity": severity, "kind": "support_contract", "kicker": "Coverage",
                "dedup_key": f"support-contract:{c.pk}:{state}:{c.end_date}",
                "contract": str(c.pk), "state": state,
                "end_date": c.end_date.isoformat(),
            })
        sent += 1
    return sent


# ─── the email digest section ────────────────────────────────────────────────

_DIGEST_ROWS = 10


def digest_summary(tenant, now=None) -> dict:
    """Contracts that end within the window and those that ended in the last
    30 days, for the tenant's daily/weekly digest."""
    from core.effective_settings import coverage_warning_days

    from .models import SupportContract

    today = timezone.localdate(now) if now else timezone.localdate()
    days = coverage_warning_days(tenant)
    base = SupportContract.objects.filter(tenant=tenant).select_related("manufacturer")
    expiring = base.filter(contract_state_q("expiring", days, today)).order_by("end_date")
    recent = base.filter(
        end_date__lt=today, end_date__gte=today - timedelta(days=30)
    ).order_by("-end_date")
    rows = []
    for c in list(recent[:_DIGEST_ROWS]) + list(expiring[:_DIGEST_ROWS]):
        rows.append({
            "contract_number": c.contract_number,
            "manufacturer": c.manufacturer.name,
            "end_date": c.end_date,
            "expired": c.end_date < today,
            "days": (c.end_date - today).days,
        })
    return {
        "warning_days": days,
        "expiring": expiring.count(),
        "expired_recently": recent.count(),
        "rows": rows,
    }


# ─── OpenAPI shapes of the device actions ────────────────────────────────────


def schema(kind: str):
    """The response serializer of ``/api/devices/<id>/coverage/`` (``device``)
    or ``/api/devices/coverage-summary/`` (``summary``), for extend_schema."""
    from drf_spectacular.utils import inline_serializer
    from rest_framework import serializers as s

    if kind == "device":
        return inline_serializer("DeviceCoverage", {
            "status": s.ChoiceField(choices=STATUSES),
            "end": s.DateField(allow_null=True),
            "warranty_end": s.DateField(allow_null=True),
            "warning_days": s.IntegerField(),
            "contracts": s.ListField(child=s.DictField()),
            "hidden_contracts": s.IntegerField(),
            "flags": s.ListField(child=s.DictField()),
        })
    return inline_serializer("SupportCoverageSummary", {
        "warning_days": s.IntegerField(),
        "total": s.IntegerField(),
        "counts": s.DictField(child=s.IntegerField()),
        "ending": s.ListField(child=s.DictField()),
    })
