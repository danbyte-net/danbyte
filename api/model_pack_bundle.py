"""Bundles: several 3D model packs in one download
(docs/dcim/model-packs.md#bundles).

A bundle is a folder (or a zip of one, under one top folder)::

    bundle.yaml          # id, name, description, version, packs: [{id, name, version}]
    packs/<pack id>/…    # each a complete pack folder, with its pack.yaml

It has no entries of its own. The archive is opened and refused as a whole,
exactly like a pack (api.model_pack.PackFiles, ``zip_refusals``): one upload
cap, one entry count and one unpacked total for the whole bundle, and each
member's own cap. A pack inside it is read through a view confined to its
folder (``PackFiles.nested``), so it is checked, dry-run and imported like a
pack on its own.

``read_bundle`` reads ``bundle.yaml`` against the folders the archive holds;
``check_sections`` runs the pack checker on each listed pack in the bundle's
order. The in-app installer (api.model_pack_install) adds the dry runs and
installs; ``manage.py check_model_pack`` and ``import_model_pack`` print the
sections. Nothing here touches the database except the checker's tenant
lookups.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import yaml
from django.core.exceptions import ValidationError

from .model_pack import MAX_YAML_BYTES, PackFiles
from .model_pack_check import PACK_ID_RE, CheckReport, Finding, check_pack

BUNDLE_FILE = "bundle.yaml"
BUNDLE_KEYS = ("id", "name", "version")


@dataclass
class BundleEntry:
    """A pack ``bundle.yaml`` lists, in install order."""
    id: str
    name: str = ""
    version: str = ""
    present: bool = False


@dataclass
class Bundle:
    meta: dict = field(default_factory=dict)
    entries: list[BundleEntry] = field(default_factory=list)
    #: The bundle's own problems: [{"level": "error" | "warning", "message": …}].
    problems: list[dict] = field(default_factory=list)

    def problem(self, level: str, message: str):
        self.problems.append({"level": level, "message": message})


def read_bundle(files: PackFiles) -> Bundle:
    """``bundle.yaml`` and the pack folders under ``packs/``: what is listed,
    which listed packs are there, and the problems - a listed pack missing
    from the archive, a folder not listed (not installed), a list entry that
    isn't a pack id, the same pack listed twice."""
    out = Bundle()
    names = files.names()
    folders = sorted({n.split("/")[1] for n in names
                      if n.startswith("packs/") and n.count("/") >= 2})
    loose = [n for n in names if n.startswith("packs/") and n.count("/") == 1]
    try:
        raw = yaml.safe_load((files.read(BUNDLE_FILE, MAX_YAML_BYTES) or b"").decode("utf-8"))
    except (ValidationError, UnicodeDecodeError, yaml.YAMLError) as exc:
        out.problem("error", f"bundle.yaml: not readable: {exc}")
        raw = None
    if raw is not None and not isinstance(raw, dict):
        out.problem("error", "bundle.yaml: not a mapping.")
    if isinstance(raw, dict):
        out.meta = {k: str(raw[k]).strip() for k in ("id", "name", "description", "version")
                    if raw.get(k) not in (None, "")}
        for k in BUNDLE_KEYS:
            if k not in out.meta:
                out.problem("error", f"bundle.yaml: no {k}.")
        listed = raw.get("packs")
        if listed is None and isinstance(raw.get("includes"), list):
            listed = raw["includes"]
        if not isinstance(listed, list) or not listed:
            out.problem("error", "bundle.yaml: no packs list.")
            listed = []
        seen: set[str] = set()
        for row in listed:
            if isinstance(row, str):
                row = {"id": row}
            if not isinstance(row, dict):
                out.problem("error", "bundle.yaml: a packs entry that isn't {id, name, version}.")
                continue
            pid = str(row.get("id") or "").strip()
            if not PACK_ID_RE.match(pid):
                out.problem("error", f"bundle.yaml: {pid[:40]!r} is not a pack id.")
                continue
            if pid in seen:
                out.problem("error", f"bundle.yaml lists {pid} twice.")
                continue
            seen.add(pid)
            out.entries.append(BundleEntry(
                pid, str(row.get("name") or "").strip()[:200],
                str(row.get("version") or "").strip()[:50], pid in folders))
    listed_ids = {e.id for e in out.entries}
    for e in out.entries:
        if not e.present:
            out.problem("error", f"bundle.yaml lists {e.id}; the bundle has no packs/{e.id}/.")
    for f in folders:
        if f not in listed_ids:
            out.problem("warning", f"packs/{f}/ is not in bundle.yaml - not installed.")
    for n in loose:
        out.problem("warning", f"{n}: not in a pack folder - ignored.")
    return out


def module_parts(files: PackFiles) -> set[str]:
    """The module part numbers a pack ships (its module-types YAML)."""
    out: set[str] = set()
    for n in files.names():
        if not n.startswith("module-types/") or not n.endswith((".yaml", ".yml")):
            continue
        try:
            doc = yaml.safe_load((files.read(n, MAX_YAML_BYTES) or b"").decode("utf-8"))
        except (ValidationError, UnicodeDecodeError, yaml.YAMLError):
            continue
        if isinstance(doc, dict):
            pn = str(doc.get("part_number") or doc.get("model") or "").strip()
            if pn:
                out.add(pn)
    return out


@dataclass
class Section:
    """One listed pack: its checker report (with the bundle's problems about
    it as errors) and, when present, the view to read it through."""
    entry: BundleEntry
    report: CheckReport
    files: PackFiles | None = None

    @property
    def id(self) -> str:
        return self.entry.id

    @property
    def name(self) -> str:
        return self.report.pack.get("name") or self.entry.name or self.entry.id

    @property
    def version(self) -> str:
        return self.report.pack.get("version") or self.entry.version


def check_sections(files: PackFiles, bundle: Bundle, *, tenant=None) -> list[Section]:
    """The pack checker on each pack ``bundle.yaml`` lists, in its order. A
    render's or bay's module part number may be in another pack of the
    bundle. A listed pack missing from the archive, or whose pack.yaml
    ``id`` or ``version`` isn't what bundle.yaml says, gets an error: it is
    not installed (the others are)."""
    views: dict[str, PackFiles] = {}
    for e in bundle.entries:
        if e.present:
            try:
                views[e.id] = PackFiles.nested(files, f"packs/{e.id}")
            except FileNotFoundError:
                e.present = False
    known: set[str] = set()
    for v in views.values():
        known |= module_parts(v)
    out: list[Section] = []
    for e in bundle.entries:
        view = views.get(e.id)
        if view is None:
            rep = CheckReport(findings=[Finding(
                "error", "bundle.yaml", f"Listed, but the bundle has no packs/{e.id}/.")])
            out.append(Section(e, rep))
            continue
        rep = check_pack(view, tenant=tenant, known_parts=known)
        got = rep.pack.get("id", "")
        if got != e.id:
            msg = f"pack.yaml id is {got or 'missing'}; bundle.yaml lists the pack as {e.id}."
            rep.findings.append(Finding("error", "pack.yaml", msg))
            bundle.problem("error", f"packs/{e.id}/: {msg}")
        have = rep.pack.get("version", "")
        if e.version and have and have != e.version:
            msg = f"pack.yaml version is {have}; bundle.yaml says {e.version}."
            rep.findings.append(Finding("error", "pack.yaml", msg))
            bundle.problem("error", f"packs/{e.id}/: {msg}")
        out.append(Section(e, rep, view))
    return out
