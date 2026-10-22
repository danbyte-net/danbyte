"""Bulk SNMP actions from the SNMP drift page (#419).

Poll, Refresh MACs and Sync from SNMP for many devices at once, mounted under
``/api/monitoring/snmp-drift/``:

* ``POST bulk-poll/``, ``POST bulk-mac-refresh/``, ``POST bulk-sync/`` - body
  ``{"devices": [id, ...]}``, at most :data:`MAX_DEVICES`. Answers 202 with a
  run id, or 200 with ``run_id: null`` when nothing was left to queue.
* ``GET bulk-runs/<run_id>/`` - the run's progress, for the user who started it.

Each is the per-device action, run in the background:

* the request keeps only the devices the caller may **change** (row and site
  scoped, as the per-device endpoints); the rest are counted as ``skipped``
  and never named, so a hidden device leaks nothing;
* Poll and Refresh MACs poll a stack once, through its owner, and a device an
  Outpost polls is not polled here: its Outpost is asked for a pass, once per
  Outpost, as Poll now does (#325);
* the RQ job reloads every device by id *and* tenant and re-checks
  ``device.change`` for the user, so a grant revoked or a device moved after
  the click stops it;
* Poll and Refresh MACs share the Refresh MACs single-flight key, so a device
  already being read is counted ``busy`` rather than read twice;
* Sync writes the source of truth under the caller's name: the job sets the
  audit context, so the change log reads as if they had pressed Sync on each
  device, all under one request id (the run id).

Progress lives in a Redis hash for :data:`RUN_TTL`; the page follows it.
"""
from __future__ import annotations

import logging
import re
import uuid

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import Device
from api.views import _get_active_tenant
from auth_api import rbac

log = logging.getLogger("monitoring.snmp_bulk")

POLL, MACS, SYNC = "poll", "macs", "sync"
ACTIONS = (POLL, MACS, SYNC)

#: Devices one request may name. A fleet larger than this goes in batches.
MAX_DEVICES = 5000
#: Devices per RQ job. Poll and Refresh MACs talk to the network and may each
#: take the full MAC-read budget, so they run one device per job and spread
#: over the workers; Sync is a database pass and runs in chunks.
CHUNK = {POLL: 1, MACS: 1, SYNC: 25}
#: The RQ timeout of one job: the full MAC read's budget per device for the
#: network actions, a generous minute a device for Sync.
JOB_TIMEOUT = {POLL: 15 * 60, MACS: 15 * 60, SYNC: 25 * 60}
RUN_TTL = 6 * 60 * 60

#: Per-device outcomes counted on the run.
OUTCOMES = ("ok", "unreachable", "failed", "denied", "busy", "outpost")
#: Sync's summary keys, added up over the run.
SYNC_KEYS = ("interfaces_created", "interfaces_updated", "ips_assigned",
             "ips_skipped", "vlans_assigned")

_RUN_ID = re.compile(r"^[0-9a-f]{32}$")


def _conn():
    import django_rq

    return django_rq.get_connection("default")


def _queue():
    import django_rq

    return django_rq.get_queue("default")


def has_worker(queue) -> bool:
    """Whether an RQ worker listens on ``queue``. Without one a run would sit
    at 0 of N for good (#441: the Docker workers had never started), so the
    request says so instead. A Redis error reads as yes: queueing then fails
    and reports that itself."""
    try:
        from rq import Worker

        return Worker.count(queue=queue) > 0
    except Exception:  # noqa: BLE001
        return True


def run_key(run_id) -> str:
    return f"snmp-bulk:run:{run_id}"


def _text(value) -> str:
    return value.decode() if isinstance(value, bytes) else str(value or "")


# ─── selecting the devices ──────────────────────────────────────────────────


def _parse_ids(raw) -> tuple[list[uuid.UUID] | None, str]:
    """``(ids, "")`` - de-duplicated, in order - or ``(None, error)``."""
    if not isinstance(raw, list) or not raw:
        return None, "Name at least one device."
    if len(raw) > MAX_DEVICES:
        return None, f"At most {MAX_DEVICES} devices at a time."
    out, seen = [], set()
    for value in raw:
        try:
            pk = uuid.UUID(str(value))
        except ValueError:
            return None, "Every device must be an id."
        if pk not in seen:
            seen.add(pk)
            out.append(pk)
    return out, ""


def changeable(user, tenant, ids):
    """The named devices ``user`` may change, in the active tenant only."""
    return rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant, pk__in=ids), user, tenant, "device", "change"
    )


def poll_owners(tenant, devices) -> list:
    """One device per stack - its owner, the member Poll now polls - and every
    standalone device, in a fixed handful of queries."""
    from .vc_stack import stacks

    by_vc = stacks({d.virtual_chassis_id for d in devices}, tenant.id)
    out, seen = [], set()
    for d in devices:
        owner = d
        if d.virtual_chassis_id and by_vc.get(d.virtual_chassis_id):
            owner = by_vc[d.virtual_chassis_id][0]
        if owner.pk not in seen:
            seen.add(owner.pk)
            out.append(owner)
    return out


def split_outposts(tenant, devices) -> tuple[list, dict]:
    """``(core, {engine: [device, ...]})`` - the devices the core polls, and
    those an enabled Outpost does, grouped by Outpost."""
    from .engines import engines_for_targets
    from .models import MonitoringEngine
    from .snmp_target import SnmpTarget

    targets = [SnmpTarget.of(d) for d in devices]
    engines = engines_for_targets(tenant, targets)
    core, remote = [], {}
    for t in targets:
        engine = engines.get(t.key)
        if engine is not None and engine.kind == MonitoringEngine.REMOTE and engine.enabled:
            remote.setdefault(engine, []).append(t.obj)
        else:
            core.append(t.obj)
    return core, remote


def _ask_outposts(remote: dict) -> list[dict]:
    """Stamp each Outpost's SNMP request once: the agent pulls work, so it polls
    every device of its own on its next pass (``views._queue_on_outpost``)."""
    out = []
    now = timezone.now()
    for engine, devices in remote.items():
        engine.snmp_requested_at = now
        engine.save(update_fields=["snmp_requested_at"])
        out.append({
            "name": engine.name,
            "devices": len(devices),
            "stale": engine.stale_since is not None,
        })
    return sorted(out, key=lambda e: e["name"].lower())


# ─── the run ────────────────────────────────────────────────────────────────


def start(action, tenant, user, devices, *, via="") -> str:
    """Record the run and queue its jobs. Returns the run id. Raises on a Redis
    failure - there is no sensible inline fallback for a fleet."""
    run_id = uuid.uuid4().hex
    conn = _conn()
    conn.hset(run_key(run_id), mapping={
        "action": action,
        "tenant": str(tenant.pk),
        "owner": str(user.pk),
        "total": len(devices),
        "processed": 0,
        "queued_at": timezone.now().isoformat(),
        **{k: 0 for k in OUTCOMES},
        **({k: 0 for k in SYNC_KEYS} if action == SYNC else {}),
    })
    conn.expire(run_key(run_id), RUN_TTL)
    queue = _queue()
    size = CHUNK[action]
    ids = [str(d.pk) for d in devices]
    for i in range(0, len(ids), size):
        queue.enqueue(
            run_chunk, run_id, action, str(tenant.pk), user.pk, ids[i:i + size], via,
            job_timeout=JOB_TIMEOUT[action],
        )
    return run_id


def _count(run_id, **deltas) -> None:
    try:
        conn = _conn()
        for field, n in deltas.items():
            if n:
                conn.hincrby(run_key(run_id), field, n)
        conn.expire(run_key(run_id), RUN_TTL)
    except Exception as exc:  # noqa: BLE001 - progress is best-effort
        log.warning("bulk SNMP %s: progress not written: %s", run_id, exc)


def _poll_one(action, device, tenant) -> str:
    """Poll now (quick MAC read) or Refresh MACs (the full one) for a device
    the job has already re-checked."""
    from .engines import engine_for_target
    from .mac_jobs import _release, lock_key
    from .models import MonitoringEngine
    from .snmp_poll import poll_target
    from .snmp_target import SnmpTarget

    owner = SnmpTarget.of(device).owner()
    engine = engine_for_target(owner)
    if engine.kind == MonitoringEngine.REMOTE and engine.enabled:
        return "outpost"  # moved to an Outpost since the click
    lock = uuid.uuid4().hex
    try:
        if not _conn().set(lock_key(owner.id), lock, nx=True, ex=JOB_TIMEOUT[MACS]):
            return "busy"
    except Exception as exc:  # noqa: BLE001 - poll anyway
        log.warning("bulk SNMP poll %s: no single-flight lock: %s", owner.id, exc)
        lock = None
    try:
        state, reason = poll_target(
            owner, tenant, mac_mode="quick" if action == POLL else "full"
        )
    finally:
        if lock:
            _release(owner.id, lock)
    if reason is not None:
        return "failed"
    return "ok" if state is not None and state.reachable else "unreachable"


def _sync_one(device, tenant) -> tuple[str, dict]:
    from .snmp_drift import sync_device_from_snmp
    from .vc_stack import stack_state

    state = stack_state(device, tenant)
    if state is None or not state.polled_at or state.reachable is False:
        return "unreachable", {}
    # No outer transaction, as the per-device Sync: the sync recovers from a
    # racing interface insert itself, which an enclosing atomic block would
    # turn into an aborted transaction.
    summary = sync_device_from_snmp(device, tenant)
    return "ok", {k: int(summary.get(k) or 0) for k in SYNC_KEYS}


def run_chunk(run_id, action, tenant_id, user_id, device_ids, via="") -> dict:
    """The RQ job: one action over a few devices. Everything is re-read here.
    Returns the outcome counts, for the worker log."""
    from django.contrib.auth import get_user_model

    from audit.context import clear_context, set_context
    from core.models import Tenant

    tally: dict = {}
    tenant = Tenant.objects.filter(pk=tenant_id, is_active=True).first()
    user = get_user_model().objects.filter(pk=user_id, is_active=True).first()
    devices = {}
    if tenant is not None and user is not None:
        devices = {
            str(d.pk): d
            for d in Device.objects.filter(tenant=tenant, pk__in=device_ids)
        }
    if action == SYNC and user is not None:
        set_context(user, run_id, via)
    try:
        for device_id in device_ids:
            outcome, extra = "failed", {}
            try:
                device = devices.get(str(device_id))
                if device is None:
                    outcome = "denied"  # gone, moved tenant, or the user is
                elif not rbac.can_act_on(user, tenant, "device", "change", device):
                    outcome = "denied"
                elif action == SYNC:
                    outcome, extra = _sync_one(device, tenant)
                else:
                    outcome = _poll_one(action, device, tenant)
            except Exception:  # noqa: BLE001 - one device must not stop the run
                log.exception("bulk SNMP %s of %s failed", action, device_id)
                outcome = "failed"
            finally:
                tally[outcome] = tally.get(outcome, 0) + 1
                _count(run_id, processed=1, **{outcome: 1}, **extra)
    finally:
        if action == SYNC:
            clear_context()
    return tally


def read_run(run_id) -> dict | None:
    try:
        raw = _conn().hgetall(run_key(run_id))
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    return {_text(k): _text(v) for k, v in raw.items()}


# ─── endpoints ──────────────────────────────────────────────────────────────


_BULK_REQUEST = inline_serializer(
    name="SnmpBulkRequest",
    fields={"devices": serializers.ListField(child=serializers.UUIDField())},
)
_BULK_RESPONSES = {
    202: OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{run_id, action, requested, queued, skipped, outposts: "
        "[{name, devices, stale}]}. skipped counts the named devices the caller "
        "may not change; outposts lists the Outposts asked for a pass.",
    ),
    200: OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Nothing left to queue here - every device was skipped or "
        "belongs to an Outpost. Same shape, run_id null.",
    ),
}


def _bulk(request, action):
    from audit.context import current_via

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if not rbac.has_action(request.user, tenant, "device", "change"):
        return Response(
            {"detail": "You do not have permission to change devices."}, status=403
        )
    ids, error = _parse_ids(request.data.get("devices"))
    if ids is None:
        return Response({"devices": [error]}, status=400)

    devices = list(changeable(request.user, tenant, ids).order_by("name", "pk"))
    skipped = len(ids) - len(devices)
    outposts: list[dict] = []
    if action in (POLL, MACS):
        devices, remote = split_outposts(tenant, poll_owners(tenant, devices))
        outposts = _ask_outposts(remote)
    body = {
        "run_id": None,
        "action": action,
        "requested": len(ids),
        "queued": len(devices),
        "skipped": skipped,
        "outposts": outposts,
    }
    if not devices:
        return Response(body)
    if not has_worker(_queue()):
        log.warning("bulk SNMP %s not queued: no RQ worker listens on the queue", action)
        return Response(
            {"detail": "No background worker is running, so the run would never "
                       "start. Start the workers service and try again."},
            status=503,
        )
    try:
        body["run_id"] = start(action, tenant, request.user, devices, via=current_via())
    except Exception as exc:  # noqa: BLE001 - Redis down
        log.warning("bulk SNMP %s could not be queued: %s", action, exc)
        return Response(
            {"detail": "The background queue is unavailable - try again shortly."},
            status=503,
        )
    return Response(body, status=202)


@extend_schema(
    summary="Poll now for many devices, in the background",
    tags=["monitoring"], request=_BULK_REQUEST, responses=_BULK_RESPONSES,
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bulk_poll_view(request):
    return _bulk(request, POLL)


@extend_schema(
    summary="Refresh MACs for many devices, in the background",
    tags=["monitoring"], request=_BULK_REQUEST, responses=_BULK_RESPONSES,
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bulk_mac_refresh_view(request):
    return _bulk(request, MACS)


@extend_schema(
    summary="Sync many devices from their last SNMP poll, in the background",
    tags=["monitoring"], request=_BULK_REQUEST, responses=_BULK_RESPONSES,
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bulk_sync_view(request):
    return _bulk(request, SYNC)


@extend_schema(
    summary="Progress of a bulk SNMP run",
    tags=["monitoring"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{run_id, found, done, action, total, processed, counts: "
        "{ok, unreachable, failed, denied, busy, outpost}, sync: {...} for a sync}. "
        "An unknown, expired or someone else's run reads {found: false, done: true}.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def bulk_run_view(request, run_id):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    unknown = {"run_id": run_id, "found": False, "done": True}
    run = read_run(run_id) if _RUN_ID.match(run_id or "") else None
    if run is None or run.get("tenant") != str(tenant.pk):
        return Response(unknown)
    if not (request.user.is_superuser or run.get("owner") == str(request.user.pk)):
        return Response(unknown)

    def num(key):
        try:
            return int(run.get(key) or 0)
        except ValueError:
            return 0

    total, processed = num("total"), num("processed")
    body = {
        "run_id": run_id,
        "found": True,
        "done": processed >= total,
        "action": run.get("action"),
        "total": total,
        "processed": processed,
        "counts": {k: num(k) for k in OUTCOMES},
    }
    if run.get("action") == SYNC:
        body["sync"] = {k: num(k) for k in SYNC_KEYS}
    return Response(body)
