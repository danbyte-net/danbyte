"""What keeps discovery off an address it does not carry the flag for itself.

A prefix's ``scan_exempt`` covers every address inside it, in the prefix's
VRF (``scope.resolve`` and ``services`` enforce it). ``exempt_through``
names that prefix for the address's page, read-only: the flag is changed on
the prefix.
"""
from __future__ import annotations

import ipaddress


def exempt_through(ip, user=None) -> dict | None:
    """``{id, cidr}`` of the exempt prefix covering ``ip`` (its own prefix
    first, then the narrowest exempt prefix of its VRF around it), or None.
    A prefix ``user`` may not view is named ``{id: None, cidr: None}``: the
    address is still exempt, the prefix stays hidden. Two queries at most."""
    from api.models import Prefix
    from auth_api import rbac

    try:
        addr = ipaddress.ip_address(str(ip.ip_address).split("/")[0])
    except ValueError:
        return None
    found = None
    own = ip.prefix if ip.prefix_id else None
    if own is not None and own.scan_exempt and own.tenant_id == ip.tenant_id:
        found = own
    if found is None:
        best = None
        for pk, cidr in Prefix.objects.filter(
                tenant_id=ip.tenant_id, scan_exempt=True,
                vrf_id=ip.vrf_id).values_list("pk", "cidr"):
            try:
                net = ipaddress.ip_network(cidr, strict=False)
            except ValueError:
                continue
            if net.version == addr.version and addr in net \
                    and (best is None or net.prefixlen > best[1].prefixlen):
                best = (pk, net)
        if best is None:
            return None
        found = Prefix(pk=best[0], cidr=str(best[1]), tenant_id=ip.tenant_id)
    if user is not None and not getattr(user, "is_superuser", False):
        visible = rbac.restrict_queryset(
            Prefix.objects.filter(tenant_id=ip.tenant_id, pk=found.pk), user,
            ip.tenant, "prefix", "view")
        if not visible.exists():
            return {"id": None, "cidr": None}
    return {"id": str(found.pk), "cidr": found.cidr}
