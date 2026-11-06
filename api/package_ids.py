"""Package identifiers for the SBOM: package URLs (purl) and CPE 2.3 names.

An application and a platform hold a template; an install may hold its own
value, which wins. Two placeholders fill a template:

``{version}``     the install's version (an application), or the host's
                  running version (a platform);
``{os_version}``  the host's running platform version.

``pkg:deb/debian/frr@{version}?arch=amd64&distro=debian-{os_version}`` with
FRRouting ``10.3-3+deb13u1`` on a Debian ``13`` host resolves to
``pkg:deb/debian/frr@10.3-3%2Bdeb13u1?arch=amd64&distro=debian-13``.

A placeholder's value is escaped for where it lands: percent-encoded in a
purl (``+`` → ``%2B``, ``:`` → ``%3A``), backslash-quoted in a CPE
(``+`` → ``\\+``). A template that names a placeholder whose value is blank
resolves to nothing, so the SBOM leaves the field out rather than writing a
half-filled identifier.

The check is loose: a purl is ``pkg:<type>/<name>…``, a CPE is ``cpe:2.3:``
with 13 colon-separated parts. The field names (``purl_template``,
``cpe_template``) are what a vulnerability matcher reads too.
"""
from __future__ import annotations

import re
from urllib.parse import quote

from django.core.exceptions import ValidationError

PLACEHOLDERS = ("version", "os_version")
_PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
_PURL = re.compile(r"pkg:[A-Za-z][A-Za-z0-9.+\-]*/[^/\s]\S*")
_CPE_SPLIT = re.compile(r"(?<!\\):")
#: Characters a CPE 2.3 formatted string keeps unquoted.
_CPE_PLAIN = re.compile(r"[A-Za-z0-9._\-]")


def _check_placeholders(value: str) -> None:
    bad = [m for m in _PLACEHOLDER.findall(value) if m not in PLACEHOLDERS]
    if bad:
        raise ValidationError(
            f"Unknown placeholder {{{bad[0]}}}; use {{version}} or {{os_version}}."
        )


def validate_purl(value: str) -> None:
    """A package URL, or a template of one: ``pkg:<type>/<name>…``."""
    if not value:
        return
    _check_placeholders(value)
    if not _PURL.fullmatch(value):
        raise ValidationError("A package URL starts pkg:<type>/, such as pkg:deb/debian/frr.")


def validate_cpe(value: str) -> None:
    """A CPE 2.3 formatted string, or a template of one: 13 parts."""
    if not value:
        return
    _check_placeholders(value)
    parts = _CPE_SPLIT.split(value)
    if len(parts) != 13 or parts[0] != "cpe" or parts[1] != "2.3":
        raise ValidationError(
            "A CPE starts cpe:2.3: and has 13 colon-separated parts."
        )
    if parts[2] not in ("a", "o", "h", "*", "-") and "{" not in parts[2]:
        raise ValidationError("The CPE part is a, o or h.")
    if any(not p for p in parts):
        raise ValidationError("A CPE part is empty; use * for any.")


def _purl_escape(value: str) -> str:
    return quote(value, safe=".-_~")


def _cpe_escape(value: str) -> str:
    return "".join(c if _CPE_PLAIN.match(c) else "\\" + c for c in value)


def _render(template: str, values: dict, escape) -> str:
    if not template:
        return ""
    missing = False

    def sub(m):
        nonlocal missing
        v = (values.get(m.group(1)) or "").strip()
        if not v:
            missing = True
        return escape(v)

    out = _PLACEHOLDER.sub(sub, template)
    return "" if missing else out


def render_purl(template: str, *, version: str = "", os_version: str = "") -> str:
    """The package URL ``template`` names; "" when a placeholder is blank."""
    return _render(template, {"version": version, "os_version": os_version}, _purl_escape)


def render_cpe(template: str, *, version: str = "", os_version: str = "") -> str:
    """The CPE ``template`` names; "" when a placeholder is blank."""
    return _render(template, {"version": version, "os_version": os_version}, _cpe_escape)
