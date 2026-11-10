"""Match the store against a tenant's inventory (#451).

``recompute(tenant)`` builds the tenant's current match set in memory and
diffs it against the open ``VulnerabilityMatch`` rows: new ones are inserted
(``first_seen_at``), still-matching ones touched (``last_seen_at``, and
``version``/``confidence``/``priority`` when they changed, and ``excepted``
from the tenant's active exceptions), vanished ones
resolved (``resolved_at``). Bulk statements only, so the query count does not
grow with the inventory; a per-tenant advisory lock keeps two recomputes from
interleaving.

What runs where comes from the SBOM's query (``api.sbom.what_runs_where``):
each device and VM with its platform (its own, else its device type's), its
device type and its installs. A platform mapping tests the host's
``software_version``; an application mapping tests each install's
``version``; device type mappings are hardware context only.

``objects`` narrows a run to some hosts (a version, platform or install
changed); ``cves`` to some records. Either way only the rows inside the scope
are diffed.
"""
from __future__ import annotations

import logging
import zlib
from collections import defaultdict
from collections.abc import Iterable

from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from . import evaluate, priority
from .exceptions import Resolver
from .models import Cve, CveProduct, ProductMapping, VulnerabilityMatch, VulnerabilityPolicy

log = logging.getLogger(__name__)

LOCK_CLASS = 451
CHUNK = 2000
_CVE_FIELDS = ("id", "vuln_id", "configurations", "osv", "cvss_score", "epss",
               "kev_added", "rejected")


def _lock(tenant_id) -> None:
    key = zlib.crc32(str(tenant_id).encode()) - 2**31
    with connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s, %s)", [LOCK_CLASS, key])


def _platform_id(host):
    if host.platform_id:
        return host.platform_id
    dt = getattr(host, "device_type", None) if hasattr(host, "device_type_id") else None
    return dt.platform_id if dt is not None else None


def _hosts(tenant, platform_ids: set, app_ids: set, objects: dict | None):
    from api.models import Device, InstalledSoftware, VirtualMachine
    from api.sbom import what_runs_where

    installs = InstalledSoftware.objects.filter(tenant=tenant, application_id__in=app_ids)
    dev_q = (Q(platform_id__in=platform_ids)
             | Q(platform__isnull=True, device_type__platform_id__in=platform_ids)
             | Q(pk__in=installs.filter(device__isnull=False).values("device_id")))
    vm_q = (Q(platform_id__in=platform_ids)
            | Q(pk__in=installs.filter(virtual_machine__isnull=False)
                .values("virtual_machine_id")))
    devices = Device.objects.filter(tenant=tenant).filter(dev_q)
    vms = VirtualMachine.objects.filter(tenant=tenant).filter(vm_q)
    if objects is not None:
        devices = devices.filter(pk__in=list(objects.get("device") or []))
        vms = vms.filter(pk__in=list(objects.get("virtual_machine") or []))
    return what_runs_where(devices, vms, installs)


def _candidates(keys: Iterable[tuple], cve_ids: Iterable[str] | None):
    """``{product key: [Cve]}`` for the mapped product keys."""
    keys = set(keys)
    if not keys:
        return {}
    q = Q()
    for kind, part, vendor, product in keys:
        q |= Q(kind=kind, part=part, vendor=vendor, product=product)
    rows = CveProduct.objects.filter(q, cve__rejected=False)
    if cve_ids is not None:
        rows = rows.filter(cve__vuln_id__in=list(cve_ids))
    by_key: dict[tuple, set] = defaultdict(set)
    for cve_id, kind, part, vendor, product in rows.values_list(
            "cve_id", "kind", "part", "vendor", "product"):
        by_key[(kind, part, vendor, product)].add(cve_id)
    ids = set().union(*by_key.values()) if by_key else set()
    cves = {c.pk: c for c in Cve.objects.filter(pk__in=ids).only(*_CVE_FIELDS)}
    return {k: [cves[i] for i in v if i in cves] for k, v in by_key.items()}


def recompute(tenant, *, cves: Iterable[str] | None = None,
              objects: dict | None = None) -> dict:
    """Rebuild the tenant's matches; returns counts. ``cves``: vuln ids to
    limit the run to. ``objects``: ``{"device": ids, "virtual_machine": ids}``."""
    counts = {"created": 0, "touched": 0, "updated": 0, "resolved": 0, "hosts": 0}
    cves = None if cves is None else set(cves)
    with transaction.atomic():
        _lock(tenant.pk)
        policy = VulnerabilityPolicy.objects.filter(tenant=tenant).first()
        mappings = list(ProductMapping.objects.filter(tenant=tenant, enabled=True))
        by_platform: dict = defaultdict(list)
        by_app: dict = defaultdict(list)
        hardware: dict = defaultdict(set)
        for m in mappings:
            if m.device_type_id:
                if m.kind == "cpe" and m.part == "h":
                    hardware[m.device_type_id].add((m.vendor, m.product))
            elif m.platform_id:
                by_platform[m.platform_id].append(m)
            elif m.application_id:
                by_app[m.application_id].append(m)
        matching = [m for ms in (*by_platform.values(), *by_app.values()) for m in ms]
        candidates = _candidates((m.product_key for m in matching), cves)
        os_of = {pid: frozenset((m.part, m.vendor, m.product) for m in ms if m.kind == "cpe")
                 for pid, ms in by_platform.items()}

        desired: dict[tuple, tuple] = {}
        resolver = Resolver(tenant.pk)
        stats: dict = defaultdict(lambda: defaultdict(set))
        cache: dict = {}
        levels: dict = {}

        def consider(m, host_key, install_id, version, hw, plats, via):
            if not version or not version.strip():
                return
            target = evaluate.Target(
                kind=m.kind, part=m.part, vendor=m.vendor, product=m.product,
                scheme=m.scheme, version=version.strip()[:128], hardware=hw,
                platforms=plats or None)
            for cve in candidates.get(m.product_key, ()):
                ck = (cve.pk, target)
                if ck not in cache:
                    cache[ck] = evaluate.match(cve.configurations, cve.osv, target)
                conf, flags = cache[ck]
                for f in flags:
                    stats[m.pk][f].add(cve.pk)
                if conf is None:
                    continue
                if cve.pk not in levels:
                    levels[cve.pk] = priority.of_cve(cve, policy)
                excepted = resolver.covering(cve.pk, *host_key, m.platform_id,
                                             m.application_id) if resolver else None
                desired[(cve.pk, *host_key, m.pk, install_id)] = (
                    target.version, conf, levels[cve.pk], via, excepted)

        devices, vms = _hosts(tenant, set(by_platform), set(by_app), objects)
        for kind, hosts in (("device", devices), ("virtual_machine", vms)):
            for host in hosts:
                counts["hosts"] += 1
                host_key = (host.pk, None) if kind == "device" else (None, host.pk)
                hw = None
                if kind == "device" and host.device_type_id in hardware:
                    hw = frozenset(hardware[host.device_type_id])
                pid = _platform_id(host)
                plats = os_of.get(pid)
                for m in by_platform.get(pid, ()):
                    consider(m, host_key, None, host.software_version, hw, plats, "platform")
                for inst in host.installed_software.all():
                    for m in by_app.get(inst.application_id, ()):
                        consider(m, host_key, inst.pk, inst.version, hw, plats,
                                 "application")

        counts.update(_diff(tenant, desired, cves=cves, objects=objects))
        if cves is None and objects is None:
            now = timezone.now()
            for m in mappings:
                cand = candidates.get(m.product_key, ()) if not m.device_type_id else ()
                cov = {"candidates": len(cand),
                       **{f: len(stats[m.pk][f]) for f in (
                           evaluate.UNPARSED_BOUNDS, evaluate.RANGE_NOT_UNDERSTOOD,
                           evaluate.VERSION_NOT_UNDERSTOOD)}}
                if cov != m.coverage or m.matched_at is None:
                    # UPDATE, not save(): bookkeeping stays out of the change log.
                    ProductMapping.objects.filter(pk=m.pk).update(coverage=cov, matched_at=now)
    return counts


def _diff(tenant, desired: dict, *, cves, objects) -> dict:
    now = timezone.now()
    open_rows = VulnerabilityMatch.objects.filter(tenant=tenant, resolved_at__isnull=True)
    if cves is not None:
        open_rows = open_rows.filter(cve__vuln_id__in=list(cves))
    if objects is not None:
        open_rows = open_rows.filter(
            Q(device_id__in=list(objects.get("device") or []))
            | Q(virtual_machine_id__in=list(objects.get("virtual_machine") or [])))
    existing = {}
    for row in open_rows.values_list("pk", "cve_id", "device_id", "virtual_machine_id",
                                     "mapping_id", "installed_software_id", "version",
                                     "confidence", "priority", "excepted_id"):
        pk, *key, version, conf, prio, excepted = row
        existing[tuple(key)] = (pk, version, conf, prio, excepted)

    new, changed, touched = [], [], []
    for key, (version, conf, prio, via, excepted) in desired.items():
        have = existing.pop(key, None)
        if have is None:
            cve_id, device_id, vm_id, mapping_id, install_id = key
            new.append(VulnerabilityMatch(
                tenant=tenant, cve_id=cve_id, device_id=device_id, virtual_machine_id=vm_id,
                via=via, mapping_id=mapping_id, installed_software_id=install_id,
                version=version, confidence=conf, priority=prio, excepted_id=excepted,
                first_seen_at=now, last_seen_at=now))
        elif have[1:] != (version, conf, prio, excepted):
            changed.append(VulnerabilityMatch(pk=have[0], version=version, confidence=conf,
                                              priority=prio, excepted_id=excepted,
                                              last_seen_at=now))
        else:
            touched.append(have[0])
    gone = [v[0] for v in existing.values()]

    VulnerabilityMatch.objects.bulk_create(new, batch_size=CHUNK)
    VulnerabilityMatch.objects.bulk_update(
        changed, ["version", "confidence", "priority", "excepted", "last_seen_at"],
        batch_size=CHUNK)
    for i in range(0, len(touched), CHUNK * 5):
        VulnerabilityMatch.objects.filter(pk__in=touched[i:i + CHUNK * 5]).update(
            last_seen_at=now)
    for i in range(0, len(gone), CHUNK * 5):
        VulnerabilityMatch.objects.filter(pk__in=gone[i:i + CHUNK * 5]).update(
            resolved_at=now)
    return {"created": len(new), "updated": len(changed), "touched": len(touched),
            "resolved": len(gone)}


def reprioritise(tenant) -> int:
    """Rewrite the open matches' priority after a policy change, without
    re-evaluating any version."""
    policy = VulnerabilityPolicy.objects.filter(tenant=tenant).first()
    rows = VulnerabilityMatch.objects.filter(tenant=tenant, resolved_at__isnull=True)
    cve_ids = set(rows.values_list("cve_id", flat=True))
    by_level: dict[str, list] = defaultdict(list)
    for cve in Cve.objects.filter(pk__in=cve_ids).only("id", "cvss_score", "epss", "kev_added"):
        by_level[priority.of_cve(cve, policy)].append(cve.pk)
    n = 0
    with transaction.atomic():
        _lock(tenant.pk)
        for level, ids in by_level.items():
            n += rows.filter(cve_id__in=ids).exclude(priority=level).update(priority=level)
    return n
