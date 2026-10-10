"""MAC address registry for the IPAM MAC page.

``GET /api/macs/`` → every MAC address known in the active tenant, aggregated
from four places: device interface hardware addresses, virtual-machine
interface addresses, IP↔MAC pairings, and first-class
:class:`~api.models.MACAddress` objects. Each MAC is one row carrying the
interfaces that bear it, the IPs paired with it, and any MAC objects (with
their description / tags) recorded for it.

Full CRUD on the MAC *objects* themselves lives at ``/api/mac-addresses/``
(see :class:`~api.viewsets.MACAddressViewSet`); this module only aggregates.

Each source is a row type of its own, cut to the caller's view scope for it
(``interface``, ``vminterface``, ``ipaddress``, ``macaddress``) in the active
tenant: a viewer limited to Site A never learns a Site B address or port
through a shared MAC. An IP's device and interface show only when the caller
may view that row as well; SNMP sightings only on devices and VMs they may
view.
"""
from __future__ import annotations

import re

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from .models import Device, Interface, IPAddress, MACAddress, VirtualMachine, VMInterface
from .natural import natural
from .oui import hexkey, vendor_for, vendors_for
from .serializers import TagSerializer
from .views import _get_active_tenant


def _norm(mac: str) -> str:
    return mac.strip().lower()


def _hexkey(mac: str) -> str:
    """Separator-insensitive comparison key: aa:bb == AA-BB == aabb."""
    return re.sub(r"[^0-9a-f]", "", (mac or "").lower())


def _visible(qs, user, tenant, slug):
    """``qs`` cut to the rows the caller may view (tenant filter is the
    caller's)."""
    return rbac.restrict_queryset(qs, user, tenant, slug, "view")


def _visible_ids(model, tenant_path, ids, user, tenant, slug) -> set:
    """The ids among ``ids`` of rows in ``tenant`` the caller may view - one
    query for a whole page, none when ``ids`` is empty."""
    if not ids:
        return set()
    qs = model.objects.filter(pk__in=ids, **{tenant_path: tenant})
    return set(_visible(qs, user, tenant, slug).values_list("pk", flat=True))


def _snmp_sightings(tenant, mac: str, user) -> list[dict]:
    """Where polling has *observed* this MAC. A MAC clicked on a monitoring
    card often exists only here (a neighbour's address learned on a port), so
    the detail page must be able to say "seen on sw1 port eth2" instead of
    pretending the address doesn't exist. Only devices and VMs the caller may
    view are listed.

    Since #284 these are indexed reads of the sighting tables: every port the
    MAC was learned on and every ARP entry naming it, present and gone (the
    history, within the tenant's retention). A ``fdb`` row carries its VLAN,
    first and last seen, whether it is still there and the port's role
    (access or uplink) next to the original ``device``/``source``/``port``
    keys. A device polled before 0.17 still answers from its JSON tables
    until its next poll - only those rows are loaded."""
    from django.db.models import F, Q

    # Local: api must not import monitoring at module level.
    from monitoring.mac_location import UplinkContext, seen_rows
    from monitoring.mac_tables import canon_mac
    from monitoring.models import ArpSighting, DeviceSnmp, MacSighting

    key = _hexkey(mac)
    canon = canon_mac(key)
    seen: list[dict] = []
    devices = _visible(Device.objects.filter(tenant=tenant), user, tenant, "device")
    vms = _visible(
        VirtualMachine.objects.filter(tenant=tenant), user, tenant, "virtualmachine"
    )
    if canon:
        rows = seen_rows(
            MacSighting.objects.filter(tenant=tenant, mac=canon, device__in=devices)
            .order_by(F("gone_at").desc(nulls_first=True), "-last_seen")
        )
        ctx = UplinkContext(tenant).load(
            {r.polled_device_id for r in rows}, {r.interface_id for r in rows}
        )
        for r in rows:
            uplink = ctx.classify(r.polled_device_id, r.port_key, r.interface_id)
            seen.append({
                "device": {"id": str(r.device_id), "name": r.device_name},
                "source": "fdb",
                "port": r.port_name,
                "interface": (
                    {"id": str(r.interface_id), "name": r.interface_name}
                    if r.interface_id else None
                ),
                "vlan": r.vlan,
                "first_seen": r.first_seen,
                "last_seen": r.last_seen,
                "gone_at": r.gone_at,
                "present": r.gone_at is None,
                "role": "uplink" if uplink.is_uplink else "access",
            })
        for a in (
            ArpSighting.objects.filter(tenant=tenant, mac=canon)
            .filter(Q(device__in=devices) | Q(vm__in=vms))
            .order_by(F("gone_at").desc(nulls_first=True), "-last_seen")
            .values(
                "device_id", "device__name", "vm_id", "vm__name", "ip",
                "interface_id", "interface__name", "first_seen", "last_seen", "gone_at",
            )
        ):
            owner = (
                {"device": {"id": str(a["device_id"]), "name": a["device__name"]}}
                if a["device_id"]
                else {"vm": {"id": str(a["vm_id"]), "name": a["vm__name"]}}
            )
            seen.append({
                **owner, "source": "arp", "ip": a["ip"],
                "interface": (
                    {"id": str(a["interface_id"]), "name": a["interface__name"]}
                    if a["interface_id"] else None
                ),
                "vlan": None,
                "first_seen": a["first_seen"],
                "last_seen": a["last_seen"],
                "gone_at": a["gone_at"],
                "present": a["gone_at"] is None,
                "role": None,
            })

    states = (
        DeviceSnmp.objects.filter(tenant=tenant, fdb_meta={})
        .filter(Q(device__in=devices) | Q(vm__in=vms))
        .select_related("device", "vm")
    )
    for state in states:
        # A state row belongs to a device OR a VM (#13) - reading
        # state.device.name on a VM row was a straight 500 (#139).
        if state.device_id:
            owner = {
                "device": {"id": str(state.device_id), "name": state.device.name}
            }
        elif state.vm_id:
            owner = {"vm": {"id": str(state.vm_id), "name": state.vm.name}}
        else:
            continue
        legacy = {
            "interface": None, "vlan": None, "first_seen": None,
            "last_seen": state.polled_at, "gone_at": None, "present": True, "role": None,
        }
        ifname = {
            str(o.get("if_index")): o.get("name")
            for o in (state.interfaces or [])
            if o.get("if_index")
        }
        for a in state.arp or []:
            if _hexkey(a.get("mac", "")) == key:
                seen.append({**owner, "source": "arp", "ip": a.get("ip"), **legacy})
        for f in state.fdb or []:
            if _hexkey(f.get("mac", "")) == key:
                seen.append({
                    **owner, "source": "fdb",
                    "port": ifname.get(str(f.get("if_index") or "")),
                    **legacy,
                })
    return seen


def _match_mac(qs, field: str, key: str, canon: str | None):
    """``qs`` rows whose ``field`` holds this MAC: in any notation when the
    query is a whole MAC, else the old case-insensitive match."""
    if canon:
        from monitoring.mac_tables import filter_hex

        return filter_hex(qs, field, [canon])
    return qs.filter(**{f"{field}__iexact": key})


def _iface_ref(iface) -> dict:
    return {
        "id": str(iface.id),
        "name": iface.name,
        "device": {"id": str(iface.device_id), "name": iface.device.name},
    }


def _vm_iface_ref(vi) -> dict:
    return {
        "id": str(vi.id),
        "name": vi.name,
        "vm": {"id": str(vi.vm_id), "name": vi.vm.name},
    }


def _mac_object(m: MACAddress, *, with_custom_fields: bool = False) -> dict:
    """Serialize a MAC object for the aggregation views (list / detail)."""
    obj = {
        "id": str(m.id),
        "numid": m.numid,
        "mac_address": m.mac_address,
        "description": m.description,
        "vendor_override": m.vendor_override,
        "assigned_interface": (
            _iface_ref(m.assigned_interface) if m.assigned_interface_id else None
        ),
        "tags": TagSerializer(m.tags.all(), many=True).data,
    }
    if with_custom_fields:
        obj["custom_fields"] = m.custom_fields or {}
    return obj


@extend_schema(
    summary="List every MAC address known in the active tenant, aggregated from "
    "interfaces, IP↔MAC pairings and first-class MAC objects",
    tags=["mac-addresses"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Aggregated MAC rows: {count, results:[{mac, vendor, interfaces[], "
        "vm_interfaces[], ips[], objects[], location}]}. location is where the "
        "network learned the MAC (site, location, device, port, since, last_seen), "
        "or null.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def mac_list_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"count": 0, "results": []})
    user = request.user
    if not rbac.has_action(user, tenant, "macaddress", "view"):
        return Response({"detail": "macaddress.view required."}, status=403)

    entries: dict[str, dict] = {}

    def bucket(mac: str) -> dict:
        key = _norm(mac)
        if key not in entries:
            entries[key] = {
                "mac": mac,
                "interfaces": [],
                "vm_interfaces": [],
                "ips": [],
                "objects": [],
            }
        return entries[key]

    ifaces = _visible(
        Interface.objects.filter(device__tenant=tenant)
        .exclude(mac_address="")
        .select_related("device"),
        user, tenant, "interface",
    )
    for i in ifaces:
        bucket(i.mac_address)["interfaces"].append(_iface_ref(i))

    # VM interfaces carry the same kind of address as a device port (#142).
    vm_ifaces = _visible(
        VMInterface.objects.filter(vm__tenant=tenant)
        .exclude(mac_address="")
        .select_related("vm"),
        user, tenant, "vminterface",
    )
    for vi in vm_ifaces:
        bucket(vi.mac_address)["vm_interfaces"].append(_vm_iface_ref(vi))

    ips = list(
        _visible(
            IPAddress.objects.filter(tenant=tenant)
            .exclude(mac_address="")
            .select_related("assigned_device"),
            user, tenant, "ipaddress",
        )
    )
    # An IP's device is its own row: named only when the caller may view it.
    devices = _visible_ids(
        Device, "tenant", {ip.assigned_device_id for ip in ips} - {None},
        user, tenant, "device",
    )
    for ip in ips:
        bucket(ip.mac_address)["ips"].append(
            {
                "id": str(ip.id),
                "ip_address": ip.ip_address,
                "device": (
                    {"id": str(ip.assigned_device_id), "name": ip.assigned_device.name}
                    if ip.assigned_device_id in devices
                    else None
                ),
            }
        )

    # First-class MAC objects - surface even when no interface/IP string carries
    # the address yet, so a standalone object is still listed and its
    # description / tags show on the row.
    objects = _visible(
        MACAddress.objects.filter(tenant=tenant)
        .select_related("assigned_interface__device")
        .prefetch_related("tags"),
        user, tenant, "macaddress",
    )
    for m in objects:
        bucket(m.mac_address)["objects"].append(_mac_object(m))

    from monitoring.mac_location import location_cells
    from monitoring.mac_tables import canon_mac

    vendors = vendors_for(entries.keys(), tenant)
    # Where each MAC was learned - the MAC page's Location, for every row in
    # one batch (#344).
    canon = {key: canon_mac(key) for key in entries}
    located = location_cells(tenant, set(canon.values()) - {None}, user)
    for key, entry in entries.items():
        override = next((o["vendor_override"] for o in entry["objects"] if o["vendor_override"]), "")
        entry["vendor"] = (
            {"name": override, "source": "override"} if override else vendors.get(hexkey(key))
        )
        entry["location"] = located.get(canon[key])
    results = sorted(entries.values(), key=lambda e: _norm(e["mac"]))
    return Response({"count": len(results), "results": results})


@extend_schema(
    summary="Detail for one MAC address: interfaces bearing it, IPs paired with "
    "it, first-class MAC objects recorded for it, and where the network has "
    "seen it",
    tags=["mac-addresses"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{mac, vendor, objects[], interfaces[], vm_interfaces[], ips[], "
        "seen[], location, ips_observed[], names[], name, name_source} for the "
        "given MAC address in any notation, or 404 when nothing carries it.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def mac_detail_view(request, mac):
    """One MAC address: every interface that bears it, every IP paired with it,
    and every first-class MAC object recorded for it (with the description /
    tags / custom fields you can edit)."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "Not found."}, status=404)
    user = request.user
    if not rbac.has_action(user, tenant, "macaddress", "view"):
        return Response({"detail": "macaddress.view required."}, status=403)

    from monitoring.mac_location import enrich, locate, location_payload, vlan_objects
    from monitoring.mac_tables import canon_mac

    key = _norm(mac)
    # Any notation of a whole MAC - colons, dashes, Cisco dots, bare hex -
    # names the same address (#284).
    canon = canon_mac(key)
    ifaces = _visible(
        _match_mac(Interface.objects.filter(device__tenant=tenant), "mac_address", key, canon)
        .select_related("device")
        .order_by(natural("device__name"), natural("name")),
        user, tenant, "interface",
    )
    vm_ifaces = _visible(
        _match_mac(VMInterface.objects.filter(vm__tenant=tenant), "mac_address", key, canon)
        .select_related("vm")
        .order_by(natural("vm__name"), natural("name")),
        user, tenant, "vminterface",
    )
    ips = _visible(
        _match_mac(IPAddress.objects.filter(tenant=tenant), "mac_address", key, canon)
        .select_related("assigned_device", "assigned_interface", "status")
        .order_by("ip_address"),
        user, tenant, "ipaddress",
    )
    objects = _visible(
        _match_mac(MACAddress.objects.filter(tenant=tenant), "mac_address", key, canon)
        .select_related("assigned_interface__device")
        .prefetch_related("tags")
        .order_by(
            natural("assigned_interface__device__name"), natural("assigned_interface__name")
        ),
        user, tenant, "macaddress",
    )
    seen = _snmp_sightings(tenant, key, user)
    # Where it is, what it answers to and what it's called - each source cut
    # to the caller's scope for its own type (#284).
    location = None
    observed = {"ips": [], "names": [], "name": None, "name_source": None}
    if canon:
        loc = locate(tenant, [canon], user).get(canon)
        if loc is not None:
            vlans = vlan_objects(tenant, user, {(loc.at.site_id, loc.at.vlan)})
            location = location_payload(loc, vlans)
        observed = enrich(tenant, [canon], user).get(canon) or observed
    if (
        not ifaces.exists()
        and not vm_ifaces.exists()
        and not ips.exists()
        and not objects.exists()
        and not seen
        and not observed["ips"]
    ):
        return Response({"detail": "Not found."}, status=404)

    if ifaces.exists():
        display = ifaces.first().mac_address
    elif vm_ifaces.exists():
        display = vm_ifaces.first().mac_address
    elif ips.exists():
        display = ips.first().mac_address
    elif objects.exists():
        display = objects.first().mac_address
    else:
        display = canon or key

    override = next((m.vendor_override for m in objects if m.vendor_override), "")
    vendor = (
        {"name": override, "source": "override"} if override else vendor_for(key, tenant)
    )
    # An IP's device and interface are rows of their own: named only when the
    # caller may view them.
    ips = list(ips)
    devices = _visible_ids(
        Device, "tenant", {ip.assigned_device_id for ip in ips} - {None},
        user, tenant, "device",
    )
    ports = _visible_ids(
        Interface, "device__tenant", {ip.assigned_interface_id for ip in ips} - {None},
        user, tenant, "interface",
    )
    return Response(
        {
            "mac": display,
            "vendor": vendor,
            "seen": seen,
            "location": location,
            "ips_observed": observed["ips"],
            "names": observed["names"],
            "name": observed["name"],
            "name_source": observed["name_source"],
            "objects": [_mac_object(m, with_custom_fields=True) for m in objects],
            "interfaces": [
                {**_iface_ref(i), "enabled": i.enabled} for i in ifaces
            ],
            "vm_interfaces": [
                {**_vm_iface_ref(vi), "enabled": vi.enabled} for vi in vm_ifaces
            ],
            "ips": [
                {
                    "id": str(ip.id),
                    "ip_address": ip.ip_address,
                    "status": (
                        {
                            "name": ip.status.name,
                            "color": ip.status.color,
                            "text_color": ip.status.text_color,
                        }
                        if ip.status_id
                        else None
                    ),
                    "device": (
                        {"id": str(ip.assigned_device_id), "name": ip.assigned_device.name}
                        if ip.assigned_device_id in devices
                        else None
                    ),
                    "interface": (
                        {"id": str(ip.assigned_interface_id), "name": ip.assigned_interface.name}
                        if ip.assigned_interface_id in ports
                        else None
                    ),
                }
                for ip in ips
            ],
        }
    )
