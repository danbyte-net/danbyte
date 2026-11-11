"""Does a vulnerability record affect one product at one version (#451)?

Pure functions over the stored record (``Cve.configurations``, ``Cve.osv``)
and a :class:`Target`: the mapped product, its version and what else the host
is mapped to (its hardware and its operating system). No Django.

NVD configurations (``match_nvd``). Each configuration entry is tested on its
own and the entries are OR'd. Inside an entry, nodes combine with the entry's
``operator`` (AND/OR) and a node's ``cpeMatch`` list is OR; ``negate`` is
honoured. A ``cpeMatch`` naming the mapped product tests the version: a
concrete CPE version must equal it, a ``*`` version must fall inside the
``versionStart*``/``versionEnd*`` bounds. Only a ``vulnerable: true`` one can
make the match. A ``cpeMatch`` naming another product is context: hardware
(``h``) is satisfied when the device type's hardware mapping names it, an OS
(``o``) when the host's platform mapping does. When the host has no mapping of
that kind the node is unknown: it does not stop the match, and the match is
``partial`` (decision 9).

OSV advisories (``match_osv``). An ``affected`` entry for the mapped package
matches when its ``versions`` list holds the version (``exact``) or one of
its ``ECOSYSTEM``/``SEMVER`` ranges covers it (``range``), evaluated as the
OSV schema describes: events in version order, ``introduced`` opens,
``fixed`` and ``limit`` close at, ``last_affected`` closes after. Distro
packages (deb, rpm, apk) are advisories per release (``Debian:12``,
``Ubuntu:22.04:LTS``): an entry counts only for a target on its release (see
``match_osv`` for a target whose release is unknown).

Each test also reports why it could not decide, as flags the coverage report
counts: ``version_not_understood``, ``unparsed_bounds``,
``range_not_understood``, ``release_unknown``.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import versions
from .identifiers import DISTRO_TYPES, ecosystem_release, split_cpe

CONFIDENCE_ORDER = {"exact": 3, "range": 2, "partial": 1}

VERSION_NOT_UNDERSTOOD = "version_not_understood"
UNPARSED_BOUNDS = "unparsed_bounds"
RANGE_NOT_UNDERSTOOD = "range_not_understood"
RELEASE_UNKNOWN = "release_unknown"
#: Every flag a test can raise, in the order the coverage report lists them.
FLAGS = (UNPARSED_BOUNDS, RANGE_NOT_UNDERSTOOD, VERSION_NOT_UNDERSTOOD, RELEASE_UNKNOWN)


@dataclass(frozen=True)
class Target:
    """One product at one version on one host."""

    kind: str          # cpe | purl
    part: str          # o / a / h for a CPE, "" for a package
    vendor: str        # CPE vendor, or the purl type
    product: str       # CPE product, or the package (namespace/name)
    scheme: str        # resolved: never "auto"
    version: str
    #: ``(vendor, product)`` of the device type's hardware mappings; None
    #: when the device type has none (or the host is a VM).
    hardware: frozenset | None = None
    #: ``(part, vendor, product)`` of the host's platform mappings; None
    #: when the platform has none.
    platforms: frozenset | None = None
    #: ``(family, release)`` of a distro package's host (``("debian", "12")``,
    #: :mod:`vulnerabilities.identifiers`); None when it is not known.
    release: tuple | None = None

    @property
    def key(self) -> versions.Key | None:
        return _key(self.version, self.scheme)


_KEYS: dict[tuple[str, str], versions.Key | None] = {}


def _key(version: str, scheme: str) -> versions.Key | None:
    k = (scheme, version)
    if k not in _KEYS:
        if len(_KEYS) > 50_000:
            _KEYS.clear()
        _KEYS[k] = versions.parse(version, scheme)
    return _KEYS[k]


def _unescape(value: str) -> str:
    out, esc = [], False
    for ch in value:
        if esc:
            out.append(ch)
            esc = False
        elif ch == "\\":
            esc = True
        else:
            out.append(ch)
    return "".join(out)


def _best(a: str | None, b: str | None) -> str | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if CONFIDENCE_ORDER[a] >= CONFIDENCE_ORDER[b] else b


# ─── three-valued logic: True, False, None (unknown) ─────────────────────────


def _or(values) -> bool | None:
    values = list(values)
    if any(v is True for v in values):
        return True
    return None if any(v is None for v in values) else False


def _and(values) -> bool | None:
    values = list(values)
    if any(v is False for v in values):
        return False
    return None if any(v is None for v in values) else True


def _negate(value: bool | None, negate: bool) -> bool | None:
    if not negate or value is None:
        return value
    return not value


# ─── versions against a CPE match ────────────────────────────────────────────


def _in_range(target: Target, m: dict, flags: set) -> bool:
    bounds = [(k, m[k]) for k in ("versionStartIncluding", "versionStartExcluding",
                                  "versionEndIncluding", "versionEndExcluding") if m.get(k)]
    if not bounds:
        return True
    if not versions.supports_ranges(target.scheme):
        flags.add(RANGE_NOT_UNDERSTOOD)
        return False
    key = target.key
    if key is None:
        flags.add(VERSION_NOT_UNDERSTOOD)
        return False
    for name, raw in bounds:
        bound = _key(raw, target.scheme)
        if bound is None:
            flags.add(UNPARSED_BOUNDS)
            return False
        c = versions.compare(key, bound)
        if c is None:
            # Not comparable (another IOS train): outside this range.
            return False
        if name == "versionStartIncluding" and c < 0:
            return False
        if name == "versionStartExcluding" and c <= 0:
            return False
        if name == "versionEndIncluding" and c > 0:
            return False
        if name == "versionEndExcluding" and c >= 0:
            return False
    return True


def _exact(target: Target, version: str, update: str) -> bool:
    """A concrete CPE version (and update) against the target's version."""
    scheme = target.scheme
    any_update = update in ("*", "")
    if scheme == "junos":
        cpe_text = version if update in ("*", "-", "") else f"{version}{update}"
    elif update in ("*", "-", ""):
        cpe_text = version
    else:
        cpe_text = f"{version}-{update}"
    key = target.key
    if key is not None:
        other = _key(cpe_text, scheme)
        if other is not None and versions.compare(key, other) is not None:
            if scheme == "junos" and any_update:
                # junos:21.4:* - every release of 21.4.
                return key.sort[:2] == other.sort[:2]
            return key.sort == other.sort
    # Decision 10: an exact CPE string still matches a version no scheme reads.
    return target.version.strip().lower() == cpe_text.lower()


def _version_test(target: Target, m: dict, parts: list[str], flags: set) -> str | None:
    """``exact`` / ``range`` when the match's version test passes, else None."""
    version = _unescape(parts[5])
    update = _unescape(parts[6])
    if version == "-":
        return None
    if version in ("*", ""):
        return "range" if _in_range(target, m, flags) else None
    return "exact" if _exact(target, version, update) else None


def _context(target: Target, part: str, vendor: str, product: str) -> bool | None:
    if part == "h":
        if target.hardware is None:
            return None
        return (vendor, product) in target.hardware
    if part == "o":
        if target.platforms is None:
            return None
        return (part, vendor, product) in target.platforms
    return None


def match_nvd(configurations, target: Target) -> tuple[str | None, set]:
    """``(confidence or None, flags)`` of a record's NVD configurations."""
    flags: set = set()
    best = None
    if target.kind != "cpe":
        return None, flags
    for entry in configurations or []:
        node_values, hit = [], None
        for node in entry.get("nodes") or []:
            values, node_hit = [], None
            for m in node.get("cpeMatch") or []:
                parts = split_cpe(m.get("criteria", ""))
                if parts is None:
                    values.append(False)
                    continue
                part, vendor, product = parts[2].lower(), parts[3].lower(), parts[4].lower()
                if (part, vendor, product) == (target.part, target.vendor, target.product):
                    conf = _version_test(target, m, parts, flags)
                    values.append(conf is not None)
                    if conf is not None and m.get("vulnerable"):
                        node_hit = _best(node_hit, conf)
                else:
                    values.append(_context(target, part, vendor, product))
            combine = _and if node.get("operator") == "AND" else _or
            value = _negate(combine(values), bool(node.get("negate")))
            node_values.append(value)
            if node_hit and not node.get("negate") and value is not False:
                hit = _best(hit, node_hit)
        combine = _and if entry.get("operator") == "AND" else _or
        value = _negate(combine(node_values), bool(entry.get("negate")))
        if hit is None or value is False:
            continue
        best = _best(best, "partial" if value is None else hit)
    return best, flags


# ─── OSV ranges ──────────────────────────────────────────────────────────────


def _osv_range(target: Target, rng: dict, flags: set) -> bool:
    scheme = "semver" if rng.get("type") == "SEMVER" else target.scheme
    if not versions.supports_ranges(scheme):
        flags.add(RANGE_NOT_UNDERSTOOD)
        return False
    key = _key(target.version, scheme)
    if key is None:
        flags.add(VERSION_NOT_UNDERSTOOD)
        return False
    events = []
    for e in rng.get("events") or []:
        (kind, raw), = e.items()
        if kind == "introduced" and raw == "0":
            events.append((0, None, kind))
            continue
        k = _key(raw, scheme)
        if k is None or versions.compare(k, key) is None:
            flags.add(UNPARSED_BOUNDS)
            return False
        events.append((1, k, kind))
    if not events:
        return False
    # Events in version order; "0" first.
    from functools import cmp_to_key

    def order(a, b):
        if a[0] != b[0]:
            return a[0] - b[0]
        if a[1] is None:
            return 0
        return versions.compare(a[1], b[1]) or 0

    events.sort(key=cmp_to_key(order))
    affected = False
    for _, k, kind in events:
        c = 1 if k is None else versions.compare(key, k)
        if kind == "introduced" and c >= 0:
            affected = True
        elif kind in ("fixed", "limit") and c >= 0:
            affected = False
        elif kind == "last_affected" and c > 0:
            affected = False
    return affected


def _osv_entry(a: dict, target: Target, key, flags: set) -> str | None:
    """``exact`` / ``range`` when one ``affected`` entry covers the version."""
    listed = a.get("versions") or []
    if target.version in listed or (key is not None and any(
            (k := _key(v, target.scheme)) is not None
            and versions.compare(key, k) == 0 for v in listed)):
        return "exact"
    if any(_osv_range(target, r, flags) for r in a.get("ranges") or []):
        return "range"
    return None


def match_osv(osv, target: Target) -> tuple[str | None, set]:
    """``(confidence or None, flags)`` of a record's OSV advisories.

    For a distro package (deb, rpm, apk) an entry written for one release
    (``Debian:12``) is tested only against a target on that release. When
    the target's release is unknown the record matches (``partial``) only
    if every release it names agrees the version is affected; when the
    releases disagree it does not match and is flagged ``release_unknown``.
    """
    flags: set = set()
    best = None
    if target.kind != "purl" or not target.version.strip():
        return None, flags
    key = target.key
    distro = target.vendor in DISTRO_TYPES
    per_release: dict = {}
    for adv in (osv or {}).values():
        for a in adv.get("affected") or []:
            if (a.get("purl_type"), a.get("package")) != (target.vendor, target.product):
                continue
            # Entries stored without an ecosystem test as release-less.
            release = ecosystem_release(a.get("ecosystem")) if distro else None
            if release is not None and target.release is not None \
                    and release != target.release:
                continue
            conf = _osv_entry(a, target, key, flags)
            if release is None or target.release is not None:
                best = _best(best, conf)
            else:
                per_release[release] = _best(per_release.get(release), conf)
    if per_release:
        verdicts = list(per_release.values())
        if all(v is not None for v in verdicts):
            best = _best(best, "partial")
        elif any(v is not None for v in verdicts):
            flags.add(RELEASE_UNKNOWN)
    return best, flags


# ─── Microsoft fixed builds ──────────────────────────────────────────────────

#: Microsoft lists the product but no fixed build on its build line.
NO_FIXED_BUILD = "no_fixed_build"
#: The host's installation type or architecture is not known and its
#: variants disagree (one affected, another not).
VARIANT_UNKNOWN = "variant_unknown"
MSRC_FLAGS = (NO_FIXED_BUILD, VARIANT_UNKNOWN)


def _msrc_variant(msrc: dict, key: str, line: str, ubr: int, flags: set) -> bool | None:
    named, lowest = False, None
    for month in (msrc or {}).values():
        p = (month.get("products") or {}).get(key) if isinstance(month, dict) else None
        if not isinstance(p, dict):
            continue
        named = True
        for raw in p.get("fixed") or []:
            k = versions.parse(raw, "winbuild")
            if k is not None and k.group == line and (lowest is None or k.sort < lowest):
                lowest = k.sort
    if not named:
        return False
    if lowest is None:
        flags.add(NO_FIXED_BUILD)
        return None
    # Builds are cumulative: the host is fixed from the lowest build that
    # carries the fix (a hotpatch build counts; it sits between the previous
    # and the next regular build).
    return (ubr,) < lowest


def match_msrc(msrc, keys, line: str, ubr) -> tuple[str | None, set]:
    """``(confidence or None, flags)`` of Microsoft's data for a Windows host
    that can be any of the products ``keys`` (one when its installation type
    and architecture are known), on build line ``line`` at ``ubr``.

    Affected when the host's UBR is below the lowest fixed build Microsoft
    lists for its product on its own build line. With several candidate
    products every one must agree; when they disagree the record does not
    match and is flagged ``variant_unknown``. A product listed without a
    fixed build on the line is flagged ``no_fixed_build`` and not matched."""
    flags: set = set()
    if not keys or not line or not isinstance(ubr, int) or isinstance(ubr, bool):
        return None, flags
    verdicts = [_msrc_variant(msrc, k, line, ubr, flags) for k in keys]
    if all(v is True for v in verdicts):
        return "range", flags
    if any(v is True for v in verdicts) and any(v is False for v in verdicts):
        flags.add(VARIANT_UNKNOWN)
    return None, flags


def match(record_configurations, record_osv, target: Target) -> tuple[str | None, set]:
    if target.kind == "purl":
        return match_osv(record_osv, target)
    return match_nvd(record_configurations, target)
