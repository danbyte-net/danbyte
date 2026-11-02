"""The build description of a virtual machine, as plain data.

One shape for everything that hands a VM to something that builds it: the
``provision`` payload sent to an automation runner, the ``build`` key of a
VM render and the ``backing_vm`` key of a device render. Plain dicts, so a
template cannot walk from them into rows, and no secrets: credentials stay
with the runner.
"""
from __future__ import annotations


def _interface(iface) -> dict:
    return {
        "id": str(iface.id),
        "name": iface.name,
        "index": iface.index,
        "model": iface.model,
        "bridge": iface.bridge,
        "firewall": iface.firewall,
        "mac_address": iface.mac_address,
        "mtu": iface.mtu,
        "vlan": iface.vlan.vlan_id if iface.vlan_id else None,
        "enabled": iface.enabled,
        "kind": iface.kind,
    }


def _disk(disk) -> dict:
    return {
        "key": disk.key,
        "name": disk.name,
        "size_gb": disk.size_gb,
        "storage": disk.storage,
        "controller": disk.controller,
        "disk_format": disk.disk_format,
    }


def _iface_order(iface):
    # netN order first; NICs with no index after, by name.
    return (iface.index is None, iface.index or 0, iface.name)


def _visible_device(device, user, tenant):
    """``device`` when nobody in particular reads the spec, or when ``user``
    may view it; else ``None``, so a render does not name a device the
    reader cannot see."""
    if device is None or user is None:
        return device
    from auth_api import rbac

    from .models import Device

    ok = rbac.restrict_queryset(
        Device.objects.filter(pk=device.pk, tenant=tenant), user, tenant, "device", "view",
    ).exists()
    return device if ok else None


def vm_build_spec(vm, user=None, tenant=None) -> dict:
    """Everything a runner needs to (re)create ``vm`` on a hypervisor.
    ``user`` (with ``tenant``) hides the devices that reader may not view."""
    tenant = tenant or vm.tenant
    ifaces = sorted(vm.interfaces.select_related("vlan"), key=_iface_order)
    rep = _visible_device(vm.represents_device, user, tenant)
    host = _visible_device(vm.device, user, tenant)
    return {
        "id": str(vm.id),
        "name": vm.name,
        "intended": vm.intended,
        "vmid": vm.vmid,
        "cluster": vm.cluster.name if vm.cluster_id else None,
        "node": host.name if host is not None else None,
        "cpu_type": vm.cpu_type,
        "sockets": vm.sockets,
        "vcpus": vm.vcpus,
        "memory_mb": vm.memory_mb,
        "disk_gb": vm.disk_gb,
        "image": vm.image,
        "storage": vm.storage,
        "hypervisor_options": dict(vm.hypervisor_options or {}),
        "represents_device": (
            {"id": str(rep.id), "name": rep.name} if rep is not None else None
        ),
        "interfaces": [_interface(i) for i in ifaces],
        "disks": [_disk(d) for d in vm.disks.all()],
    }
