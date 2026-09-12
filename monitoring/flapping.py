"""Flapping as a state (M22, and the alert-side dampening of A5).

A check that keeps bouncing - into a bad status ``flap_threshold`` times
inside ``flap_window_minutes`` - is **flapping**, and that is now something a
``CheckState`` *is*, not a list somebody has to ask for. The sweep here sets
it; the badge on every list, the IP summary and the device page read it;
``Alert.flapping`` mirrors it so a flapping host cannot page on a loop.

Sticky by default. "It stopped bouncing" and "it is fine" are different
claims, and the second is the operator's to make: **Confirm not flapping**
clears the state, records who said so, and only bad transitions *after* that
moment count towards flagging it again - so a confirmation means something,
and the flag re-arms only on new evidence. A tenant that would rather not
be asked turns on ``auto_clear_flapping``, and a state then clears itself
once the check has been quiet for ``auto_clear_flapping_after_minutes``.

Exclusions keep expected churn out: addresses whose status is in
``flap_exclude_ip_statuses`` (a DHCP scope) and addresses flagged
``IPAddress.flap_exclude`` are never flagged, and are cleared if they were.
"""
from __future__ import annotations

from datetime import timedelta

from django.db.models import Max, Q
from django.utils import timezone

# A "flap" = a transition *into* a bad status. Repeated bad transitions in a
# short window is the bounce signal (down → up → down …).
_BAD = ("down", "degraded", "stale")


def _bad_transitions(tenant_id, since):
    """``{(ip_id, template_id): [at, ...]}`` for every bad transition in the
    window, newest first - one query per tenant, aggregated in Python because
    each state has its own cut-off (when it was last confirmed)."""
    from .models import StateTransition

    out: dict = {}
    rows = (
        StateTransition.objects.filter(tenant_id=tenant_id, at__gte=since, to_status__in=_BAD)
        .order_by("-at")
        .values_list("target_ip_id", "template_id", "at")
    )
    for ip_id, template_id, at in rows:
        out.setdefault((ip_id, template_id), []).append(at)
    return out


def _excluded_ip_ids(ms, ip_ids) -> set:
    from api.models import IPAddress

    status_ids = set(ms.flap_exclude_ip_statuses.values_list("id", flat=True))
    out = set()
    for ip_id, excl, status_id in IPAddress.objects.filter(id__in=ip_ids).values_list(
        "id", "flap_exclude", "status_id"
    ):
        if excl or (status_id and status_id in status_ids):
            out.add(ip_id)
    return out


def sweep_flapping(now=None) -> dict:
    """Flag and clear, every tenant with detection on. Returns counts."""
    from .models import Alert, AlertStatus, CheckState, MonitoringSettings

    now = now or timezone.now()
    flagged = cleared = flapping = 0
    for ms in MonitoringSettings.objects.filter(flap_threshold__gt=0).select_related("tenant"):
        since = now - timedelta(minutes=max(ms.flap_window_minutes, 1))
        settle = timedelta(minutes=max(ms.auto_clear_flapping_after_minutes, 1))
        bad = _bad_transitions(ms.tenant_id, since)

        # Every state that might change: the ones with bad transitions in the
        # window, and the ones already flagged (which may need clearing).
        candidates = list(
            CheckState.objects.filter(tenant_id=ms.tenant_id).filter(
                Q(flapping_since__isnull=False)
                | Q(target_ip_id__in={k[0] for k in bad})
            )
        )
        excluded = _excluded_ip_ids(ms, {s.target_ip_id for s in candidates})
        changed_pairs: dict = {}
        for state in candidates:
            ats = bad.get((state.target_ip_id, state.template_id), [])
            # Only evidence newer than the last confirmation counts.
            if state.flap_cleared_at is not None:
                ats = [a for a in ats if a > state.flap_cleared_at]
            count = len(ats)
            was = state.flapping_since is not None
            if state.target_ip_id in excluded:
                if was:
                    _clear(state, now, None)
                    changed_pairs[(state.target_ip_id, state.template_id)] = False
                    cleared += 1
                continue
            if not was and count >= ms.flap_threshold:
                state.flapping_since = now
                state.flap_count = count
                state.save(update_fields=["flapping_since", "flap_count"])
                changed_pairs[(state.target_ip_id, state.template_id)] = True
                flagged += 1
                flapping += 1
            elif was:
                if (
                    ms.auto_clear_flapping
                    and count < ms.flap_threshold
                    and (not ats or now - ats[0] >= settle)
                ):
                    _clear(state, now, None)
                    changed_pairs[(state.target_ip_id, state.template_id)] = False
                    cleared += 1
                else:
                    flapping += 1
                    if state.flap_count != count:
                        state.flap_count = count
                        state.save(update_fields=["flap_count"])
        _mirror(ms.tenant_id, changed_pairs, Alert, AlertStatus)
    return {"flagged": flagged, "cleared": cleared, "flapping": flapping}


def _clear(state, now, user) -> None:
    state.flapping_since = None
    state.flap_count = 0
    state.flap_cleared_at = now
    state.flap_cleared_by = user
    state.save(update_fields=["flapping_since", "flap_count", "flap_cleared_at", "flap_cleared_by"])


def _mirror(tenant_id, pairs: dict, Alert=None, AlertStatus=None) -> None:
    """``Alert.flapping`` follows the state for the pairs that changed."""
    if not pairs:
        return
    if Alert is None:
        from .models import Alert, AlertStatus
    for (ip_id, template_id), value in pairs.items():
        Alert.objects.filter(
            tenant_id=tenant_id, status=AlertStatus.FIRING,
            target_ip_id=ip_id, template_id=template_id,
        ).exclude(flapping=value).update(flapping=value)


def clear_flapping(states, user, now=None) -> int:
    """An operator's "not flapping": clear each state, remember who and when,
    mirror the alerts, write one change-log entry per address. Returns how
    many were actually flapping."""
    from audit.bulk import _entry
    from audit.context import current_request_id
    from audit.models import ChangeAction, ChangeLogEntry

    from .signals import flapping_cleared

    now = now or timezone.now()
    states = [s for s in states if s.flapping_since is not None]
    if not states:
        return 0
    pairs: dict = {}
    by_ip: dict = {}
    for state in states:
        pairs.setdefault(state.tenant_id, {})[(state.target_ip_id, state.template_id)] = False
        by_ip.setdefault(state.target_ip_id, []).append(state)
        _clear(state, now, user)
    for tenant_id, changed in pairs.items():
        _mirror(tenant_id, changed)
    rid = current_request_id()
    entries = []
    for ip_states in by_ip.values():
        ip = ip_states[0].target_ip
        entries.append(_entry(
            ip, ChangeAction.UPDATE,
            {"flapping": {
                "old": True, "new": False,
                "checks": [s.template.name if s.template_id else s.kind for s in ip_states],
            }},
            user, rid,
        ))
    ChangeLogEntry.objects.bulk_create(entries)
    flapping_cleared.send(sender=None, states=states, user=user)
    return len(states)


def flapping_ips(tenant, now=None, limit: int = 50, viewable_ips=None) -> list[dict]:
    """The tenant's flapping (IP, check) pairs, noisiest first - the persisted
    state, in the shape the card and the dashboard have always read.

    ``viewable_ips`` (an ``IPAddress`` queryset) restricts the result to the
    caller's site-scoped view; ``None`` means unrestricted (superuser / unscoped
    grant). The caller must handle "no view grant at all" before calling."""
    from .models import CheckState, MonitoringSettings, StateTransition

    ms = MonitoringSettings.for_tenant(tenant)
    if not ms.flap_threshold:  # 0 = flap detection disabled
        return []
    states = CheckState.objects.filter(tenant=tenant, flapping_since__isnull=False)
    if viewable_ips is not None:
        states = states.filter(target_ip__in=viewable_ips)
    states = list(
        states.select_related("target_ip", "template")
        .order_by("-flap_count", "-flapping_since")[:limit]
    )
    if not states:
        return []
    last = {
        (r["target_ip_id"], r["template_id"]): r["last_at"]
        for r in StateTransition.objects.filter(
            tenant=tenant, to_status__in=_BAD,
            target_ip_id__in={s.target_ip_id for s in states},
        )
        .values("target_ip_id", "template_id")
        .annotate(last_at=Max("at"))
    }
    return [
        {
            "state_id": str(s.id),
            "ip_id": str(s.target_ip_id),
            "ip_address": s.target_ip.ip_address,
            "dns_name": s.target_ip.dns_name or None,
            "template_id": str(s.template_id) if s.template_id else None,
            "template_name": s.template.name if s.template_id else None,
            "kind": s.kind,
            "flap_count": s.flap_count,
            "window_minutes": ms.flap_window_minutes,
            "flapping_since": s.flapping_since,
            "last_at": last.get((s.target_ip_id, s.template_id)) or s.flapping_since,
        }
        for s in states
    ]
