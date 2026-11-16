"""An application's package names (#451): which inventoried packages are
that application.

An entry is ``type:pattern`` - ``deb:nginx``, ``rpm:httpd``,
``deb:postgresql-*``, ``generic:Mozilla Firefox*`` (a Windows program) - or
a bare ``pattern``, which means every Linux package type (deb, rpm, apk).
A pattern is an exact name or a glob whose only wildcard is ``*``; nobody
writes a regular expression. Linux package names compare in lower case
(dpkg and apk names are lower case, RPM's are matched without case too);
Windows program names compare without case.

:class:`Matcher` turns a tenant's applications into one lookup:
``matcher.match(purl_type, name)`` answers the application ids whose names
take that package, exact names by a dict and globs by one compiled
expression per type - no query, no per-package regex compile.
"""
from __future__ import annotations

import re
from collections import defaultdict

from django.core.exceptions import ValidationError

LINUX_TYPES = ("deb", "rpm", "apk")
TYPES = (*LINUX_TYPES, "generic")
MAX_ENTRIES = 50
MAX_LENGTH = 128
_LINUX_NAME = re.compile(r"^[a-z0-9*][a-z0-9.+_~*-]*$")
_GENERIC_NAME = re.compile(r"^[^\x00-\x1f\x7f:]+$")


def parse(entry: str) -> list[tuple[str, str]]:
    """``[(type, pattern)]`` for one entry (a bare name spreads over the
    Linux types). Raises ``ValueError`` with the reason."""
    raw = (entry or "").strip()
    if not raw:
        raise ValueError("An entry is empty.")
    if len(raw) > MAX_LENGTH + 10:
        raise ValueError(f"{raw[:40]}…: at most {MAX_LENGTH} characters.")
    ptype, sep, pattern = raw.partition(":")
    if not sep:
        ptype, pattern = "", raw
    ptype, pattern = ptype.strip().lower(), pattern.strip()
    if ptype and ptype not in TYPES:
        raise ValueError(f"{raw}: the type is one of {', '.join(TYPES)}.")
    if not pattern or pattern.strip("*") == "":
        raise ValueError(f"{raw}: name a package, not only *.")
    if len(pattern) > MAX_LENGTH:
        raise ValueError(f"{raw}: at most {MAX_LENGTH} characters.")
    if ptype == "generic":
        if not _GENERIC_NAME.match(pattern):
            raise ValueError(f"{raw}: no control characters or colons.")
        return [("generic", pattern)]
    pattern = pattern.lower()
    if not _LINUX_NAME.match(pattern):
        raise ValueError(f"{raw}: letters, digits, . + _ ~ - and * only.")
    return [(ptype, pattern)] if ptype else [(t, pattern) for t in LINUX_TYPES]


def clean(value) -> list[str]:
    """The stored list: each entry normalised (``Deb: Nginx`` → ``deb:nginx``),
    duplicates dropped, order kept. Raises Django's ``ValidationError``."""
    if value in (None, ""):
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValidationError("A list of package names.")
    out: list[str] = []
    errors = []
    for entry in value:
        try:
            pairs = parse(entry)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        ptype = entry.partition(":")[0].strip().lower() if ":" in entry else ""
        text = f"{ptype}:{pairs[0][1]}" if ptype else pairs[0][1]
        if text not in out:
            out.append(text)
    if errors:
        raise ValidationError(errors[0])
    if len(out) > MAX_ENTRIES:
        raise ValidationError(f"At most {MAX_ENTRIES} package names.")
    return out


def _glob(pattern: str) -> str:
    return "".join(".*" if part == "*" else re.escape(part)
                   for part in re.split(r"(\*)", pattern) if part)


class Matcher:
    """Which applications take a package. Built once per tenant from
    ``[(application id, package_names)]``; earlier entries of one
    application rank first (``rank``), so the version of ``nginx`` wins over
    ``nginx-common`` when both are there."""

    def __init__(self, apps):
        self.exact: dict[tuple[str, str], list[tuple]] = defaultdict(list)
        globs: dict[str, list[tuple[str, object, int]]] = defaultdict(list)
        self.app_ids: set = set()
        for app_id, names in apps:
            for rank, entry in enumerate(names or []):
                try:
                    pairs = parse(entry)
                except ValueError:
                    continue  # stored before a rule tightened: skip, never fail
                for ptype, pattern in pairs:
                    self.app_ids.add(app_id)
                    key = pattern if ptype != "generic" else pattern.lower()
                    if "*" in key:
                        globs[ptype].append((key, app_id, rank))
                    else:
                        self.exact[(ptype, key)].append((app_id, rank))
        self.globs: dict[str, tuple[re.Pattern, list]] = {}
        for ptype, rows in globs.items():
            # One alternation per type tells most names apart at once; a
            # name it takes is then tried against each glob of the type.
            rx = re.compile("|".join(f"(?:{_glob(p)})" for p, _a, _r in rows), re.S)
            self.globs[ptype] = (rx, [(re.compile(_glob(p), re.S), a, r)
                                      for p, a, r in rows])
        self._cache: dict[tuple[str, str], tuple] = {}

    def __bool__(self) -> bool:
        return bool(self.app_ids)

    def match(self, ptype: str, name: str) -> tuple:
        """``((application id, rank), …)`` taking this package."""
        key = (ptype, (name or "").lower())
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        out = list(self.exact.get(key, ()))
        glob = self.globs.get(ptype)
        if glob is not None:
            rx, rows = glob
            if rx.fullmatch(key[1]):
                out.extend((app_id, rank) for one, app_id, rank in rows
                           if one.fullmatch(key[1]))
        hit = tuple(out)
        self._cache[key] = hit
        return hit

    def apps_of(self, ptype: str, name: str) -> set:
        return {a for a, _r in self.match(ptype, name)}


def matcher_for(tenant) -> Matcher:
    """The tenant's applications that name packages, as a :class:`Matcher`
    (one query)."""
    from .models import Application

    rows = Application.objects.filter(tenant=tenant).exclude(package_names=[]).values_list(
        "pk", "package_names")
    return Matcher(list(rows))
