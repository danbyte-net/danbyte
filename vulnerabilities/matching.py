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
``version``; device type mappings are hardware context only. A distro
package (deb, rpm, apk) also takes the host's release and, for Debian and
Ubuntu, the source package name (``package_target``): OSV writes those
advisories per release and per source package.

Packages discovery read from a host (``discovery.HostPackage``, #451 B2)
are a third source, ``via="package"``, with no mapping: each current
package is tested under the OSV name its advisories use (the source package
for Debian and Ubuntu) at the release its host reported. Only while
Discovery is on for the tenant, and only packages some stored record names
- one query finds those (``_package_rows``), one more their records, so the
cost does not grow with the packages nobody advises.

Windows hosts discovery read are a fourth source, ``via="os_build"``, with
neither a mapping nor a package: the host's build (``10.0.20348.2849``) is
tested against the fixed builds Microsoft lists for its product
(:mod:`vulnerabilities.msrc_products`, ``evaluate.match_msrc``). A host
whose product or UBR is not known gets no match. Also only while Discovery
is on for the tenant.

``objects`` narrows a run to some hosts (a version, platform or install
changed); ``cves`` to some records. Either way only the rows inside the scope
are diffed.
"""
from __future__ import annotations

import logging
import re
import zlib
from collections import defaultdict
from collections.abc import Iterable

from django.db import connection, transaction
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from api.package_ids import render_purl

from . import evaluate, priority
from .exceptions import Resolver
from .identifiers import (
    DISTRO_TYPES,
    distro_release,
    ecosystem_release,
    platform_release,
    purl_key,
    purl_qualifiers,
)
from .models import Cve, CveProduct, ProductMapping, VulnerabilityMatch, VulnerabilityPolicy
from .versions import resolve_scheme

log = logging.getLogger(__name__)

LOCK_CLASS = 451
CHUNK = 2000
_SOURCE_NAME = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,127}$")
_CVE_FIELDS = ("id", "vuln_id", "configurations", "osv", "cvss_score", "epss",
               "kev_added", "rejected")


def _lock(tenant_id) -> None:
    key = zlib.crc32(str(tenant_id).encode()) - 2**31
    with connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s, %s)", [LOCK_CLASS, key])


def _platform_of_id(host):
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


def _package_rows(tenant, objects, cves) -> list[tuple]:
    """``(pk, device, vm, purl type, match name, version, ecosystem)`` of
    the tenant's current inventoried packages that some stored record names
    - none while Discovery is off for the tenant."""
    from discovery.gate import active
    from discovery.models import HostPackage

    if not active(tenant):
        return []
    named = CveProduct.objects.filter(
        kind="purl", part="", vendor=OuterRef("purl_type"), product=OuterRef("match_name"),
        cve__rejected=False)
    if cves is not None:
        named = named.filter(cve__vuln_id__in=list(cves))
    from discovery.models import MATCHED_TYPES

    qs = HostPackage.objects.filter(tenant=tenant, removed_at__isnull=True,
                                    purl_type__in=MATCHED_TYPES).filter(Exists(named))
    if objects is not None:
        qs = qs.filter(Q(device_id__in=list(objects.get("device") or []))
                       | Q(virtual_machine_id__in=list(objects.get("virtual_machine") or [])))
    return list(qs.values_list("pk", "device_id", "virtual_machine_id", "purl_type",
                               "match_name", "match_version", "ecosystem"))


def _package_candidates(tenant, objects, cves) -> dict:
    """``{product key: [Cve]}`` for the inventoried packages in scope, by a
    join rather than one OR term per package."""
    from discovery.models import HostPackage

    have = HostPackage.objects.filter(
        tenant=tenant, removed_at__isnull=True, purl_type=OuterRef("vendor"),
        match_name=OuterRef("product"))
    if objects is not None:
        have = have.filter(Q(device_id__in=list(objects.get("device") or []))
                           | Q(virtual_machine_id__in=list(objects.get("virtual_machine") or [])))
    rows = CveProduct.objects.filter(kind="purl", part="", vendor__in=sorted(DISTRO_TYPES),
                                     cve__rejected=False).filter(Exists(have))
    if cves is not None:
        rows = rows.filter(cve__vuln_id__in=list(cves))
    by_key: dict[tuple, set] = defaultdict(set)
    for cve_id, vendor, product in rows.values_list("cve_id", "vendor", "product"):
        by_key[("purl", "", vendor, product)].add(cve_id)
    ids = set().union(*by_key.values()) if by_key else set()
    found = {c.pk: c for c in Cve.objects.filter(pk__in=ids).only(*_CVE_FIELDS)}
    return {k: [found[i] for i in v if i in found] for k, v in by_key.items()}


_MSRC_CVE_FIELDS = ("id", "vuln_id", "msrc", "cvss_score", "epss", "kev_added", "rejected")


def os_build_hosts(tenant, objects=None) -> list[tuple]:
    """``(device id, vm id, HostProduct)`` of the tenant's Windows hosts as
    discovery last read them - none while Discovery is off for the tenant.
    One query; the host must still be in the tenant."""
    from discovery.gate import active
    from discovery.models import HostOsFact

    from .msrc_products import resolve_fact

    if not active(tenant):
        return []
    qs = HostOsFact.objects.filter(tenant=tenant, os_id="windows").filter(
        Q(device__tenant=tenant) | Q(virtual_machine__tenant=tenant))
    if objects is not None:
        qs = qs.filter(Q(device_id__in=list(objects.get("device") or []))
                       | Q(virtual_machine_id__in=list(objects.get("virtual_machine") or [])))
    return [(f.device_id, f.virtual_machine_id, resolve_fact(f)) for f in qs]


def os_build_summary(tenant, kind: str, host, fact) -> dict | None:
    """For a Windows host's package list: which Microsoft product it was
    matched as (or why not) and its open OS-build matches no exception
    covers. One count query; None for a host that is not Windows."""
    from .models import VulnerabilityMatch, VulnerabilitySettings
    from .msrc_products import resolve_fact

    if fact is None or fact.os_id != "windows":
        return None
    hp = resolve_fact(fact)
    enabled = VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists()
    open_ = VulnerabilityMatch.objects.filter(
        tenant=tenant, via="os_build", resolved_at__isnull=True, excepted__isnull=True,
        **{kind: host}).count() if enabled else 0
    return {"product": hp.label, "build": hp.build, "flag": hp.flag, "open": open_}


def _msrc_candidates(keys: set, cves) -> dict:
    """``{product key: [Cve]}`` for Windows product keys."""
    from .msrc_products import KIND, VENDOR

    if not keys:
        return {}
    rows = CveProduct.objects.filter(kind=KIND, part="", vendor=VENDOR,
                                     product__in=sorted(keys), cve__rejected=False)
    if cves is not None:
        rows = rows.filter(cve__vuln_id__in=list(cves))
    by_key: dict[str, set] = defaultdict(set)
    for cve_id, product in rows.values_list("cve_id", "product"):
        by_key[product].add(cve_id)
    ids = set().union(*by_key.values()) if by_key else set()
    found = {c.pk: c for c in Cve.objects.filter(pk__in=ids).only(*_MSRC_CVE_FIELDS)}
    return {k: [found[i] for i in v if i in found] for k, v in by_key.items()}


def _platform_of(host):
    if host.platform_id:
        return host.platform
    dt = getattr(host, "device_type", None) if hasattr(host, "device_type_id") else None
    return dt.platform if dt is not None else None


def package_target(m, host, purl: str, version: str) -> tuple[str, str, tuple | None]:
    """``(package, version, release)`` the OSV test uses for mapping ``m``
    on ``host``; ``purl`` is the install's (or platform's) package URL.

    For a distro package (deb, rpm, apk) the release comes from the purl's
    ``distro=`` qualifier, else the platform's purl, else the platform's
    name and the host's version (:mod:`vulnerabilities.identifiers`). Debian
    and Ubuntu advisories name the source package: a deb purl's
    ``upstream=`` qualifier (``upstream=openssl`` or ``openssl@<version>``)
    gives it, otherwise the mapped name is taken as is."""
    if m.kind != "purl" or m.vendor not in DISTRO_TYPES:
        return m.product, version, None
    namespace, _, name = m.product.rpartition("/")
    quals = {}
    if purl and (purl_key(purl) or ("",))[0] == m.vendor:
        quals = purl_qualifiers(purl)
    release = distro_release(m.vendor, namespace, quals.get("distro"))
    if release is None:
        plat = _platform_of(host)
        if plat is not None:
            own = host.software_version or ""
            plat_purl = render_purl(plat.purl_template, version=own, os_version=own)
            release = (distro_release(m.vendor, namespace,
                                      purl_qualifiers(plat_purl).get("distro"))
                       or platform_release(m.vendor, namespace, plat.name, own))
    product = m.product
    upstream = quals.get("upstream", "") if m.vendor == "deb" else ""
    if upstream and namespace:
        src, _, src_version = upstream.partition("@")
        src = src.strip().lower()
        if src != name and _SOURCE_NAME.match(src):
            product = f"{namespace}/{src}"
            version = src_version.strip()[:128] or version
    return product, version, release


def _targets(tenant, by_platform, by_app, hardware, os_of, objects, counts=None):
    """``(mapping, host key, install id, version, hardware, platforms, via,
    package, release)`` for every mapping on every host in scope."""
    devices, vms = _hosts(tenant, set(by_platform), set(by_app), objects)
    for kind, hosts in (("device", devices), ("virtual_machine", vms)):
        for host in hosts:
            if counts is not None:
                counts["hosts"] += 1
            host_key = (host.pk, None) if kind == "device" else (None, host.pk)
            hw = None
            if kind == "device" and host.device_type_id in hardware:
                hw = frozenset(hardware[host.device_type_id])
            pid = _platform_of_id(host)
            plats = os_of.get(pid)
            own = host.software_version or ""
            platform_ms = by_platform.get(pid, ())
            if platform_ms and own.strip():
                plat = _platform_of(host)
                purl = render_purl(plat.purl_template, version=own, os_version=own) if plat else ""
                for m in platform_ms:
                    product, version, release = package_target(
                        m, host, purl, own.strip()[:128])
                    yield (m, host_key, None, version, hw, plats, "platform", product,
                           release)
            for inst in host.installed_software.all():
                ms = by_app.get(inst.application_id, ())
                if not ms or not (inst.version or "").strip():
                    continue
                purl = render_purl(inst.purl or inst.application.purl_template,
                                   version=inst.version, os_version=own)
                for m in ms:
                    product, version, release = package_target(
                        m, host, purl, inst.version.strip()[:128])
                    yield (m, host_key, inst.pk, version, hw, plats, "application",
                           product, release)


def package_releases() -> dict[tuple, set]:
    """``{product key: releases}`` over every tenant's enabled deb, rpm and
    apk mappings: what the OSV fetch asks for (``fetch.osv_queries``). A
    source package an install names (``upstream=``) is a key of its own; a
    host whose release is unknown adds ``None``."""
    out: dict[tuple, set] = defaultdict(set)
    rows = ProductMapping.objects.filter(enabled=True, kind="purl",
                                         vendor__in=sorted(DISTRO_TYPES)).exclude(
        platform__isnull=True, application__isnull=True)
    by_tenant: dict = defaultdict(lambda: (defaultdict(list), defaultdict(list)))
    for m in rows:
        plat, app = by_tenant[m.tenant_id]
        (plat[m.platform_id] if m.platform_id else app[m.application_id]).append(m)
    for tenant_id, (plat, app) in by_tenant.items():
        for m, *_rest, product, release in _targets(tenant_id, plat, app, {}, {}, None):
            out[(m.kind, m.part, m.vendor, product)].add(release)
    return dict(out)


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
        os_of = {pid: frozenset((m.part, m.vendor, m.product) for m in ms if m.kind == "cpe")
                 for pid, ms in by_platform.items()}

        desired: dict[tuple, tuple] = {}
        resolver = Resolver(tenant.pk)
        stats: dict = defaultdict(lambda: defaultdict(set))
        cache: dict = {}
        levels: dict = {}

        def consider(m, host_key, install_id, version, hw, plats, via, product, release):
            target = evaluate.Target(
                kind=m.kind, part=m.part, vendor=m.vendor, product=product,
                scheme=m.scheme, version=version, hardware=hw,
                platforms=plats or None, release=release)
            for cve in candidates.get((m.kind, m.part, m.vendor, product), ()):
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
                desired[(cve.pk, *host_key, m.pk, install_id, None)] = (
                    target.version, conf, levels[cve.pk], via, excepted)

        def consider_package(pk, device_id, vm_id, ptype, name, version, ecosystem):
            key = ("purl", "", ptype, name)
            target = evaluate.Target(
                kind="purl", part="", vendor=ptype, product=name,
                scheme=resolve_scheme("auto", "purl", "", ptype, name), version=version,
                release=ecosystem_release(ecosystem) if ecosystem else None)
            for cve in pkg_candidates.get(key, ()):
                ck = (cve.pk, target)
                if ck not in cache:
                    cache[ck] = evaluate.match(cve.configurations, cve.osv, target)
                conf = cache[ck][0]
                if conf is None:
                    continue
                if cve.pk not in levels:
                    levels[cve.pk] = priority.of_cve(cve, policy)
                excepted = resolver.covering(cve.pk, device_id, vm_id, None, None) \
                    if resolver else None
                desired[(cve.pk, device_id, vm_id, None, None, pk)] = (
                    target.version, conf, levels[cve.pk], "package", excepted)

        items = list(_targets(tenant, by_platform, by_app, hardware, os_of, objects, counts))
        source_keys = {(item[0].kind, item[0].part, item[0].vendor, item[7]) for item in items
                       if item[7] != item[0].product}
        candidates = _candidates({*(m.product_key for m in matching), *source_keys}, cves)
        for item in items:
            consider(*item)
        pkg_rows = _package_rows(tenant, objects, cves)
        pkg_candidates = _package_candidates(tenant, objects, cves) if pkg_rows else {}
        for row in pkg_rows:
            consider_package(*row)

        windows = [h for h in os_build_hosts(tenant, objects) if not h[2].flag]
        counts["windows_hosts"] = len(windows)
        if windows:
            msrc_candidates = _msrc_candidates(
                {k for *_ids, hp in windows for k in hp.keys}, cves)
            for device_id, vm_id, hp in windows:
                seen = {c.pk: c for k in hp.keys for c in msrc_candidates.get(k, ())}
                for cve in seen.values():
                    ck = ("msrc", cve.pk, hp.keys, hp.line, hp.ubr)
                    if ck not in cache:
                        cache[ck] = evaluate.match_msrc(cve.msrc, hp.keys, hp.line, hp.ubr)
                    conf = cache[ck][0]
                    if conf is None:
                        continue
                    if cve.pk not in levels:
                        levels[cve.pk] = priority.of_cve(cve, policy)
                    excepted = resolver.covering(cve.pk, device_id, vm_id, None, None) \
                        if resolver else None
                    desired[(cve.pk, device_id, vm_id, None, None, None)] = (
                        hp.build, conf, levels[cve.pk], "os_build", excepted)

        counts.update(_diff(tenant, desired, cves=cves, objects=objects))
        if cves is None and objects is None:
            now = timezone.now()
            for m in mappings:
                cand = candidates.get(m.product_key, ()) if not m.device_type_id else ()
                cov = {"candidates": len(cand),
                       **{f: len(stats[m.pk][f]) for f in evaluate.FLAGS}}
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
                                     "mapping_id", "installed_software_id",
                                     "host_package_id", "version",
                                     "confidence", "priority", "excepted_id"):
        pk, *key, version, conf, prio, excepted = row
        existing[tuple(key)] = (pk, version, conf, prio, excepted)

    new, changed, touched = [], [], []
    for key, (version, conf, prio, via, excepted) in desired.items():
        have = existing.pop(key, None)
        if have is None:
            cve_id, device_id, vm_id, mapping_id, install_id, package_id = key
            new.append(VulnerabilityMatch(
                tenant=tenant, cve_id=cve_id, device_id=device_id, virtual_machine_id=vm_id,
                via=via, mapping_id=mapping_id, installed_software_id=install_id,
                host_package_id=package_id,
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
