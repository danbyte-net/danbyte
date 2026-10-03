"""Refresh MACs: read one device's whole MAC table in the background (#284).

Poll now is synchronous and has to finish inside the web worker's request
timeout, so its MAC-table read is the quick one. **Refresh MACs** runs the
full read - the long budget and the per-VLAN contexts - as an RQ job:

* one run per device at a time: a Redis key (``SET NX``, 15 minutes) holds the
  run id, and a second click while it runs gets that run back;
* the job reloads the device by id *and* tenant and re-checks
  ``device.change`` for the user who asked, so a grant revoked after the
  click, or a device moved away, stops it;
* progress lives in a Redis hash for an hour, which the UI polls through
  ``GET /api/monitoring/mac-refresh/<run_id>/``.
"""
from __future__ import annotations

import logging
import uuid

from django.utils import timezone

log = logging.getLogger("monitoring.mac_jobs")

LOCK_TTL = 15 * 60
RUN_TTL = 60 * 60
JOB_TIMEOUT = LOCK_TTL


class RefreshUnavailable(Exception):
    """Redis could not take the run - the caller refreshes inline instead."""


def _conn():
    import django_rq

    return django_rq.get_connection("default")


def _queue():
    import django_rq

    return django_rq.get_queue("default")


def lock_key(device_id) -> str:
    return f"mac-refresh:lock:{device_id}"


def run_key(run_id) -> str:
    return f"mac-refresh:run:{run_id}"


def _text(value) -> str:
    return value.decode() if isinstance(value, bytes) else str(value or "")


def start_refresh(device, tenant, user) -> dict:
    """Queue a refresh of ``device`` (a stack's owner) for ``user``.

    ``{"run_id", "running"}`` - ``running`` when one was already in flight and
    this is its id. Raises :class:`RefreshUnavailable` when Redis can't take
    it."""
    run_id = uuid.uuid4().hex
    try:
        conn = _conn()
        if not conn.set(lock_key(device.pk), run_id, nx=True, ex=LOCK_TTL):
            held = _text(conn.get(lock_key(device.pk)))
            if held:
                return {"run_id": held, "running": True}
            # The lock expired between the two calls - take it now.
            conn.set(lock_key(device.pk), run_id, ex=LOCK_TTL)
        conn.hset(run_key(run_id), mapping={
            "status": "queued",
            "tenant": str(tenant.pk),
            "owner": str(user.pk),
            "device": str(device.pk),
            "device_name": device.name,
            "queued_at": timezone.now().isoformat(),
            "started_at": "", "finished_at": "",
            "macs": 0, "ports": 0, "complete": "", "error": "",
        })
        conn.expire(run_key(run_id), RUN_TTL)
        _queue().enqueue(
            refresh_device, str(device.pk), str(tenant.pk), user.pk, run_id,
            job_timeout=JOB_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001 - any Redis failure means "inline"
        log.warning("MAC refresh could not be queued: %s", exc)
        raise RefreshUnavailable(str(exc)) from exc
    return {"run_id": run_id, "running": False}


def _write(run_id, **fields) -> None:
    try:
        conn = _conn()
        conn.hset(run_key(run_id), mapping={k: "" if v is None else v for k, v in fields.items()})
        conn.expire(run_key(run_id), RUN_TTL)
    except Exception as exc:  # noqa: BLE001 - progress is best-effort
        log.warning("MAC refresh %s: progress not written: %s", run_id, exc)


def _release(device_id, run_id) -> None:
    """Drop the single-flight key - only if it is still this run's."""
    try:
        conn = _conn()
        if _text(conn.get(lock_key(device_id))) == run_id:
            conn.delete(lock_key(device_id))
    except Exception:  # noqa: BLE001 - it expires on its own
        pass


def summary(state) -> dict:
    """``{macs, ports, complete, partial_reason}`` of a device's last read."""
    meta = (state.fdb_meta or {}) if state is not None else {}
    core = meta.get("core") or {}
    return {
        "macs": int(core.get("present") or 0),
        "ports": int(core.get("ports") or 0),
        "complete": bool(meta.get("complete")),
        "error": str(meta.get("error") or ""),
    }


def run_refresh(device, tenant, *, mac_mode: str = "full"):
    """Poll ``device`` now and return ``(state, reason)`` - the inline path
    when Redis is down, and the job's core."""
    from .snmp_poll import poll_device

    return poll_device(device, tenant, mac_mode=mac_mode)


def refresh_device(device_id, tenant_id, user_id, run_id) -> str:
    """The RQ job. Returns the final status, for the worker log."""
    from django.contrib.auth import get_user_model

    from api.models import Device
    from auth_api import rbac
    from core.models import Tenant

    status, error, result = "error", "", {}
    _write(run_id, status="running", started_at=timezone.now().isoformat())
    try:
        tenant = Tenant.objects.filter(pk=tenant_id).first()
        device = (
            Device.objects.filter(pk=device_id, tenant_id=tenant_id).first()
            if tenant is not None else None
        )
        user = get_user_model().objects.filter(pk=user_id, is_active=True).first()
        if device is None or user is None:
            status, error = "skipped", "The device or the user is gone."
        elif not rbac.can_act_on(user, tenant, "device", "change", device):
            status, error = "denied", "You may no longer change this device."
        else:
            state, reason = run_refresh(device, tenant)
            if reason == "no_profile":
                error = "No SNMP profile resolves for this device."
            elif reason == "no_target":
                error = "Device has no primary IP or name to poll."
            elif state is None or not state.reachable:
                status, error = "unreachable", (state.error if state else "")[:500]
            else:
                status = "done"
                result = summary(state)
    except Exception as exc:  # noqa: BLE001 - the run must end with a status
        log.exception("MAC refresh %s failed", run_id)
        status, error = "error", str(exc)[:500]
    finally:
        fields = {
            "status": status, "error": error or result.get("error", ""),
            "finished_at": timezone.now().isoformat(),
        }
        if result:
            fields.update(
                macs=result["macs"], ports=result["ports"],
                complete="1" if result["complete"] else "0",
            )
        _write(run_id, **fields)
        _release(device_id, run_id)
    return status


def read_run(run_id) -> dict | None:
    """The run's hash as text, or ``None`` when unknown, expired, or Redis is
    unreachable."""
    try:
        raw = _conn().hgetall(run_key(run_id))
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    return {_text(k): _text(v) for k, v in raw.items()}
