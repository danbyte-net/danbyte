"""Ansible dynamic-inventory endpoint - Danbyte as a pull source of truth.

`GET /api/inventory/ansible/` returns the standard Ansible inventory-script JSON
for the active tenant's **devices and virtual machines**: groups by
site/region/role/platform/status/tag (plus cluster/cluster-group for VMs), and
per-host vars (primary IP as ansible_host, key attributes, and the merged config
context). Point an Ansible inventory plugin / `-i` script at it and playbooks
render + push - credentials stay in the runner, never in Danbyte.

Each host's ``danbyte.kind`` is ``device`` or ``virtual_machine``, and the
``all_devices`` / ``all_vms`` groups let a play target one or the other. Host
names are expected unique across devices and VMs (Ansible requires it); on the
rare collision the device wins and the VM is skipped.
"""
from __future__ import annotations

import re

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.rbac import restrict_queryset

from .config_context import render_config_context
from .views import _get_active_tenant


def _grp(*parts) -> str:
    """A safe Ansible group name (lowercase, non-alnum → _)."""
    raw = "_".join(str(p) for p in parts if p)
    return re.sub(r"[^a-z0-9_]+", "_", raw.lower()).strip("_") or "ungrouped"


def _ip_dict(ip) -> dict:
    """An interface-assigned IP: the bare address plus its CIDR (host address +
    the prefix's mask length), so a play can render either form."""
    masklen = str(ip.prefix.cidr).split("/")[-1] if ip.prefix_id else None
    return {
        "address": ip.ip_address,
        "cidr": f"{ip.ip_address}/{masklen}" if masklen else None,
    }


def _iface_dict(iface) -> dict:
    """One device interface, shaped for network playbooks."""
    return {
        "name": iface.name,
        "type": iface.type or None,
        "enabled": iface.enabled,
        "mac_address": iface.mac_address or None,
        "mtu": iface.mtu,
        "speed": iface.speed or None,
        "virtual": iface.virtual,
        "vlan": (
            {"vid": iface.vlan.vlan_id, "name": iface.vlan.name}
            if iface.vlan_id else None
        ),
        "ip_addresses": [_ip_dict(ip) for ip in iface.ip_addresses.all()],
        "tags": [t.slug for t in iface.tags.all()],
        "custom_fields": iface.custom_fields or {},
    }


def with_inventory_relations(qs):
    """Apply the select_related + Prefetch chain that ``device_hostvars`` /
    ``device_groups`` need, so building them is N+1-free - for the whole fleet
    *and* a single-device fetch."""
    from django.db.models import Prefetch

    from .models import Interface, IPAddress

    iface_qs = (
        Interface.objects.select_related("vlan")
        .prefetch_related(
            "tags",
            Prefetch(
                "ip_addresses",
                queryset=IPAddress.objects.select_related("prefix").order_by("ip_address"),
            ),
        )
        .order_by("name")
    )
    return qs.select_related(
        "site", "site__region", "role", "platform",
        "primary_ip", "device_type", "device_type__manufacturer",
    ).prefetch_related("tags", Prefetch("interfaces", queryset=iface_qs))


def device_hostvars(d) -> dict:
    """The per-host vars Ansible sees for one device - the ``danbyte`` metadata
    block, interfaces, custom fields, merged config context, and ansible_host."""
    hv = {
        "danbyte": {
            "id": str(d.id),
            "kind": "device",
            "site": d.site.name if d.site_id else None,
            "region": d.site.region.name if (d.site_id and d.site.region_id) else None,
            "role": d.role.slug if d.role_id else None,
            "platform": d.platform.slug if d.platform_id else None,
            "status": d.status.slug if d.status_id else None,
            "serial_number": d.serial_number or None,
            "asset_tag": d.asset_tag or None,
            "device_type": d.device_type.model if d.device_type_id else None,
            "manufacturer": (
                d.device_type.manufacturer.name
                if d.device_type_id and d.device_type.manufacturer_id else None
            ),
            "tags": [t.slug for t in d.tags.all()],
            # User-defined custom fields, keyed by field name. A playbook can
            # read e.g. ``danbyte.custom_fields.install_btop`` to gate a task.
            "custom_fields": d.custom_fields or {},
            # The device's interfaces (name/type/mtu/mac/vlan/assigned IPs),
            # so network plays can iterate ``danbyte.interfaces``.
            "interfaces": [_iface_dict(i) for i in d.interfaces.all()],
        },
        "config_context": render_config_context(d)["rendered"],
    }
    if d.primary_ip_id:
        hv["ansible_host"] = d.primary_ip.ip_address
    return hv


def device_groups(d) -> list[str]:
    """The inventory groups one device belongs to (site/region/role/platform/
    status/tag/cf), plus the catch-all ``all_devices``."""
    groups = ["all_devices"]
    if d.site_id:
        groups.append(_grp("site", d.site.name))
        if d.site.region_id:
            groups.append(_grp("region", d.site.region.name))
    if d.role_id:
        groups.append(_grp("role", d.role.slug))
    if d.platform_id:
        groups.append(_grp("platform", d.platform.slug))
    groups.append(_grp("status", d.status.slug if d.status_id else "none"))
    for t in d.tags.all():
        groups.append(_grp("tag", t.slug))
    # Each boolean custom field that's ON becomes a ``cf_<name>`` group, so a
    # playbook can target ``hosts: cf_install_btop`` instead of a ``when:``.
    for key, val in (d.custom_fields or {}).items():
        if val is True:
            groups.append(_grp("cf", key))
    return groups


def _vm_iface_dict(iface) -> dict:
    """One VM interface. VMInterface has no type/speed/virtual (it's virtual by
    definition), so this is the Interface shape minus those."""
    return {
        "name": iface.name,
        "enabled": iface.enabled,
        "mac_address": iface.mac_address or None,
        "mtu": iface.mtu,
        "speed": iface.speed or None,
        "vlan": (
            {"vid": iface.vlan.vlan_id, "name": iface.vlan.name}
            if iface.vlan_id else None
        ),
        "ip_addresses": [_ip_dict(ip) for ip in iface.ip_addresses.all()],
        "tags": [t.slug for t in iface.tags.all()],
        "custom_fields": iface.custom_fields or {},
    }


def with_vm_inventory_relations(qs):
    """The select_related + Prefetch chain ``vm_hostvars``/``vm_groups`` need,
    so building the VM half of the inventory is N+1-free."""
    from django.db.models import Prefetch

    from .models import IPAddress, VMInterface

    iface_qs = (
        VMInterface.objects.select_related("vlan")
        .prefetch_related(
            "tags",
            Prefetch(
                "ip_addresses",
                queryset=IPAddress.objects.select_related("prefix").order_by("ip_address"),
            ),
        )
        .order_by("name")
    )
    return qs.select_related(
        "site", "site__region", "role", "platform", "status",
        "cluster", "cluster__group", "primary_ip", "device",
    ).prefetch_related("tags", Prefetch("interfaces", queryset=iface_qs))


def vm_hostvars(vm) -> dict:
    """Per-host vars for one VM - the ``danbyte`` block (with cluster + resource
    facts), interfaces, custom fields, merged config context, and ansible_host."""
    hv = {
        "danbyte": {
            "id": str(vm.id),
            "kind": "virtual_machine",
            "site": vm.site.name if vm.site_id else None,
            "region": vm.site.region.name if (vm.site_id and vm.site.region_id) else None,
            "role": vm.role.slug if vm.role_id else None,
            "platform": vm.platform.slug if vm.platform_id else None,
            "status": vm.status.slug if vm.status_id else None,
            "cluster": vm.cluster.name if vm.cluster_id else None,
            "cluster_group": (
                vm.cluster.group.name
                if vm.cluster_id and vm.cluster.group_id else None
            ),
            # The physical host the VM is pinned to, when one is set.
            "host": vm.device.name if vm.device_id else None,
            "vcpus": vm.vcpus,
            "memory_mb": vm.memory_mb,
            "disk_gb": vm.disk_gb,
            "tags": [t.slug for t in vm.tags.all()],
            "custom_fields": vm.custom_fields or {},
            "interfaces": [_vm_iface_dict(i) for i in vm.interfaces.all()],
        },
        "config_context": render_config_context(vm)["rendered"],
    }
    if vm.primary_ip_id:
        hv["ansible_host"] = vm.primary_ip.ip_address
    return hv


def vm_groups(vm) -> list[str]:
    """The inventory groups one VM belongs to - the device set plus cluster and
    cluster-group, and the catch-all ``all_vms``."""
    groups = ["all_vms"]
    if vm.site_id:
        groups.append(_grp("site", vm.site.name))
        if vm.site.region_id:
            groups.append(_grp("region", vm.site.region.name))
    if vm.role_id:
        groups.append(_grp("role", vm.role.slug))
    if vm.platform_id:
        groups.append(_grp("platform", vm.platform.slug))
    if vm.cluster_id:
        groups.append(_grp("cluster", vm.cluster.name))
        if vm.cluster.group_id:
            groups.append(_grp("cluster_group", vm.cluster.group.name))
    groups.append(_grp("status", vm.status.slug if vm.status_id else "none"))
    for t in vm.tags.all():
        groups.append(_grp("tag", t.slug))
    for key, val in (vm.custom_fields or {}).items():
        if val is True:
            groups.append(_grp("cf", key))
    return groups


@extend_schema(
    summary="Ansible dynamic-inventory JSON for the active tenant's devices + VMs",
    tags=["inventory"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="has_primary_ip",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Only devices with a primary IP (1/true/yes).",
        ),
        OpenApiParameter(
            name="status",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter by device status slug.",
        ),
        OpenApiParameter(
            name="site",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter by site name.",
        ),
        OpenApiParameter(
            name="role",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter by device role slug.",
        ),
        OpenApiParameter(
            name="platform",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter by platform slug.",
        ),
        OpenApiParameter(
            name="kind",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Limit to one kind: 'device' or 'vm'. Default: both.",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Standard Ansible inventory-script JSON: `_meta.hostvars` per device "
            "and VM (danbyte metadata incl. `kind`, interfaces, custom fields, "
            "merged config context, ansible_host) plus site/region/role/platform/"
            "status/tag groups, cluster/cluster-group for VMs, and all_devices/"
            "all_vms."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ansible_inventory(request):
    tenant = _get_active_tenant(request)
    empty = {"_meta": {"hostvars": {}}, "all": {"children": ["ungrouped"]},
             "ungrouped": {"hosts": []}}
    if tenant is None:
        return Response(empty)

    from .models import Device

    qs = with_inventory_relations(
        Device.objects.filter(tenant=tenant)
    ).order_by("name")
    qs = restrict_queryset(qs, request.user, tenant, "device", "view")

    p = request.query_params
    if p.get("has_primary_ip") in ("1", "true", "yes"):
        qs = qs.exclude(primary_ip__isnull=True)
    if p.get("status"):
        qs = qs.filter(status__slug=p["status"])
    if p.get("site"):
        qs = qs.filter(site__name=p["site"])
    if p.get("role"):
        qs = qs.filter(role__slug=p["role"])
    if p.get("platform"):
        qs = qs.filter(platform__slug=p["platform"])

    hostvars: dict = {}
    groups: dict[str, set] = {}

    def add(group: str, host: str):
        groups.setdefault(group, set()).add(host)

    kind = (p.get("kind") or "").lower()
    if kind != "vm":
        for d in qs:
            host = d.name
            hostvars[host] = device_hostvars(d)
            for g in device_groups(d):
                add(g, host)

    if kind != "device":
        from .models import VirtualMachine

        vqs = with_vm_inventory_relations(
            VirtualMachine.objects.filter(tenant=tenant)
        ).order_by("name")
        vqs = restrict_queryset(vqs, request.user, tenant, "virtualmachine", "view")
        if p.get("has_primary_ip") in ("1", "true", "yes"):
            vqs = vqs.exclude(primary_ip__isnull=True)
        if p.get("status"):
            vqs = vqs.filter(status__slug=p["status"])
        if p.get("site"):
            vqs = vqs.filter(site__name=p["site"])
        if p.get("role"):
            vqs = vqs.filter(role__slug=p["role"])
        if p.get("platform"):
            vqs = vqs.filter(platform__slug=p["platform"])

        for vm in vqs:
            host = vm.name
            # A device with the same name already claimed this host - Ansible
            # keys hostvars by name, so the device wins and the VM is skipped
            # rather than silently clobbering the device's vars.
            if host in hostvars:
                continue
            hostvars[host] = vm_hostvars(vm)
            for g in vm_groups(vm):
                add(g, host)

    out: dict = {"_meta": {"hostvars": hostvars}}
    for g, hosts in groups.items():
        out[g] = {"hosts": sorted(hosts)}
    out["all"] = {"children": sorted(groups.keys()) or ["ungrouped"]}
    if "ungrouped" not in out:
        out["ungrouped"] = {"hosts": []}
    return Response(out)
