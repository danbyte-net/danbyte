"""Service scan, the server side (#451 B3): which addresses a profile scans,
the run, and what is stored.

A service-scan profile names sites, prefixes, devices and VMs like an
inventory profile, but its targets are **IP addresses already in IPAM**:

* every address in a named prefix or a prefix inside it (same VRF);
* every address of a named site (its own site, or its device's or VM's);
* every address assigned to a named device or VM (directly or through an
  interface), and their primary and out-of-band addresses.

Nothing outside IPAM is scanned, and no CIDR is typed at run time. Run now by
a person scans only the addresses that person may view.

Per address, in this order, a reason not to contact it (a host result, no
connection made): ``exempt`` (the address, its prefix, a prefix around it,
or its device or VM is ``scan_exempt``), ``denied`` (a discovery or
monitoring deny subnet), ``blocked`` (the check runner's target policy,
``danbyte_checks.netguard``), ``maintenance`` (its device or VM is in an open
maintenance event). The scan itself is ``danbyte_checks.service_scan``.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
from dataclasses import dataclass

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

log = logging.getLogger(__name__)

HOSTS_PARALLEL_MAX = 16
RATE_MIN = 1


def rate_cap() -> int:
    """The deployment's ceiling on connections per second for one run."""
    return int(getattr(settings, "DISCOVERY_SCAN_MAX_RATE", 200) or 200)


@dataclass
class AddressTarget:
    ip: object
    address: str
    kind: str = ""            # device | virtual_machine | "" (no host)
    host: object = None
    skip: str = ""
    message: str = ""


def host_of(ip) -> tuple[str, object]:
    """``(kind, host)`` an address belongs to, or ``("", None)``."""
    if ip.assigned_device_id:
        return "device", ip.assigned_device
    if ip.assigned_interface_id and ip.assigned_interface.device_id:
        return "device", ip.assigned_interface.device
    if ip.assigned_vm_id:
        return "virtual_machine", ip.assigned_vm
    if ip.assigned_vm_interface_id and ip.assigned_vm_interface.vm_id:
        return "virtual_machine", ip.assigned_vm_interface.vm
    return "", None


def address_queryset(profile, user=None):
    """The IPAM addresses ``profile`` names, inside its tenant (and, for a
    person, the ones they may view)."""
    from api.models import Device, IPAddress, Prefix, VirtualMachine

    from .scope import _nets

    tenant = profile.tenant
    ips = IPAddress.objects.filter(tenant=tenant)
    if user is not None and not user.is_superuser:
        from auth_api import rbac

        ips = rbac.restrict_queryset(ips, user, tenant, "ipaddress", "view")
    site_ids = list(profile.sites.filter(tenant=tenant).values_list("pk", flat=True))
    dev_ids = list(profile.devices.filter(tenant=tenant).values_list("pk", flat=True))
    vm_ids = list(profile.virtual_machines.filter(tenant=tenant).values_list("pk", flat=True))
    named = _nets(profile.prefixes.filter(tenant=tenant).values_list("cidr", "vrf_id"))
    prefix_ids = []
    if named:
        for pk, cidr, vrf in Prefix.objects.filter(tenant=tenant).values_list(
                "pk", "cidr", "vrf_id"):
            try:
                net = ipaddress.ip_network(str(cidr), strict=False)
            except ValueError:
                continue
            if any(net.version == n.version and net.subnet_of(n) and v == vrf
                   for n, v in named):
                prefix_ids.append(pk)
    q = Q(pk__in=[])
    if prefix_ids:
        q |= Q(prefix_id__in=prefix_ids)
    if site_ids:
        q |= (Q(site_id__in=site_ids) | Q(assigned_device__site_id__in=site_ids)
              | Q(assigned_interface__device__site_id__in=site_ids)
              | Q(assigned_vm__site_id__in=site_ids)
              | Q(assigned_vm_interface__vm__site_id__in=site_ids))
    if dev_ids:
        own = Device.objects.filter(tenant=tenant, pk__in=dev_ids)
        q |= (Q(assigned_device_id__in=dev_ids) | Q(assigned_interface__device_id__in=dev_ids)
              | Q(pk__in=own.values("primary_ip_id")) | Q(pk__in=own.values("oob_ip_id")))
    if vm_ids:
        own = VirtualMachine.objects.filter(tenant=tenant, pk__in=vm_ids)
        q |= (Q(assigned_vm_id__in=vm_ids) | Q(assigned_vm_interface__vm_id__in=vm_ids)
              | Q(pk__in=own.values("primary_ip_id")))
    return ips.filter(q).select_related(
        "prefix", "assigned_device", "assigned_interface__device", "assigned_vm",
        "assigned_vm_interface__vm").order_by("ip_address", "pk")


def resolve(profile, *, user=None, now=None, outpost: bool = False) -> list[AddressTarget]:
    """Every address in scope as an :class:`AddressTarget`, skipped ones with
    their reason. At most ``scope.MAX_HOSTS``. ``outpost``: scanned by
    Outposts, which apply their own target policy instead of the server's."""
    from api.models import Prefix
    from danbyte_checks import netguard
    from monitoring.models import MonitoringDenySubnet

    from .models import DiscoverySettings
    from .scope import MAX_HOSTS, _in, _nets, _open_maintenance

    tenant = profile.tenant
    now = now or timezone.now()
    exempt_nets = _nets(Prefix.objects.filter(tenant=tenant, scan_exempt=True)
                        .values_list("cidr", "vrf_id"))
    deny_any = _nets((c, None) for c in DiscoverySettings.for_tenant(tenant).deny_subnets or [])
    deny_vrf = _nets(MonitoringDenySubnet.objects.filter(tenant=tenant)
                     .values_list("cidr", "vrf_id"))
    in_maintenance = _open_maintenance(tenant, now)
    out: list[AddressTarget] = []
    for ip in address_queryset(profile, user)[:MAX_HOSTS]:
        address = str(ip.ip_address).split("/")[0]
        kind, host = host_of(ip)
        t = AddressTarget(ip=ip, address=address, kind=kind, host=host)
        out.append(t)
        try:
            addr = ipaddress.ip_address(address)
        except ValueError:
            t.skip, t.message = "no_address", "The address is not valid."
            continue
        if ip.scan_exempt or (ip.prefix_id and ip.prefix.scan_exempt) \
                or (host is not None and host.scan_exempt) or _in(addr, exempt_nets, ip.vrf_id):
            t.skip, t.message = "exempt", "Exempt from discovery."
            continue
        if _in(addr, deny_any, any_vrf=True) or _in(addr, deny_vrf, ip.vrf_id):
            t.skip, t.message = "denied", "In a deny subnet."
            continue
        if not outpost and netguard.target_blocked(address):
            t.skip, t.message = "blocked", "The server's target policy refuses this address."
            continue
        if host is not None:
            label = "api.device" if kind == "device" else "api.virtualmachine"
            if (label, str(host.pk)) in in_maintenance:
                t.skip, t.message = "maintenance", "In an open maintenance event."
                continue
    return out


def truncated(profile, *, user=None) -> bool:
    from .scope import MAX_HOSTS

    return address_queryset(profile, user).count() > MAX_HOSTS


def plan(profile) -> dict:
    """The ports and rates a run of ``profile`` uses."""
    from danbyte_checks import service_scan

    ports = service_scan.parse_ports(profile.ports or [])
    return {
        "ports": ports,
        "rate": max(RATE_MIN, min(profile.connects_per_second or 1, rate_cap())),
        "hosts_parallel": max(1, min(HOSTS_PARALLEL_MAX, profile.max_concurrency or 1)),
        "port_concurrency": service_scan.PORT_CONCURRENCY,
        "connect_timeout": service_scan.CONNECT_TIMEOUT,
    }


def builtin_scan(addresses: list[str], p: dict) -> list:
    """The built-in engine: ``danbyte_checks.service_scan``."""
    from danbyte_checks import inventory, service_scan

    return asyncio.run(service_scan.scan(
        addresses, p["ports"], rate=p["rate"], hosts_parallel=p["hosts_parallel"],
        observe_key=inventory.observe_host_key))


def execute(run, profile, *, user=None, now=None, scanner=None) -> tuple[dict, list[str]]:
    """Scan the profile's addresses and store what answered. Returns
    ``(counts, errors)``; the caller writes them on the run. ``scanner``
    (``(addresses, plan) -> [HostResult]``) is injectable for tests and is
    how the nmap engine plugs in."""
    from .models import InventoryHostResult
    from .scope import MAX_HOSTS

    now = now or timezone.now()
    tenant = profile.tenant
    targets = resolve(profile, user=user, now=now)
    errors: list[str] = []
    if truncated(profile, user=user):
        errors.append(f"More than {MAX_HOSTS} addresses in scope; the rest were not scanned.")
    try:
        p = plan(profile)
    except ValueError as exc:
        return {"hosts": len(targets)}, [f"The port list is not valid: {exc}"[:300]]
    if scanner is None:
        try:
            scanner = _engine(profile)
        except Exception as exc:  # noqa: BLE001 - nmap refused: fail the run, scan nothing
            return {"hosts": len(targets)}, [str(exc)[:300]]
    todo = [t for t in targets if not t.skip]
    by_address: dict[str, object] = {}
    if todo:
        try:
            for r in scanner([t.address for t in todo], p):
                by_address[r.address] = r
        except Exception as exc:  # noqa: BLE001 - the engine failing fails the run, not the worker
            log.exception("discovery: the service scan failed")
            errors.append(f"The scan failed: {type(exc).__name__}: {exc}"[:300])
    counts = {"hosts": len(targets), "ok": 0, "services": 0, "new": 0, "gone": 0,
              "connects": 0, "ports": len(p["ports"]), "rate": p["rate"],
              "hosts_parallel": p["hosts_parallel"]}
    rows = [host_row(tenant, run, t, by_address.get(t.address) if not t.skip else None, now,
                     counts) for t in targets]
    InventoryHostResult.objects.bulk_create(rows, batch_size=1000)
    return counts, errors


def host_row(tenant, run, t, r, now, counts: dict, *, engine: str = "server"):
    """The (unsaved) host result for target ``t`` and its scan result ``r``
    (``None``: skipped, or nothing came back), storing the open ports of a
    scanned host and adding to ``counts``. Shared by server runs and the
    Outpost ingest."""
    from .models import InventoryHostResult

    status, message = t.skip, t.message
    n_open = 0
    if not t.skip:
        if r is None:
            status, message = "failed", "Not scanned."
        elif r.status != "ok":
            status, message = r.status, r.message
        else:
            status = "ok"
            stored = store(tenant, t, run, r.open, now)
            n_open = len(r.open)
            counts["ok"] = counts.get("ok", 0) + 1
            counts["services"] = counts.get("services", 0) + n_open
            counts["new"] = counts.get("new", 0) + stored["new"]
            counts["gone"] = counts.get("gone", 0) + stored["gone"]
        counts["connects"] = counts.get("connects", 0) + (
            getattr(r, "connects", 0) if r is not None else 0)
    if status != "ok":
        counts[status] = counts.get(status, 0) + 1
    return InventoryHostResult(
        tenant=tenant, run=run, ip_address=t.ip, address=t.address, status=status,
        message=(message or "")[:300], finished_at=timezone.now(), services=n_open,
        connects=getattr(r, "connects", 0) if r is not None else 0, engine=engine,
        **({t.kind: t.host} if t.host is not None else {}))


def _engine(profile):
    if profile.scan_engine == "nmap":
        from . import nmap

        return nmap.scanner(profile)
    return builtin_scan


def store(tenant, target, run, found: list, now) -> dict:
    """Upsert the address's open ports; ports open before and closed now get
    ``gone_at``. Returns ``{new, gone}``."""
    from monitoring.models import Certificate

    from .models import ObservedService

    ip = target.ip
    existing = {(o.protocol, o.port): o for o in ObservedService.objects.filter(ip_address=ip)}
    fps = {(f.tls or {}).get("fingerprint_sha256") for f in found if f.tls}
    certs = dict(Certificate.objects.filter(tenant=tenant, fingerprint_sha256__in=[
        f for f in fps if f]).values_list("fingerprint_sha256", "pk")) if fps else {}
    host_kw = {"device": target.host if target.kind == "device" else None,
               "virtual_machine": target.host if target.kind == "virtual_machine" else None}
    new = 0
    seen = set()
    with transaction.atomic():
        for f in found:
            key = (f.protocol or "tcp", int(f.port))
            seen.add(key)
            values = {
                "tenant": tenant, "address": target.address, **host_kw,
                "service_name": (f.service or "")[:40], "banner": (f.banner or "")[:512],
                "product": (f.product or "")[:128], "vendor": (f.vendor or "")[:128],
                "version": (f.version or "")[:64], "cpe": (f.cpe or "")[:255],
                "os_guess": (f.os or "")[:128], "source": f.source or "port",
                "rule": (f.rule or "")[:200], "confidence": f.confidence or "low",
                "http": f.http or {}, "tls": f.tls or {},
                "certificate_id": certs.get((f.tls or {}).get("fingerprint_sha256")),
                "last_seen": now, "gone_at": None, "run": run,
            }
            row = existing.get(key)
            if row is None:
                ObservedService.objects.create(ip_address=ip, protocol=key[0], port=key[1],
                                               first_seen=now, **values)
                new += 1
            else:
                if row.gone_at is not None:
                    new += 1
                ObservedService.objects.filter(pk=row.pk).update(**values)
            if f.host_key and target.host is not None:
                _record_key(tenant, target.host, f.host_key)
        gone_ids = [o.pk for k, o in existing.items() if k not in seen and o.gone_at is None]
        if gone_ids:
            ObservedService.objects.filter(pk__in=gone_ids).update(gone_at=now)
    return {"new": new, "gone": len(gone_ids)}


def _record_key(tenant, host, key: dict) -> None:
    """The SSH host key a port presented, as *observed* in the host-key
    inventory - never accepted; a person accepts it."""
    from monitoring.ssh_host_keys import record_host_key

    try:
        record_host_key(tenant, host, key)
    except Exception:  # noqa: BLE001 - bookkeeping never fails the run
        log.exception("discovery: recording an observed host key failed")
