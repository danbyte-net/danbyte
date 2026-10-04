"""The IP addresses a caller may see where another row lists them.

An interface's address list, a VM interface's, and a tunnel end's outside
address are IP rows in their own right. They pass the caller's
``ipaddress.view`` scope in the active tenant, the same rule as the IP list
and the interface IPs tab, so a viewer limited to Site A never learns the
Site B address bound to a Site A port. A device's primary, secondary and OOB
addresses are device attributes and are not filtered here (see
``topology_enrich._card_ips``).

Viewsets prefetch the visible rows once per page with the ``*_prefetch``
helpers; serializers read them through ``assigned_ips`` / ``outside_ip``,
which fall back to one restricted query for a row that was not prefetched
(a create's response).
"""
from __future__ import annotations

from django.db.models import Prefetch

# Where the prefetched, already-restricted rows land on each parent row.
VISIBLE_IPS = "visible_ips"
VISIBLE_OUTSIDE_IP = "visible_outside_ip"


def visible_ips(request, tenant):
    """The tenant's IP rows the caller may view, unevaluated.

    A superuser gets the tenant's rows unchanged. No grant, no tenant or no
    signed-in user gives ``none()``, which Django answers without a query.
    """
    from auth_api import rbac

    from .models import IPAddress

    qs = IPAddress.objects.filter(tenant=tenant)
    user = getattr(request, "user", None)
    if tenant is None or not getattr(user, "is_authenticated", False):
        return qs.none()
    return rbac.restrict_queryset(qs, user, tenant, "ipaddress", "view")


def assigned_ips_prefetch(request, tenant, fk="assigned_interface"):
    """``ip_addresses`` of each interface (``fk="assigned_vm_interface"`` for
    VM interfaces), cut to the visible rows: one query per page."""
    return Prefetch(
        "ip_addresses",
        queryset=visible_ips(request, tenant).only("id", "ip_address", fk),
        to_attr=VISIBLE_IPS,
    )


def outside_ip_prefetch(request, tenant, lookup="outside_ip"):
    """Each tunnel end's ``outside_ip`` when the caller may view it, else
    None: one query per page. From a tunnel, ``lookup`` is
    ``terminations__outside_ip``."""
    return Prefetch(
        lookup,
        queryset=visible_ips(request, tenant).only("id", "ip_address"),
        to_attr=VISIBLE_OUTSIDE_IP,
    )


def forget_visible(obj) -> None:
    """Drop the visible rows prefetched onto ``obj`` before a write.

    DRF clears ``_prefetched_objects_cache`` after an update but not a
    ``to_attr`` list, so the response would repeat the pre-save addresses.
    With them gone the serializer's restricted fallback reads the saved row.
    """
    obj.__dict__.pop(VISIBLE_IPS, None)
    obj.__dict__.pop(VISIBLE_OUTSIDE_IP, None)


def _active_tenant(context, tenant_id):
    """The request and its active tenant when that tenant owns the row, else
    ``(None, None)`` - a row from another tenant lists nothing."""
    request = context.get("request")
    if request is None:
        return None, None
    from .views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None or tenant.id != tenant_id:
        return None, None
    return request, tenant


def assigned_ips(obj, context, fk, tenant_id) -> list:
    """The IPs assigned to ``obj`` through ``fk`` that the caller may view."""
    ips = getattr(obj, VISIBLE_IPS, None)
    if ips is not None:
        return ips
    request, tenant = _active_tenant(context, tenant_id)
    if tenant is None or obj.pk is None:
        return []
    return list(
        visible_ips(request, tenant).filter(**{fk: obj}).only("id", "ip_address")
    )


def outside_ip(obj, context, tenant_id):
    """A tunnel end's outside address when the caller may view it."""
    if obj.outside_ip_id is None:
        return None
    if hasattr(obj, VISIBLE_OUTSIDE_IP):
        return getattr(obj, VISIBLE_OUTSIDE_IP)
    request, tenant = _active_tenant(context, tenant_id)
    if tenant is None:
        return None
    return (
        visible_ips(request, tenant)
        .filter(pk=obj.outside_ip_id)
        .only("id", "ip_address")
        .first()
    )
