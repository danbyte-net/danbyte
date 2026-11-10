"""Version keys (#451): read a version string under a scheme and order it.

``parse(version, scheme)`` answers a :class:`Key`, or ``None`` when the
scheme cannot read the string (decision 10: such an object matches no range;
an exact CPE version string still matches). Two keys compare with
:func:`compare`, which answers ``None`` when they are not comparable (Cisco
IOS releases of different trains, Junos X releases against R releases).

Schemes:

* ``cisco_iosxe`` ``17.09.04a`` = ``17.9.4a``; 17.9.4 < 17.9.4a < 17.9.5.
* ``cisco_ios``   ``15.2(7)E8``; ordered within one train (15.2 E) only.
* ``cisco_nxos``  ``9.3(10)``, ``10.2(5)M``, ``7.0(3)I7(9)``; the F/M tag
  of a 10.x release is not an order.
* ``junos``       ``21.4R3-S5.4``: version ``21.4``, update ``r3-s5`` as the
  CPE writes it; the build (``.4``) is dropped.
* ``arista_eos``  ``4.28.3M``; the train letter is a tag, not an order.
* ``semver``      ``1.24.0``, ``1.0.0-rc.1``, ``16.4``, ``14.13 (Debian …)``
  (leading version only), ``1.1.1w`` (a letter after the last number sorts
  after the bare number, as OpenSSL numbers its fixes), ``9.6beta1``.
* ``pep440``      Python packages, by ``packaging.version`` (already a
  dependency).
* ``dpkg``        Debian/Ubuntu: epoch, upstream, revision, ``~`` before
  anything (dpkg's own algorithm).
* ``apk``         Alpine: numbers, a letter, ``_alpha``…``_p`` suffixes,
  ``-rN``.
* ``rpm``         RHEL, Rocky, AlmaLinux, SUSE: ``epoch:version-release``,
  each part by rpmvercmp (``~`` before the end, ``^`` after it, letters
  before digits, separators ignored).
* ``generic``     digits and letters as tokens; exact matches only - no range
  is evaluated under it.

Pure Python, no Django.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

SCHEMES = ("cisco_ios", "cisco_iosxe", "cisco_nxos", "junos", "arista_eos",
           "semver", "pep440", "dpkg", "apk", "rpm", "generic")
#: Schemes whose order is good enough to test a version range.
RANGE_SCHEMES = frozenset(SCHEMES) - {"generic"}
MAX_LEN = 128


@dataclass(frozen=True)
class Key:
    """A parsed version. ``group`` names the class within which keys of a
    scheme compare; ``sort`` compares lexicographically; ``text`` is the
    normalised form (the CPE form for the vendor schemes)."""

    scheme: str
    group: str
    sort: tuple
    text: str


def compare(a: Key, b: Key) -> int | None:
    """-1, 0 or 1; ``None`` when the two are not comparable."""
    if a.scheme != b.scheme or a.group != b.group:
        return None
    if a.sort == b.sort:
        return 0
    return -1 if a.sort < b.sort else 1


def supports_ranges(scheme: str) -> bool:
    return scheme in RANGE_SCHEMES


def _clean(version) -> str:
    if not isinstance(version, str):
        return ""
    text = version.strip()
    return text if 0 < len(text) <= MAX_LEN else ""


# ─── Cisco ───────────────────────────────────────────────────────────────────

_IOSXE = re.compile(
    r"^(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?([a-z]?)(?:\.?([a-z]{1,3}))?$", re.I)
_IOS = re.compile(
    r"^(\d{1,2})\.(\d{1,2})\((\d{1,3})([a-z]?)\)([a-z]{0,4})(\d{0,3})([a-z]?)$", re.I)
_NXOS = re.compile(
    r"^(\d{1,2})\.(\d{1,2})\((\d{1,3})([a-z]?)\)"
    r"(?:([a-z]{1,3})(\d{0,3})(?:\((\d{1,3})([a-z]?)\))?)?$", re.I)


def _iosxe(text: str) -> Key | None:
    m = _IOSXE.match(text)
    if not m:
        return None
    major, minor, maint = int(m[1]), int(m[2]), int(m[3] or 0)
    letter = (m[4] or "").lower()
    train = (m[5] or "").lower()
    norm = f"{major}.{minor}" + (f".{maint}" if m[3] is not None else "") + letter
    return Key("cisco_iosxe", "", (major, minor, maint, letter),
               norm + (train if train else ""))


def _ios(text: str) -> Key | None:
    m = _IOS.match(text)
    if not m:
        return None
    major, minor, maint = int(m[1]), int(m[2]), int(m[3])
    mletter, train = m[4].lower(), m[5].lower()
    rebuild = int(m[6]) if m[6] else 0
    rletter = m[7].lower()
    norm = f"{major}.{minor}({maint}{mletter}){train}{m[6]}{rletter}"
    return Key("cisco_ios", f"{major}.{minor}{train}",
               (maint, mletter, rebuild, rletter), norm)


def _nxos(text: str) -> Key | None:
    m = _NXOS.match(text)
    if not m:
        return None
    major, minor, maint = int(m[1]), int(m[2]), int(m[3])
    mletter = m[4].lower()
    train = (m[5] or "").lower()
    tnum = int(m[6]) if m[6] else 0
    sub = int(m[7]) if m[7] else 0
    sletter = (m[8] or "").lower()
    norm = f"{major}.{minor}({maint}{mletter}){train}{m[6] or ''}"
    if m[7]:
        norm += f"({sub}{sletter})"
    # 10.x marks a release F (feature) or M (maintenance): a tag on the
    # number, not a train of its own.
    order_train = "" if (train in ("f", "m") and not m[6] and not m[7]) else train
    return Key("cisco_nxos", "",
               (major, minor, maint, mletter, order_train, tnum, sub, sletter), norm)


# ─── Juniper, Arista ─────────────────────────────────────────────────────────

_JUNOS = re.compile(
    r"^(\d{1,2})\.(\d{1,2})(?:([a-z])(\d{1,3})(?:-([a-z])(\d{1,4}))?(?:\.(\d{1,3}))?)?"
    r"(?:-evo)?$", re.I)
_JUNOS_RANK = {"b": 0, "f": 1, "r": 2, "x": 2}


def _junos(text: str) -> Key | None:
    m = _JUNOS.match(text)
    if not m:
        return None
    major, minor = int(m[1]), int(m[2])
    if m[3] is None:
        return Key("junos", "", (major, minor, -1, 0, 0), f"{major}.{minor}")
    rel = m[3].lower()
    if rel not in _JUNOS_RANK:
        return None
    rnum = int(m[4])
    svc = int(m[6]) if m[6] else 0
    update = f"{rel}{rnum}" + (f"-{m[5].lower()}{svc}" if m[6] else "")
    # An X release (15.1X49-D200, the SRX train) orders among its own kind.
    group = "x" if rel == "x" else ""
    return Key("junos", group, (major, minor, _JUNOS_RANK[rel], rnum, svc),
               f"{major}.{minor}{update}")


def junos_parts(key: Key) -> tuple[str, str]:
    """``(version, update)`` as a CPE names a Junos release."""
    m = re.match(r"^(\d+\.\d+)(.*)$", key.text)
    return (m[1], m[2] or "-") if m else (key.text, "-")


_EOS = re.compile(r"^(\d{1,2})\.(\d{1,3})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?([a-z]{0,4})$", re.I)


def _eos(text: str) -> Key | None:
    m = _EOS.match(text)
    if not m:
        return None
    nums = tuple(int(g) if g else 0 for g in m.groups()[:4])
    shown = ".".join(g for g in m.groups()[:4] if g is not None)
    return Key("arista_eos", "", nums, f"{shown}{(m[5] or '').lower()}")


# ─── semver (loose) ──────────────────────────────────────────────────────────

_SEMVER = re.compile(r"^v?(\d{1,9}(?:\.\d{1,9}){0,6})(.*)$", re.I)
_PRE_WORD = re.compile(r"^[.-]?(alpha|beta|preview|pre|rc|dev|a|b)[.-]?(\d*)$", re.I)
_POST_LETTER = re.compile(r"^([a-z])$", re.I)
_IDENT = re.compile(r"^[0-9a-z-]+$", re.I)


def _ident_tokens(ident: str) -> tuple:
    """One pre-release identifier, split at digit/letter boundaries so rc2 <
    rc10: digits numerically below letters, as semver orders them."""
    out = []
    for tok in re.findall(r"\d+|[a-z]+|-", ident.lower()):
        out.append((0, int(tok), "") if tok.isdigit() else (1, 0, tok))
    return tuple(out)


def _trim(nums: tuple) -> tuple:
    n = list(nums)
    while n and n[-1] == 0:
        n.pop()
    return tuple(n)


def _semver(text: str) -> Key | None:
    token = text.split()[0] if text.split() else ""
    m = _SEMVER.match(token)
    if not m:
        return None
    nums = tuple(int(p) for p in m[1].split("."))
    rest = m[2].split("+", 1)[0]
    letter, pre = "", None
    if not rest:
        pass
    elif _POST_LETTER.match(rest):
        letter = rest.lower()
    elif (w := _PRE_WORD.match(rest)) is not None:
        pre = (w[1].lower() + ("." + w[2] if w[2] else ""))
    elif rest.startswith("-") and len(rest) > 1:
        pre = rest[1:]
        if not all(_IDENT.match(p) for p in pre.split(".")):
            return None
    else:
        return None
    pre_key = () if pre is None else tuple(_ident_tokens(p) for p in pre.split("."))
    norm = m[1] + letter + (f"-{pre.lower()}" if pre is not None else "")
    return Key("semver", "", (_trim(nums), letter, 1 if pre is None else 0, pre_key), norm)


# ─── PEP 440 ─────────────────────────────────────────────────────────────────


def _pep440(text: str) -> Key | None:
    from packaging.version import InvalidVersion, Version

    try:
        v = Version(text)
    except InvalidVersion:
        return None
    return Key("pep440", "", (v,), str(v))


# ─── dpkg ────────────────────────────────────────────────────────────────────

_DPKG = re.compile(r"^(?:(\d{1,9}):)?([0-9][A-Za-z0-9.+~:-]*?)(?:-([A-Za-z0-9.+~]+))?$")
_PAD = ((0,), 0)


def _dpkg_order(c: str) -> int:
    if c == "~":
        return -1
    if c.isalpha():
        return ord(c)
    return ord(c) + 256


def _dpkg_part(s: str) -> tuple:
    """A sort key equal to dpkg's verrevcmp over one part: alternating
    non-digit runs (char by char, ``~`` lowest, the end next, letters before
    other characters) and digit runs (numerically)."""
    pairs, i = [], 0
    while i < len(s):
        j = i
        while j < len(s) and not s[j].isdigit():
            j += 1
        nd = tuple(_dpkg_order(c) for c in s[i:j]) + (0,)
        k = j
        while k < len(s) and s[k].isdigit():
            k += 1
        pairs.append((nd, int(s[j:k]) if k > j else 0))
        i = k
    while pairs and pairs[-1] == _PAD:
        pairs.pop()
    return (*pairs, _PAD)


def _dpkg(text: str) -> Key | None:
    m = _DPKG.match(text)
    if not m:
        return None
    epoch = int(m[1] or 0)
    upstream, revision = m[2], m[3] or ""
    if ":" in upstream and m[1] is None:
        return None
    return Key("dpkg", "", (epoch, _dpkg_part(upstream), _dpkg_part(revision)),
               text)


# ─── apk ─────────────────────────────────────────────────────────────────────

_APK = re.compile(
    r"^(\d{1,9}(?:\.\d{1,9})*)([a-z]?)((?:_(?:alpha|beta|pre|rc|cvs|svn|git|hg|p)\d*)*)"
    r"(?:-r(\d{1,9}))?$")
_APK_SUFFIX = {"alpha": -4, "beta": -3, "pre": -2, "rc": -1,
               "cvs": 1, "svn": 2, "git": 3, "hg": 4, "p": 5}


def _apk(text: str) -> Key | None:
    m = _APK.match(text)
    if not m:
        return None
    nums = tuple(int(p) for p in m[1].split("."))
    suffixes = tuple(
        (_APK_SUFFIX[name], int(num or 0))
        for name, num in re.findall(r"_([a-z]+)(\d*)", m[3])
    ) or ((0, 0),)
    return Key("apk", "", (nums, m[2], suffixes, int(m[4] or 0)), text)


# ─── rpm ─────────────────────────────────────────────────────────────────────

_RPM = re.compile(r"^(?:(\d{1,9}):)?([^:\s-][^:\s]*?)(?:-([^:\s-]+))?$")
_RPM_TOKEN = re.compile(r"~|\^|[A-Za-z]+|[0-9]+")
_RPM_ALNUM = re.compile(r"[A-Za-z0-9]")
_RPM_END = (1, 0, "")


def _rpm_part(s: str) -> tuple:
    """A sort key equal to rpmvercmp over one part: ``~`` lowest, then the
    end of the string, then ``^``, then letter runs (by text), then digit
    runs (by number); any other character only separates."""
    out = []
    for tok in _RPM_TOKEN.findall(s):
        if tok == "~":
            out.append((0, 0, ""))
        elif tok == "^":
            out.append((2, 0, ""))
        elif tok.isdigit():
            out.append((4, int(tok), ""))
        else:
            out.append((3, 0, tok))
    return (*out, _RPM_END)


def _rpm(text: str) -> Key | None:
    m = _RPM.match(text)
    if not m or not _RPM_ALNUM.search(m[2]):
        return None
    return Key("rpm", "", (int(m[1] or 0), _rpm_part(m[2]), _rpm_part(m[3] or "")), text)


# ─── generic ─────────────────────────────────────────────────────────────────


def _generic(text: str) -> Key | None:
    toks = re.findall(r"\d+|[a-z]+", text.lower())
    if not any(t.isdigit() for t in toks):
        return None
    return Key("generic", "",
               tuple((0, int(t), "") if t.isdigit() else (1, 0, t) for t in toks),
               text.lower())


_PARSERS = {
    "cisco_iosxe": _iosxe,
    "cisco_ios": _ios,
    "cisco_nxos": _nxos,
    "junos": _junos,
    "arista_eos": _eos,
    "semver": _semver,
    "pep440": _pep440,
    "dpkg": _dpkg,
    "apk": _apk,
    "rpm": _rpm,
    "generic": _generic,
}


def parse(version, scheme: str) -> Key | None:
    """The key of ``version`` under ``scheme``; ``None`` when it is blank,
    too long or not a version that scheme reads."""
    text = _clean(version)
    fn = _PARSERS.get(scheme)
    if not text or fn is None:
        return None
    return fn(text)


# ─── which scheme ────────────────────────────────────────────────────────────

_CPE_SCHEMES = {
    ("cisco", "ios"): "cisco_ios",
    ("cisco", "ios_xe"): "cisco_iosxe",
    ("cisco", "nx-os"): "cisco_nxos",
    ("cisco", "nx_os"): "cisco_nxos",
    ("juniper", "junos"): "junos",
    ("arista", "eos"): "arista_eos",
}
_PURL_SCHEMES = {
    "pypi": "pep440",
    "npm": "semver",
    "cargo": "semver",
    "golang": "semver",
    "deb": "dpkg",
    "apk": "apk",
    "rpm": "rpm",
}


def auto_scheme(kind: str, part: str, vendor: str, product: str) -> str:
    """The scheme ``auto`` resolves to for a product (decision 11)."""
    if kind == "purl":
        return _PURL_SCHEMES.get(vendor, "generic")
    hit = _CPE_SCHEMES.get((vendor, product))
    if hit:
        return hit
    return "semver" if part == "a" else "generic"


def resolve_scheme(scheme: str, kind: str, part: str, vendor: str, product: str) -> str:
    return auto_scheme(kind, part, vendor, product) if scheme in ("", "auto") else scheme
