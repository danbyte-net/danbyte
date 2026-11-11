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
   ``no_credential`` no login for the host on a transport the tenant has
                    on: none of its own, none pinned on the profile, no
                    shared credential whose scope matches
   ``host_key_refused`` only SSH logins, and no accepted host key
                    (decision 5)

Transports are tried most secure first - SSH key, SSH password, WinRM over
HTTPS - each only while the tenant has it on (``DiscoverySettings``); the
password switch governs every password login, Linux and Windows alike. A
host with no accepted SSH key can still be read over WinRM, whose server
certificate is verified instead. ``Target.extra["skipped"]`` says why each
transport not tried was left out.

Hosts that pass carry their logins (``monitoring.credentials``: the host's
own credential, the profile's pinned shared credential, then matching
shared credentials) and accepted keys; the secret is resolved later, at
connect time, and never stored on the target.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field

from django.db.models import Q
from django.utils import timezone

MAX_HOSTS = 4096
SSH_KINDS = ("ssh_key", "ssh_password")
WINRM_KIND = "winrm_cert"
#: Transports, most secure first, and the credential kind each logs in with.
TRANSPORT_KINDS = (("ssh_key", "ssh_key"), ("ssh_password", "ssh_password"),
                   ("winrm", WINRM_KIND))
KIND_TRANSPORT = {k: t for t, k in TRANSPORT_KINDS}
TRANSPORT_LABELS = {"ssh_key": "SSH key", "ssh_password": "SSH password",
                    "winrm": "WinRM HTTPS"}
OUTPOST_NO_WINRM = "Outposts read over SSH only"


def transports(settings_row) -> tuple[list[str], dict[str, str]]:
    """The tenant's transports that may be tried, in order, and why each
    other one may not: ``(["ssh_key", …], {"winrm": "Switched off"})``."""
    from .gate import winrm_state

    on, off = [], {}
    if settings_row.ssh_key_enabled:
        on.append("ssh_key")
    else:
        off["ssh_key"] = "Switched off"
    if settings_row.ssh_password_enabled:
        on.append("ssh_password")
    else:
        off["ssh_password"] = "Switched off"
    ok, label, _reason = winrm_state()
    if not ok:
        off["winrm"] = label
    elif settings_row.winrm_enabled:
        on.append("winrm")
    else:
        off["winrm"] = "Switched off"
    return on, off


@dataclass
class Target:
    kind: str                 # device | virtual_machine
    host: object
    address: str = ""
    skip: str = ""            # a HOST_STATUSES word, or "" to read it
    message: str = ""
    credential: object = None
    #: The logins that may be tried, most secure transport first
    #: (``credentials.Login``); ``credential`` is the first.
    logins: list = field(default_factory=list)
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
        "primary_ip", "oob_ip", "primary_ip__prefix", "oob_ip__prefix").prefetch_related("tags")
    vms = vms.filter(vm_q | Q(pk__in=vm_extra)).select_related(
        "primary_ip", "primary_ip__prefix").prefetch_related("tags")
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
    from danbyte_checks.inventory import known_hosts_lines

    return known_hosts_lines(address, keys)


def resolve(profile, *, user=None, now=None, outpost: bool = False) -> list[Target]:
    """Every host in ``profile``'s scope as a :class:`Target`, skipped ones
    with their reason. At most :data:`MAX_HOSTS` (the rest are dropped and
    the run reports it).

    ``outpost``: the hosts are read by Outposts, not the server. The
    server's target policy is then not the one that applies (the Outpost
    applies its own, as it does to checks), and WinRM is left out: an
    Outpost reads over SSH only."""
    from api.models import Prefix
    from danbyte_checks import netguard
    from monitoring.credentials import MAX_TRIES, CredentialResolver
    from monitoring.models import MonitoringDenySubnet, SSHHostKey

    from .models import DiscoverySettings

    tenant = profile.tenant
    now = now or timezone.now()
    devices, vms = _host_querysets(profile, user)
    hosts = [("device", d) for d in devices[:MAX_HOSTS + 1]]
    hosts += [("virtual_machine", v) for v in vms[:MAX_HOSTS + 1 - len(hosts)]]

    exempt_nets = _nets(Prefix.objects.filter(tenant=tenant, scan_exempt=True)
                        .values_list("cidr", "vrf_id"))
    settings_row = DiscoverySettings.for_tenant(tenant)
    deny_any = _nets((c, None) for c in settings_row.deny_subnets or [])
    on, off = transports(settings_row)
    if outpost and "winrm" in on:
        on.remove("winrm")
        off["winrm"] = OUTPOST_NO_WINRM
    kinds = tuple(k for t, k in TRANSPORT_KINDS if t in on)
    deny_vrf = _nets(MonitoringDenySubnet.objects.filter(tenant=tenant)
                     .values_list("cidr", "vrf_id"))
    in_maintenance = _open_maintenance(tenant, now)

    dev_ids = [h.pk for k, h in hosts if k == "device"]
    vm_ids = [h.pk for k, h in hosts if k == "virtual_machine"]
    resolver = CredentialResolver(tenant, kinds=kinds, user=user,
                                  pinned=profile.shared_credential)
    resolver.load_hosts(hosts[:MAX_HOSTS])
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
        if not outpost and netguard.target_blocked(t.address):
            t.skip, t.message = "blocked", "The server's target policy refuses this address."
            continue
        label = "api.device" if kind == "device" else "api.virtualmachine"
        if (label, str(host.pk)) in in_maintenance:
            t.skip, t.message = "maintenance", "In an open maintenance event."
            continue
        rank = {k: i for i, k in enumerate(kinds)}
        logins = sorted(resolver.logins(host), key=lambda x: rank.get(x.kind, 99))[:MAX_TRIES]
        skipped = [{"transport": tr, "outcome": "skipped", "reason": why}
                   for tr, why in off.items()]
        have = {KIND_TRANSPORT.get(x.kind) for x in logins}
        skipped += [{"transport": tr, "outcome": "skipped", "reason": "No credential"}
                    for tr in on if tr not in have]
        t.extra["server_name"] = (getattr(ip, "dns_name", "") or "").strip()
        if not logins:
            t.skip, t.message = "no_credential", "No login for this host on a transport " \
                                                 "that is on."
            t.extra["skipped"] = skipped
            continue
        accepted = keys.get((kind, host.pk)) or []
        ssh_ports = sorted({x.credential.port or 22 for x in logins if x.kind in SSH_KINDS})
        t.known_hosts = _known_hosts(t.address, [(a, b, port) for a, b in accepted
                                                 for port in ssh_ports])
        if ssh_ports and t.known_hosts is None:
            t.extra["no_key"] = True
            rest = [x for x in logins if x.kind not in SSH_KINDS]
            skipped += [{"transport": KIND_TRANSPORT[x.kind], "outcome": "skipped",
                         "reason": "No accepted SSH host key"}
                        for x in logins if x.kind in SSH_KINDS]
            if not rest:
                t.logins, t.credential = logins, logins[0].credential
                t.skip, t.message = "host_key_refused", "No accepted SSH host key."
                t.extra["skipped"] = skipped
                continue
            logins = rest
        t.logins, t.credential = logins, logins[0].credential
        t.extra["skipped"] = skipped
    return out


def truncated(profile, *, user=None) -> bool:
    devices, vms = _host_querysets(profile, user)
    return devices.count() + vms.count() > MAX_HOSTS
