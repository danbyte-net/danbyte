"""Push a device type's component templates at every device of that type (#103).

A type's templates drift from the devices built off them - a port added to the
model months after the fleet was created exists on the type and nowhere else.
Doing that device-by-device is the thing this replaces.

It rides the ``DeviceTypeImportRun`` machinery (kind ``component_sync``) rather
than inventing a second progress model: same queue, same polling endpoint, same
inline fallback when Redis is down.

**Permissions are re-checked per device inside the job.** The enqueue-time
check only proves the user could act on the *type*; a site-scoped grant may
cover some of its devices and not others, and the fleet can change between
enqueue and run. Devices the user may not change are skipped and counted, never
silently synced.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#: Failures recorded per run, so one broken fleet can't bloat the row.
FAILURE_CAP = 50


def devices_for_sync(device_type):
    """Every device built from this type, oldest first for a stable order."""
    from .models import Device

    return (
        Device.objects.filter(device_type=device_type)
        .select_related("device_type", "site", "tenant")
        .order_by("created_at", "id")
    )


def preview_sync(device_type, user, tenant) -> dict:
    """What a sync would do, without doing it.

    Returns totals plus a per-device list (capped) so the dialog can say
    "12 of 40 devices would change" before anything is touched.
    """
    from auth_api import rbac

    from .models import diff_device_components

    rows: list[dict] = []
    totals = {"devices": 0, "changing": 0, "skipped": 0, "extra_with_ips": 0}
    for device in devices_for_sync(device_type):
        totals["devices"] += 1
        if not rbac.can_act_on(user, tenant, "device", "change", device):
            totals["skipped"] += 1
            continue
        diff = diff_device_components(device)
        if not diff:
            continue
        totals["changing"] += 1
        add = sum(len(v.get("add", [])) for v in diff.values())
        extra = sum(len(v.get("extra", [])) for v in diff.values())
        # Deleting an interface that carries addresses drops those links, so
        # the count is surfaced before anyone ticks "remove extra".
        with_ips = (
            device.interfaces.filter(
                name__in=diff.get("interfaces", {}).get("extra", []),
                ip_addresses__isnull=False,
            )
            .distinct()
            .count()
            if diff.get("interfaces", {}).get("extra")
            else 0
        )
        totals["extra_with_ips"] += with_ips
        if len(rows) < 100:
            rows.append({
                "id": str(device.id),
                "name": device.name,
                "add": add,
                "extra": extra,
                "interfaces_with_ips": with_ips,
            })
    return {"totals": totals, "devices": rows}


def run_devicetype_component_sync(run_id: str) -> None:
    """Sync every device of the run's type. Never raises - a failure lands on
    the run so the worker survives it."""
    from django.utils import timezone

    from auth_api import rbac

    from .models import DeviceType, DeviceTypeImportRun, sync_device_components

    run = DeviceTypeImportRun.objects.filter(id=run_id).first()
    if run is None:
        return
    run.status = "running"
    run.started_at = timezone.now()
    run.save(update_fields=["status", "started_at"])

    failures: list[dict] = []
    progress = {"done": 0, "total": 0, "changed": 0, "skipped": 0, "failed": 0}
    try:
        dt = DeviceType.objects.filter(
            id=(run.options or {}).get("device_type"), tenant=run.tenant
        ).first()
        if dt is None:
            run.status = "failed"
            run.error = "The device type no longer exists."
            run.finished_at = timezone.now()
            run.save()
            return
        remove_extra = bool((run.options or {}).get("remove_extra"))
        devices = list(devices_for_sync(dt))
        progress["total"] = len(devices)
        run.progress = dict(progress)
        run.save(update_fields=["progress"])

        for device in devices:
            try:
                # Re-checked here, not trusted from enqueue time: the grant or
                # the device's site may have changed since.
                if not rbac.can_act_on(
                    run.created_by, run.tenant, "device", "change", device
                ):
                    progress["skipped"] += 1
                    continue
                result = sync_device_components(
                    device, remove_extra=remove_extra
                )
                if result.get("added") or result.get("removed"):
                    progress["changed"] += 1
            except Exception as exc:  # noqa: BLE001 - one device must not stop the fleet
                progress["failed"] += 1
                if len(failures) < FAILURE_CAP:
                    failures.append({"name": device.name, "error": str(exc)})
                logger.exception("component sync failed for %s", device.name)
            finally:
                progress["done"] += 1
                if progress["done"] % 10 == 0:
                    run.progress = dict(progress)
                    run.save(update_fields=["progress"])
        run.status = "success"
    except Exception as exc:  # noqa: BLE001
        run.status = "failed"
        run.error = str(exc)
        logger.exception("component sync run failed")
    finally:
        run.progress = dict(progress)
        run.failures = failures
        run.finished_at = timezone.now()
        run.save()


def enqueue_component_sync(device_type, *, remove_extra: bool, user) -> object:
    """Create the run and queue it. Returns the run."""
    from .devicetype_import_tasks import _enqueue
    from .models import DeviceTypeImportRun

    run = DeviceTypeImportRun.objects.create(
        tenant=device_type.tenant,
        kind="component_sync",
        source_url="",
        options={
            "device_type": str(device_type.id),
            "remove_extra": bool(remove_extra),
        },
        created_by=user,
        status="queued",
    )
    _enqueue(run_devicetype_component_sync, run, "component sync")
    return run
