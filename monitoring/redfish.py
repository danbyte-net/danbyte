"""Redfish collector + inventory reconciler.

Walks a BMC's Redfish tree (DMTF's management REST standard - iDRAC, iLO,
XClarity, Supermicro, UCS all speak it) and reconciles the observed hardware
into the device's inventory items:

  Systems → Storage → Drives      → kind=disk (media from MediaType/Protocol)
  Systems → Processors            → kind=cpu
  Systems → Memory                → kind=ram
  Chassis → Power → PowerSupplies → kind=psu
  Chassis → Thermal → Fans        → kind=fan

Reconcile rules (deliberately narrow - observed facts must not stomp intent):
  * Match an existing item by SERIAL first, then by exact name. Matching by
    serial means a user's rename sticks across polls.
  * Create items the device doesn't have yet (named from the BMC).
  * Update hardware FACTS (kind/media/capacity_bytes/speed/part_id/serial).
    Never touch parent nesting, tags, description, or custom fields.
  * Health → lifecycle status: OK → active, Critical/Warning → failed
    (statuses stay user-editable catalog rows; flips are journaled on the
    device). Items the BMC no longer reports are LEFT ALONE.

Plain httpx against the REST tree - no vendor SDK, so the collector stays
dependency-light and airgap-safe. Redirects are disabled and the request goes
only to the admin-configured host (see RedfishEndpoint's security note).
"""
from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Any

import httpx
from django.utils import timezone

logger = logging.getLogger(__name__)

# Redfish MediaType/Protocol → InventoryItem.media
def _drive_media(media_type: str, protocol: str) -> str:
    if (protocol or "").lower() == "nvme":
        return "nvme"
    mt = (media_type or "").lower()
    if mt == "ssd":
        return "ssd"
    if mt == "hdd":
        return "hdd"
    return ""


def _host_allowed(host: str) -> tuple[bool, str]:
    """Loopback/link-local are never a BMC - refuse them even though the
    endpoint is admin-configured. RFC1918 is expressly allowed here."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as exc:
        return False, f"cannot resolve {host}: {exc}"
    for info in infos:
        addr = ipaddress.ip_address(info[4][0])
        if addr.is_loopback or addr.is_link_local or addr.is_unspecified:
            return False, f"{addr} is loopback/link-local - not a BMC address"
    return True, ""


class _Client:
    """Minimal Redfish walker: GET a path, follow @odata.id references."""

    def __init__(self, endpoint):
        creds = endpoint.secret_params or {}
        self.base = f"https://{endpoint.host}:{endpoint.port}"
        self.http = httpx.Client(
            auth=(creds.get("username", ""), creds.get("password", "")),
            verify=endpoint.verify_tls,
            timeout=endpoint.timeout_ms / 1000,
            follow_redirects=False,
            headers={"Accept": "application/json"},
        )

    def get(self, path: str) -> dict[str, Any]:
        r = self.http.get(self.base + path)
        r.raise_for_status()
        return r.json()

    def members(self, collection: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for m in collection.get("Members", []) or []:
            ref = m.get("@odata.id")
            if ref:
                try:
                    out.append(self.get(ref))
                except httpx.HTTPError as exc:  # skip broken members, keep going
                    logger.info("redfish member %s failed: %s", ref, exc)
        return out

    def close(self):
        self.http.close()


def _health(res: dict[str, Any]) -> str:
    return ((res.get("Status") or {}).get("Health") or "").lower()


def _present(res: dict[str, Any]) -> bool:
    state = ((res.get("Status") or {}).get("State") or "").lower()
    return state not in ("absent", "unavailableoffline")


def collect(endpoint) -> dict[str, Any]:
    """Walk the BMC and return the observed hardware dict (see model help).
    Raises httpx.HTTPError / OSError on failure - callers persist the error."""
    ok, reason = _host_allowed(endpoint.host)
    if not ok:
        raise OSError(reason)
    c = _Client(endpoint)
    try:
        root = c.get("/redfish/v1/")
        out: dict[str, Any] = {
            "system": {}, "drives": [], "processors": [],
            "memory": [], "psus": [], "fans": [],
        }

        systems_ref = (root.get("Systems") or {}).get("@odata.id")
        for system in c.members(c.get(systems_ref)) if systems_ref else []:
            out["system"] = {
                "manufacturer": system.get("Manufacturer") or "",
                "model": system.get("Model") or "",
                "serial": system.get("SerialNumber") or "",
                "health": _health(system),
            }
            # Drives, via each Storage subsystem.
            storage_ref = (system.get("Storage") or {}).get("@odata.id")
            for storage in c.members(c.get(storage_ref)) if storage_ref else []:
                for dref in storage.get("Drives", []) or []:
                    ref = dref.get("@odata.id")
                    if not ref:
                        continue
                    try:
                        d = c.get(ref)
                    except httpx.HTTPError:
                        continue
                    if not _present(d):
                        continue
                    out["drives"].append({
                        "name": d.get("Name") or d.get("Id") or "Drive",
                        "serial": d.get("SerialNumber") or "",
                        "model": d.get("Model") or "",
                        "capacity_bytes": d.get("CapacityBytes"),
                        "media": _drive_media(
                            d.get("MediaType") or "", d.get("Protocol") or ""
                        ),
                        "speed": d.get("Protocol") or "",
                        "health": _health(d),
                        "life_left": d.get("PredictedMediaLifeLeftPercent"),
                    })
            # Processors.
            proc_ref = (system.get("Processors") or {}).get("@odata.id")
            for p in c.members(c.get(proc_ref)) if proc_ref else []:
                if not _present(p):
                    continue
                out["processors"].append({
                    "name": p.get("Name") or p.get("Id") or "CPU",
                    "serial": p.get("SerialNumber") or "",
                    "model": p.get("Model") or "",
                    "speed": (
                        f"{p['MaxSpeedMHz']} MHz" if p.get("MaxSpeedMHz") else ""
                    ),
                    "health": _health(p),
                })
            # Memory DIMMs.
            mem_ref = (system.get("Memory") or {}).get("@odata.id")
            for m in c.members(c.get(mem_ref)) if mem_ref else []:
                if not _present(m):
                    continue
                cap_mib = m.get("CapacityMiB")
                out["memory"].append({
                    "name": m.get("Name") or m.get("Id") or "DIMM",
                    "serial": m.get("SerialNumber") or "",
                    "model": m.get("PartNumber") or "",
                    "capacity_bytes": int(cap_mib) * 1024 * 1024
                    if cap_mib else None,
                    "speed": (
                        f"{m['OperatingSpeedMhz']} MT/s"
                        if m.get("OperatingSpeedMhz") else ""
                    ),
                    "health": _health(m),
                })

        chassis_ref = (root.get("Chassis") or {}).get("@odata.id")
        for chassis in c.members(c.get(chassis_ref)) if chassis_ref else []:
            power_ref = (chassis.get("Power") or {}).get("@odata.id")
            if power_ref:
                try:
                    power = c.get(power_ref)
                except httpx.HTTPError:
                    power = {}
                for psu in power.get("PowerSupplies", []) or []:
                    if not _present(psu):
                        continue
                    out["psus"].append({
                        "name": psu.get("Name") or "PSU",
                        "serial": psu.get("SerialNumber") or "",
                        "model": psu.get("Model") or "",
                        "health": _health(psu),
                    })
            thermal_ref = (chassis.get("Thermal") or {}).get("@odata.id")
            if thermal_ref:
                try:
                    thermal = c.get(thermal_ref)
                except httpx.HTTPError:
                    thermal = {}
                for fan in thermal.get("Fans", []) or []:
                    if not _present(fan):
                        continue
                    out["fans"].append({
                        "name": fan.get("Name") or fan.get("FanName") or "Fan",
                        "serial": "",
                        "model": "",
                        "health": _health(fan),
                    })
        return out
    finally:
        c.close()


# ─── Reconcile ────────────────────────────────────────────────────────────────

_KIND_LISTS = [
    ("drives", "disk"),
    ("processors", "cpu"),
    ("memory", "ram"),
    ("psus", "psu"),
    ("fans", "fan"),
]


def _status_for_health(tenant, health: str):
    from api.status_registry import resolve_status

    if health == "ok":
        return resolve_status(tenant, "active", "inventoryitem")
    if health in ("critical", "warning"):
        return resolve_status(tenant, "failed", "inventoryitem")
    return None  # unknown health → leave status alone


def reconcile(endpoint, observed: dict[str, Any]) -> dict[str, int]:
    """Fold the observed hardware into the device's inventory items (rules in
    the module docstring). Returns {"created": n, "updated": n, "flipped": n}."""
    from api.models import InventoryItem

    device = endpoint.device
    tenant = endpoint.tenant
    items = list(device.inventory_items.select_related("status"))
    by_serial = {i.serial_number: i for i in items if i.serial_number}
    by_name = {i.name: i for i in items}
    created = updated = flipped = 0
    flips: list[str] = []

    for list_key, kind in _KIND_LISTS:
        for part in observed.get(list_key, []) or []:
            serial = (part.get("serial") or "").strip()
            name = (part.get("name") or "").strip()[:128] or kind
            item = (by_serial.get(serial) if serial else None) or by_name.get(name)

            facts = {
                "kind": kind,
                "media": part.get("media") or "" if kind == "disk" else "",
                "capacity_bytes": part.get("capacity_bytes"),
                "speed": (part.get("speed") or "")[:64],
                "part_id": (part.get("model") or "")[:128],
                "serial_number": serial[:255],
            }
            status = _status_for_health(tenant, part.get("health") or "")

            if item is None:
                item = InventoryItem.objects.create(
                    device=device, name=name, status=status, **facts
                )
                by_name[item.name] = item
                if serial:
                    by_serial[serial] = item
                created += 1
                continue

            changed = []
            for k, v in facts.items():
                # Facts only - and never blank out a value the BMC didn't send.
                if v not in (None, "") and getattr(item, k) != v:
                    setattr(item, k, v)
                    changed.append(k)
            if status is not None and item.status_id != status.id:
                old = item.status.name if item.status_id else "-"
                item.status = status
                changed.append("status")
                flipped += 1
                flips.append(f"{item.name}: {old} → {status.name}")
            if changed:
                item.save(update_fields=[*changed, "updated_at"])
                updated += 1

    if flips:
        # Status flips are operationally significant - journal them on the
        # device so the Journal tab tells the story.
        from audit.models import JournalEntry
        from audit.site_capture import entry_site_id

        JournalEntry.objects.create(
            tenant=tenant,
            author_name="Redfish collector",
            object_type="api.device",
            object_id=str(device.id),
            object_site_id=entry_site_id(device),
            comments="Hardware health (BMC): " + "; ".join(flips[:20]),
        )
    return {"created": created, "updated": updated, "flipped": flipped}


def poll_endpoint(endpoint) -> None:
    """Collect + reconcile + persist the outcome on the endpoint row."""
    try:
        observed = collect(endpoint)
    except (httpx.HTTPError, OSError, ValueError) as exc:
        endpoint.reachable = False
        endpoint.error = str(exc)[:2000]
        endpoint.polled_at = timezone.now()
        endpoint.save(update_fields=["reachable", "error", "polled_at", "updated_at"])
        return
    endpoint.data = observed
    endpoint.reachable = True
    endpoint.error = ""
    endpoint.polled_at = timezone.now()
    endpoint.save(
        update_fields=["data", "reachable", "error", "polled_at", "updated_at"]
    )
    reconcile(endpoint, observed)
