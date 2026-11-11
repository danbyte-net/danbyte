"""Store what a read found, and hand inventoried packages to the CVE store.

``store(...)`` replaces one host's package set with a full read, in bulk:
one read of what is there, one insert, one update, a few statements by
primary key - never a query per package. A package missing from the read
gets ``removed_at`` (and is purged 30 days later, ``purge_removed``); one
that comes back loses it.

``tracked_keys`` / ``tracked_releases`` are the vulnerability store's
providers (``vulnerabilities.products``): the distinct OSV packages across
every tenant with Discovery on, and the releases they are installed on.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from urllib.parse import quote

from django.db import transaction
from django.utils import timezone

from vulnerabilities.identifiers import (
    DEBIAN_CODENAMES,
    distro_release,
    ecosystem_release,
    osv_ecosystems,
)
from vulnerabilities.msrc_products import normalise_arch, resolve_fact

from .models import HostOsFact, HostPackage

CHUNK = 2000
REMOVED_KEEP_DAYS = 30
#: os-release ``ID`` -> the distro namespace OSV and package URLs use.
NAMESPACES = {"debian": "debian", "ubuntu": "ubuntu", "alpine": "alpine",
              "rocky": "rocky", "almalinux": "almalinux", "rhel": "redhat"}
PURL_TYPES = {"dpkg": "deb", "rpm": "rpm", "apk": "apk", "windows": "generic"}


def host_kwargs(host) -> dict:
    from api.models import VirtualMachine

    if isinstance(host, VirtualMachine):
        return {"virtual_machine": host}
    return {"device": host}


def release_of(os_facts: dict, manager: str) -> tuple[str, str]:
    """``(namespace, ecosystem)`` of a host: ``("debian", "Debian:12")``,
    ``("ubuntu", "Ubuntu:24.04:LTS")``, ``("alpine", "Alpine:v3.22")``,
    ``("rocky", "Rocky Linux:9")``. A distro OSV has no per-release data
    for keeps its os-release ID and a blank ecosystem (matching then
    treats the release as unknown)."""
    os_id = os_facts.get("id", "")
    namespace = NAMESPACES.get(os_id, os_id)
    ptype = PURL_TYPES.get(manager, "")
    if namespace not in NAMESPACES.values() or not ptype:
        return namespace, ""
    text = os_facts.get("version_id") or ""
    codename = os_facts.get("version_codename") or ""
    release = distro_release(ptype, namespace, text) if text else None
    if release is None and codename:
        release = distro_release(ptype, namespace, codename)
    if release is None:
        return namespace, ""
    if namespace == "redhat":
        return namespace, f"Red Hat:enterprise_linux:{release[1]}"
    names = osv_ecosystems(release)
    return namespace, names[0] if names else ""


def _distro_qualifier(namespace: str, ecosystem: str, os_facts: dict) -> str:
    codename = os_facts.get("version_codename") or ""
    if namespace == "debian" and codename in DEBIAN_CODENAMES:
        return codename
    release = ecosystem_release(ecosystem)
    return f"{namespace}-{release[1]}" if release else ""


def _purl(ptype, namespace, name, version, arch, distro) -> str:
    quals = [f"arch={quote(arch, safe='')}"] if arch else []
    if distro:
        quals.append(f"distro={quote(distro, safe='')}")
    out = f"pkg:{ptype}/{quote(namespace, safe='')}/{quote(name, safe='')}@{quote(version, safe='')}"
    return (out + ("?" + "&".join(quals) if quals else ""))[:512]


def rows_for(packages, os_facts: dict, manager: str) -> dict[tuple, dict]:
    """``{(purl_type, name, arch): fields}`` for parsed packages."""
    namespace, ecosystem = release_of(os_facts, manager)
    ptype = PURL_TYPES[manager]
    distro = _distro_qualifier(namespace, ecosystem, os_facts)
    out = {}
    for p in packages:
        name = p.name.lower() if ptype != "rpm" else p.name
        src = (p.source_name or p.name)
        if ptype == "deb":
            match = f"{namespace}/{src.lower()}"
            match_version = p.source_version or p.version
        elif ptype == "apk":
            match = f"{namespace}/{src.lower()}"
            match_version = p.version
        elif ptype == "generic":
            # A Windows program: inventory only, never matched (OSV has no
            # ecosystem for it). Its name keeps its case.
            name, src = p.name, ""
            match = f"{namespace}/{p.name.lower()}"
            match_version = p.version
        else:
            match = f"{namespace}/{p.name.lower()}"
            match_version = p.version
        out[(ptype, name, p.arch or "")] = {
            "namespace": namespace[:64],
            "version": p.version[:128],
            "source_name": src[:128],
            "source_version": (p.source_version or p.version)[:128] if src else "",
            "publisher": (getattr(p, "publisher", "") or "")[:128],
            "ecosystem": ecosystem[:64],
            "match_name": match[:200],
            "match_version": match_version[:128],
            "purl": _purl(ptype, namespace, name, p.version, p.arch, distro),
        }
    return out


_COMPARED = ("version", "source_name", "source_version", "ecosystem", "match_name",
             "match_version", "namespace", "purl", "publisher")
#: OS facts whose change re-matches the host (the Windows build line, UBR
#: and what tells its product apart).
_OS_COMPARED = ("os_id", "version_id", "build", "ubr", "edition", "display_version",
                "pretty_name", "installation_type", "architecture")


def store(tenant, host, run, result, now=None, transport="") -> dict:
    """Replace ``host``'s packages with ``result`` (a successful
    :class:`danbyte_checks.inventory.InventoryResult`) and record its OS
    facts. Returns ``{packages, added, removed, updated, changed,
    windows_products}`` (the Microsoft product keys a Windows host can be)."""
    now = now or timezone.now()
    win = result.os.get("windows") or {}
    on_host = host_kwargs(host)
    wanted = rows_for(result.packages, result.os, result.manager)
    namespace, ecosystem = release_of(result.os, result.manager)
    with transaction.atomic():
        fact = HostOsFact.objects.select_for_update().filter(**on_host).first()
        before = None if fact is None else tuple(getattr(fact, f) for f in _OS_COMPARED)
        fields = {
                "tenant": tenant, "os_id": result.os.get("id", "")[:64],
                "id_like": result.os.get("id_like") or [],
                "version_id": result.os.get("version_id", "")[:32],
                "codename": result.os.get("version_codename", "")[:32],
                "pretty_name": result.os.get("pretty_name", "")[:128],
                "ecosystem": ecosystem, "package_manager": result.manager,
                "build": str(win.get("build") or "")[:16], "ubr": win.get("ubr"),
                "edition": str(win.get("edition") or "")[:64],
                "display_version": str(win.get("display_version") or "")[:16],
                "installation_type": str(win.get("installation_type") or "").strip()[:32],
                "architecture": normalise_arch(str(win.get("architecture") or "")),
                "hotfixes": list(win.get("hotfixes") or []),
                "features": list(win.get("features") or []),
                "transport": transport[:16], "collected_at": now, "run": run}
        if fact is None:
            fact = HostOsFact.objects.create(**on_host, **fields)
        else:
            for k, v in fields.items():
                setattr(fact, k, v)
            fact.save()
        # A new Windows build (or edition, release) re-matches the host
        # against Microsoft's fixed builds even when no package moved.
        os_moved = before != tuple(getattr(fact, f) for f in _OS_COMPARED)
        have = {}
        for row in HostPackage.objects.filter(**on_host).values(
                "pk", "purl_type", "name", "arch", "removed_at", *_COMPARED):
            have[(row["purl_type"], row["name"], row["arch"])] = row
        new, changed, gone, back = [], [], [], 0
        for key, fields in wanted.items():
            row = have.pop(key, None)
            if row is None:
                new.append(HostPackage(
                    tenant=tenant, **on_host, purl_type=key[0], name=key[1], arch=key[2],
                    first_seen=now, last_seen=now, run=run, **fields))
                continue
            moved = any(row[f] != fields[f] for f in _COMPARED)
            if row["removed_at"] is not None:
                back += 1
            if moved or row["removed_at"] is not None:
                changed.append(HostPackage(pk=row["pk"], removed_at=None, last_seen=now,
                                           run=run, **fields))
        for row in have.values():
            if row["removed_at"] is None:
                gone.append(row["pk"])
        HostPackage.objects.bulk_create(new, batch_size=CHUNK)
        HostPackage.objects.bulk_update(
            changed, ["removed_at", "last_seen", "run", *_COMPARED], batch_size=CHUNK)
        for i in range(0, len(gone), CHUNK * 5):
            HostPackage.objects.filter(pk__in=gone[i:i + CHUNK * 5]).update(removed_at=now)
        # Everything still there was seen now.
        HostPackage.objects.filter(**on_host, removed_at__isnull=True).update(
            last_seen=now, run=run)
    updated = len(changed) - back
    windows = resolve_fact(fact).keys if fact.os_id == "windows" else ()
    return {"packages": len(wanted), "added": len(new) + back, "removed": len(gone),
            "updated": updated, "changed": bool(new or changed or gone or os_moved),
            "windows_products": windows}


def purge_removed(now=None) -> int:
    """Delete packages gone for more than :data:`REMOVED_KEEP_DAYS`."""
    now = now or timezone.now()
    cutoff = now - timedelta(days=REMOVED_KEEP_DAYS)
    n, _ = HostPackage.objects.filter(removed_at__lt=cutoff).delete()
    return n


# ─── providers for the vulnerability store ───────────────────────────────────


def _current(tenant_ids=None):
    from .gate import active_tenant_ids
    from .models import MATCHED_TYPES

    active = active_tenant_ids() if tenant_ids is None else set(tenant_ids)
    # Windows programs (``generic``) are inventory, never matched.
    return HostPackage.objects.filter(removed_at__isnull=True, tenant_id__in=active,
                                      purl_type__in=MATCHED_TYPES)


def tracked_keys():
    """``products.register_provider`` hook: every package inventoried in a
    tenant with Discovery on, as the OSV key its advisories carry. One
    query; no tenant data leaves the deployment beyond the package names."""
    return {("purl", "", t, name) for t, name in
            _current().values_list("purl_type", "match_name").distinct()}


def tracked_releases() -> dict:
    """``products.register_release_provider`` hook: ``{key: releases}``
    (``None`` for a host whose release is unknown)."""
    out: dict = defaultdict(set)
    for t, name, eco in _current().values_list(
            "purl_type", "match_name", "ecosystem").distinct():
        out[("purl", "", t, name)].add(ecosystem_release(eco) if eco else None)
    return dict(out)
