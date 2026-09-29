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

The rollup and result cuts first look up the addresses reset inside the
window - usually none, and then the figure query is left as it was. A few are
named by id; only past :data:`_INLINE_MAX` does the query join the address
table.

A reset never reaches back into an SLA period that had ended before it: the
engine asks :func:`cuts` for the resets before the period's end only, so a
closed period keeps the figures it closed with.

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


def cuts(tenant_id, since, ip_ids=None, *, resets_before=None) -> dict:
    """``{ip_id (str): Cut}`` for the tenant's addresses whose window from
    ``since`` is cut - reset after it, or excluded now. One query on two
    partial indexes, and usually empty. ``ip_ids`` narrows the answer in
    Python rather than sending tens of thousands of ids to the database.

    ``resets_before`` leaves out the resets at or after it: an SLA period's
    end, so a reset made after a period ended does not rewrite it."""
    from api.models import IPAddress

    if tenant_id is None:
        return {}
    wanted = {str(i) for i in ip_ids} if ip_ids is not None else None
    reset = Q(availability_since__gt=since)
    if resets_before is not None:
        reset &= Q(availability_since__lt=resets_before)
    out = {}
    rows = (
        IPAddress.objects.filter(tenant_id=tenant_id)
        .filter(reset | Q(monitoring_excluded=True))
        .values_list("id", "availability_since", "monitoring_excluded",
                     "monitoring_excluded_at")
        .order_by()
    )
    for pk, counts_from, excluded, excluded_at in rows:
        key = str(pk)
        if wanted is not None and key not in wanted:
            continue
        counted = counts_from is not None and counts_from > since and (
            resets_before is None or counts_from < resets_before
        )
        excluded_from = (excluded_at or since) if excluded else None
        if not counted and excluded_from is None:
            continue
        out[key] = Cut(counts_from if counted else None, excluded_from)
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

#: Resets named one by one in a figure query; past this many inside one
#: window the query joins the address table instead.
_INLINE_MAX = 100


def _counted(field: str = "bucket") -> Q:
    """Rows at or after their address's cut (or with none) - by a join."""
    return Q(target_ip__availability_since__isnull=True) | Q(
        **{f"{field}__gte": F("target_ip__availability_since")}
    )


def _resets_after(since, tenant_id=None, before=None) -> list[tuple]:
    """``[(ip_id, counts_from)]`` of the addresses that count from a moment
    after ``since`` (and before ``before``) - at most ``_INLINE_MAX + 1``,
    usually none. One query on the partial index. Only these can have a row
    before their cut in a window that opens at ``since``."""
    from api.models import IPAddress

    qs = IPAddress.objects.filter(availability_since__gt=since)
    if before is not None:
        qs = qs.filter(availability_since__lt=before)
    if tenant_id is not None:
        qs = qs.filter(tenant_id=tenant_id)
    return list(
        qs.values_list("id", "availability_since").order_by()[: _INLINE_MAX + 1]
    )


def _cut_q(rows, field: str, before=None) -> Q:
    """Rows at or after their address's cut, for the resets in ``rows``
    (:func:`_resets_after`): nothing to add when there are none, the ids
    spelled out when there are a few, the join past that."""
    if not rows:
        return Q()
    if len(rows) > _INLINE_MAX:
        if before is None:
            return _counted(field)
        return _counted(field) | Q(target_ip__availability_since__gte=before)
    q = ~Q(target_ip_id__in=[pk for pk, _ in rows])
    for pk, counts_from in rows:
        q |= Q(target_ip_id=pk, **{f"{field}__gte": counts_from})
    return q


def _utc_day(dt: datetime) -> datetime:
    return dt.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


def _day_rest(rows, start, stop) -> Q | None:
    """The hourly rows that stand in for a daily slice's reset days: from
    the cut to the next UTC midnight - the daily rows' own boundary. A reset
    exactly on a midnight needs none (that day's daily row counts whole)."""
    if len(rows) > _INLINE_MAX:
        # The ceiling of the cut's day: midnight itself stays on that day.
        ceiling = ExpressionWrapper(
            TruncDay(
                F("target_ip__availability_since") + Value(timedelta(days=1))
                - Value(timedelta(microseconds=1)),
                tzinfo=UTC,
            ),
            output_field=DateTimeField(),
        )
        return Q(
            target_ip__availability_since__gte=start,
            target_ip__availability_since__lt=stop,
            bucket__gte=F("target_ip__availability_since"),
            bucket__lt=ceiling,
        )
    q = None
    for pk, counts_from in rows:
        day = _utc_day(counts_from)
        if not (start <= counts_from < stop) or counts_from == day:
            continue
        one = Q(target_ip_id=pk, bucket__gte=counts_from, bucket__lt=day + timedelta(days=1))
        q = one if q is None else q | one
    return q


def rollup_slices(win) -> list[tuple]:
    """``[(model, Q)]`` - the rollup rows a window's figures read, with each
    address counted from its cut. Replaces ``win.parts`` for readers.

    Hourly rows count from the first whole hour after the cut, daily rows
    from the first whole day. For a daily slice, the reset day's remaining
    hours come from the hourly rows - bounded by the next **UTC** midnight,
    the daily rows' own boundary, whatever the viewer's timezone, so no hour
    is counted twice. (Hourly rows are kept 30 days: a reset older than that
    loses at most its own day.) The resets are looked up across tenants -
    the window has none - and an id from another tenant simply matches no
    row the caller's narrowing keeps.

    A reset at or after the window's end does not cut it: that is a no-op
    for a window up to now, and keeps an SLA period's figures (read through
    ``span_window``) as they were when it ended."""
    from .models import CheckRollupDaily, CheckRollupHourly

    before = win.until
    rows = _resets_after(min(start for _m, start, _s in win.parts), before=before)
    out = []
    for model, start, stop in win.parts:
        out.append((model, Q(bucket__gte=start, bucket__lt=stop)
                    & _cut_q(rows, "bucket", before)))
        if model is CheckRollupDaily and rows:
            rest = _day_rest(rows, start, stop)
            if rest is not None:
                out.append((CheckRollupHourly, rest))
    return out


def trim_rollups(qs, *, since=None, tenant_id=None, before=None):
    """A rollup queryset without the rows before their address's cut. With
    ``since`` - the queryset holds no row before it - only the addresses
    reset after it are looked at (:func:`_cut_q`); ``before`` ignores the
    resets from then on (an SLA window's end)."""
    if since is None:
        return qs.filter(_counted())
    return qs.filter(_cut_q(_resets_after(since, tenant_id, before), "bucket", before))


def trim_results(qs, field: str = "timestamp", *, since=None, tenant_id=None):
    """A ``CheckResult`` queryset without the rows before their address's
    cut - for figures that count results (the dashboard's availability).
    ``since`` as for :func:`trim_rollups`."""
    if since is None:
        return qs.filter(_counted(field))
    return qs.filter(_cut_q(_resets_after(since, tenant_id), field))


# ─── the reset ──────────────────────────────────────────────────────────────


_RESET_FIELDS = (
    "availability_since", "availability_reset_at", "availability_reset_by",
    "availability_reset_reason",
)


def affected_agreements(ip, since=None) -> list:
    """The active agreements whose stored figures count this address and
    that a change to its reset from ``since`` on touches: the open and
    rolling ones, and the closed (not yet frozen) ones that ended after
    ``since`` - a period that had ended by then keeps the figures it closed
    with. ``since`` None: open and rolling only. One containment query on
    the stored units, not a walk of every agreement's members."""
    from .models import SlaAgreement, SlaPeriodResult

    which = Q(state__in=("open", "rolling"))
    if since is not None:
        which |= Q(state="closed", period_end__gt=since)
    ids = set(
        SlaPeriodResult.objects.filter(
            which, tenant_id=ip.tenant_id,
            units__contains=[{"items": [{"ip_id": str(ip.pk)}]}],
        ).values_list("agreement_id", flat=True)
    )
    if not ids:
        return []
    return list(
        SlaAgreement.objects.filter(pk__in=ids, tenant_id=ip.tenant_id, status="active")
        .order_by("name")
    )


def touched_from(current, counts_from):
    """The earliest moment a reset to ``counts_from`` (None: cleared)
    changes, given the reset ``current`` in force: the earlier of the two."""
    moments = [m for m in (current, counts_from) if m is not None]
    return min(moments) if moments else None


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
    :func:`exclusion.describe` for the address.

    ``reason`` is required: ``ValueError`` without one. Clearing when no
    reset is in force writes nothing."""
    from zoneinfo import ZoneInfo

    from api.models import IPAddress

    from .exclusion import (
        NOTE_MAX,
        _journal,
        _snapshot,
        _username,
        describe,
        log_change,
        sentence,
    )
    from .models import CheckState

    now = now or timezone.now()
    tz = tz or ZoneInfo("UTC")
    reason = (reason or "").strip()[:NOTE_MAX]
    if not reason:
        raise ValueError("A reset needs a reason.")
    by = _username(user)
    with transaction.atomic():
        locked = IPAddress.objects.select_for_update(of=("self",)).get(pk=ip.pk)
        if counts_from is None and locked.availability_since is None:
            return describe(locked)
        since = touched_from(locked.availability_since, counts_from)
        if agreements is None:
            agreements = affected_agreements(locked, since)
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
        text += f" Reason: {sentence(reason)}"
        # A count, not names, on the address: whoever reads its journal may
        # not see every agreement. Each agreement's own journal says it all.
        n = len(agreements)
        _journal(locked, user, text + (
            f" Affects {n} SLA agreement{'' if n == 1 else 's'}." if n else ""
        ))
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
        since_iso = since.isoformat() if since else None
        transaction.on_commit(lambda: _enqueue_refresh(ip_id, since_iso))
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


def _enqueue_refresh(ip_id: str, since: str | None = None) -> None:
    try:
        import django_rq

        django_rq.get_queue("default").enqueue(refresh_after_reset, ip_id, since)
    except Exception:  # noqa: BLE001 - the SLA timer catches up within 15 minutes
        log.warning("could not queue the SLA refresh after a reset of %s", ip_id,
                    exc_info=True)


def refresh_after_reset(ip_id: str, since: str | None = None) -> int:
    """RQ job: recompute the agreements that count the address, now rather
    than on the next SLA tick. Re-reads the address and the agreements - the
    reset may have been cleared, or an agreement archived, since. ``since``
    (ISO) is the earliest moment the change touched (:func:`touched_from`);
    left out, the reset in force. Frozen periods are never touched. Returns
    how many agreements it refreshed."""
    from django.utils.dateparse import parse_datetime

    from api.models import IPAddress

    from .sla import refresh_agreement

    ip = IPAddress.objects.filter(pk=ip_id).first()
    if ip is None:
        return 0
    moment = (parse_datetime(since) if since else None) or ip.availability_since
    n = 0
    for agreement in affected_agreements(ip, moment):
        try:
            refresh_agreement(agreement)
            n += 1
        except Exception:  # noqa: BLE001 - one agreement must not stop the rest
            log.exception("SLA refresh after reset failed for %s", agreement.pk)
    return n
