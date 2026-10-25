"""Adopting what an external monitor knows and Danbyte does not.

A remote object no Danbyte device answers to becomes a proposal in the
system's review queue; applying it makes the device. Each system reads its own
objects (names, groups, addresses, inventory); what is shared is how a
proposal is placed, what it still lacks, how a change to the connection's
defaults reaches the proposals already waiting, and how the device is made.

"No device answers to" is decided against **every** device of the tenant,
not a provisioning scope: an object that matches a device by address, serial
or name is that device, and adopting it would be a duplicate with a different
name.

A connection that adopts carries ``adopt_site``, ``adopt_role`` and
``adopt_device_type`` - the last-resort defaults - and its adoption rules sit
on :class:`~monitoring.external.models.ExternalAdoptionRuleBase`.
"""
from __future__ import annotations

FIELDS = ("site", "role", "device_type")
_MISSING_LABEL = {"site": "site", "role": "role", "device_type": "device type"}


def device_index(tenant) -> dict:
    """Every address, serial and name the tenant's devices answer to."""
    from api.models import Device, IPAddress

    addresses = {
        str(ip).split("/")[0]
        for ip in IPAddress.objects.filter(
            tenant=tenant, assigned_device__isnull=False
        ).values_list("ip_address", flat=True)
    }
    serials, names = set(), set()
    for name, serial in Device.objects.filter(tenant=tenant).values_list(
        "name", "serial_number"
    ):
        if name:
            names.add(name.strip().lower())
        if serial:
            serials.add(serial.strip().lower())
    return {"addresses": addresses, "serials": serials, "names": names}


def first_matching_rule(rules, candidates: dict) -> dict:
    """What the first matching adoption rule says, or nothing.

    ``candidates`` maps a rule scope to the object's values for it (its
    names, its groups, its addresses). A rule sets only what it names, so a
    name rule that knows the site but not the type leaves the type to the
    inventory and the defaults.
    """
    from integrations.placement import pattern_matches

    for rule in rules or ():
        values = candidates.get(rule.scope) or []
        if any(pattern_matches(rule.pattern, v, scope=rule.scope) for v in values):
            out = {"rule": rule.pattern, "site": (rule.site_id, rule.site.name)}
            if rule.role_id:
                out["role"] = (rule.role_id, rule.role.name)
            if rule.device_type_id:
                out["device_type"] = (rule.device_type_id, rule.device_type.model)
            return out
    return {}


def connection_defaults(conn) -> dict:
    """The connection's last-resort placement, as ``(id, label)`` or None."""
    return {
        "site": (conn.adopt_site_id, conn.adopt_site.name) if conn.adopt_site_id else None,
        "role": (conn.adopt_role_id, conn.adopt_role.name) if conn.adopt_role_id else None,
        "device_type": (
            (conn.adopt_device_type_id, conn.adopt_device_type.model)
            if conn.adopt_device_type_id else None
        ),
    }


def place(conn, placed: dict, *, site=None, device_type=None) -> tuple[dict, list]:
    """Decide site, type and role, most specific first.

    An adoption rule (``placed``), then what the object itself says (``site``
    and ``device_type`` hints the system read from it), then the connection's
    defaults. Returns ``({field: (id, label) | None}, defaulted)`` where
    ``defaulted`` lists the fields that fell to the defaults - so a later
    change to the defaults can be re-applied to a pending proposal without
    disturbing what a rule or the object decided.
    """
    defaulted: list[str] = []
    chosen = {
        "site": placed.get("site") or site,
        "device_type": placed.get("device_type") or device_type,
        "role": placed.get("role"),
    }
    # Order kept from the original decision chain: site, type, role.
    for field in ("site", "device_type", "role"):
        if chosen[field] is None:
            defaulted.append(field)
            attr = f"adopt_{field}_id"
            if getattr(conn, attr):
                obj = getattr(conn, f"adopt_{field}")
                label = obj.model if field == "device_type" else obj.name
                chosen[field] = (getattr(conn, attr), label)
    return chosen, defaulted


def placement_detail(chosen: dict) -> dict:
    """The ``*_id`` / label pairs a proposal's detail carries."""
    out = {}
    for field in FIELDS:
        value = chosen.get(field)
        out[f"{field}_id"] = str(value[0]) if value else None
        out[field] = value[1] if value else None
    return out


def set_reason(detail: dict, hint: str = "") -> None:
    """Say what a proposal is still missing, or clear the sentence."""
    missing = [_MISSING_LABEL[f] for f in FIELDS if not detail.get(f"{f}_id")]
    if missing:
        tail = f", or {hint}." if hint else "."
        detail["reason"] = (
            "No " + ", ".join(missing) + " to adopt into - set the defaults on "
            "the connection" + tail
        )
    else:
        detail.pop("reason", None)


def applicable(detail: dict) -> bool:
    return bool(
        detail.get("site_id") and detail.get("role_id") and detail.get("device_type_id")
    )


def refresh_pending_proposals(conn, changes, *, hint: str = "") -> int:
    """Re-apply the connection's defaults to the adoptions still waiting.

    ``changes`` is the connection's pending adoption proposals. A proposal
    records what it decided at sync time; the defaults are its last resort,
    so when they change the proposals that leaned on them (or had nothing to
    lean on) must follow at once - an operator who has just pressed *Set
    defaults* is looking at the queue, not waiting for the next pass. Fields
    a rule or the object decided are left alone. Returns how many proposals
    changed.
    """
    defaults = connection_defaults(conn)
    changed = 0
    for change in changes:
        detail = dict(change.detail or {})
        # Older proposals carry no marker: a field with no value is one the
        # defaults may fill, which is what the marker would have said.
        defaulted = set(detail.get("defaulted") or []) | {
            f for f in FIELDS if not detail.get(f"{f}_id")
        }
        before = {k: detail.get(k) for k in ("site_id", "role_id", "device_type_id", "reason")}
        for field in defaulted:
            value = defaults[field]
            detail[f"{field}_id"] = str(value[0]) if value else None
            detail[field] = value[1] if value else None
        detail["defaulted"] = sorted(defaulted)
        set_reason(detail, hint)
        after = {k: detail.get(k) for k in ("site_id", "role_id", "device_type_id", "reason")}
        if after != before or "defaulted" not in (change.detail or {}):
            change.detail = detail
            change.save(update_fields=["detail"])
            changed += 1
    return changed


def make_device(conn, detail: dict, *, name: str, origin: str):
    """Make the device an applicable proposal describes. Returns
    ``(device, note)``.

    Every catalog id is re-read inside the connection's tenant - a proposal's
    detail is data, not a trusted reference. The address is recorded only
    when a prefix of the tenant's contains it: an address with nowhere to
    live is left to the operator rather than invented a prefix for. Call
    inside the transaction that also writes the system's link.
    """
    from api.models import Device, DeviceRole, DeviceType, IPAddress, Site
    from api.status_registry import resolve_status
    from api.vrf_placement import containing_prefix, row_in_vrf

    if not applicable(detail):
        raise ValueError(detail.get("reason") or "This proposal is missing a default.")
    tenant = conn.tenant
    site = Site.objects.filter(tenant=tenant, pk=detail["site_id"]).first()
    role = DeviceRole.objects.filter(tenant=tenant, pk=detail["role_id"]).first()
    dtype = DeviceType.objects.filter(tenant=tenant, pk=detail["device_type_id"]).first()
    if site is None or role is None or dtype is None:
        raise ValueError("A default named in this proposal no longer exists.")

    device = Device.objects.create(
        tenant=tenant, name=name[:255], device_type=dtype, role=role, site=site,
        serial_number=(detail.get("serial") or "")[:255],
        status=resolve_status(tenant, "active", "device"),
        description=f"Adopted from {origin}",
    )
    note = ""
    address = (detail.get("address") or "").strip()
    if address:
        # The remote system names no VRF: an address held in several VRFs
        # resolves to the one it places into, never an arbitrary one (#331).
        row = row_in_vrf(tenant, address)
        if row is None:
            prefix = containing_prefix(tenant, address)
            if prefix is not None:
                row = IPAddress.objects.create(
                    tenant=tenant, ip_address=address, prefix=prefix,
                    description=f"Adopted from {origin}",
                )
            else:
                note = f" {address} is in no prefix of yours, so it was not recorded."
        if row is not None and row.assigned_device_id is None:
            row.assigned_device = device
            row.save(update_fields=["assigned_device"])
            device.primary_ip = row
            device.save(update_fields=["primary_ip"])
    return device, note
