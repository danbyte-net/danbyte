"""Windows inventory - Django-free, shared by the core and Outposts.

Discovery phase B2-win (#451). One fixed PowerShell script reads what a
Windows host has: the OS product, edition, version, build and UBR
(``HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion``), the installed
hotfixes (CIM ``Win32_QuickFixEngineering``, what ``Get-HotFix`` reads),
the installed programs from the Uninstall registry keys (64-bit and 32-bit
views) and, on Windows Server, the installed roles and features (CIM
``Win32_ServerFeature``). It prints one compact JSON document.

The script is a constant. Nothing a user typed is ever placed in it and no
command line is composed from data: PowerShell is started as
``powershell -NoProfile -NonInteractive -EncodedCommand <base64>`` with the
base64 of the constant script (UTF-16LE, as PowerShell wants it), so the
command line holds only ``[A-Za-z0-9+/=]`` and there is nothing for a
remote shell (cmd.exe or PowerShell) to expand. The same script runs over
SSH and over WinRM.

Telling Windows from Linux over SSH uses only fixed commands, in order:
``cat /etc/os-release`` and ``cat /usr/lib/os-release`` (the Linux reader,
:mod:`danbyte_checks.inventory`); when both fail, ``cmd /c ver``, which a
Windows host answers ``Microsoft Windows [Version 10.0.20348.2340]``. Only
an answer of that exact shape runs the PowerShell script.

The parser is strict: a document that is not the expected shape is refused,
strings are stripped of control characters and capped, and at most
:data:`MAX_PROGRAMS` programs are kept.
"""
from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, field

#: The script, kept short: the encoded form must fit cmd.exe's 8191
#: character command line. PowerShell 5.1 (Windows Server 2016 and later).
SCRIPT = (
    "$ErrorActionPreference='Stop';"
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
    "$cv=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';"
    "$os=$null;try{$os=Get-CimInstance Win32_OperatingSystem}catch{};"
    "$hf=@();try{$hf=@(Get-CimInstance Win32_QuickFixEngineering|ForEach-Object{"
    "[pscustomobject]@{id=[string]$_.HotFixID;description=[string]$_.Description;"
    "installed_on=[string]$_.InstalledOn}})}catch{};"
    "$pr=@();foreach($v in @(@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','x64'),"
    "@('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','x86'))){"
    "$a=$v[1];$pr+=@(Get-ItemProperty $v[0] -ErrorAction SilentlyContinue|Where-Object{"
    "$_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName}|ForEach-Object{"
    "[pscustomobject]@{name=[string]$_.DisplayName;version=[string]$_.DisplayVersion;"
    "publisher=[string]$_.Publisher;arch=$a}})};"
    "$fe=@();try{$fe=@(Get-CimInstance Win32_ServerFeature|ForEach-Object{[string]$_.Name})}catch{};"
    "[pscustomobject]@{schema=1;product_name=[string]$cv.ProductName;"
    "edition_id=[string]$cv.EditionID;display_version=[string]$cv.DisplayVersion;"
    "release_id=[string]$cv.ReleaseId;current_build=[string]$cv.CurrentBuildNumber;"
    "ubr=$cv.UBR;installation_type=[string]$cv.InstallationType;"
    "caption=$(if($os){[string]$os.Caption}else{''});"
    "version=$(if($os){[string]$os.Version}else{''});"
    "architecture=$(if($os){[string]$os.OSArchitecture}else{''});"
    "hotfixes=$hf;programs=$pr;features=$fe}|ConvertTo-Json -Depth 4 -Compress"
)

ENCODED = base64.b64encode(SCRIPT.encode("utf-16-le")).decode("ascii")
#: The argv for PowerShell (WinRM runs it as a command with these
#: arguments); joined with spaces for SSH, where it stays free of anything
#: a shell would expand.
POWERSHELL_ARGS = ("-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED)
POWERSHELL = "powershell " + " ".join(POWERSHELL_ARGS)

#: Every command this module sends over SSH. Constants only.
COMMANDS: dict[str, str] = {
    "ver": "cmd /c ver",
    "powershell": POWERSHELL,
}

MAX_PROGRAMS = 20_000
MAX_HOTFIXES = 2_000
MAX_FEATURES = 1_000
MAX_TEXT = 200

_VER = re.compile(r"Microsoft Windows \[Version (\d{1,3})\.(\d{1,3})\.(\d{1,6})(?:\.(\d{1,7}))?\]")
_KB = re.compile(r"^KB\d{4,8}$", re.IGNORECASE)
_BUILD = re.compile(r"^\d{1,6}$")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


class WindowsParseError(ValueError):
    """The host's answer is not the expected shape."""


@dataclass
class Program:
    name: str
    version: str = ""
    publisher: str = ""
    #: ``x64`` (the native Uninstall key) or ``x86`` (WOW6432Node).
    arch: str = ""


@dataclass
class WindowsFacts:
    product_name: str = ""
    edition: str = ""
    display_version: str = ""
    caption: str = ""
    version: str = ""
    build: str = ""
    ubr: int | None = None
    installation_type: str = ""
    architecture: str = ""
    hotfixes: list[dict] = field(default_factory=list)
    features: list[str] = field(default_factory=list)
    programs: list[Program] = field(default_factory=list)
    truncated: bool = False

    @property
    def full_build(self) -> str:
        """``10.0.20348.2340``: major.minor from the version, build, UBR."""
        if not self.build:
            return ""
        head = nt_version(self.version, self.build)
        if not head:
            return ""
        return f"{head}.{self.build}" + (f".{self.ubr}" if self.ubr is not None else "")


#: NT versions of the builds before Windows 10 (build 10240), for a host
#: whose CIM version string was not read: Windows Server 2012 is 6.2.9200,
#: 2012 R2 6.3.9600 (Microsoft's fixed builds are written so too).
_OLD_NT = {"9200": "6.2", "9600": "6.3"}


def nt_version(version: str, build: str) -> str:
    """The NT ``major.minor`` of a Windows host: from its version string
    (CIM's ``Version``, ``6.3.9600``) when it names this build, else from
    the build - ``10.0`` from Windows 10 / Server 2016 (build 10240) on,
    ``6.2`` / ``6.3`` for Server 2012 / 2012 R2, blank for anything else."""
    if not (build or "").isdigit():
        return ""
    parts = (version or "").split(".")
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit() and \
            (len(parts) < 3 or parts[2] == build):
        return f"{int(parts[0])}.{int(parts[1])}"
    if int(build) >= 10240:
        return "10.0"
    return _OLD_NT.get(str(int(build)), "")


def parse_ver(text: str) -> str | None:
    """The version in ``cmd /c ver`` output (``10.0.20348.2340``), or None
    when the answer is not a Windows one."""
    m = _VER.search(text or "")
    if not m:
        return None
    return ".".join(g for g in m.groups() if g is not None)


def _text(value, cap: int = MAX_TEXT) -> str:
    if value is None:
        return ""
    if not isinstance(value, (str, int, float)):
        return ""
    return _CTRL.sub("", str(value)).strip()[:cap]


def _list(value) -> list:
    """ConvertTo-Json writes a one-element array as the bare element."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def parse_inventory(text: str) -> WindowsFacts:
    """The script's JSON document. Raises :class:`WindowsParseError` when
    it is not one (wrong schema, no build)."""
    raw = (text or "").lstrip("﻿").strip()
    try:
        doc = json.loads(raw)
    except ValueError:
        raise WindowsParseError("The host's answer is not JSON.") from None
    if not isinstance(doc, dict) or doc.get("schema") != 1:
        raise WindowsParseError("The host's answer is not the inventory document.")
    build = _text(doc.get("current_build"), 16)
    if not _BUILD.match(build):
        raise WindowsParseError("The host reported no build number.")
    ubr = doc.get("ubr")
    ubr = ubr if isinstance(ubr, int) and not isinstance(ubr, bool) and 0 <= ubr < 10**7 \
        else None
    facts = WindowsFacts(
        product_name=_text(doc.get("product_name"), 128),
        edition=_text(doc.get("edition_id"), 64),
        display_version=_text(doc.get("display_version") or doc.get("release_id"), 16),
        caption=_text(doc.get("caption"), 128),
        version=_text(doc.get("version"), 32) if re.fullmatch(
            r"\d{1,3}\.\d{1,3}(\.\d{1,6})?", _text(doc.get("version"), 32)) else "",
        build=build, ubr=ubr,
        installation_type=_text(doc.get("installation_type"), 32),
        architecture=_text(doc.get("architecture"), 32),
    )
    seen = set()
    for h in _list(doc.get("hotfixes"))[:MAX_HOTFIXES]:
        if not isinstance(h, dict):
            continue
        kb = _text(h.get("id"), 16)
        if not _KB.match(kb) or kb.upper() in seen:
            continue
        seen.add(kb.upper())
        facts.hotfixes.append({"id": kb.upper(), "description": _text(h.get("description"), 64),
                               "installed_on": _text(h.get("installed_on"), 32)})
    facts.features = sorted({f for f in (_text(x, 64) for x in _list(doc.get("features"))
                                         [:MAX_FEATURES]) if f})
    programs: dict[tuple, Program] = {}
    for p in _list(doc.get("programs")):
        if not isinstance(p, dict):
            continue
        name = _text(p.get("name"), 128)
        if not name:
            continue
        arch = _text(p.get("arch"), 8)
        arch = arch if arch in ("x64", "x86") else ""
        programs[(name.lower(), arch)] = Program(
            name=name, version=_text(p.get("version"), 128),
            publisher=_text(p.get("publisher"), 128), arch=arch)
    rows = sorted(programs.values(), key=lambda x: (x.name.lower(), x.arch))
    facts.truncated = len(rows) > MAX_PROGRAMS
    facts.programs = rows[:MAX_PROGRAMS]
    return facts


def os_facts(facts: WindowsFacts) -> dict:
    """The facts in the shape the core stores as the host's OS (the keys
    :func:`danbyte_checks.inventory.parse_os_release` gives, plus the
    Windows ones)."""
    return {
        "id": "windows",
        "id_like": [],
        "version_id": facts.full_build[:32],
        "version_codename": facts.display_version.lower()[:32],
        "pretty_name": (facts.caption or facts.product_name)[:128],
        "name": "Windows",
        "windows": {
            "product_name": facts.product_name, "edition": facts.edition,
            "display_version": facts.display_version, "build": facts.build,
            "ubr": facts.ubr, "installation_type": facts.installation_type,
            "architecture": facts.architecture, "hotfixes": facts.hotfixes,
            "features": facts.features,
        },
    }
