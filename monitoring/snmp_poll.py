"""Poll one device's SNMP observed state - shared by the on-demand view and the
scheduled ``poll_snmp`` command (#84, Phase 2).

Stores facts + interfaces on ``DeviceSnmp`` and appends interface counter
samples for the utilisation series. Never touches the device's source-of-truth
fields.
"""
from __future__ import annotations

import inspect
import logging
import socket

from django.utils import timezone

from danbyte_checks.snmp_facts import fetch_snmp

from .models import DeviceSnmp
from .snmp_resolve import resolve_device_profile, resolve_vm_profile
from .snmp_util import record_samples

log = logging.getLogger("monitoring.snmp_poll")

#: How much of the MAC table a fetch reads (#284): ``full`` for background
#: and scheduled polls; ``quick`` - a short budget, no per-VLAN contexts -
#: for the synchronous Poll now, which must finish inside the web worker's
#: request timeout.
MAC_MODES = ("full", "quick")


def _accepts(func, name: str) -> bool:
    """Whether ``func`` takes keyword ``name`` - so a collector that predates
    an option keeps working when the core starts passing it."""
    try:
        params = inspect.signature(func).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
    )


def _vlan_hint(device) -> list[int]:
    """The VLANs Danbyte has on a device's (and its stack's) interfaces - the
    list a collector in per-VLAN *always* mode walks when the agent names no
    contexts of its own (``params.mac_vlan_hint``)."""
    from api.models import Interface

    if device is None:
        return []
    scope = (
        {"device__virtual_chassis_id": device.virtual_chassis_id}
        if device.virtual_chassis_id
        else {"device": device}
    )
    qs = Interface.objects.filter(device__tenant_id=device.tenant_id, **scope)
    vids = set(qs.exclude(vlan__isnull=True).values_list("vlan__vlan_id", flat=True))
    vids |= set(qs.values_list("tagged_vlans__vlan_id", flat=True))
    return sorted(v for v in vids if v and 1 <= v <= 4094)[:1024]


def snmp_params(profile, device=None) -> dict:
    """The non-secret ``params`` a fetch gets: the profile's own, plus the
    VLAN hint when the profile reads per-VLAN MAC tables *always*. Shared
    with the Outpost work list, so both collectors see the same options."""
    params = dict(profile.params or {})
    if params.get("mac_vlan_contexts") == "always" and device is not None:
        params["mac_vlan_hint"] = _vlan_hint(device)
    return params


def fetch_for(target, profile, *, device=None, mac_mode: str = "full") -> dict:
    """Run the collector for one target. ``mac_mode`` - and the VLAN hint in
    ``params`` - go only to a collector that takes ``mac_mode``, so an older
    ``danbyte_checks`` keeps working exactly as before (it reads the whole
    table its own way)."""
    if not _accepts(fetch_snmp, "mac_mode"):
        return fetch_snmp(
            target, profile.version, profile.params, profile.secret_params,
            profile.timeout_ms,
        )
    return fetch_snmp(
        target, profile.version, snmp_params(profile, device),
        profile.secret_params, profile.timeout_ms,
        mac_mode=mac_mode if mac_mode in MAC_MODES else "full",
    )


def _device_target(device):
    """The address to poll: the device's primary IP, else its name **if that
    name actually resolves**.

    Falling back to the name unconditionally sent unresolvable names into
    pysnmp, which surfaced as "Bad IPv4/UDP transport address <name>@161 …
    Temporary failure in name resolution" - technically true, useless to the
    operator. Returning None instead yields the caller's plain "no primary IP
    or resolvable name" message.
    """
    # An explicit per-device override wins over everything.
    from .models import SnmpProfileBinding

    override = (
        SnmpProfileBinding.objects.filter(
            tenant_id=device.tenant_id,
            scope=SnmpProfileBinding.SCOPE_DEVICE,
            object_id=device.id,
        )
        .values_list("target", flat=True)
        .first()
    )
    if override:
        return override
    # Management (out-of-band) IP next - that's the address an operator points
    # SNMP/BMC tooling at; the primary IP may be a data-plane address the
    # agent doesn't even listen on.
    if device.oob_ip_id and device.oob_ip.ip_address:
        return device.oob_ip.ip_address
    if device.primary_ip_id and device.primary_ip.ip_address:
        return device.primary_ip.ip_address
    name = (device.name or "").strip()
    if name:
        try:
            socket.getaddrinfo(name, None)
        except OSError:
            pass
        else:
            return name
    # A stack member without an address of its own is reached through the
    # member that owns the stack's management address (#148).
    if device.virtual_chassis_id:
        from .vc_stack import stack_owner

        owner = stack_owner(device)
        if owner.id != device.id:
            return _device_target(owner)
    return None


def persist_snmp_result(tenant, profile, result, *, device=None, vm=None) -> DeviceSnmp:
    """Write a fetched SNMP result onto ``DeviceSnmp`` (+ counter samples) for a
    Device or a VM target. The ``result`` dict is exactly what ``fetch_snmp``
    produces, whether it ran here or on an Outpost - so both paths persist
    identically."""
    lookup = {"vm": vm} if vm is not None else {"device": device}
    state, created = DeviceSnmp.objects.get_or_create(
        **lookup, defaults={"tenant": tenant}
    )
    state.tenant = tenant
    state.profile = profile
    state.reachable = bool(result.get("reachable"))
    state.error = (result.get("error") or "")[:500]
    state.polled_at = timezone.now()
    fields = ["tenant", "profile", "reachable", "error", "polled_at", "updated_at"]
    # A failed poll says nothing about the device: keep the last good
    # observation (drift skips it while unreachable) instead of replacing it
    # with an empty one that would read as "every port vanished" (#153).
    if state.reachable:
        state.data = result.get("data") or {}
        state.interfaces = result.get("interfaces") or []
        state.neighbors = result.get("neighbors") or []
        state.arp = result.get("arp") or []
        state.fdb = result.get("fdb") or []
        fields += ["data", "interfaces", "neighbors", "arp", "fdb"]
    # Only what this poll observed: the MAC-table fields are record_mac_tables'
    # and sensor readings poll_hardware's, and a concurrent writer of either
    # must not be overwritten with what this row held when it was loaded.
    state.save(update_fields=None if created else fields)
    if state.reachable and state.interfaces:
        record_samples(tenant, state.interfaces, state.polled_at,
                       device=device, vm=vm)
    if state.reachable:
        # Learned MACs and ARP become sightings (#284). A fault there must not
        # cost the poll that was just stored.
        from .mac_tables import record_mac_tables

        try:
            record_mac_tables(state, result)
        except Exception:  # noqa: BLE001
            log.exception("Recording MAC tables failed for %s", state.target)
    return state


def poll_device(device, tenant, profile=None, *, mac_mode: str = "full"):
    """Poll ``device`` and persist its observed SNMP state + counter samples.

    Returns ``(DeviceSnmp | None, reason)`` - ``reason`` is ``"no_profile"`` or
    ``"no_target"`` on a setup error (state untouched), otherwise ``None`` and a
    saved ``DeviceSnmp`` (whose ``reachable`` reflects whether the device
    answered). ``mac_mode`` is ``"quick"`` for the synchronous Poll now.
    """
    # A stack is one SNMP agent: polling any member polls the owner and the
    # observed state lives on the owner's row, so every member reads the same
    # facts and no port is counted twice (#148).
    if device.virtual_chassis_id:
        from .vc_stack import stack_owner

        owner = stack_owner(device)
        if owner.id != device.id:
            return poll_device(owner, tenant, profile, mac_mode=mac_mode)
    if profile is None:
        profile, _source = resolve_device_profile(device, tenant)
    if profile is None:
        return None, "no_profile"
    target = _device_target(device)
    if not target:
        return None, "no_target"

    result = fetch_for(target, profile, device=device, mac_mode=mac_mode)
    return persist_snmp_result(tenant, profile, result, device=device), None


def _vm_target(vm):
    """The address to poll a VM at: an explicit per-VM binding override, else
    its primary IP. VMs have no OOB IP or resolvable device name."""
    from .models import SnmpProfileBinding

    override = (
        SnmpProfileBinding.objects.filter(
            tenant_id=vm.tenant_id,
            scope=SnmpProfileBinding.SCOPE_VM,
            object_id=vm.id,
        )
        .values_list("target", flat=True)
        .first()
    )
    if override:
        return override
    if vm.primary_ip_id and vm.primary_ip.ip_address:
        return vm.primary_ip.ip_address
    return None


def poll_vm(vm, tenant, profile=None, *, mac_mode: str = "full"):
    """Poll a virtual machine (a virtual router / appliance) and persist its
    observed SNMP state - same engine and storage as :func:`poll_device`.

    Returns ``(DeviceSnmp | None, reason)`` - ``reason`` is ``"no_profile"`` or
    ``"no_target"`` on a setup error, otherwise ``None`` and a saved row."""
    if profile is None:
        profile, _source = resolve_vm_profile(vm, tenant)
    if profile is None:
        return None, "no_profile"
    target = _vm_target(vm)
    if not target:
        return None, "no_target"

    result = fetch_for(target, profile, mac_mode=mac_mode)
    return persist_snmp_result(tenant, profile, result, vm=vm), None
