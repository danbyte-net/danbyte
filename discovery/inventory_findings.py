"""Review-queue proposals from the package inventory (#451).

Beside the service-scan findings (``discovery.findings``), an inventory read
proposes, for a person to accept or ignore:

``platform``     the host's OS facts (Debian 13) do not fit its platform
                 (blank, "Linux 6.x/2.6 Kernel", "Debian 12"): set it to the
                 tenant's platform for that release - one mapped to the same
                 endoflife.date product and cycle, else one named "Debian 13",
                 else a per-OS "Debian" - or create "Debian 13" when the
                 tenant has none. With end-of-life data on, a created
                 platform (and a matched one without a mapping, named per
                 release) is mapped to the product and cycle (debian / 13)
                 through the same mapping the platform page writes. One per
                 host. Needs *change* on the host; *add* on platforms to
                 create one, *change* on it to map it.
``application``  well-known software (``discovery.known_software``) is on
                 hosts and the tenant has no application of that name: create
                 it with its package names (and its end-of-life product when
                 the catalog has it); the installs follow
                 (``discovery.software``). One per software, not per host.
                 Needs *add* on applications, tenant-wide.
``link``         the tenant has the application but it names no packages: set
                 its package names. Needs *change* on it.

A platform is never changed without an accept. Ignore is remembered per
finding (``InventoryFindingDecision``) until its evidence changes - for a
platform, the OS and release read or the host's platform.
"""
from __future__ import annotations

from collections import defaultdict

from django.db.models import Q
from django.utils.text import slugify

from . import known_software, os_platform

KINDS = ("platform", "application", "link")
MAX_HOSTS = 5000
EVIDENCE_HOSTS = 20


def _host_ref(kind, obj) -> dict:
    return {"kind": kind, "id": str(obj.pk), "name": str(obj.name or obj.pk)}


def _platform_ref(p) -> dict | None:
    return None if p is None else {"id": str(p.pk), "name": p.name}


def visible_facts(request, tenant, hosts_q: Q):
    """The OS facts of hosts the caller may view (``hosts_q`` from
    ``discovery.api._visible_hosts_q``)."""
    from .models import HostOsFact

    return HostOsFact.objects.filter(tenant=tenant).filter(
        Q(device__tenant=tenant) | Q(virtual_machine__tenant=tenant)).filter(hosts_q)


def _decisions(tenant) -> dict:
    from .models import InventoryFindingDecision

    return {d.key: d.evidence for d in InventoryFindingDecision.objects.filter(tenant=tenant)}


def platform_evidence(fact, host) -> str:
    return f"{fact.os_id}|{os_platform.version_of(fact)}|{host.platform_id or ''}"[:400]


def platform_rows(tenant, facts, *, include_ignored=False, decisions=None) -> list[dict]:
    """``platform`` findings for ``facts`` (a HostOsFact queryset)."""
    from api.models import Platform

    decisions = _decisions(tenant) if decisions is None else decisions
    facts = list(facts.select_related(
        "device__platform__eol_mapping", "device__device_type__platform__eol_mapping",
        "virtual_machine__platform__eol_mapping")[:MAX_HOSTS])
    if not facts:
        return []
    catalog = os_platform.load_catalog()
    platforms = list(Platform.objects.filter(tenant=tenant).select_related("eol_mapping"))
    out = []
    for f in facts:
        t = os_platform.target(f, catalog)
        if t is None:
            continue
        kind, host = ("device", f.device) if f.device_id else ("virtual_machine",
                                                               f.virtual_machine)
        current = host.platform
        if current is None and kind == "device" and host.device_type_id:
            current = host.device_type.platform
        if os_platform.fits(current, t):
            continue
        fid = f"platform:{kind}:{host.pk}"
        ev = platform_evidence(f, host)
        ignored = decisions.get(fid) == ev
        if ignored and not include_ignored:
            continue
        found = os_platform.find_platform(platforms, t)
        name = found.name if found is not None else t.name
        mapped = None
        if t.eol_product and (found is None or (
                os_platform.per_release(found)
                and getattr(found, "eol_mapping", None) is None)):
            mapped = {"product": t.eol_product, "cycle": t.eol_cycle}
        out.append({
            "id": fid, "kind": "platform", "host": _host_ref(kind, host),
            "title": f"Set platform to {name}",
            "proposal": {"platform": _platform_ref(found), "platform_name": name,
                         "current": _platform_ref(current), "eol": mapped},
            "confidence": "high", "ignored": ignored, "evidence": [], "evidence_key": ev,
            "os": {"os_id": f.os_id, "version_id": f.version_id,
                   "pretty_name": f.pretty_name, "collected_at": f.collected_at},
        })
    return out


def _known_matcher():
    from api.package_names import Matcher

    return Matcher([(k.key, k.packages) for k in known_software.KNOWN])


def _known_names() -> tuple[set, list]:
    """The well-known names (exact) and glob prefixes: what one query asks
    the inventory for."""
    exact, prefixes = set(), set()
    for k in known_software.KNOWN:
        for entry in k.packages:
            pattern = entry.partition(":")[2] or entry
            if "*" in pattern:
                prefixes.add(pattern.split("*", 1)[0])
            else:
                exact.add(pattern)
    return exact, sorted(prefixes)


_KNOWN_EXACT, _KNOWN_PREFIXES = _known_names()


def software_rows(tenant, packages, *, include_ignored=False, decisions=None) -> list[dict]:
    """``application`` and ``link`` findings for ``packages`` (a HostPackage
    queryset of hosts the caller may view): one per well-known software."""
    from api.models import Application
    from api.package_names import matcher_for

    decisions = _decisions(tenant) if decisions is None else decisions
    known = _known_matcher()
    tenant_matcher = matcher_for(tenant)
    q = Q(name__in=sorted(_KNOWN_EXACT))
    for prefix in _KNOWN_PREFIXES:
        q |= Q(name__startswith=prefix)
    hits: dict = defaultdict(dict)
    for dev, vm, ptype, name, version in packages.filter(q).values_list(
            "device_id", "virtual_machine_id", "purl_type", "name", "version").iterator(
            chunk_size=5000):
        keys = known.apps_of(ptype, name)
        if not keys:
            continue
        # Already some application's package: nothing to propose for it.
        if tenant_matcher and tenant_matcher.apps_of(ptype, name):
            for key in keys:
                hits[key]["__linked__"] = True
            continue
        for key in keys:
            hits[key].setdefault((dev, vm), (name, version))
    if not hits:
        return []
    apps_by_name: dict = {}
    for a in Application.objects.filter(tenant=tenant).only("pk", "name", "slug",
                                                            "package_names"):
        apps_by_name.setdefault(a.name.lower(), a)
        apps_by_name.setdefault(a.slug, a)
    host_names = _host_names(tenant, {h for v in hits.values() for h in v if h != "__linked__"})
    out = []
    for key, by_host in hits.items():
        if by_host.pop("__linked__", False) or not by_host:
            continue
        k = known_software.BY_KEY[key]
        app = next((apps_by_name[n] for n in known_software.names_of(k) if n in apps_by_name),
                   None)
        if app is not None and app.package_names:
            continue
        n = len(by_host)
        fid = f"link:{key}" if app is not None else f"application:{key}"
        ignored = fid in decisions
        if ignored and not include_ignored:
            continue
        evidence = []
        for (dev, vm), (pkg, version) in sorted(by_host.items(), key=lambda kv: str(kv[0]))[
                :EVIDENCE_HOSTS]:
            ref = host_names.get((dev, vm))
            if ref is not None:
                evidence.append({**ref, "package": pkg, "version": version})
        hosts = f"{n} {'host' if n == 1 else 'hosts'}"
        if app is None:
            title = f"Application {k.name} found on {hosts}"
        else:
            title = f"Link packages to {app.name} ({hosts})"
        out.append({
            "id": fid, "kind": "link" if app is not None else "application", "host": None,
            "title": title,
            "proposal": {"application": None if app is None else {"id": str(app.pk),
                                                                  "name": app.name},
                         "application_name": k.name, "software": key,
                         "package_names": list(k.packages), "hosts": n},
            "confidence": "high", "ignored": ignored, "evidence": [], "evidence_key": "",
            "packages": evidence,
        })
    return out


def _host_names(tenant, keys) -> dict:
    from api.models import Device, VirtualMachine

    devs = [d for d, _v in keys if d]
    vms = [v for _d, v in keys if v]
    out = {}
    for pk, name in Device.objects.filter(tenant=tenant, pk__in=devs).values_list("pk", "name"):
        out[(pk, None)] = {"kind": "device", "id": str(pk), "name": name or str(pk)}
    for pk, name in VirtualMachine.objects.filter(tenant=tenant, pk__in=vms).values_list(
            "pk", "name"):
        out[(None, pk)] = {"kind": "virtual_machine", "id": str(pk), "name": name or str(pk)}
    return out


def build(request, tenant, hosts_q: Q, *, include_ignored=False) -> list[dict]:
    """Every inventory proposal on hosts the caller may view."""
    from .models import HostPackage

    decisions = _decisions(tenant)
    rows = platform_rows(tenant, visible_facts(request, tenant, hosts_q),
                         include_ignored=include_ignored, decisions=decisions)
    pkgs = HostPackage.objects.filter(tenant=tenant, removed_at__isnull=True).filter(hosts_q)
    rows += software_rows(tenant, pkgs, include_ignored=include_ignored, decisions=decisions)
    rank = {k: i for i, k in enumerate(KINDS)}
    rows.sort(key=lambda r: (rank[r["kind"]], r["title"]))
    return rows


# ─── accepting ───────────────────────────────────────────────────────────────


class Refused(Exception):
    pass


def _may_create_catalog(user, tenant, slug) -> bool:
    from auth_api import rbac

    return user.is_superuser or (rbac.has_action(user, tenant, slug, "add")
                                 and rbac.site_scope(user, tenant, slug, "add") is None)


def _unique_slug(model, tenant, name) -> str:
    base = slugify(name)[:120] or "item"
    slug, n = base, 1
    while model.objects.filter(tenant=tenant, slug=slug).exists():
        n += 1
        slug = f"{base}-{n}"
    return slug


def _map_platform(platform, tenant, product: str, cycle: str):
    from compliance.eol import fill_mapping, find_product
    from compliance.models import EolMapping

    cat = find_product(os_platform.EOL_SOURCE, product, tenant.pk)
    if cat is None:
        return None
    mapping = EolMapping(tenant=tenant, platform=platform, source=os_platform.EOL_SOURCE,
                         product=product, cycle=cycle)
    fill_mapping(mapping, cat)
    mapping.save()
    return mapping


def accept_platform(request, tenant, row, host) -> dict:
    """Put ``host`` on the proposed platform (creating and mapping it as the
    finding says). Everything is a normal change-logged save."""
    from api.models import Platform
    from auth_api import rbac

    user = request.user
    slug = "device" if row["host"]["kind"] == "device" else "virtualmachine"
    if not user.is_superuser and not rbac.can_act_on(user, tenant, slug, "change", host):
        raise Refused(f"{slug}.change required for this host.")
    proposal = row["proposal"]
    platform = None
    if proposal["platform"]:
        platform = Platform.objects.filter(tenant=tenant, pk=proposal["platform"]["id"]).first()
    if platform is None:
        # Another accept in this batch may have made it already.
        name = proposal["platform_name"]
        platform = Platform.objects.filter(tenant=tenant).filter(
            Q(name__iexact=name) | Q(slug=slugify(name))).first()
    created = False
    if platform is None:
        if not _may_create_catalog(user, tenant, "platform"):
            raise Refused("platform.add required to create a platform.")
        platform = Platform(tenant=tenant, name=proposal["platform_name"][:128],
                            slug=_unique_slug(Platform, tenant, proposal["platform_name"]),
                            description="Created from a package inventory.")
        platform.save()
        created = True
    eol = proposal.get("eol")
    mapped = False
    if eol and getattr(platform, "eol_mapping", None) is None and (
            created or os_platform.per_release(platform)):
        from compliance.models import EolMapping

        if not EolMapping.objects.filter(platform=platform).exists() and (
                created or user.is_superuser
                or rbac.can_act_on(user, tenant, "platform", "change", platform)):
            mapped = _map_platform(platform, tenant, eol["product"], eol["cycle"]) is not None
    host.platform = platform
    host.save()
    out = {"kind": "platform", "id": str(platform.pk), "name": platform.name}
    if created:
        out["created_platform"] = True
    if mapped:
        out["mapped"] = f"{eol['product']} {eol['cycle']}"
    return out


def accept_application(request, tenant, row) -> dict:
    from api.models import Application
    from compliance.eol import find_product, load_config

    user = request.user
    p = row["proposal"]
    if not _may_create_catalog(user, tenant, "application"):
        raise Refused("application.add required to add an application.")
    k = known_software.BY_KEY[p["software"]]
    existing = Application.objects.filter(tenant=tenant).filter(
        Q(name__iexact=k.name) | Q(slug=slugify(k.name))).first()
    if existing is not None:
        raise Refused(f"{existing.name} exists already; link its packages instead.")
    eol_product = ""
    if load_config().enabled:
        eol_product = next((n for n in k.eol
                            if find_product(os_platform.EOL_SOURCE, n, tenant.pk)), "")
    app = Application(tenant=tenant, name=k.name, slug=_unique_slug(Application, tenant, k.name),
                      package_names=list(k.packages),
                      eol_source=os_platform.EOL_SOURCE if eol_product else "",
                      eol_product=eol_product,
                      description="Found by a package inventory.")
    app.save()
    return {"kind": "application", "id": str(app.pk), "name": app.name}


def accept_link(request, tenant, row) -> dict:
    from api.models import Application
    from auth_api import rbac

    user = request.user
    ref = row["proposal"]["application"]
    app = Application.objects.filter(tenant=tenant, pk=ref["id"]).first()
    if app is None:
        raise Refused("Not found.")
    if not user.is_superuser and not rbac.can_act_on(user, tenant, "application", "change",
                                                     app):
        raise Refused("application.change required.")
    if app.package_names:
        raise Refused("It names packages already.")
    app.package_names = list(row["proposal"]["package_names"])
    app.save()
    return {"kind": "link", "id": str(app.pk), "name": app.name}
