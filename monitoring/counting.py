"""What is counted: an address's availability reset, and its exclusion.

Resetting an address's availability sets ``IPAddress.availability_since`` -
"counts from". It is a cut applied when figures are **read**: transitions,
results and rollups are never rewritten, so the history before it is kept
(the results table, the transitions list and the latency charts still show
it) but no uptime, SLA or availability figure counts it. Moving the date, or
clearing it, is therefore always safe.

Readers apply the cut in three places, all here:

* **segments** - :func:`clip`, called by ``timeline.segments_for_pairs``, which
  every uptime, strip, history and SLA figure is built from. Exact: the time
  before the cut becomes one ``skipped`` segment marked ``not_counted``, so a
  strip stays full width and the SLA engine sees a whole timeline. The same
  pass marks the time an address has been excluded from monitoring
  (``excluded``), so a window stays right even after the retention pruner
  has removed the transition that parked it.
* **rollups** - :func:`rollup_slices`, which the rollup-based figures (lists,
  explore, SLA objectives and status columns) read through. Buckets are
  aligned, so these count from the next whole hour after the cut; the reset
  day's remaining hours come from the hourly rows.
* **raw results** - :func:`trim_results`, for the dashboard charts that count
  result rows. Exact.

The rollup tables themselves keep what actually happened (``roll`` reads
segments uncounted), so a later reset or its removal needs no re-roll.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from django.db import transaction
from django.db.models import DateTimeField, ExpressionWrapper, F, Q, Value
from django.db.models.functions import TruncDay
from django.utils import timezone

log = logging.getLogger("monitoring.counting")

#: Segment notes: why a stretch of a window is not counted.
NOT_COUNTED = "not_counted"
EXCLUDED = "excluded"


@dataclass(frozen=True)
class Cut:
    """How one address's window is cut: counted from ``counts_from`` (when
    that falls after the window opens), and excluded from ``excluded_at`` on
    (while it is excluded now)."""

    counts_from: datetime | None = None
    excluded_at: datetime | None = None


# ─── segments ───────────────────────────────────────────────────────────────


def cuts(tenant_id, since, ip_ids=None) -> dict:
    """``{ip_id (str): Cut}`` for the tenant's addresses whose window from
    ``since`` is cut - reset after it, or excluded now. One query on two
    partial indexes, and usually empty. ``ip_ids`` narrows the answer in
    Python rather than sending tens of thousands of ids to the database."""
    from api.models import IPAddress

    if tenant_id is None:
        return {}
    wanted = {str(i) for i in ip_ids} if ip_ids is not None else None
    out = {}
    rows = (
        IPAddress.objects.filter(tenant_id=tenant_id)
        .filter(Q(availability_since__gt=since) | Q(monitoring_excluded=True))
        .values_list("id", "availability_since", "monitoring_excluded",
                     "monitoring_excluded_at")
        .order_by()
    )
    for pk, counts_from, excluded, excluded_at in rows:
        key = str(pk)
        if wanted is not None and key not in wanted:
            continue
        out[key] = Cut(
            counts_from if counts_from and counts_from > since else None,
            (excluded_at or since) if excluded else None,
        )
    return out


def clip(segments, since, until, cut: Cut) -> list[dict]:
    """``segments`` over ``[since, until)`` with the cut applied: everything
    before ``counts_from`` as one ``not_counted`` segment (the status in
    effect at the cut opens what follows), everything from ``excluded_at``
    on as one ``excluded`` segment. Both are ``skipped``: not measured."""
    out = list(segments)
    start = since
    if cut.counts_from is not None:
        c = min(max(cut.counts_from, since), until)
        kept = []
        for seg in out:
            if seg["end"] <= c:
                continue
            kept.append({**seg, "start": c} if seg["start"] < c else seg)
        out = kept
        if c > since:
            out.insert(0, {"start": since, "end": c, "status": "skipped", "note": NOT_COUNTED})
        start = c
    if cut.excluded_at is not None:
        x = max(start, cut.excluded_at)
        if x < until:
            kept = []
            for seg in out:
                if seg["start"] >= x:
                    continue
                kept.append({**seg, "end": x} if seg["end"] > x else seg)
            out = kept + [{"start": x, "end": until, "status": "skipped", "note": EXCLUDED}]
    return out


# ─── rollups and raw results ────────────────────────────────────────────────


def _counted(field: str = "bucket") -> Q:
    """Rows at or after their address's cut (or with none)."""
    return Q(target_ip__availability_since__isnull=True) | Q(
        **{f"{field}__gte": F("target_ip__availability_since")}
    )


def _next_utc_midnight():
    return ExpressionWrapper(
        TruncDay("target_ip__availability_since", tzinfo=UTC) + Value(timedelta(days=1)),
        output_field=DateTimeField(),
    )


def rollup_slices(win) -> list[tuple]:
    """``[(model, Q)]`` - the rollup rows a window's figures read, with each
    address counted from its cut. Replaces ``win.parts`` for readers.

    Hourly rows count from the first whole hour after the cut, daily rows
    from the first whole day. For a daily slice, the reset day's remaining
    hours come from the hourly rows - bounded by the next **UTC** midnight,
    the daily rows' own boundary, whatever the viewer's timezone, so no hour
    is counted twice. (Hourly rows are kept 30 days: a reset older than that
    loses at most its own day.)"""
    from .models import CheckRollupDaily, CheckRollupHourly

    out = []
    for model, start, stop in win.parts:
        out.append((model, Q(bucket__gte=start, bucket__lt=stop) & _counted()))
        if model is CheckRollupDaily:
            out.append((CheckRollupHourly, Q(
                target_ip__availability_since__gte=start,
                target_ip__availability_since__lt=stop,
                bucket__gte=F("target_ip__availability_since"),
                bucket__lt=_next_utc_midnight(),
            )))
    return out


def trim_rollups(qs):
    """A rollup queryset without the rows before their address's cut."""
    return qs.filter(_counted())


def trim_results(qs, field: str = "timestamp"):
    """A ``CheckResult`` queryset without the rows before their address's
    cut - for figures that count results (the dashboard's availability)."""
    return qs.filter(_counted(field))


# ─── the reset ──────────────────────────────────────────────────────────────


_RESET_FIELDS = (
    "availability_since", "availability_reset_at", "availability_reset_by",
    "availability_reset_reason",
)


def affected_agreements(ip) -> list:
    """The active agreements whose stored figures (open, rolling, or closed
    and not yet frozen) count this address - one containment query on the
    stored units, not a walk of every agreement's members."""
    from .models import SlaAgreement, SlaPeriodResult

    ids = set(
        SlaPeriodResult.objects.filter(
            tenant_id=ip.tenant_id, state__in=("open", "rolling", "closed"),
            units__contains=[{"items": [{"ip_id": str(ip.pk)}]}],
        ).values_list("agreement_id", flat=True)
    )
    if not ids:
        return []
    return list(
        SlaAgreement.objects.filter(pk__in=ids, tenant_id=ip.tenant_id, status="active")
        .order_by("name")
    )


def _when(dt, tz) -> str:
    local = dt.astimezone(tz)
    return f"{local:%d %b %Y %H:%M} ({tz.key if hasattr(tz, 'key') else tz})"


def reset(ip, *, counts_from, user, reason: str, tz=None, now=None,
          agreements=None) -> dict:
    """Count the address's availability from ``counts_from`` - or, with
    ``counts_from=None``, from the start again (the reset cleared). Writes
    the change log and a journal entry on the address and on each agreement
    it changes, clears a flapping flag (the host it described is gone), and
    refreshes those agreements' SLA figures after the commit. Returns
    :func:`exclusion.describe` for the address."""
    from zoneinfo import ZoneInfo

    from api.models import IPAddress

    from .exclusion import NOTE_MAX, _journal, _snapshot, _username, describe, log_change
    from .models import CheckState

    now = now or timezone.now()
    tz = tz or ZoneInfo("UTC")
    reason = (reason or "").strip()[:NOTE_MAX]
    by = _username(user)
    if agreements is None:
        agreements = affected_agreements(ip)
    with transaction.atomic():
        locked = IPAddress.objects.select_for_update(of=("self",)).get(pk=ip.pk)
        old = _snapshot(locked, _RESET_FIELDS)
        if counts_from is None:
            # Cleared: the note describes the reset in force, and there is none.
            new = {"availability_since": None, "availability_reset_at": None,
                   "availability_reset_by": "", "availability_reset_reason": ""}
        else:
            new = {"availability_since": counts_from, "availability_reset_at": now,
                   "availability_reset_by": by, "availability_reset_reason": reason}
        IPAddress.objects.filter(pk=ip.pk).update(**new, updated_at=now)
        for k, v in new.items():
            setattr(ip, k, v)
            setattr(locked, k, v)
        log_change(locked, old, {**new, **({"reason": reason} if counts_from is None else {})},
                   user)

        if counts_from is None:
            text = "Availability reset cleared - all history counts again."
        else:
            text = f"Availability reset - counts from {_when(counts_from, tz)}."
        text += f" Reason: {reason}"
        if agreements:
            text += " SLA: " + ", ".join(a.name for a in agreements) + "."
        _journal(locked, user, text)
        for a in agreements:
            _agreement_journal(a, user, f"{locked.ip_address}: {text}")

        if counts_from is not None:
            # A new host behind the address: whether the old one bounced
            # says nothing about it.
            from .flapping import clear_flapping

            flapping = list(
                CheckState.objects.filter(target_ip_id=ip.pk, flapping_since__isnull=False)
                .select_related("target_ip", "template")
            )
            if flapping:
                clear_flapping(flapping, user if getattr(user, "pk", None) else None, now)

        ip_id = str(ip.pk)
        transaction.on_commit(lambda: _enqueue_refresh(ip_id))
    return describe(ip)


def _agreement_journal(agreement, user, text: str) -> None:
    from audit.models import JournalEntry, JournalKind
    from audit.site_capture import entry_site_id

    from .exclusion import _username

    JournalEntry.objects.create(
        tenant_id=agreement.tenant_id,
        created_by=user if getattr(user, "pk", None) else None,
        author_name=_username(user),
        object_type=agreement._meta.label_lower,
        object_id=str(agreement.pk),
        object_site_id=entry_site_id(agreement),
        kind=JournalKind.INFO,
        comments=text,
    )


def _enqueue_refresh(ip_id: str) -> None:
    try:
        import django_rq

        django_rq.get_queue("default").enqueue(refresh_after_reset, ip_id)
    except Exception:  # noqa: BLE001 - the SLA timer catches up within 15 minutes
        log.warning("could not queue the SLA refresh after a reset of %s", ip_id,
                    exc_info=True)


def refresh_after_reset(ip_id: str) -> int:
    """RQ job: recompute the agreements that count the address, now rather
    than on the next SLA tick. Re-reads the address and the agreements - the
    reset may have been cleared, or an agreement archived, since. Frozen
    periods are never touched. Returns how many agreements it refreshed."""
    from api.models import IPAddress

    from .sla import refresh_agreement

    ip = IPAddress.objects.filter(pk=ip_id).first()
    if ip is None:
        return 0
    n = 0
    for agreement in affected_agreements(ip):
        try:
            refresh_agreement(agreement)
            n += 1
        except Exception:  # noqa: BLE001 - one agreement must not stop the rest
            log.exception("SLA refresh after reset failed for %s", agreement.pk)
    return n
