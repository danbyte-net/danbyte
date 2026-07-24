"""Poll one device's SNMP observed state — shared by the on-demand view and the
scheduled ``poll_snmp`` command (#84, Phase 2).

Stores facts + interfaces on ``DeviceSnmp`` and appends interface counter
samples for the utilisation series. Never touches the device's source-of-truth
fields.
"""
from __future__ import annotations

import socket

from django.utils import timezone

from danbyte_checks.snmp_facts import fetch_snmp

from .models import DeviceSnmp
from .snmp_resolve import resolve_device_profile
from .snmp_util import record_samples


def _device_target(device):
    """The address to poll: the device's primary IP, else its name **if that
    name actually resolves**.

    Falling back to the name unconditionally sent unresolvable names into
    pysnmp, which surfaced as "Bad IPv4/UDP transport address <name>@161 …
    Temporary failure in name resolution" — technically true, useless to the
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
    # Management (out-of-band) IP next — that's the address an operator points
    # SNMP/BMC tooling at; the primary IP may be a data-plane address the
    # agent doesn't even listen on.
    if device.oob_ip_id and device.oob_ip.ip_address:
        return device.oob_ip.ip_address
    if device.primary_ip_id and device.primary_ip.ip_address:
        return device.primary_ip.ip_address
    name = (device.name or "").strip()
    if not name:
        return None
    try:
        socket.getaddrinfo(name, None)
    except OSError:
        return None
    return name


def persist_snmp_result(device, tenant, profile, result) -> DeviceSnmp:
    """Write a fetched SNMP result onto ``DeviceSnmp`` (+ counter samples). The
    ``result`` dict is exactly what ``fetch_snmp`` produces, whether it ran here
    or on an Outpost — so both paths persist identically."""
    state, _ = DeviceSnmp.objects.get_or_create(
        device=device, defaults={"tenant": tenant}
    )
    state.tenant = tenant
    state.profile = profile
    state.data = result.get("data") or {}
    state.interfaces = result.get("interfaces") or []
    state.neighbors = result.get("neighbors") or []
    state.arp = result.get("arp") or []
    state.fdb = result.get("fdb") or []
    state.reachable = bool(result.get("reachable"))
    state.error = (result.get("error") or "")[:500]
    state.polled_at = timezone.now()
    state.save()
    if state.reachable and state.interfaces:
        record_samples(device, tenant, state.interfaces, state.polled_at)
    return state


def poll_device(device, tenant, profile=None):
    """Poll ``device`` and persist its observed SNMP state + counter samples.

    Returns ``(DeviceSnmp | None, reason)`` — ``reason`` is ``"no_profile"`` or
    ``"no_target"`` on a setup error (state untouched), otherwise ``None`` and a
    saved ``DeviceSnmp`` (whose ``reachable`` reflects whether the device
    answered).
    """
    if profile is None:
        profile, _source = resolve_device_profile(device, tenant)
    if profile is None:
        return None, "no_profile"
    target = _device_target(device)
    if not target:
        return None, "no_target"

    result = fetch_snmp(
        target, profile.version, profile.params, profile.secret_params,
        profile.timeout_ms,
    )
    return persist_snmp_result(device, tenant, profile, result), None
