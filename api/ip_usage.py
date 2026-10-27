"""The addresses a device or VM uses - one definition behind its IPs tab, the
tab's count and the ``?device=`` / ``?virtual_machine=`` filters on
``/api/ips/``.

An object uses an address when the address is assigned to the object, to one
of its interfaces, or sits in one of its address slots (primary, OOB,
secondary) - a slot may hold an address assigned elsewhere, and that address
is still one this object answers on.
"""
from __future__ import annotations

from django.db.models import Count, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce

from .models import IPAddress

# Per kind: the direct assignment, the interface assignment (as a path to the
# interface's owner) and the object's address slots.
_KINDS = {
    "device": (
        "assigned_device_id",
        "assigned_interface__device_id",
        ("primary_ip_id", "oob_ip_id", "secondary_ip_id"),
    ),
    "vm": (
        "assigned_vm_id",
        "assigned_vm_interface__vm_id",
        ("primary_ip_id",),
    ),
}


def addresses_q(kind: str, obj=None) -> Q:
    """``Q`` over IPAddress for the addresses ``obj`` uses. Without ``obj`` it
    refers to the outer row (``OuterRef``), for a per-row count subquery."""
    direct, via_iface, slots = _KINDS[kind]
    if obj is None:
        pk = OuterRef("pk")
        slot_refs = [OuterRef(s) for s in slots]
    else:
        pk = obj.pk
        slot_refs = [getattr(obj, s) for s in slots if getattr(obj, s)]
    q = Q(**{direct: pk}) | Q(**{via_iface: pk})
    for ref in slot_refs:
        q |= Q(pk=ref)
    return q


def address_count(kind: str):
    """How many addresses the outer row uses, as one correlated subquery so a
    list of devices or VMs pays no query per row. Same tenant only."""
    return Coalesce(
        Subquery(
            IPAddress.objects.filter(addresses_q(kind), tenant_id=OuterRef("tenant_id"))
            .order_by()
            .values("tenant_id")
            .annotate(n=Count("pk", distinct=True))
            .values("n")
        ),
        0,
    )


def addresses_of(kind: str, obj):
    """The addresses ``obj`` uses, in its tenant."""
    return IPAddress.objects.filter(addresses_q(kind, obj), tenant_id=obj.tenant_id)


def assigned_addresses(kind: str, obj):
    """The addresses assigned to ``obj`` or to one of its interfaces, in its
    tenant, lowest first with IPv4 before IPv6. The address slots are left
    out: a slot may hold an address assigned elsewhere."""
    import ipaddress

    direct, via_iface, _slots = _KINDS[kind]
    rows = IPAddress.objects.filter(
        Q(**{direct: obj.pk}) | Q(**{via_iface: obj.pk}), tenant_id=obj.tenant_id
    ).distinct()

    def order(ip):
        try:
            addr = ipaddress.ip_address(str(ip.ip_address).split("/")[0])
        except ValueError:
            return (9, 0, str(ip.ip_address))
        return (addr.version, int(addr), "")

    return sorted(rows, key=order)
