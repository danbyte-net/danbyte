"""One SNMP poll target - a device or a virtual machine - behind one interface.

Poll now, the scheduled core poller, ``poll_snmp`` and an Outpost's SNMP work
list and result ingest all work on an ``SnmpTarget``. What differs between the
two kinds lives here and nowhere else: how the profile resolves, which address
is polled, the store row it writes, and where the object sits for engine
resolution (``monitoring.engines.engine_for_target``). Everything downstream
of that - which engine polls it, the queue on an Outpost, the fetch and the
persistence - is the same code for both (#325).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

DEVICE = "device"
VM = "vm"
KINDS = (DEVICE, VM)


@dataclass(frozen=True, eq=False)
class SnmpTarget:
    kind: str
    obj: Any

    # ─── Construction ────────────────────────────────────────────────────

    @classmethod
    def of(cls, obj) -> SnmpTarget:
        """The target for a Device, a VirtualMachine, or an existing target."""
        if isinstance(obj, SnmpTarget):
            return obj
        from api.models import Device, VirtualMachine

        if isinstance(obj, Device):
            return cls(DEVICE, obj)
        if isinstance(obj, VirtualMachine):
            return cls(VM, obj)
        raise TypeError(f"not an SNMP target: {type(obj).__name__}")

    # ─── Identity ────────────────────────────────────────────────────────

    @property
    def id(self):
        return self.obj.id

    @property
    def key(self) -> tuple:
        return (self.kind, self.obj.id)

    @property
    def tenant_id(self):
        return self.obj.tenant_id

    @property
    def tenant(self):
        return self.obj.tenant

    @property
    def is_vm(self) -> bool:
        return self.kind == VM

    @property
    def noun(self) -> str:
        return "VM" if self.is_vm else "Device"

    # ─── Where it sits - what engine resolution reads ────────────────────

    @property
    def engine_scope(self):
        """The ``MonitoringEngineBinding`` scope of the object's own binding,
        or None when the kind has none."""
        from .models import MonitoringEngineBinding

        return None if self.is_vm else MonitoringEngineBinding.SCOPE_DEVICE

    @property
    def location_id(self):
        return None if self.is_vm else self.obj.location_id

    @property
    def own_site_id(self):
        return self.obj.site_id

    @property
    def cluster_id(self):
        return self.obj.cluster_id if self.is_vm else None

    def site_id(self):
        """The site the target answers to: its own, else its location's (a
        device placed in a room of a site), else its cluster's (a VM with no
        site of its own runs where its cluster is)."""
        if self.own_site_id:
            return self.own_site_id
        if self.location_id:
            return self.obj.location.site_id
        if self.cluster_id:
            return self.obj.cluster.site_id
        return None

    # ─── What is polled ──────────────────────────────────────────────────

    def owner(self) -> SnmpTarget:
        """The target that is actually polled: a stack member reads through
        its owner (#148); everything else is its own owner."""
        if not self.is_vm and self.obj.virtual_chassis_id:
            from .vc_stack import stack_owner

            owner = stack_owner(self.obj)
            if owner.id != self.obj.id:
                return SnmpTarget(DEVICE, owner)
        return self

    def resolve_profile(self, tenant):
        """``(SnmpProfile | None, source)`` along the kind's hierarchy."""
        from .snmp_resolve import resolve_device_profile, resolve_vm_profile

        if self.is_vm:
            return resolve_vm_profile(self.obj, tenant)
        return resolve_device_profile(self.obj, tenant)

    def address(self):
        """The address to poll, or None."""
        from .snmp_poll import _device_target, _vm_target

        return _vm_target(self.obj) if self.is_vm else _device_target(self.obj)

    def params(self, profile) -> dict:
        from .snmp_poll import snmp_params

        return snmp_params(profile, None if self.is_vm else self.obj)

    def store(self) -> dict:
        """The ``DeviceSnmp`` lookup for this target's observed row."""
        return {"vm": self.obj} if self.is_vm else {"device": self.obj}

    # ─── Operator messages ───────────────────────────────────────────────

    def no_profile_detail(self) -> str:
        if self.is_vm:
            return (
                "No SNMP profile resolves for this VM - assign one on the VM, "
                "its platform/cluster, or set a tenant default."
            )
        return (
            "No SNMP profile resolves for this device - assign one on the "
            "device, its role, its type, or set a tenant default."
        )

    def no_target_detail(self) -> str:
        if self.is_vm:
            return "VM has no primary IP to poll."
        return "Device has no primary IP or name to poll."


def model_for(kind):
    from api.models import Device, VirtualMachine

    return VirtualMachine if kind == VM else Device


def load(kind, object_id, tenant):
    """The tenant's target of ``kind`` with ``object_id``, or None."""
    if kind not in KINDS:
        return None
    obj = model_for(kind).objects.filter(pk=object_id, tenant=tenant).first()
    return SnmpTarget(kind, obj) if obj is not None else None


def candidates(tenant, kind):
    """The queryset of ``kind`` objects that are SNMP targets at all.

    Every device is. A VM is one once something says it runs an SNMP agent:
    a profile bound to the VM itself, its platform or its cluster, or an
    observed row - it has been polled, or Poll now queued it on an Outpost.
    Without that bar a tenant-default profile would put every hypervisor
    guest on the schedule and on its Outpost's work list, and most of them
    would only ever time out."""
    model = model_for(kind)
    qs = model.objects.filter(tenant=tenant)
    if kind != VM:
        return qs
    from django.db.models import Q

    from .models import SnmpProfileBinding

    bound: dict = {
        SnmpProfileBinding.SCOPE_VM: [],
        SnmpProfileBinding.SCOPE_PLATFORM: [],
        SnmpProfileBinding.SCOPE_CLUSTER: [],
    }
    for scope, oid in SnmpProfileBinding.objects.filter(
        tenant=tenant, scope__in=list(bound)
    ).values_list("scope", "object_id"):
        bound[scope].append(oid)
    return qs.filter(
        Q(snmp__isnull=False)
        | Q(id__in=bound[SnmpProfileBinding.SCOPE_VM])
        | Q(platform_id__in=bound[SnmpProfileBinding.SCOPE_PLATFORM])
        | Q(cluster_id__in=bound[SnmpProfileBinding.SCOPE_CLUSTER])
    )
