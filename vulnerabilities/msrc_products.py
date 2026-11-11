"""Windows products in Microsoft's advisory data (#451, MSRC source).

One table, as data: each Windows release Microsoft's CVRF documents name as
a product (``Windows Server 2022 (Server Core installation)``), with the
build line its fixed builds are on (``10.0.20348``), whether it is a server,
its installation type (Desktop Experience or Server Core) and, for client
releases, the CPU architecture. The names were taken from the monthly
documents of 2025-Oct, 2026-Oct and 2026-Nov; a release Microsoft adds later
needs a row here before hosts on it match.

:func:`resolve` maps what discovery read from a Windows host
(``discovery.HostOsFact``: build, UBR, caption, edition, display version)
to the products it can be. A host that cannot be placed confidently - a
build line not in the table, a caption that contradicts the build, no UBR -
gets no product and a flag, never a guess. When the installation type or
the architecture is not known the host keeps every variant of its release
as a candidate; matching then needs every variant to agree.

Pure Python, no Django.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

#: ``CveProduct`` / ``TrackedProducts`` key of an MSRC product.
KIND = "msrc"
VENDOR = "microsoft"

#: Why a Windows host has no product to match.
PRODUCT_UNKNOWN = "product_unknown"
UBR_UNKNOWN = "ubr_unknown"


@dataclass(frozen=True)
class Product:
    key: str
    #: Microsoft's product name, as the CVRF ``FullProductName`` writes it.
    name: str
    #: ``10.0.20348`` - the build line its ``FixedBuild`` values are on.
    line: str
    family: str
    server: bool
    #: ``desktop`` / ``core`` for a server; blank for a client release.
    install: str = ""
    #: ``x64`` / ``arm64`` / ``x86`` for a client release; blank for a server.
    arch: str = ""


@dataclass(frozen=True)
class Family:
    """One release: every product variant of it shares the build line."""

    key: str
    label: str
    line: str
    server: bool
    #: Client releases: the ``DisplayVersion`` (or ``ReleaseId``) it reports.
    release: str = ""
    #: Server releases: the year its caption names.
    year: str = ""


_SERVER = (
    # (family, label, line, year, [(install, name)])
    ("windows_server_2012", "Windows Server 2012", "6.2.9200", "2012",
     [("desktop", "Windows Server 2012"),
      ("core", "Windows Server 2012 (Server Core installation)")]),
    ("windows_server_2012_r2", "Windows Server 2012 R2", "6.3.9600", "2012",
     [("desktop", "Windows Server 2012 R2"),
      ("core", "Windows Server 2012 R2 (Server Core installation)")]),
    ("windows_server_2016", "Windows Server 2016", "10.0.14393", "2016",
     [("desktop", "Windows Server 2016"),
      ("core", "Windows Server 2016 (Server Core installation)")]),
    ("windows_server_2019", "Windows Server 2019", "10.0.17763", "2019",
     [("desktop", "Windows Server 2019"),
      ("core", "Windows Server 2019 (Server Core installation)")]),
    ("windows_server_2022", "Windows Server 2022", "10.0.20348", "2022",
     [("desktop", "Windows Server 2022"),
      ("core", "Windows Server 2022 (Server Core installation)")]),
    ("windows_server_2022_23h2", "Windows Server 2022, 23H2 Edition", "10.0.25398", "2022",
     [("core", "Windows Server 2022, 23H2 Edition (Server Core installation)")]),
    ("windows_server_2025", "Windows Server 2025", "10.0.26100", "2025",
     [("desktop", "Windows Server 2025"),
      ("core", "Windows Server 2025 (Server Core installation)")]),
)

_ARCH_NAMES = {"x64": "x64-based Systems", "arm64": "ARM64-based Systems",
               "x86": "32-bit Systems"}

_CLIENT = (
    # (family, label, line, release, archs)
    ("windows_10_1607", "Windows 10 Version 1607", "10.0.14393", "1607", ("x64", "x86")),
    ("windows_10_1809", "Windows 10 Version 1809", "10.0.17763", "1809", ("x64", "x86")),
    ("windows_10_21h2", "Windows 10 Version 21H2", "10.0.19044", "21H2",
     ("x64", "arm64", "x86")),
    ("windows_10_22h2", "Windows 10 Version 22H2", "10.0.19045", "22H2",
     ("x64", "arm64", "x86")),
    ("windows_11_22h2", "Windows 11 Version 22H2", "10.0.22621", "22H2", ("x64", "arm64")),
    ("windows_11_23h2", "Windows 11 Version 23H2", "10.0.22631", "23H2", ("x64", "arm64")),
    ("windows_11_24h2", "Windows 11 Version 24H2", "10.0.26100", "24H2", ("x64", "arm64")),
    ("windows_11_25h2", "Windows 11 Version 25H2", "10.0.26200", "25H2", ("x64", "arm64")),
    ("windows_11_26h1", "Windows 11 Version 26H1", "10.0.28000", "26H1", ("x64", "arm64")),
    ("windows_11_26h2", "Windows 11 Version 26H2", "10.0.26300", "26H2", ("x64", "arm64")),
)


def _build() -> tuple[dict[str, Product], dict[str, Family]]:
    products: dict[str, Product] = {}
    families: dict[str, Family] = {}
    for fam, label, line, year, variants in _SERVER:
        families[fam] = Family(fam, label, line, True, year=year)
        for install, name in variants:
            key = fam if install == "desktop" else f"{fam}_core"
            products[key] = Product(key, name, line, fam, True, install=install)
    for fam, label, line, release, archs in _CLIENT:
        families[fam] = Family(fam, label, line, False, release=release)
        for arch in archs:
            key = f"{fam}_{arch}"
            products[key] = Product(key, f"{label} for {_ARCH_NAMES[arch]}", line, fam,
                                    False, arch=arch)
    return products, families


PRODUCTS, FAMILIES = _build()


def _norm(name: str) -> str:
    return " ".join(name.lower().split())


_BY_NAME = {_norm(p.name): p.key for p in PRODUCTS.values()}


def key_for_name(name) -> str | None:
    """The product key of an MSRC product name (case and spacing as
    Microsoft varies them: ``Windows 11 version 26H1 for x64-based
    Systems``), or None for a product this table does not hold."""
    if not isinstance(name, str) or len(name) > 200:
        return None
    return _BY_NAME.get(_norm(name))


def product_key(key: str) -> tuple[str, str, str, str]:
    return (KIND, "", VENDOR, key)


# ─── hosts ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class HostProduct:
    """What a Windows host is in Microsoft's terms."""

    #: The release (``windows_server_2022``); blank when it is not known.
    family: str = ""
    label: str = ""
    #: ``10.0.20348``.
    line: str = ""
    ubr: int | None = None
    #: The product keys it can be: one when the variant is known, every
    #: variant of the release when it is not.
    keys: tuple[str, ...] = ()
    #: ``product_unknown`` / ``ubr_unknown``; blank when it can be matched.
    flag: str = ""

    @property
    def build(self) -> str:
        return f"{self.line}.{self.ubr}" if self.line and self.ubr is not None else ""


_VERSION = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,6})(?:\.(\d{1,7}))?$")
_YEAR = re.compile(r"\b(20\d\d)\b")


def _install(installation_type: str, edition: str) -> str:
    t = (installation_type or "").strip().lower()
    if t == "server core":
        return "core"
    if t == "server":
        return "desktop"
    e = (edition or "").strip().lower()
    # Old servers wrote the Core installation into the edition id.
    if e.startswith("server") and e.endswith("core"):
        return "core"
    return ""


def _arch(architecture: str) -> str:
    a = (architecture or "").strip().lower()
    if "arm" in a and "64" in a:
        return "arm64"
    if a in ("64-bit", "x64", "amd64"):
        return "x64"
    if a in ("32-bit", "x86"):
        return "x86"
    return ""


def resolve(*, os_id: str = "", version_id: str = "", build: str = "", ubr=None,
            caption: str = "", edition: str = "", display_version: str = "",
            installation_type: str = "", architecture: str = "") -> HostProduct:
    """The products a Windows host can be, from its OS facts."""
    if (os_id or "").lower() != "windows":
        return HostProduct(flag=PRODUCT_UNKNOWN)
    m = _VERSION.match((version_id or "").strip())
    build = (build or "").strip() or (m[3] if m else "")
    if not build.isdigit():
        return HostProduct(flag=PRODUCT_UNKNOWN)
    if ubr is None and m and m[4] is not None:
        ubr = int(m[4])
    text = _norm(caption or "")
    edition_l = (edition or "").strip().lower()
    if "windows server" in text:
        server = True
    elif text:
        server = False if "windows" in text and "server" not in text else None
    else:
        server = True if edition_l.startswith("server") and "hci" not in edition_l else None
    if server is None:
        return HostProduct(flag=PRODUCT_UNKNOWN)
    fams = [f for f in FAMILIES.values()
            if f.server == server and f.line.rsplit(".", 1)[1] == build]
    if m and fams:
        prefix = f"{int(m[1])}.{int(m[2])}"
        fams = [f for f in fams if f.line.rsplit(".", 1)[0] == prefix]
    if len(fams) != 1:
        return HostProduct(flag=PRODUCT_UNKNOWN)
    fam = fams[0]
    if server:
        years = set(_YEAR.findall(text))
        if years and years != {fam.year}:
            return HostProduct(flag=PRODUCT_UNKNOWN)
    else:
        shown = (display_version or "").strip().upper()
        if shown and shown != fam.release.upper():
            return HostProduct(flag=PRODUCT_UNKNOWN)
        if "windows 11" in text and fam.key.startswith("windows_10"):
            return HostProduct(flag=PRODUCT_UNKNOWN)
    variants = [p for p in PRODUCTS.values() if p.family == fam.key]
    if server:
        install = _install(installation_type, edition)
        picked = [p for p in variants if p.install == install] if install else variants
    else:
        arch = _arch(architecture)
        picked = [p for p in variants if p.arch == arch] if arch else variants
    if not picked:
        # A Core host of a release Microsoft lists only as Desktop (or an
        # architecture it does not ship): nothing to match against.
        return HostProduct(family=fam.key, label=fam.label, line=fam.line,
                           flag=PRODUCT_UNKNOWN)
    keys = tuple(sorted(p.key for p in picked))
    if not isinstance(ubr, int) or isinstance(ubr, bool) or ubr < 0:
        return HostProduct(family=fam.key, label=fam.label, line=fam.line, keys=keys,
                           flag=UBR_UNKNOWN)
    return HostProduct(family=fam.key, label=fam.label, line=fam.line, ubr=ubr, keys=keys)


def resolve_fact(fact) -> HostProduct:
    """:func:`resolve` over a ``discovery.HostOsFact`` (or anything with its
    fields). Installation type and architecture are read when the fact
    carries them."""
    return resolve(
        os_id=getattr(fact, "os_id", ""), version_id=getattr(fact, "version_id", ""),
        build=getattr(fact, "build", ""), ubr=getattr(fact, "ubr", None),
        caption=getattr(fact, "pretty_name", ""), edition=getattr(fact, "edition", ""),
        display_version=getattr(fact, "display_version", ""),
        installation_type=getattr(fact, "installation_type", "") or "",
        architecture=getattr(fact, "architecture", "") or "")
