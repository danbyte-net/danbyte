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

from .models import Interface, IPAddress, VMInterface

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

# Per kind: the address's interface key, the interface model and its owner.
_IFACES = {
    "device": ("assigned_interface_id", Interface, "device_id"),
    "vm": ("assigned_vm_interface_id", VMInterface, "vm_id"),
}


def addresses_q(kind: str, obj=None, *, one: bool | None = None) -> Q:
    """``Q`` over IPAddress for the addresses ``obj`` uses. Without ``obj`` it
    refers to the outer row (``OuterRef``), for a per-row count subquery.

    ``one`` (the default with ``obj``) reads the object's interfaces as an
    ``IN`` list rather than a join: for one object Postgres then walks the two
    foreign-key indexes, where the join's OR made it hash every interface in
    the database. A list keeps the join, which is cheaper over many rows."""
    direct, via_iface, slots = _KINDS[kind]
    if obj is None:
        pk = OuterRef("pk")
        slot_refs = [OuterRef(s) for s in slots]
    else:
        pk = obj.pk
        slot_refs = [getattr(obj, s) for s in slots if getattr(obj, s)]
    if one is None:
        one = obj is not None
    if one:
        fk, model, owner = _IFACES[kind]
        # Nested one level deeper than the address filter: the outer row is
        # two queries out.
        inner = OuterRef(OuterRef("pk")) if obj is None else pk
        via = Q(**{f"{fk}__in": model.objects.filter(**{owner: inner}).values("pk")})
    else:
        via = Q(**{via_iface: pk})
    q = Q(**{direct: pk}) | via
    for ref in slot_refs:
        q |= Q(pk=ref)
    return q


def address_count(kind: str, *, one: bool = False):
    """How many addresses the outer row uses, as one correlated subquery.
    Same tenant only. ``one`` for a single-object read (see
    :func:`addresses_q`). Not for a list: the OR defeats every index, so each
    row reads all of the tenant's addresses - a list counts its page with
    :func:`attach_address_counts` (#455)."""
    return Coalesce(
        Subquery(
            IPAddress.objects.filter(addresses_q(kind, one=one), tenant_id=OuterRef("tenant_id"))
            .order_by()
            .values("tenant_id")
            .annotate(n=Count("pk", distinct=True))
            .values("n")
        ),
        0,
    )


def attach_address_counts(kind: str, objs) -> None:
    """Set ``ip_count_annotated`` on each of ``objs`` (devices or VMs, a
    list's page) to the number of addresses it uses - the same number as
    :func:`address_count`, in one query for the whole page (#455).

    The per-row subquery ORs the assignment, the interface and the slots, so
    Postgres can use no index and read every address of the tenant for each
    row: a page cost rows x tenant addresses. Here each branch is its own
    indexed lookup over the page's ids, the ``UNION`` drops an address that
    reaches the same object twice, and the pairs are counted in Python - as
    many as the page's objects use, whatever the tenant holds."""
    objs = [o for o in objs if getattr(o, "ip_count_annotated", None) is None]
    if not objs:
        return
    direct, via_iface, slots = _KINDS[kind]
    ids = [o.pk for o in objs]
    model = type(objs[0])
    branches = [
        IPAddress.objects.filter(**{f"{direct}__in": ids})
        .order_by().values_list(direct, "pk", "tenant_id"),
        IPAddress.objects.filter(**{f"{via_iface}__in": ids})
        .order_by().values_list(via_iface, "pk", "tenant_id"),
    ]
    for slot in slots:
        rel = slot.removesuffix("_id")
        branches.append(
            model.objects.filter(pk__in=ids, **{f"{rel}__isnull": False})
            .order_by().values_list("pk", slot, f"{rel}__tenant_id")
        )
    pairs = branches[0].union(*branches[1:])
    tenant_of = {o.pk: o.tenant_id for o in objs}
    counts: dict = {}
    for owner, _ip, tenant_id in pairs:
        if tenant_id == tenant_of.get(owner):
            counts[owner] = counts.get(owner, 0) + 1
    for o in objs:
        o.ip_count_annotated = counts.get(o.pk, 0)


def address_counts(kind: str, qs) -> dict:
    """``{pk: addresses used}`` for every row of ``qs`` (devices or VMs) -
    :func:`attach_address_counts` over a whole filtered list, for the IPs
    range filter of a server-paged list (#482). Rows using none are left
    out."""
    pairs_of = dict(qs.order_by().values_list("pk", "tenant_id"))
    if not pairs_of:
        return {}
    direct, via_iface, slots = _KINDS[kind]
    ids = list(pairs_of)
    branches = [
        IPAddress.objects.filter(**{f"{direct}__in": ids})
        .order_by().values_list(direct, "pk", "tenant_id"),
        IPAddress.objects.filter(**{f"{via_iface}__in": ids})
        .order_by().values_list(via_iface, "pk", "tenant_id"),
    ]
    for slot in slots:
        rel = slot.removesuffix("_id")
        branches.append(
            qs.model.objects.filter(pk__in=ids, **{f"{rel}__isnull": False})
            .order_by().values_list("pk", slot, f"{rel}__tenant_id")
        )
    counts: dict = {}
    for owner, _ip, tenant_id in branches[0].union(*branches[1:]):
        if tenant_id == pairs_of.get(owner):
            counts[owner] = counts.get(owner, 0) + 1
    return counts


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
