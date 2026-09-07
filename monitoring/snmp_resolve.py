"""Resolve the effective SNMP profile for a device along the assignment
hierarchy: **device → device role → device type → location (→ parents) → site →
tenant default** (#84).

The most specific binding wins, so a per-device profile overrides one set on its
role, which overrides one set on its type, which overrides one set on its
location (or a parent location), which overrides one set on its site. Falls back
to the tenant's default profile (or its only profile) when nothing is bound. The
location/site levels let an Outpost poll a site's devices with site-scoped
credentials.
"""
from __future__ import annotations

from .models import SnmpProfile, SnmpProfileBinding


def _binding_profile(tenant, scope, object_id):
    if not object_id:
        return None
    return (
        SnmpProfileBinding.objects.filter(
            tenant=tenant, scope=scope, object_id=object_id
        )
        .select_related("profile")
        .first()
    )


def _location_chain_profile(tenant, location_id):
    """Walk the location and its ancestors, returning the first bound profile -
    so a device in a child location inherits a profile set on a parent."""
    if not location_id:
        return None
    from api.models import Location

    seen = set()
    cur = Location.objects.filter(id=location_id).only("id", "parent_id").first()
    while cur is not None and cur.id not in seen and len(seen) < 32:
        seen.add(cur.id)
        binding = _binding_profile(
            tenant, SnmpProfileBinding.SCOPE_LOCATION, cur.id
        )
        if binding is not None:
            return binding.profile
        cur = (
            Location.objects.filter(id=cur.parent_id)
            .only("id", "parent_id")
            .first()
            if cur.parent_id
            else None
        )
    return None


def resolve_device_profile(device, tenant):
    """Return ``(SnmpProfile | None, source)`` for ``device``.

    ``source`` is one of ``device`` / ``device_role`` / ``device_type`` /
    ``location`` / ``site`` / ``tenant_default`` / ``None`` (nothing configured).
    """
    chain = [
        (SnmpProfileBinding.SCOPE_DEVICE, device.id),
        (SnmpProfileBinding.SCOPE_ROLE, getattr(device, "role_id", None)),
        (SnmpProfileBinding.SCOPE_TYPE, getattr(device, "device_type_id", None)),
    ]
    for scope, object_id in chain:
        binding = _binding_profile(tenant, scope, object_id)
        if binding is not None:
            return binding.profile, scope

    # Location (walking parents) then site - where the device lives, not what it
    # is. Lets a site's Outpost resolve site-scoped credentials.
    profile = _location_chain_profile(tenant, getattr(device, "location_id", None))
    if profile is not None:
        return profile, SnmpProfileBinding.SCOPE_LOCATION
    site_binding = _binding_profile(
        tenant, SnmpProfileBinding.SCOPE_SITE, getattr(device, "site_id", None)
    )
    if site_binding is not None:
        return site_binding.profile, SnmpProfileBinding.SCOPE_SITE

    default = SnmpProfile.objects.filter(tenant=tenant, is_default=True).first()
    if default is None:
        # Only auto-pick when there's exactly one profile - otherwise we'd guess
        # which credential to poll with and silently use the wrong one.
        profiles = list(SnmpProfile.objects.filter(tenant=tenant)[:2])
        default = profiles[0] if len(profiles) == 1 else None
    if default is not None:
        return default, "tenant_default"
    return None, None


def _default_profile(tenant):
    """The tenant's default SNMP profile, or the sole one if only one exists."""
    default = SnmpProfile.objects.filter(tenant=tenant, is_default=True).first()
    if default is None:
        profiles = list(SnmpProfile.objects.filter(tenant=tenant)[:2])
        default = profiles[0] if len(profiles) == 1 else None
    return default


def resolve_vm_profile(vm, tenant):
    """Return ``(SnmpProfile | None, source)`` for a virtual machine.

    Resolution mirrors the device hierarchy, adapted to what a VM has:
    **vm → platform → cluster → site → tenant default** - most specific wins.
    """
    chain = [
        (SnmpProfileBinding.SCOPE_VM, vm.id),
        (SnmpProfileBinding.SCOPE_PLATFORM, getattr(vm, "platform_id", None)),
        (SnmpProfileBinding.SCOPE_CLUSTER, getattr(vm, "cluster_id", None)),
        (SnmpProfileBinding.SCOPE_SITE, getattr(vm, "site_id", None)),
    ]
    for scope, object_id in chain:
        binding = _binding_profile(tenant, scope, object_id)
        if binding is not None:
            return binding.profile, scope

    default = _default_profile(tenant)
    if default is not None:
        return default, "tenant_default"
    return None, None


def resolve_snmp_vrf(device, tenant):
    """The default VRF for SNMP-discovered addresses on ``device`` - most
    specific binding first (device → role → type → site), then the tenant
    default. ``None`` = no policy (caller keeps its any-VRF tie-break)."""
    from api.models import VRF

    from .models import MonitoringSettings, SnmpVrfBinding

    lookups = [
        (SnmpVrfBinding.SCOPE_DEVICE, device.pk),
        (SnmpVrfBinding.SCOPE_ROLE, device.role_id),
        (SnmpVrfBinding.SCOPE_TYPE, device.device_type_id),
        (SnmpVrfBinding.SCOPE_SITE, device.site_id),
    ]
    for scope, oid in lookups:
        if not oid:
            continue
        b = (
            SnmpVrfBinding.objects.filter(
                tenant=tenant, scope=scope, object_id=oid
            )
            .select_related("vrf")
            .first()
        )
        if b is not None:
            return b.vrf
    vrf_id = (
        MonitoringSettings.objects.filter(tenant=tenant)
        .values_list("snmp_default_vrf_id", flat=True)
        .first()
    )
    return VRF.objects.filter(pk=vrf_id).first() if vrf_id else None
