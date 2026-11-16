"""Root-cause alerting (#450): a device behind a down upstream is explained.

The alert pipeline asks this module two things.

:func:`prepare`, from ``process_transitions`` before any alert is opened,
classifies the batch's failing devices against the tenant's dependency
graph (:mod:`api.dependencies`):

* **explained** - a down upstream accounts for the device (every member of
  one of its redundancy groups is down, or at outage behind something
  down). The alert is kept but never announced on its own; it points at
  the :class:`~monitoring.models.RootCauseIncident` of its root, the
  topmost down device that is not itself explained.
* **held** - the device has upstreams and one of them is failing or not
  recently confirmed up (or the hold mode is ``always``): the alert waits
  ``root_cause_hold_seconds`` while those upstreams are checked again.
* **sent** - anything else, exactly as before this existed.

:func:`release_due`, at the end of a batch (at most every few seconds per
tenant) and from the minute alert-maintenance beat, settles what is due:
held alerts are classified again and sent or explained, an incident's
"opened" message goes out once its burst has been counted, a root that has
stayed up through the hold resolves its incident with one recovery message
and releases whatever is still down, a root that becomes explained merges
into its new root's incident, and explained alerts without a live incident
are released.

The rule throughout: fail open, never later than necessary, never lose a
message. Any error sends; a tenant without dependency rows, or with the
switch off, takes the path it took before, without a database query.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.db.models import Count, F
from django.utils import timezone

log = logging.getLogger("monitoring.root_cause")

SENT, HELD, EXPLAINED, WITHHELD = "sent", "held", "explained", "withheld"

_DOWN = {"down", "stale"}
_UP = {"up", "degraded"}
_IGNORED = {"unknown", "skipped"}

#: An upstream is checked again at most this often because of a hold.
POKE_SPACING = 60
#: ``release_due`` runs at most this often per tenant from the batch path.
RELEASE_SPACING = 5


# ─── device health ──────────────────────────────────────────────────────────

@dataclass
class Health:
    """What a device's deciding checks say. ``monitored`` - at least one
    deciding check has a verdict; ``down`` - one says down or stale and none
    says up or degraded; ``suspect`` - not down, but a check is failing
    (inside its ``fall``); ``verified`` - not down or suspect, and a check
    said up with no failure within the hold."""

    monitored: bool = False
    down: bool = False
    suspect: bool = False
    verified: bool = False


def device_health(tenant_id, device_ids, now, recent_seconds: int) -> dict:
    """``{device id (str): Health}``. A device is decided by its primary IP,
    or by every IP assigned to it when it has none. Unknown and skipped
    states are ignored, so an unmonitored or unreachable-by-us upstream is
    never down."""
    from api.models import Device, IPAddress

    from .models import CheckState

    ids = {str(d) for d in device_ids}
    if not ids:
        return {}
    primary = {
        str(pk): ip for pk, ip in Device.objects.filter(
            tenant_id=tenant_id, pk__in=ids
        ).values_list("pk", "primary_ip_id")
    }
    owner: dict = {str(ip): dev for dev, ip in primary.items() if ip}
    bare = [dev for dev, ip in primary.items() if not ip]
    if bare:
        for ip, dev in IPAddress.objects.filter(
            tenant_id=tenant_id, assigned_device_id__in=bare
        ).values_list("pk", "assigned_device_id"):
            owner[str(ip)] = str(dev)
    states: dict = {dev: [] for dev in primary}
    if owner:
        for ip, status, fails, checked in CheckState.objects.filter(
            tenant_id=tenant_id, target_ip_id__in=list(owner)
        ).values_list("target_ip_id", "status", "consecutive_fail", "last_checked"):
            states[owner[str(ip)]].append((status, fails or 0, checked))
    recent = now - timedelta(seconds=max(recent_seconds, 0))
    out = {}
    for dev, rows in states.items():
        h = Health()
        live = [r for r in rows if r[0] not in _IGNORED]
        h.monitored = bool(live)
        bad = any(s in _DOWN for s, _f, _c in live)
        good = any(s in _UP for s, _f, _c in live)
        h.down = bad and not good
        if not h.down:
            h.suspect = any(f > 0 for s, f, _c in rows if s != "skipped")
            h.verified = not h.suspect and any(
                s == "up" and f == 0 and c is not None and c >= recent
                for s, f, c in live
            )
        out[dev] = h
    return out


# ─── classification ─────────────────────────────────────────────────────────

@dataclass
class Verdict:
    state: str = SENT
    #: The root device (str id) of an explained device; the others it hangs
    #: off go in ``also``.
    root: str | None = None
    also: list = field(default_factory=list)
    #: Upstreams worth checking again now (held devices only).
    poke: set = field(default_factory=set)


def _settings(tenant_id):
    from .models import MonitoringSettings

    ms = MonitoringSettings.objects.filter(tenant_id=tenant_id).first()
    # A tenant without a settings row runs on the model defaults.
    return ms or MonitoringSettings(tenant_id=tenant_id)


class Classifier:
    """One tenant's graph and health, read once, answering for many
    devices."""

    def __init__(self, tenant_id, graph, ms, now):
        self.tenant_id = tenant_id
        self.graph = graph
        self.hold = int(ms.root_cause_hold_seconds or 0)
        self.always = ms.root_cause_hold_mode == "always"
        self.now = now
        self.health: dict = {}

    def run(self, device_ids, *, allow_hold: bool = True, extra=()) -> dict:
        """``{device id: Verdict}`` for those of ``device_ids`` in the graph.
        ``extra`` devices get their health read too (incident roots)."""
        from api.dependencies import OUTAGE, ancestors, walk

        g = self.graph
        devs = {str(d) for d in device_ids if d}
        devs = {d for d in devs if d in g.up or d in g.down}
        with_up = {d for d in devs if g.up.get(d)}
        anc_all = ancestors(g, with_up) if with_up else {}
        need = set(anc_all) | devs | {str(e) for e in extra}
        self.health = device_health(self.tenant_id, need, self.now, self.hold)
        down = {d for d, h in self.health.items() if h.down}
        closure = set(down)
        if down:
            closure |= {d for d, lvl in walk(g, down).levels.items() if lvl == OUTAGE}

        def explained(x) -> bool:
            return any(m <= closure for m in g.up.get(x, {}).values())

        out = {}
        for x in devs:
            v = Verdict()
            out[x] = v
            if x not in with_up:
                continue  # nothing above it: a root, or alone
            mine = ancestors(g, [x])
            if explained(x):
                roots = [a for a in mine if a in down and not explained(a)]
                if not roots:
                    log.warning("root cause: %s explained without a root; sent", x)
                    continue
                roots.sort(key=lambda a: (-mine[a], a))
                v.state, v.root, v.also = EXPLAINED, roots[0], roots[1:]
                continue
            if not allow_hold or self.hold <= 0:
                continue
            watched = [a for a in mine
                       if self.health.get(a, Health()).monitored
                       and not self.health[a].down]
            shaky = {a for a in watched
                     if self.health[a].suspect or not self.health[a].verified}
            if self.always or shaky:
                v.state, v.poke = HELD, shaky
        return out


# ─── incidents ──────────────────────────────────────────────────────────────

def incident_for(tenant_id, root_id, now, hold: int):
    """The live incident of ``root_id``, opened when there is none. A
    recovering one reopens silently - the root went down again."""
    from .models import RootCauseIncident as RCI

    live = [RCI.OPEN, RCI.RECOVERING]
    inc = RCI.objects.filter(tenant_id=tenant_id, device_id=root_id, status__in=live).first()
    if inc is None:
        try:
            with transaction.atomic():
                inc = RCI.objects.create(
                    tenant_id=tenant_id, device_id=root_id, opened_at=now,
                    announce_at=now + timedelta(seconds=max(hold, 0)),
                )
        except IntegrityError:  # a parallel batch opened it
            inc = RCI.objects.filter(
                tenant_id=tenant_id, device_id=root_id, status__in=live
            ).first()
    elif inc.status == RCI.RECOVERING:
        RCI.objects.filter(pk=inc.pk, status=RCI.RECOVERING).update(
            status=RCI.OPEN, recovering_since=None
        )
        inc.status, inc.recovering_since = RCI.OPEN, None
    return inc


def poke_upstreams(tenant_id, device_ids, now) -> int:
    """Run the deciding checks of ``device_ids`` on the next dispatch, at
    most once per device per :data:`POKE_SPACING`. Local engine only: an
    Outpost or an external monitor answers on its own schedule."""
    from django.db.models import Q

    from api.models import Device, IPAddress

    from .models import CheckState, MonitoringEngine

    fresh = [d for d in device_ids
             if cache.add(f"rootcause:poke:{tenant_id}:{d}", 1, POKE_SPACING)]
    if not fresh:
        return 0
    primary = dict(Device.objects.filter(tenant_id=tenant_id, pk__in=fresh)
                   .values_list("pk", "primary_ip_id"))
    ips = [ip for ip in primary.values() if ip]
    bare = [d for d, ip in primary.items() if not ip]
    if bare:
        ips += list(IPAddress.objects.filter(
            tenant_id=tenant_id, assigned_device_id__in=bare
        ).values_list("pk", flat=True))
    if not ips:
        return 0
    return CheckState.objects.filter(
        tenant_id=tenant_id, target_ip_id__in=ips, in_flight=False,
        next_run__gt=now, fast_owned=False,
    ).filter(
        Q(engine__isnull=True) | Q(engine__kind=MonitoringEngine.LOCAL)
    ).update(next_run=now)


# ─── the batch path ─────────────────────────────────────────────────────────

@dataclass
class Plan:
    """What :func:`prepare` decided: ``decisions[(tenant id, ip id)]`` for
    every non-sent alert to open, and the tenants with a graph, which get a
    :func:`release_due` after the batch."""

    decisions: dict = field(default_factory=dict)
    tenants: set = field(default_factory=set)

    def get(self, tr):
        return self.decisions.get((tr.tenant_id, tr.target_ip_id))


@dataclass
class Decision:
    state: str
    notify_after: object = None
    incident: object = None
    also: list = field(default_factory=list)

    def fields(self) -> dict:
        """The create defaults that differ from a sent alert. A non-sent
        alert has never been notified: renotify reads ``last_notified_at``
        None as "due", so it is skipped there by its state instead."""
        out = {
            "notify_state": self.state,
            "notify_after": self.notify_after,
            "last_notified_at": None,
            "notify_count": 0,
        }
        if self.incident is not None:
            out["root_cause"] = self.incident
        return out


def prepare(bad, clears, ip_map, now) -> Plan:
    """Classify the batch's failing devices. Never raises: on any error the
    plan is empty and every alert is sent, as before."""
    from api.dependencies import load_graph

    plan = Plan()
    try:
        tenants = {tr.tenant_id for tr in bad} | {tr.tenant_id for tr in clears}
        for tid in tenants:
            graph = load_graph(tid)
            if not graph:
                continue
            plan.tenants.add(tid)
            trs = [tr for tr in bad if tr.tenant_id == tid]
            dev_of = {}
            for tr in trs:
                ip = ip_map.get(tr.target_ip_id)
                dev = getattr(ip, "assigned_device_id", None)
                if dev is not None:
                    dev_of[tr.target_ip_id] = str(dev)
            devs = {d for d in dev_of.values() if d in graph.up or d in graph.down}
            if not devs:
                continue
            ms = _settings(tid)
            if not ms.root_cause_enabled:
                continue
            clf = Classifier(tid, graph, ms, now)
            verdicts = clf.run(devs)
            incidents: dict = {}
            poke: set = set()
            decided: dict = {}
            for dev, v in verdicts.items():
                if v.state == EXPLAINED:
                    if v.root not in incidents:
                        incidents[v.root] = incident_for(tid, v.root, now, clf.hold)
                    decided[dev] = Decision(EXPLAINED, incident=incidents[v.root],
                                            also=v.also)
                elif v.state == HELD:
                    decided[dev] = Decision(
                        HELD, notify_after=now + timedelta(seconds=clf.hold))
                    poke |= v.poke
            for tr in trs:
                d = decided.get(dev_of.get(tr.target_ip_id))
                if d is not None:
                    plan.decisions[(tid, tr.target_ip_id)] = d
            if poke:
                try:
                    poke_upstreams(tid, poke, now)
                except Exception:  # noqa: BLE001 - a poke is only a hurry-up
                    log.exception("root cause: poking upstreams failed")
    except Exception:  # noqa: BLE001 - fail open: everything is sent
        log.exception("root cause classification failed; sending as usual")
        plan.decisions.clear()
    return plan


def after_batch(plan: Plan, now) -> None:
    """The batch's :func:`release_due`, throttled per tenant. Never raises."""
    if not plan.tenants:
        return
    try:
        release_due(plan.tenants, now, throttle=True)
    except Exception:  # noqa: BLE001 - the minute sweep tries again
        log.exception("root cause release after batch failed")


# ─── the release sweep ──────────────────────────────────────────────────────

def _dev(alert):
    ip = getattr(alert, "target_ip", None)
    dev = getattr(ip, "assigned_device_id", None)
    return str(dev) if dev else None


def release_due(tenant_ids=None, now=None, *, throttle: bool = False) -> dict:
    """Settle what is due for ``tenant_ids`` (every tenant with held or
    explained alerts or a live incident when None). Per tenant, errors are
    logged and the next sweep tries again."""
    from .models import Alert, AlertStatus
    from .models import RootCauseIncident as RCI

    now = now or timezone.now()
    if tenant_ids is None:
        tenant_ids = set(
            Alert.objects.filter(status=AlertStatus.FIRING, notify_state__in=[HELD, EXPLAINED])
            .values_list("tenant_id", flat=True).distinct()
        ) | set(
            RCI.objects.filter(status__in=[RCI.OPEN, RCI.RECOVERING])
            .values_list("tenant_id", flat=True).distinct()
        )
    totals = {"released": 0, "explained": 0, "announced": 0, "resolved": 0,
              "merged": 0, "attached": 0}
    for tid in tenant_ids:
        if throttle and not cache.add(f"rootcause:release:{tid}", 1, RELEASE_SPACING):
            continue
        try:
            for k, n in _release_tenant(tid, now).items():
                totals[k] += n
        except Exception:  # noqa: BLE001
            log.exception("root cause release failed for tenant %s", tid)
    return totals


def _release_tenant(tid, now) -> dict:
    from api.dependencies import load_graph

    from .models import Alert, AlertStatus
    from .models import RootCauseIncident as RCI

    out = {"released": 0, "explained": 0, "announced": 0, "resolved": 0,
           "merged": 0, "attached": 0}
    firing = Alert.objects.filter(tenant_id=tid, status=AlertStatus.FIRING)
    related = ("target_ip", "template", "root_cause")
    due = list(firing.filter(notify_state=HELD, notify_after__lte=now).select_related(*related))
    explained = list(firing.filter(notify_state=EXPLAINED).select_related(*related))
    incidents = list(RCI.objects.filter(tenant_id=tid, status__in=[RCI.OPEN, RCI.RECOVERING])
                     .select_related("device"))
    graph = load_graph(tid)
    ms = _settings(tid) if (graph or due or explained or incidents) else None
    enabled = bool(ms is not None and ms.root_cause_enabled and graph)
    # Late upstream: alerts that went out before an upstream was seen down.
    # Every sent, unlinked alert of a device with upstreams is a candidate.
    late: list = []
    if enabled:
        late = list(firing.filter(
            notify_state=SENT, root_cause__isnull=True,
            target_ip__assigned_device_id__in=list(graph.up),
        ).select_related(*related))
    if not (due or explained or incidents or late):
        return out

    clf = Classifier(tid, graph, ms, now)
    roots = {str(i.device_id) for i in incidents}
    devs = {_dev(a) for a in due + explained + late} | roots
    devs.discard(None)
    verdicts = clf.run(devs, allow_hold=False, extra=roots) if enabled else {}
    health = clf.health if enabled else device_health(tid, roots, now, clf.hold)
    known: dict = {str(i.device_id): i for i in incidents}

    def live_incident(root):
        inc = known.get(root)
        if inc is None or inc.status == RCI.RESOLVED:
            inc = incident_for(tid, root, now, clf.hold)
            known[root] = inc
        return inc

    released: list = []

    def release(a, **detail):
        """Send ``a`` as an ordinary alert, if this sweep claims it."""
        fields = dict(notify_state=SENT, notify_after=None, last_notified_at=now,
                      notify_count=F("notify_count") + 1)
        if detail:
            a.detail = {**(a.detail or {}), **detail}
            fields["detail"] = a.detail
        claimed = Alert.objects.filter(pk=a.pk, notify_state=a.notify_state).update(**fields)
        if claimed:
            a.notify_state = SENT
            out["released"] += 1
            if not a.flapping:
                released.append(a)

    def explain(a, root):
        inc = live_incident(root)
        claimed = Alert.objects.filter(pk=a.pk, notify_state=a.notify_state).update(
            notify_state=EXPLAINED, notify_after=None, root_cause=inc)
        if claimed:
            a.notify_state, a.root_cause = EXPLAINED, inc
            out["explained"] += 1

    # 1. held alerts that are due
    for a in due:
        v = verdicts.get(_dev(a))
        if v is not None and v.state == EXPLAINED:
            explain(a, v.root)
        else:
            release(a)

    # 2. late upstream: already sent, now explained - annotated, no message
    for a in late:
        v = verdicts.get(_dev(a))
        if v is None or v.state != EXPLAINED:
            continue
        inc = live_incident(v.root)
        if Alert.objects.filter(pk=a.pk, root_cause__isnull=True).update(root_cause=inc):
            out["attached"] += 1

    # 3. incidents: merge, recover, reopen, resolve, announce
    for inc in incidents:
        root = str(inc.device_id)
        v = verdicts.get(root)
        if v is not None and v.state == EXPLAINED and v.root != root:
            target = live_incident(v.root)
            if RCI.objects.filter(pk=inc.pk, status__in=[RCI.OPEN, RCI.RECOVERING]).update(
                status=RCI.RESOLVED, resolved_at=now, merged_into=target,
            ):
                Alert.objects.filter(root_cause=inc, status=AlertStatus.FIRING).update(
                    root_cause=target)
                inc.status = RCI.RESOLVED
                out["merged"] += 1
            continue
        is_down = health.get(root, Health()).down
        if inc.status == RCI.OPEN and not is_down:
            RCI.objects.filter(pk=inc.pk, status=RCI.OPEN).update(
                status=RCI.RECOVERING, recovering_since=now)
            inc.status, inc.recovering_since = RCI.RECOVERING, now
        elif inc.status == RCI.RECOVERING and is_down:
            RCI.objects.filter(pk=inc.pk, status=RCI.RECOVERING).update(
                status=RCI.OPEN, recovering_since=None)
            inc.status, inc.recovering_since = RCI.OPEN, None
        if (inc.status == RCI.RECOVERING
                and now - inc.recovering_since >= timedelta(seconds=clf.hold)):
            if _resolve(inc, now, verdicts, explained, live_incident, release, out):
                continue
        if (inc.status == RCI.OPEN and inc.announced_at is None
                and inc.announce_at is not None and inc.announce_at <= now):
            if RCI.objects.filter(pk=inc.pk, announced_at__isnull=True).update(announced_at=now):
                inc.announced_at = now
                _refresh_counts(inc, graph)
                _announce(inc, "opened")
                out["announced"] += 1

    # 4. explained alerts whose incident is gone or over: re-parent or send
    for a in explained:
        if a.notify_state != EXPLAINED:
            continue
        rc = a.root_cause
        if rc is not None and rc.status != RCI.RESOLVED:
            continue
        if rc is not None and rc.merged_into_id:
            Alert.objects.filter(pk=a.pk, root_cause=rc).update(root_cause_id=rc.merged_into_id)
            continue
        v = verdicts.get(_dev(a))
        if v is not None and v.state == EXPLAINED:
            explain(a, v.root)
        else:
            release(a)

    # Counts for the Root causes tab, every sweep.
    for inc in known.values():
        if inc.status != RCI.RESOLVED:
            _refresh_counts(inc, graph)

    if released:
        from .alerts import _dispatch_notifications

        _dispatch_notifications({tid: released}, [])
    return out


def _resolve(inc, now, verdicts, explained, live_incident, release, out) -> bool:
    """The root stayed up through the hold: resolve, hand the alerts it
    still explains to another root or send them, and announce the
    recovery. False when another sweep got there first."""
    from .models import Alert, AlertStatus
    from .models import RootCauseIncident as RCI

    if not RCI.objects.filter(pk=inc.pk, status=RCI.RECOVERING).update(
        status=RCI.RESOLVED, resolved_at=now,
    ):
        return False
    inc.status, inc.resolved_at = RCI.RESOLVED, now
    out["resolved"] += 1
    mine = [a for a in explained if a.root_cause_id == inc.pk and a.notify_state == EXPLAINED]
    for a in mine:
        v = verdicts.get(_dev(a))
        if v is not None and v.state == EXPLAINED and v.root != str(inc.device_id):
            target = live_incident(v.root)
            Alert.objects.filter(pk=a.pk, root_cause=inc).update(root_cause=target)
            a.root_cause = target
            continue
        release(a, still_down_after=inc.device.name)
    # Released alerts keep pointing here: they are the "still down".
    rows = Alert.objects.filter(root_cause=inc).exclude(
        target_ip__assigned_device_id=inc.device_id)
    total = rows.values("target_ip__assigned_device_id").distinct().count()
    still = (rows.filter(status=AlertStatus.FIRING)
             .values("target_ip__assigned_device_id").distinct().count())
    inc.detail = {**(inc.detail or {}), "recovered": max(total - still, 0),
                  "total": total, "still_down": still}
    RCI.objects.filter(pk=inc.pk).update(detail=inc.detail)
    if inc.announced_at is not None and not (inc.detail or {}).get("silenced"):
        RCI.objects.filter(pk=inc.pk).update(recovery_announced_at=now)
        inc.recovery_announced_at = now
        _announce(inc, "resolved")
    return True


def _refresh_counts(inc, graph) -> None:
    """``explained_count`` (devices explained), ``already_alerted_count``
    (devices whose alert had gone out before the root was known) and
    ``reduced_count`` (devices the root leaves with part of a group)."""
    from api.dependencies import REDUCED, walk

    from .models import Alert
    from .models import RootCauseIncident as RCI

    rows = (
        Alert.objects.filter(root_cause=inc)
        .exclude(target_ip__assigned_device_id=inc.device_id)
        .values("notify_state")
        .annotate(n=Count("target_ip__assigned_device_id", distinct=True))
    )
    by = {r["notify_state"]: r["n"] for r in rows}
    explained = by.get(EXPLAINED, 0)
    already = by.get(SENT, 0)
    reduced = 0
    if graph:
        levels = walk(graph, [str(inc.device_id)]).levels
        reduced = sum(1 for lvl in levels.values() if lvl == REDUCED)
    if (explained, already, reduced) != (
        inc.explained_count, inc.already_alerted_count, inc.reduced_count
    ):
        RCI.objects.filter(pk=inc.pk).update(
            explained_count=explained, already_alerted_count=already, reduced_count=reduced)
        inc.explained_count, inc.already_alerted_count, inc.reduced_count = (
            explained, already, reduced)


def _announce(inc, event: str) -> None:
    """One root-cause message, unless a silence covers the root. Never
    raises."""
    from .models import RootCauseIncident as RCI
    from .notify import notify_root_cause, root_silenced

    try:
        if event == "opened" and root_silenced(inc):
            inc.detail = {**(inc.detail or {}), "silenced": True}
            RCI.objects.filter(pk=inc.pk).update(detail=inc.detail)
            return
        notify_root_cause(inc, event)
    except Exception:  # noqa: BLE001 - a delivery error is not a state error
        log.exception("root cause %s notice for %s failed", event, inc.pk)


def announced(alert) -> bool:
    """Whether ``alert`` went out on its own - the ones a closing notice may
    follow. Held, explained and withheld alerts never did."""
    return getattr(alert, "notify_state", SENT) == SENT


def slow_upstreams(tenant, device_ids) -> tuple[int | None, dict]:
    """``(hold seconds, {device id: seconds})`` - the devices of
    ``device_ids`` whose fastest deciding check runs less often than the
    root-cause hold, so a dependent's alert usually goes out before they
    are seen down. ``(None, {})`` with the switch off or no hold."""
    from api.models import Device, IPAddress

    from .models import CheckState
    from .worker import _cfg, _load_settings, effective_interval

    ms = _settings(tenant.id)
    hold = int(ms.root_cause_hold_seconds or 0)
    if not ms.root_cause_enabled or hold <= 0 or not device_ids:
        return None, {}
    primary = {str(pk): ip for pk, ip in Device.objects.filter(
        tenant=tenant, pk__in=list(device_ids)).values_list("pk", "primary_ip_id")}
    owner = {ip: dev for dev, ip in primary.items() if ip}
    bare = [dev for dev, ip in primary.items() if not ip]
    if bare:
        for ip, dev in IPAddress.objects.filter(
            tenant=tenant, assigned_device_id__in=bare
        ).values_list("pk", "assigned_device_id"):
            owner[ip] = str(dev)
    cfg = _cfg(_load_settings([tenant.id]), tenant.id)
    fastest: dict = {}
    for st in CheckState.objects.filter(
        tenant=tenant, target_ip_id__in=list(owner)
    ).exclude(status="skipped").select_related("assignment", "template"):
        if st.interval_ms and st.fast_owned:
            secs = st.interval_ms / 1000
        else:
            secs = effective_interval(st, cfg)
        if secs is None:
            continue
        dev = owner[st.target_ip_id]
        fastest[dev] = min(fastest.get(dev, secs), secs)
    return hold, {dev: int(s) for dev, s in fastest.items() if s > hold}
