"""Product identities: CPE 2.3 names and package URLs (#451).

A vulnerability record names what it affects either by CPE (NVD: network OS,
firmware, hardware) or by package (OSV: ecosystem + name). Both reduce to a
``(kind, part, vendor, product)`` key that ``CveProduct`` indexes and a
product mapping looks up:

* CPE  ``cpe:2.3:o:cisco:ios_xe:17.9.4a:*...`` -> ``("cpe", "o", "cisco", "ios_xe")``
* purl ``pkg:pypi/Django@5.2``                 -> ``("purl", "", "pypi", "django")``
* purl ``pkg:deb/debian/openssl?arch=source``  -> ``("purl", "", "deb", "debian/openssl")``

Distro packages (deb, rpm, apk) are advised per release: OSV writes the
ecosystem ``Debian:12``, ``Ubuntu:22.04:LTS``, ``Alpine:v3.20``. The release
helpers below read one from an ecosystem, a purl ``distro=`` qualifier or a
platform, as ``(family, release)`` such as ``("debian", "12")``.

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
    "opensuse": "rpm",
}
#: purl types whose package lives under a distribution namespace.
_DISTRO_NAMESPACE = {"debian": "debian", "ubuntu": "ubuntu", "alpine": "alpine",
                     "rocky linux": "rocky", "almalinux": "almalinux",
                     "red hat": "redhat", "opensuse": "opensuse"}
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
    # OSV writes openSUSE's purls with "&" for "?" (pkg:rpm/opensuse/curl
    # &distro=…), which would put the qualifier into the name: for a distro
    # this code knows, such a purl gives way to the ecosystem and name.
    malformed = "&" in purl and "?" not in purl and isinstance(ecosystem, str) \
        and ecosystem.split(":", 1)[0].strip().lower() in _DISTRO_NAMESPACE
    if purl and not malformed:
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


def purl_qualifiers(purl: str) -> dict[str, str]:
    """The qualifiers of a package URL (``?arch=amd64&distro=bookworm``),
    keys lowercase, values percent-decoded; ``{}`` when it has none."""
    if not isinstance(purl, str) or "?" not in purl or len(purl) > 512:
        return {}
    query = purl.split("#", 1)[0].split("?", 1)[1]
    out = {}
    for pair in query.split("&"):
        key, sep, value = pair.partition("=")
        if sep and key and value:
            out[key.strip().lower()] = unquote(value).strip()
    return out


# ─── distro releases (OSV ecosystems such as ``Debian:12``) ──────────────────

#: purl types whose OSV advisories are written per distro release.
DISTRO_TYPES = frozenset({"deb", "rpm", "apk"})
#: Which distro families (purl namespaces) a purl type's releases are read for.
_TYPE_FAMILIES = {"deb": {"debian", "ubuntu"}, "apk": {"alpine"},
                  "rpm": {"rocky", "almalinux", "redhat", "opensuse"}}
#: Words a ``distro=`` qualifier or a platform name uses for a family.
_FAMILY_WORDS = {
    "debian": {"debian"},
    "ubuntu": {"ubuntu"},
    "alpine": {"alpine", "alpinelinux", "alpine linux"},
    "rocky": {"rocky", "rockylinux", "rocky linux", "el"},
    "almalinux": {"almalinux", "alma", "alma linux", "el"},
    "redhat": {"redhat", "red hat", "rhel", "red hat enterprise linux", "el"},
    "opensuse": {"opensuse", "opensuse leap", "opensuse-leap", "leap"},
}
DEBIAN_CODENAMES = {
    "wheezy": "7", "jessie": "8", "stretch": "9", "buster": "10", "bullseye": "11",
    "bookworm": "12", "trixie": "13", "forky": "14", "duke": "15",
}
UBUNTU_CODENAMES = {
    "trusty": "14.04", "xenial": "16.04", "bionic": "18.04", "focal": "20.04",
    "jammy": "22.04", "kinetic": "22.10", "lunar": "23.04", "mantic": "23.10",
    "noble": "24.04", "oracular": "24.10", "plucky": "25.04", "questing": "25.10",
    "resolute": "26.04",
}
_RELEASE_FORM = {"debian": r"\d+", "ubuntu": r"\d{2}\.\d{2}", "alpine": r"\d+\.\d+",
                 "rocky": r"\d+", "almalinux": r"\d+", "redhat": r"\d+",
                 "opensuse": r"\d+\.\d+"}

#: ``(family, release)``: ``("debian", "12")``, ``("ubuntu", "22.04")``.
Release = tuple[str, str]


def _release_number(family: str, text: str) -> str | None:
    m = re.search(_RELEASE_FORM[family], text)
    if m is None:
        return None
    value = m.group(0)
    return value if family in ("ubuntu", "alpine", "opensuse") else str(int(value))


def _codenames(family: str) -> dict[str, str]:
    if family == "debian":
        return DEBIAN_CODENAMES
    return UBUNTU_CODENAMES if family == "ubuntu" else {}


def ecosystem_release(ecosystem) -> Release | None:
    """``(family, release)`` of a per-release OSV ecosystem: ``Debian:12`` ->
    ``("debian", "12")``, ``Ubuntu:Pro:18.04:LTS`` -> ``("ubuntu", "18.04")``,
    ``Alpine:v3.19`` -> ``("alpine", "3.19")``,
    ``Red Hat:enterprise_linux:9::appstream`` -> ``("redhat", "9")``. Another
    distro's (``SUSE:…``) keeps its text. ``None`` for an ecosystem without a
    release (``PyPI``, ``Debian``)."""
    if not isinstance(ecosystem, str) or ":" not in ecosystem:
        return None
    base, _, rest = ecosystem.partition(":")
    base, rest = base.strip().lower(), rest.strip().lower()
    if not rest:
        return None
    family = _DISTRO_NAMESPACE.get(base)
    if family is None:
        return base, rest
    if family == "opensuse" and not re.fullmatch(r"leap \d+\.\d+", rest):
        # Tumbleweed, Leap Micro, …: not a Leap release; never equal to one.
        return family, rest
    number = _release_number(family, rest)
    return family, number if number is not None else rest


def distro_release(ptype: str, namespace: str, text) -> Release | None:
    """The release a ``distro=`` qualifier names for a package of ``ptype``
    under ``namespace``: ``bookworm``, ``debian-12`` and ``12.5`` are Debian
    12; ``jammy`` and ``ubuntu-22.04`` Ubuntu 22.04; ``v3.19`` and
    ``alpine-3.19.1`` Alpine 3.19; ``el9`` and ``rocky-9.3`` major 9.
    ``None`` when it is blank, names another distro or is not understood."""
    family = (namespace or "").lower()
    if family not in _TYPE_FAMILIES.get(ptype, ()) or not isinstance(text, str):
        return None
    value = text.strip().lower()[:64]
    if not value:
        return None
    names = _codenames(family)
    if value in names:
        return family, names[value]
    if value in DEBIAN_CODENAMES or value in UBUNTU_CODENAMES:
        return None  # another distro's codename
    m = re.match(r"^([a-z][a-z ]*?)?[\s_:-]*(v?\d.*)$", value)
    if m is None:
        return None
    word = (m.group(1) or "").strip()
    if word and word != "v" and word not in _FAMILY_WORDS[family]:
        return None
    number = _release_number(family, m.group(2))
    return (family, number) if number is not None else None


def platform_release(ptype: str, namespace: str, name, version) -> Release | None:
    """The release of a host from its platform's name and its running
    version: platform *Debian 12* or *Debian* at ``12.5``, *Ubuntu 22.04
    LTS*, *Ubuntu Jammy*, *Rocky Linux* at ``9.3``. The platform must name
    the package's distro; a release in the name wins over the version."""
    family = (namespace or "").lower()
    if family not in _TYPE_FAMILIES.get(ptype, ()) or not isinstance(name, str):
        return None
    text = name.strip().lower()[:128]
    words = _FAMILY_WORDS[family] - {"el"}
    if not any(re.search(rf"\b{re.escape(w)}\b", text) for w in words):
        return None
    names = _codenames(family)
    for word in re.findall(r"[a-z]+", text):
        if word in names:
            return family, names[word]
    number = _release_number(family, text)
    if number is None and isinstance(version, str):
        number = _release_number(family, version.strip()[:64])
    return (family, number) if number is not None else None


def osv_ecosystems(release: Release) -> list[str]:
    """The OSV ecosystem names to query a release by; ``[]`` when there is
    no single one (Red Hat names one per product stream)."""
    family, number = release
    if family == "debian":
        return [f"Debian:{number}"]
    if family == "ubuntu":
        yy, _, mm = number.partition(".")
        lts = mm == "04" and yy.isdigit() and int(yy) % 2 == 0
        return [f"Ubuntu:{number}:LTS" if lts else f"Ubuntu:{number}"]
    if family == "alpine":
        return [f"Alpine:v{number}"]
    if family == "rocky":
        return [f"Rocky Linux:{number}"]
    if family == "almalinux":
        return [f"AlmaLinux:{number}"]
    if family == "opensuse":
        return [f"openSUSE:Leap {number}"]
    return []
