"""Excluding an address from monitoring.

An excluded address keeps its checks, but they are **parked**: status
``skipped``, ``next_run`` NULL, nothing in flight. Every due query in the
codebase - the dispatcher, the driver claim, an Outpost's ``/work`` - asks for
``next_run <= now``, so a parked row is never handed to anybody; the fast lane
and ``/fast-work`` leave excluded addresses out of their set. No join is added
to the hot dispatch query.

``skipped`` is already what every figure calls "not measured": uptime counts it
as excluded time, the rollups as unknown seconds, the SLA engine as
unmeasured, and a change to it resolves a firing alert. So the time an address
spends excluded simply is not counted, with no new status to teach anything.

What can still land after the switch - a run that was already in flight, a
fast-lane flush, an Outpost's late report - goes through one choke point,
``worker._persist``, which drops it and parks the row again (:func:`repark`).

Including the address again re-arms the checks. It writes no transition: the
status stays ``skipped`` until the first verdict, so an agreement that counts
unknown as down does not charge the gap.
"""
from __future__ import annotations

import logging
from collections import defaultdict

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

log = logging.getLogger("monitoring.exclusion")

#: What a parking transition says, in its ``detail["reason"]``. The status
#: change channels and digests leave these out; the alert notice says why.
REASON = "excluded from monitoring"
#: Longest reason an operator can give (the model column's length).
NOTE_MAX = 200

_STATE_FIELDS = [
    "status", "since", "in_flight", "in_flight_since", "next_run", "fast_owned",
    "flapping_since", "flap_count", "flap_cleared_at",
]


def _username(user) -> str:
    if user is None:
        return ""
    try:
        return user.get_username()[:150]
    except Exception:  # noqa: BLE001 - an identity without a username
        return str(user)[:150]


# ─── reading ────────────────────────────────────────────────────────────────


def excluded_ids(ip_ids) -> set:
    """Which of ``ip_ids`` are excluded - one primary-key query."""
    from api.models import IPAddress

    ids = {i for i in ip_ids if i}
    if not ids:
        return set()
    return set(
        IPAddress.objects.filter(id__in=ids, monitoring_excluded=True)
        .values_list("id", flat=True).order_by()
    )


def excluded_subquery(tenant_id):
    """The tenant's excluded addresses, as a subquery (partial index)."""
    from api.models import IPAddress

    return IPAddress.objects.filter(
        tenant_id=tenant_id, monitoring_excluded=True
    ).values("id").order_by()


def monitored(qs, tenant_id, field: str = "target_ip"):
    """``qs`` without rows on the tenant's excluded addresses. A NOT IN over
    the (small, indexed) excluded set, not a join across every state."""
    return qs.exclude(**{f"{field}_id__in": excluded_subquery(tenant_id)})


def describe(ip) -> dict:
    """What the Monitoring tab says about exclusion and the reset. Reads the
    address's own columns - never the journal, whose entries their author can
    edit."""
    return {
        "excluded": ip.monitoring_excluded,
        "excluded_at": ip.monitoring_excluded_at,
        "excluded_by": ip.monitoring_excluded_by or None,
        "excluded_reason": ip.monitoring_excluded_reason or None,
        "counts_from": ip.availability_since,
        "reset_at": ip.availability_reset_at,
        "reset_by": ip.availability_reset_by or None,
        "reset_reason": ip.availability_reset_reason or None,
        "created_at": ip.created_at,
    }


# ─── parking ────────────────────────────────────────────────────────────────


def park(states, now, *, by: str = "", note: str = "") -> tuple[list, list]:
    """Park ``states`` - which the caller has locked, inside its transaction -
    and close their firing alerts. Returns ``(transitions, alerts)`` for
    :func:`announce` once the transaction commits: nothing goes out while
    the row locks are held, and nothing goes out for a change that rolled
    back."""
    from .alerts import _dedup_key
    from .models import Alert, AlertStatus, StateTransition

    if not states:
        return [], []
    transitions = []
    detail = {"reason": REASON, "by": by}
    if note:
        detail["note"] = note
    for s in states:
        if s.status != "skipped":
            transitions.append(StateTransition(
                tenant_id=s.tenant_id, target_ip_id=s.target_ip_id,
                template_id=s.template_id, kind=s.kind, from_status=s.status,
                to_status="skipped", at=now, detail=dict(detail),
            ))
            s.status = "skipped"
            s.since = now
        s.in_flight = False
        s.in_flight_since = None
        s.next_run = None
        s.fast_owned = False
        if s.flapping_since is not None:
            # Off the flapping lists now, not at the next sweep; bounces
            # before this moment never count towards flagging it again.
            s.flapping_since = None
            s.flap_count = 0
            s.flap_cleared_at = now
    if transitions:
        StateTransition.objects.bulk_create(transitions, batch_size=2000)
    type(states[0]).objects.bulk_update(states, _STATE_FIELDS, batch_size=2000)

    # The alerts the transitions to "skipped" resolve - closed here, with who
    # and why, rather than through process_transitions, which would announce
    # them as a recovery from inside this transaction.
    keys = defaultdict(set)
    for s in states:
        keys[s.tenant_id].add(_dedup_key(s.target_ip_id, s.template_id))
    alerts = []
    for tenant_id, dedup in keys.items():
        alerts += list(
            Alert.objects.select_for_update(of=("self",))
            .filter(tenant_id=tenant_id, dedup_key__in=dedup, status=AlertStatus.FIRING)
            .select_related("target_ip", "template")
        )
    for a in alerts:
        a.status = AlertStatus.RESOLVED
        a.resolved_at = now
        a.last_notified_at = now
        a.detail = {**(a.detail or {}), "closed_by": {"reason": "excluded", "by": by}}
    if alerts:
        Alert.objects.bulk_update(
            alerts, ["status", "resolved_at", "last_notified_at", "detail"], batch_size=500
        )
    return transitions, alerts


def announce(states, transitions, alerts, *, excluded: bool = True) -> None:
    """After commit: the closing notice per alert, and the live push to the
    pages open on these addresses. A flapping alert is kept quiet, as its
    other changes are. Never raises."""
    from .notify import notify_alert

    for a in alerts:
        if a.flapping:
            continue
        try:
            notify_alert(a, "resolved")
        except Exception:  # noqa: BLE001 - a delivery error is not a write error
            log.exception("closing notice for alert %s failed", a.pk)
    try:
        from .live import publish

        for s in states:
            s._live_excluded = excluded
        publish(states, transitions)
    except Exception:  # noqa: BLE001
        log.debug("live publish after exclusion failed", exc_info=True)


def _park_locked(state_ids, now, *, by: str = "", note: str = "", only_stray: bool = False):
    """Lock and park; returns what to announce. ``only_stray`` keeps the
    rows that are already parked out of it (the self-heal)."""
    from .models import CheckState

    qs = CheckState.objects.select_for_update(of=("self",)).filter(
        id__in=list(state_ids), target_ip__monitoring_excluded=True
    )
    if only_stray:
        qs = qs.filter(
            Q(next_run__isnull=False) | ~Q(status="skipped") | Q(in_flight=True)
            | Q(fast_owned=True)
        )
    states = list(qs.order_by("id"))
    transitions, alerts = park(states, now, by=by, note=note)
    return states, transitions, alerts


def repark(state_ids, now=None) -> int:
    """Park again the rows on excluded addresses that something re-armed - a
    run in flight when the switch was thrown, a driver claim that raced it.
    The status is read from the database, not from the writer's copy, so a
    row that is still parked writes no second transition. Returns how many
    rows needed it."""
    ids = [i for i in state_ids if i]
    if not ids:
        return 0
    now = now or timezone.now()
    with transaction.atomic():
        states, transitions, alerts = _park_locked(ids, now, by="", only_stray=True)
        if states:
            transaction.on_commit(lambda: announce(states, transitions, alerts))
    if states:
        log.info("re-parked %d check(s) on excluded addresses", len(states))
    return len(states)


def park_new(states, now) -> None:
    """A check that appears on an address that is already excluded starts
    parked (materialisation)."""
    ids = [s.id for s in states]
    if not ids:
        return
    with transaction.atomic():
        parked, transitions, alerts = _park_locked(ids, now)
        if parked:
            transaction.on_commit(lambda: announce(parked, transitions, alerts))


def heal_orphans(tenant, now=None) -> int:
    """Re-arm checks left parked on an address that is not excluded - which
    only a stale full save of the address can cause (it wrote the switch back
    off without going through :func:`set_excluded`). One query per tenant,
    usually empty; runs with materialisation."""
    from .models import CheckState
    from .worker import _cfg, _load_settings, effective_interval

    now = now or timezone.now()
    rows = list(
        CheckState.objects.filter(
            tenant=tenant, status="skipped", next_run__isnull=True, in_flight=False,
            target_ip__monitoring_excluded=False,
        ).select_related("template", "assignment")
    )
    if not rows:
        return 0
    cfg = _cfg(_load_settings({tenant.id}), tenant.id)
    armed = [s for s in rows if effective_interval(s, cfg)]
    for s in armed:
        s.next_run = now
    if armed:
        CheckState.objects.bulk_update(armed, ["next_run"], batch_size=2000)
    return len(armed)


# ─── the switch ─────────────────────────────────────────────────────────────


def _journal(ip, user, text: str) -> None:
    from audit.models import JournalEntry, JournalKind
    from audit.site_capture import entry_site_id

    JournalEntry.objects.create(
        tenant_id=ip.tenant_id,
        created_by=user if getattr(user, "pk", None) else None,
        author_name=_username(user),
        object_type="api.ipaddress",
        object_id=str(ip.pk),
        object_site_id=entry_site_id(ip),
        kind=JournalKind.INFO,
        comments=text,
    )


def log_change(ip, old: dict, new: dict, user) -> None:
    """One change-log entry for the address, written explicitly - with the
    user passed in, so a job or a script is recorded as well as a request."""
    from audit.bulk import _entry
    from audit.context import current_request_id
    from audit.models import ChangeAction
    from audit.signals import _ser

    changes = {
        k: {"old": _ser(old.get(k)), "new": _ser(v)}
        for k, v in new.items()
        if _ser(old.get(k)) != _ser(v)
    }
    if not changes:
        return
    entry = _entry(ip, ChangeAction.UPDATE, changes,
                   user if getattr(user, "pk", None) else None, current_request_id())
    if not entry.user_name:
        entry.user_name = _username(user)
    entry.save()


def _snapshot(ip, fields) -> dict:
    return {f: getattr(ip, f) for f in fields}


_EXCLUDE_FIELDS = (
    "monitoring_excluded", "monitoring_excluded_at", "monitoring_excluded_by",
    "monitoring_excluded_reason",
)


def set_excluded(ip, excluded: bool, user, *, reason: str = "", now=None) -> bool:
    """Exclude the address from monitoring, or include it again. Idempotent;
    returns whether anything changed. The address row is locked for the
    duration, which is the lock a manual "Check now" takes before it writes."""
    from api.models import IPAddress

    from .models import CheckState

    now = now or timezone.now()
    reason = (reason or "").strip()[:NOTE_MAX]
    by = _username(user)
    with transaction.atomic():
        locked = IPAddress.objects.select_for_update(of=("self",)).get(pk=ip.pk)
        if locked.monitoring_excluded == bool(excluded):
            return False
        old = _snapshot(locked, _EXCLUDE_FIELDS)
        if excluded:
            new = {
                "monitoring_excluded": True, "monitoring_excluded_at": now,
                "monitoring_excluded_by": by, "monitoring_excluded_reason": reason,
            }
        else:
            # Cleared rather than kept: the note describes the exclusion in
            # force; the change log keeps every one there was.
            new = {
                "monitoring_excluded": False, "monitoring_excluded_at": None,
                "monitoring_excluded_by": "", "monitoring_excluded_reason": "",
            }
        IPAddress.objects.filter(pk=ip.pk).update(**new, updated_at=now)
        for k, v in new.items():
            setattr(ip, k, v)
            setattr(locked, k, v)
        # Including stores no reason of its own; the change log carries it.
        extra = {"reason": reason} if reason and not excluded else {}
        log_change(locked, old, {**new, **extra}, user)
        text = "Excluded from monitoring." if excluded else "Included in monitoring."
        if reason:
            text += f" Reason: {reason}"
        _journal(locked, user, text)

        states = list(
            CheckState.objects.select_for_update(of=("self",))
            .filter(target_ip_id=ip.pk).select_related("template", "assignment")
            .order_by("id")
        )
        if excluded:
            transitions, alerts = park(states, now, by=by, note=reason)
        else:
            transitions, alerts = [], []
            _arm(states, now, ip.tenant_id)
        transaction.on_commit(
            lambda: announce(states, transitions, alerts, excluded=bool(excluded))
        )
    return True


def _arm(states, now, tenant_id) -> None:
    """Back on: due now, unless the check's own schedule has it off. The
    counters start over - the run before the exclusion says nothing about
    the host that answers now."""
    from .models import CheckState
    from .worker import _cfg, _load_settings, effective_interval

    if not states:
        return
    cfg = _cfg(_load_settings({tenant_id}), tenant_id)
    for s in states:
        s.next_run = now if effective_interval(s, cfg) else None
        s.in_flight = False
        s.in_flight_since = None
        s.consecutive_success = 0
        s.consecutive_fail = 0
    CheckState.objects.bulk_update(
        states,
        ["next_run", "in_flight", "in_flight_since", "consecutive_success", "consecutive_fail"],
        batch_size=2000,
    )
