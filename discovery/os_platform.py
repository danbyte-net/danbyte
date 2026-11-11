"""What an inventory read says about a host's OS (#451): its running
version, the platform it should be on and that platform's end-of-life
cycle.

``version_of(fact)`` is the host's ``software_version`` from the facts -
``/etc/os-release``'s ``VERSION_ID`` as the distribution writes it
(``13`` for Debian 13, ``22.04`` for Ubuntu, ``9.4`` for a RHEL-like,
``3.22.1`` for Alpine) and Windows' full build (``10.0.20348.2700``, the
form Microsoft's fixed builds are compared in). :func:`record_versions`
writes it with source ``discovery`` through the one automatic writer
(``api.software_versions.record``): never over a person's value, and
above SNMP, virtualization and Oxidized.

``target(fact)`` names the platform a host on those facts belongs on:
``Debian 13`` (label + release), with the endoflife.date product and
cycle it maps to when the cached catalog has them (``debian`` / ``13``;
``rhel`` / ``9`` for ``9.4`` - the longest cycle the version starts with,
as for an application's install). The platform is never changed here: the
review queue proposes it (``discovery.inventory_findings``).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from django.utils.text import slugify

#: os-release ``ID`` → (the name people write, endoflife.date products to
#: try in order, how many version parts name a release).
OS_NAMES: dict[str, tuple[str, tuple[str, ...], int]] = {
    "debian": ("Debian", ("debian",), 1),
    "ubuntu": ("Ubuntu", ("ubuntu",), 2),
    "rhel": ("Red Hat Enterprise Linux", ("rhel",), 1),
    "rocky": ("Rocky Linux", ("rocky-linux",), 1),
    "almalinux": ("AlmaLinux", ("almalinux",), 1),
    "centos": ("CentOS", ("centos", "centos-stream"), 1),
    "ol": ("Oracle Linux", ("oracle-linux",), 1),
    "fedora": ("Fedora", ("fedora",), 1),
    "amzn": ("Amazon Linux", ("amazon-linux",), 1),
    "alpine": ("Alpine Linux", ("alpine-linux", "alpine"), 2),
    "sles": ("SUSE Linux Enterprise Server", ("sles",), 1),
    "opensuse-leap": ("openSUSE Leap", ("opensuse",), 2),
}
EOL_SOURCE = "endoflife_date"
_NUM = re.compile(r"\d+(?:\.\d+)*")


def version_of(fact) -> str:
    """The running version the facts give, or blank."""
    if fact is None:
        return ""
    if fact.os_id == "windows":
        if fact.build and fact.ubr is not None:
            return f"10.0.{fact.build}.{fact.ubr}"
        return (fact.version_id or "")[:64]
    return (fact.version_id or "").strip()[:64]


@dataclass(frozen=True)
class Target:
    label: str
    release: str
    name: str
    slug: str
    #: endoflife.date product and cycle, blank when the catalog lacks them.
    eol_product: str
    eol_cycle: str


def _label(fact) -> tuple[str, tuple[str, ...], int]:
    known = OS_NAMES.get(fact.os_id)
    if known:
        return known
    pretty = re.sub(r"\s*\(.*?\)\s*", " ", fact.pretty_name or "").strip()
    pretty = _NUM.sub("", pretty).strip() or fact.os_id.title()
    return pretty[:100], (), 1


def target(fact, catalog: dict | None = None) -> Target | None:
    """The platform the facts point at; None for Windows (its products are
    not one name + release) and for facts without a version.
    ``catalog``: ``{product name: EolProduct}`` already loaded (else one
    query)."""
    if fact is None or fact.os_id in ("", "windows"):
        return None
    version = version_of(fact)
    if not version:
        return None
    label, products, parts = _label(fact)
    nums = _NUM.findall(version)
    if not nums:
        return None
    release = ".".join(nums[0].split(".")[:parts])
    name = f"{label} {release}"
    product, cycle = "", ""
    if products:
        from compliance.eol import suggest_cycle

        if catalog is None:
            catalog = load_catalog()
        for p in products:
            cat = catalog.get(p)
            if cat is None:
                continue
            got = suggest_cycle(cat, version)
            if got:
                product, cycle = p, got
                break
    return Target(label, release, name[:128], slugify(name)[:128], product, cycle)


def load_catalog() -> dict:
    """The cached endoflife.date products the OS names use, by name: one
    query. Empty while end-of-life data is off."""
    from compliance.eol import load_config
    from compliance.models import EolProduct

    if not load_config().enabled:
        return {}
    names = {p for _l, ps, _n in OS_NAMES.values() for p in ps}
    return {p.name: p for p in EolProduct.objects.filter(
        tenant__isnull=True, source=EOL_SOURCE, name__in=names)}


def fits(platform, t: Target) -> bool:
    """Whether ``platform`` already stands for the facts' OS and release: its
    end-of-life mapping says so, or its name names the OS without naming a
    different release ("Debian", "Debian 13"; not "Debian 12", not
    "Linux 6.x/2.6 Kernel")."""
    if platform is None:
        return False
    from compliance.eol import mapping_of

    m = mapping_of(platform)
    if m is not None and t.eol_product:
        if m.product == t.eol_product:
            return m.cycle == t.eol_cycle
        return False
    text = f"{platform.name} {platform.slug.replace('-', ' ')}".lower()
    words = slugify(t.label).split("-")
    if not all(re.search(rf"\b{re.escape(w)}\b", text) for w in words):
        return False
    nums = _NUM.findall(platform.name or "")
    return all(t.release == n or t.release.startswith(n + ".") or n.startswith(t.release)
               for n in nums)


def per_release(platform) -> bool:
    """The platform's name carries a release ("Debian 13"), so one end-of-life
    cycle fits every host on it."""
    return bool(_NUM.search(platform.name or ""))


def find_platform(platforms, t: Target):
    """The tenant platform the facts belong on, best first: one mapped to the
    same product and cycle, then one named ``Debian 13`` (or its slug), then
    a per-OS ``Debian``. None when the tenant has none."""
    from compliance.eol import mapping_of

    if t.eol_product:
        for p in platforms:
            m = mapping_of(p)
            if m is not None and (m.product, m.cycle) == (t.eol_product, t.eol_cycle):
                return p
    for p in platforms:
        if p.name.lower() == t.name.lower() or p.slug == t.slug:
            return p
    base = slugify(t.label)
    for p in platforms:
        if (p.name.lower() == t.label.lower() or p.slug == base) and fits(p, t):
            return p
    return None


# ─── running version ─────────────────────────────────────────────────────────


def record_versions(tenant, facts, now=None) -> dict:
    """Write each read host's running version from its facts (source
    ``discovery``), in bulk: one read of the hosts per kind, one UPDATE per
    kind, change-logged like any version change. Returns ``{"device": ids,
    "virtual_machine": ids}`` of the hosts whose version moved."""
    from django.db import transaction
    from django.utils import timezone

    from api.models import Device, VirtualMachine
    from api.software_versions import record
    from audit import bulk as audit_bulk
    from audit.context import cause

    now = now or timezone.now()
    moved = {"device": set(), "virtual_machine": set()}
    by_kind = {"device": {}, "virtual_machine": {}}
    for f in facts:
        version = version_of(f)
        if not version:
            continue
        if f.device_id:
            by_kind["device"][f.device_id] = version
        elif f.virtual_machine_id:
            by_kind["virtual_machine"][f.virtual_machine_id] = version
    fields = ["software_version", "software_version_seen_at", "software_version_source"]
    for kind, model in (("device", Device), ("virtual_machine", VirtualMachine)):
        wanted = by_kind[kind]
        if not wanted:
            continue
        changed, before = [], []
        for obj in model.objects.filter(tenant=tenant, pk__in=list(wanted)).only(
                "pk", "tenant_id", "site_id", "name", *fields):
            old = model(pk=obj.pk, tenant=tenant, site_id=obj.site_id, name=obj.name,
                        **{k: getattr(obj, k) for k in fields})
            if record(obj, wanted[obj.pk], "discovery", now):
                changed.append(obj)
                before.append(old)
        if not changed:
            continue
        with transaction.atomic(), cause("Package inventory"):
            model.objects.bulk_update(changed, fields, batch_size=1000)
            audit_bulk.log_bulk_update(before, {}, {
                o.pk: {k: getattr(o, k) for k in fields} for o in changed})
        moved[kind] = {o.pk for o in changed}
    return moved
