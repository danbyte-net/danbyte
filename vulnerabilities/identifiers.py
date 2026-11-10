"""Product identities: CPE 2.3 names and package URLs (#451).

A vulnerability record names what it affects either by CPE (NVD: network OS,
firmware, hardware) or by package (OSV: ecosystem + name). Both reduce to a
``(kind, part, vendor, product)`` key that ``CveProduct`` indexes and a
product mapping looks up:

* CPE  ``cpe:2.3:o:cisco:ios_xe:17.9.4a:*...`` -> ``("cpe", "o", "cisco", "ios_xe")``
* purl ``pkg:pypi/Django@5.2``                 -> ``("purl", "", "pypi", "django")``
* purl ``pkg:deb/debian/openssl?arch=source``  -> ``("purl", "", "deb", "debian/openssl")``

Pure Python, no Django.
"""
from __future__ import annotations

import re
from urllib.parse import unquote

CPE_PARTS = ("o", "a", "h")
_CVE_ID = re.compile(r"^CVE-\d{4}-\d{4,}$")
#: An OSV id: a prefix and a body (GHSA-xxxx-xxxx-xxxx, PYSEC-2024-1,
#: GO-2024-1234, RUSTSEC-2024-0001, DSA-5555-1, UBUNTU-CVE-2024-1).
_VULN_ID = re.compile(r"^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]+$")
MAX_ID = 64


def is_cve_id(value) -> bool:
    return isinstance(value, str) and len(value) <= MAX_ID and bool(_CVE_ID.match(value))


def is_vuln_id(value) -> bool:
    return isinstance(value, str) and len(value) <= MAX_ID and bool(_VULN_ID.match(value))


# ─── CPE 2.3 ────────────────────────────────────────────────────────────────


def split_cpe(criteria: str) -> list[str] | None:
    """The 13 components of a CPE 2.3 formatted string, unescaped colons
    kept as part of their component; ``None`` when it is not one."""
    if not isinstance(criteria, str) or not criteria.startswith("cpe:2.3:"):
        return None
    if len(criteria) > 512:
        return None
    parts, cur, escaped = [], [], False
    for ch in criteria:
        if escaped:
            cur.append(ch)
            escaped = False
        elif ch == "\\":
            cur.append(ch)
            escaped = True
        elif ch == ":":
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    if len(parts) != 13:
        return None
    return parts


def cpe_product(criteria: str) -> tuple[str, str, str] | None:
    """``(part, vendor, product)`` of a CPE name, lowercase; ``None`` when it
    is not a CPE 2.3 name or names no concrete vendor/product."""
    parts = split_cpe(criteria)
    if parts is None:
        return None
    part, vendor, product = parts[2].lower(), parts[3].lower(), parts[4].lower()
    if part not in CPE_PARTS or vendor in ("*", "-", "") or product in ("*", "-", ""):
        return None
    return part, vendor, product


# ─── package URLs ───────────────────────────────────────────────────────────

#: OSV ecosystem (before any ``:release`` suffix) -> purl type.
ECOSYSTEM_TYPES = {
    "pypi": "pypi",
    "npm": "npm",
    "maven": "maven",
    "go": "golang",
    "crates.io": "cargo",
    "rubygems": "gem",
    "packagist": "composer",
    "nuget": "nuget",
    "debian": "deb",
    "ubuntu": "deb",
    "alpine": "apk",
    "hex": "hex",
    "pub": "pub",
    "hackage": "hackage",
    "cran": "cran",
    "swifturl": "swift",
    "rocky linux": "rpm",
    "almalinux": "rpm",
    "red hat": "rpm",
}
#: purl types whose package lives under a distribution namespace.
_DISTRO_NAMESPACE = {"debian": "debian", "ubuntu": "ubuntu", "alpine": "alpine",
                     "rocky linux": "rocky", "almalinux": "almalinux",
                     "red hat": "redhat"}
_PURL_TYPE = re.compile(r"^[a-z][a-z0-9.+-]*$")


def _norm_name(ptype: str, name: str) -> str:
    if ptype == "pypi":
        # PEP 503 normalised name, as the purl spec asks for PyPI.
        return re.sub(r"[-_.]+", "-", name).lower()
    if ptype in ("deb", "apk", "rpm", "gem", "cargo", "npm", "hex", "pub"):
        return name.lower() if ptype != "npm" else name
    return name


def purl_key(purl: str) -> tuple[str, str] | None:
    """``(type, "namespace/name")`` of a package URL, version, qualifiers
    and subpath dropped; ``None`` when it is not one."""
    if not isinstance(purl, str) or not purl.startswith("pkg:") or len(purl) > 512:
        return None
    rest = purl[4:].lstrip("/")
    rest = rest.split("#", 1)[0].split("?", 1)[0]
    ptype, sep, path = rest.partition("/")
    ptype = ptype.lower()
    if not sep or not _PURL_TYPE.match(ptype):
        return None
    # The version follows the last "@" of the last segment (npm scopes are
    # percent-encoded as %40 in the namespace).
    head, _, last = path.rpartition("/")
    last = last.split("@", 1)[0]
    segments = [unquote(s) for s in (head.split("/") if head else []) if s] + [unquote(last)]
    if not segments[-1]:
        return None
    name = _norm_name(ptype, segments[-1])
    namespace = "/".join(segments[:-1])
    if ptype in ("deb", "apk", "rpm", "pypi", "cargo", "gem", "nuget"):
        namespace = namespace.lower()
    product = f"{namespace}/{name}" if namespace else name
    return ptype, product


def package_key(ecosystem: str, name: str, purl: str = "") -> tuple[str, str] | None:
    """The purl key of an OSV ``affected[].package``. Its own ``purl`` wins;
    otherwise the ecosystem and name are turned into one."""
    if purl:
        key = purl_key(purl)
        if key is not None:
            return key
    if not isinstance(ecosystem, str) or not isinstance(name, str) or not name:
        return None
    base = ecosystem.split(":", 1)[0].strip().lower()
    ptype = ECOSYSTEM_TYPES.get(base, "generic")
    if ptype == "maven" and ":" in name:
        group, _, artifact = name.partition(":")
        return ptype, f"{group}/{artifact}"
    distro = _DISTRO_NAMESPACE.get(base)
    clean = _norm_name(ptype, name)
    if distro:
        return ptype, f"{distro}/{clean}"
    return ptype, clean
