"""Which hosts a profile reads, and why one is left alone.

Resolved when a run starts (never when it was queued), inside the
profile's tenant only:

1. In scope: a named device or VM, one at a named site, or one whose
   primary address (a device's OOB address when it has no primary) lies in
   a named prefix of the same VRF.
2. Run now by a person: only hosts that person may view, whose SSH
   credential they may view (``devicecredential`` view, site scope
   included). A scheduled run reads the whole scope its authorisation
   covers.
3. Then, per host, in this order, a reason not to contact it - each one a
   per-host result, no connection made:

   ``no_address``   no primary (or OOB) address
   ``exempt``       the host, its address or a prefix around it is
                    ``scan_exempt``
   ``denied``       the address is in a deny subnet: the tenant's
                    discovery list (any VRF) or a monitoring deny subnet
                    (its VRF)
   ``blocked``      the check runner's target policy refuses it (link-local,
                    metadata, and internal ranges where the server blocks
                    them; ``danbyte_checks.netguard``)
   ``maintenance``  the host is in an open maintenance event
   ``no_credential`` no SSH credential (key, else password) on the host
   ``host_key_refused`` no accepted host key (decision 5)

Hosts that pass carry their credential and accepted keys; the secret is
resolved later, at connect time, and never stored on the target.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field

from django.db.models import Q
from django.utils import timezone

MAX_HOSTS = 4096
SSH_KINDS = ("ssh_key", "ssh_password")


@dataclass
class Target:
    kind: str                 # device | virtual_machine
    host: object
    address: str = ""
    skip: str = ""            # a HOST_STATUSES word, or "" to read it
    message: str = ""
    credential: object = None
    known_hosts: bytes | None = None
    extra: dict = field(default_factory=dict)


def _nets(rows) -> list[tuple]:
    out = []
    for cidr, vrf_id in rows:
        try:
            out.append((ipaddress.ip_network(cidr, strict=False), vrf_id))
        except (ValueError, TypeError):
            continue
    return out


def _in(addr, nets, vrf_id=None, *, any_vrf=False) -> bool:
    return any(addr.version == net.version and addr in net
               and (any_vrf or v == vrf_id) for net, v in nets)


def _host_querysets(profile, user=None):
    from api.models import Device, VirtualMachine

    tenant = profile.tenant
    site_ids = list(profile.sites.values_list("pk", flat=True))
    dev_ids = list(profile.devices.values_list("pk", flat=True))
    vm_ids = list(profile.virtual_machines.values_list("pk", flat=True))
    prefixes = _nets(profile.prefixes.filter(tenant=tenant).values_list("cidr", "vrf_id"))

    devices = Device.objects.filter(tenant=tenant)
    vms = VirtualMachine.objects.filter(tenant=tenant)
    if user is not None and not user.is_superuser:
        from auth_api import rbac

        devices = rbac.restrict_queryset(devices, user, tenant, "device", "view")
        vms = rbac.restrict_queryset(vms, user, tenant, "virtualmachine", "view")

    def by_prefix(qs, ip_fields):
        if not prefixes:
            return []
        ids = []
        rows = qs.values_list("pk", *[f"{f}__ip_address" for f in ip_fields],
                              *[f"{f}__vrf_id" for f in ip_fields])
        n = len(ip_fields)
        for pk, *rest in rows:
            for addr, vrf in zip(rest[:n], rest[n:], strict=True):
                if not addr:
                    continue
                try:
                    a = ipaddress.ip_address(str(addr).split("/")[0])
                except ValueError:
                    continue
                if _in(a, prefixes, vrf):
                    ids.append(pk)
                    break
        return ids

    dev_q = Q(pk__in=dev_ids) | Q(site_id__in=site_ids)
    vm_q = Q(pk__in=vm_ids) | Q(site_id__in=site_ids)
    dev_extra = by_prefix(devices.filter(Q(primary_ip__isnull=False) | Q(oob_ip__isnull=False)),
                          ("primary_ip", "oob_ip"))
    vm_extra = by_prefix(vms.filter(primary_ip__isnull=False), ("primary_ip",))
    devices = devices.filter(dev_q | Q(pk__in=dev_extra)).select_related(
        "primary_ip", "oob_ip", "primary_ip__prefix", "oob_ip__prefix")
    vms = vms.filter(vm_q | Q(pk__in=vm_extra)).select_related(
        "primary_ip", "primary_ip__prefix")
    return devices.order_by("name", "pk"), vms.order_by("name", "pk")


def _open_maintenance(tenant, now) -> set[tuple[str, str]]:
    """``{(object_type, id)}`` of devices and VMs in an open event."""
    from monitoring.models import EventImpact

    rows = EventImpact.objects.filter(
        tenant=tenant, object_type__in=("api.device", "api.virtualmachine"),
        event__starts_at__lte=now, event__status__is_closed=False,
    ).filter(Q(event__ends_at__isnull=True) | Q(event__ends_at__gt=now)).values_list(
        "object_type", "object_id")
    return {(t, str(i)) for t, i in rows}


def _known_hosts(address: str, keys) -> bytes | None:
    """known_hosts lines pinning ``address`` to the accepted keys. Port 22
    and other ports both: the lines name the bare address and the
    ``[address]:port`` form the credential's port gives."""
    lines = []
    for key_type, blob, port in keys:
        name = address if port in (None, 22) else f"[{address}]:{port}"
        lines.append(f"{name} {key_type} {blob}")
    return ("\n".join(lines) + "\n").encode() if lines else None


def resolve(profile, *, user=None, now=None) -> list[Target]:
    """Every host in ``profile``'s scope as a :class:`Target`, skipped ones
    with their reason. At most :data:`MAX_HOSTS` (the rest are dropped and
    the run reports it)."""
    from api.models import Prefix
    from danbyte_checks import netguard
    from monitoring.models import DeviceCredential, MonitoringDenySubnet, SSHHostKey

    from .models import DiscoverySettings

    tenant = profile.tenant
    now = now or timezone.now()
    devices, vms = _host_querysets(profile, user)
    hosts = [("device", d) for d in devices[:MAX_HOSTS + 1]]
    hosts += [("virtual_machine", v) for v in vms[:MAX_HOSTS + 1 - len(hosts)]]

    exempt_nets = _nets(Prefix.objects.filter(tenant=tenant, scan_exempt=True)
                        .values_list("cidr", "vrf_id"))
    deny_any = _nets((c, None) for c in DiscoverySettings.for_tenant(tenant).deny_subnets or [])
    deny_vrf = _nets(MonitoringDenySubnet.objects.filter(tenant=tenant)
                     .values_list("cidr", "vrf_id"))
    in_maintenance = _open_maintenance(tenant, now)

    dev_ids = [h.pk for k, h in hosts if k == "device"]
    vm_ids = [h.pk for k, h in hosts if k == "virtual_machine"]
    creds = DeviceCredential.objects.filter(tenant=tenant, kind__in=SSH_KINDS).filter(
        Q(device_id__in=dev_ids) | Q(virtual_machine_id__in=vm_ids))
    if user is not None and not user.is_superuser:
        from auth_api import rbac

        creds = rbac.restrict_queryset(creds, user, tenant, "devicecredential", "view")
    best: dict = {}
    for c in creds.order_by("name", "pk"):
        k = ("device", c.device_id) if c.device_id else ("virtual_machine", c.virtual_machine_id)
        # A key login is preferred to a password.
        if k not in best or (best[k].kind != "ssh_key" and c.kind == "ssh_key"):
            best[k] = c
    keys: dict = {}
    for dev, vm, key_type, blob in SSHHostKey.objects.filter(
            tenant=tenant, uploaded=True).filter(
            Q(device_id__in=dev_ids) | Q(virtual_machine_id__in=vm_ids)).values_list(
            "device_id", "virtual_machine_id", "key_type", "public_key"):
        k = ("device", dev) if dev else ("virtual_machine", vm)
        keys.setdefault(k, []).append((key_type, blob))

    out: list[Target] = []
    for kind, host in hosts[:MAX_HOSTS]:
        t = Target(kind=kind, host=host)
        out.append(t)
        ip = host.primary_ip or (getattr(host, "oob_ip", None) if kind == "device" else None)
        if ip is None or not ip.ip_address:
            t.skip, t.message = "no_address", "No primary address."
            continue
        t.address = str(ip.ip_address).split("/")[0]
        try:
            addr = ipaddress.ip_address(t.address)
        except ValueError:
            t.skip, t.message = "no_address", "The address is not valid."
            continue
        if host.scan_exempt or ip.scan_exempt or (ip.prefix_id and ip.prefix.scan_exempt) \
                or _in(addr, exempt_nets, ip.vrf_id):
            t.skip, t.message = "exempt", "Exempt from discovery."
            continue
        if _in(addr, deny_any, any_vrf=True) or _in(addr, deny_vrf, ip.vrf_id):
            t.skip, t.message = "denied", "In a deny subnet."
            continue
        if netguard.target_blocked(t.address):
            t.skip, t.message = "blocked", "The server's target policy refuses this address."
            continue
        label = "api.device" if kind == "device" else "api.virtualmachine"
        if (label, str(host.pk)) in in_maintenance:
            t.skip, t.message = "maintenance", "In an open maintenance event."
            continue
        cred = best.get((kind, host.pk))
        if cred is None:
            t.skip, t.message = "no_credential", "No SSH credential on this host."
            continue
        t.credential = cred
        accepted = keys.get((kind, host.pk)) or []
        t.known_hosts = _known_hosts(t.address, [(a, b, cred.port) for a, b in accepted])
        if t.known_hosts is None:
            t.skip, t.message = "host_key_refused", "No accepted SSH host key."
    return out


def truncated(profile, *, user=None) -> bool:
    devices, vms = _host_querysets(profile, user)
    return devices.count() + vms.count() > MAX_HOSTS
