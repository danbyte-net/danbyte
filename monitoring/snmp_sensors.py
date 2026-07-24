"""Poll user-defined SNMP sensors → inventory-item health.

For a device, run every applicable ``SnmpSensor`` (bound to its device type or
to all) using the device's own resolved SNMP profile, then reconcile the
readings into inventory items: each reading maps its raw SNMP value through the
sensor's ``value_map`` to a status slug, and the matching item's status is
flipped (created if absent). Facts other than status are never touched — this
mirrors the Redfish reconciler's "don't stomp intent" rule.
"""
from __future__ import annotations

from django.utils import timezone

from danbyte_checks.snmp_facts import SnmpFactsError, fetch_oid_sync

from .models import DeviceSnmp, SnmpSensor
from .snmp_poll import _device_target
from .snmp_resolve import resolve_device_profile


def _render_name(template: str, kind: str, index: str) -> str:
    try:
        return template.format(index=index, kind=kind.title())[:128] or kind
    except (KeyError, IndexError):
        return f"{kind.title()} {index}"[:128]


def applicable_sensors(device, tenant):
    """Enabled sensors that target this device (its type, or all types)."""
    return SnmpSensor.objects.filter(tenant=tenant, enabled=True).filter(
        models_q(device)
    )


def models_q(device):
    from django.db.models import Q

    return Q(device_type__isnull=True) | Q(device_type_id=device.device_type_id)


def poll_device_sensors(device, tenant, profile=None) -> dict:
    """Poll + reconcile all applicable sensors for ``device``.

    Returns ``{"readings": [...], "flipped": n, "error": str}``. Stores the
    readings on the device's ``DeviceSnmp.sensors`` and flips inventory-item
    statuses. ``profile=None`` resolves the device's SNMP profile.
    """
    from api.models import InventoryItem
    from api.status_registry import resolve_status
    from audit.models import JournalEntry
    from audit.site_capture import entry_site_id

    if profile is None:
        profile, _ = resolve_device_profile(device, tenant)
    if profile is None:
        return {"readings": [], "flipped": 0, "error": "no SNMP profile"}
    target = _device_target(device)
    if not target:
        return {"readings": [], "flipped": 0,
                "error": "device has no primary IP (and its name does not resolve)"}

    sensors = list(applicable_sensors(device, tenant))
    items = list(device.inventory_items.select_related("status"))
    by_name = {i.name: i for i in items}
    readings: list[dict] = []
    flips: list[str] = []
    errors: list[str] = []

    for sensor in sensors:
        try:
            raw = fetch_oid_sync(
                target, profile.version, profile.params, profile.secret_params,
                sensor.oid, sensor.walk, profile.timeout_ms,
            )
        except SnmpFactsError as exc:
            errors.append(f"{sensor.name}: {exc}")
            continue
        for index, value in raw.items():
            name = _render_name(sensor.name_template, sensor.item_kind, index)
            slug = (sensor.value_map or {}).get(str(value))
            readings.append({
                "sensor": sensor.name, "name": name,
                "raw": value, "status": slug or "",
            })
            if not slug:
                continue  # unmapped value → leave status alone
            status = resolve_status(tenant, slug, "inventoryitem")
            if status is None:
                continue
            item = by_name.get(name)
            if item is None:
                item = InventoryItem.objects.create(
                    device=device, name=name, kind=sensor.item_kind,
                    status=status,
                )
                by_name[name] = item
            elif item.status_id != status.id:
                old = item.status.name if item.status_id else "—"
                item.status = status
                item.save(update_fields=["status", "updated_at"])
                flips.append(f"{name}: {old} → {status.name}")

    if flips:
        JournalEntry.objects.create(
            tenant=tenant, author_name="SNMP sensors",
            object_type="api.device", object_id=str(device.id),
            object_site_id=entry_site_id(device),
            comments="Hardware health (SNMP): " + "; ".join(flips[:20]),
        )

    state, _ = DeviceSnmp.objects.get_or_create(
        device=device, defaults={"tenant": tenant}
    )
    state.tenant = tenant
    state.sensors = readings
    if errors and not state.polled_at:
        state.error = "; ".join(errors)[:500]
    state.polled_at = timezone.now()
    state.save(update_fields=["tenant", "sensors", "error", "polled_at", "updated_at"])
    return {
        "readings": readings, "flipped": len(flips),
        "error": "; ".join(errors),
    }
