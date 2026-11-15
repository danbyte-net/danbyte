"""3D model packs: device type and module type YAML with ``model3d:`` blocks,
plus the ``.glb`` files they name (docs/dcim/model-packs.md).

A pack is a folder (or a zip of one)::

    pack.yaml
    device-types/<Vendor>/<PART>.yaml
    module-types/<Vendor>/<PART>.yaml
    models/<Vendor>/<PART>.glb
    models/<Vendor>/<PART>.far.glb

The ``model3d:`` block of a type's YAML::

    model3d:
      file: models/Cisco/C9500-48Y4C.glb      # path inside the pack
      far: models/Cisco/C9500-48Y4C.far.glb   # optional far-distance copy
      empty: filler                           # filler | hole | nothing
      leds:
        SYS: { source: device.status }

``apply_model3d`` sets it on a type: each file is checked like an upload
(api.model_3d.validate_glb), scanned for anchors (api.model_anchors) and
stored as the type's model. A lone YAML (no pack around it) has nowhere to
read the files from, so the block is skipped with a note.

``import_pack`` imports a whole pack: it matches each YAML to an existing
type by manufacturer and part number, creates the ones that are missing
(api.devicetype_import) and sets their models. ``manage.py
import_model_pack`` drives it.
"""
from __future__ import annotations

import posixpath
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from django.core.exceptions import ValidationError

from .model_anchors import EMPTY_MODES

#: What a ``leds:`` entry may take its state from (Phase 3 draws them).
LED_SOURCES = ("device.status", "device.locate", "module.status",
               "interface.oper_status", "none")
#: YAML files a pack may hold at most, and each one's size.
MAX_YAML_FILES = 2000
MAX_YAML_BYTES = 2 * 1024 * 1024


def _clean_path(path) -> str | None:
    """A pack-relative POSIX path, or None for one that leaves the pack
    (absolute, ``..``, a drive or a backslash)."""
    if not isinstance(path, str) or not path.strip():
        return None
    p = path.strip()
    if "\\" in p or p.startswith("/") or ":" in p.split("/")[0]:
        return None
    norm = posixpath.normpath(p)
    if norm.startswith("..") or norm in (".", ""):
        return None
    return norm


class PackFiles:
    """Read files from a pack folder or zip by pack-relative path. Paths are
    confined to the pack; reads are capped at the model size cap."""

    def __init__(self, source):
        self.source = Path(source)
        self._zip = None
        self._prefix = ""
        if self.source.is_file():
            self._zip = zipfile.ZipFile(self.source)
            names = [n for n in self._zip.namelist() if not n.endswith("/")]
            # A zip of the pack folder has one top folder around everything.
            tops = {n.split("/", 1)[0] for n in names}
            if len(tops) == 1 and all("/" in n for n in names):
                top = next(iter(tops))
                if f"{top}/pack.yaml" in names or any(
                        n.startswith((f"{top}/device-types/", f"{top}/module-types/"))
                        for n in names):
                    self._prefix = top + "/"
        elif not self.source.is_dir():
            raise FileNotFoundError(str(source))

    def close(self):
        if self._zip is not None:
            self._zip.close()

    def names(self) -> list[str]:
        if self._zip is not None:
            return sorted(n[len(self._prefix):] for n in self._zip.namelist()
                          if n.startswith(self._prefix) and not n.endswith("/"))
        root = self.source.resolve()
        out = []
        for p in root.rglob("*"):
            if p.is_file() and not p.is_symlink():
                out.append(p.relative_to(root).as_posix())
        return sorted(out)

    def read(self, path, cap: int) -> bytes | None:
        """The file's bytes, None when it isn't in the pack. Raises
        ValidationError when it is over ``cap``."""
        rel = _clean_path(path)
        if rel is None:
            return None
        if self._zip is not None:
            try:
                info = self._zip.getinfo(self._prefix + rel)
            except KeyError:
                return None
            if info.file_size > cap:
                raise ValidationError(f"{rel} is larger than the size cap.")
            with self._zip.open(info) as fh:
                data = fh.read(cap + 1)
        else:
            root = self.source.resolve()
            p = (root / rel).resolve()
            if root not in p.parents or not p.is_file() or p.is_symlink():
                return None
            if p.stat().st_size > cap:
                raise ValidationError(f"{rel} is larger than the size cap.")
            with p.open("rb") as fh:
                data = fh.read(cap + 1)
        if len(data) > cap:
            raise ValidationError(f"{rel} is larger than the size cap.")
        return data


def model3d_paths(block) -> list[str]:
    if not isinstance(block, dict):
        return []
    return [str(block[k]) for k in ("file", "far") if isinstance(block.get(k), str)]


def apply_model3d(obj, block, files: PackFiles | None, *, dry_run: bool = False) -> list[str]:
    """Set a type's 3D model from its YAML ``model3d:`` block; the notes for
    the import report. ``files`` None (a lone YAML) skips the block with a
    note. With ``dry_run`` everything is read, checked and scanned, but
    nothing is stored."""
    from . import model_3d
    from .model_anchors import scan_result

    if block in (None, "", {}):
        return []
    if not isinstance(block, dict):
        return ["model3d: not a mapping - skipped."]
    if files is None:
        named = ", ".join(model3d_paths(block)) or "no file"
        return [f"model3d: {named} not imported - the 3D files come with the model "
                "pack (manage.py import_model_pack)."]
    notes: list[str] = []
    cap = model_3d.max_bytes()

    def load(key):
        path = block.get(key)
        if path in (None, ""):
            return None, None
        try:
            data = files.read(path, cap)
        except ValidationError as exc:
            notes.append(f"model3d.{key}: {' '.join(exc.messages)}")
            return None, None
        if data is None:
            notes.append(f"model3d.{key}: {path} is not in the pack - skipped.")
            return None, None
        try:
            return data, model_3d.validate_glb(data)
        except ValidationError as exc:
            notes.append(f"model3d.{key}: {path}: {' '.join(exc.messages)}")
            return None, None

    data, doc = load("file")
    if data is None:
        if "file" not in block:
            notes.append("model3d: no file - skipped.")
        return notes
    for key, choices in (("fit", ("auto", "native")), ("up", ("y", "z")),
                         ("front", ("+z", "-z", "+x", "-x"))):
        val = block.get(key)
        if val in (None, ""):
            continue
        if str(val) in choices:
            setattr(obj, f"model_3d_{key}", str(val))
        else:
            notes.append(f"model3d.{key}: {val!r} is not one of {', '.join(choices)}.")
    anchors, report = scan_result(obj, doc)
    mode = block.get("empty")
    if mode not in (None, ""):
        if mode in EMPTY_MODES:
            anchors["empty_mode"] = mode
        else:
            notes.append(f"model3d.empty: {mode!r} is not one of {', '.join(EMPTY_MODES)}.")
    notes.append(f"model: {report['summary']}")
    notes += [f"model: {w}" for w in report["warnings"]]
    leds = {}
    raw = block.get("leds")
    if isinstance(raw, dict):
        for led, spec in raw.items():
            src = spec.get("source") if isinstance(spec, dict) else None
            if src in LED_SOURCES:
                leds[str(led)] = {"source": src}
            else:
                notes.append(f"model3d.leds.{led}: unknown source {src!r} - dropped.")
    elif raw not in (None, ""):
        notes.append("model3d.leds: not a mapping - dropped.")
    far_data, far_doc = load("far")
    if not dry_run:
        obj.model_anchors = anchors
        obj.model_leds = leds or None
        # The pack's models replace any port mapping made by hand on the old one.
        obj.model_ports = None
        model_3d.store(obj, data)
        if obj.model_3d_far and far_data is None:
            obj.model_3d_far.delete(save=False)
            obj.model_3d_far = None
            obj.save()
    if far_data is not None:
        obj.model_anchors = anchors
        _, far_report = scan_result(obj, far_doc, far=True)
        notes.append(f"far model: {far_report['summary']}")
        notes += [f"far model: {w}" for w in far_report["warnings"]]
        if not dry_run:
            model_3d.store(obj, far_data, far=True)
    return notes


# ── whole packs ─────────────────────────────────────────────────────────────

@dataclass
class TypeResult:
    kind: str           # "device-type" | "module-type"
    path: str
    name: str = ""
    action: str = ""    # "matched" | "created" | "error"
    notes: list[str] = field(default_factory=list)


@dataclass
class PackResult:
    name: str = ""
    version: str = ""
    types: list[TypeResult] = field(default_factory=list)
    unused_models: list[str] = field(default_factory=list)

    @property
    def errors(self) -> int:
        return sum(1 for t in self.types if t.action == "error")


def _match(model_cls, tenant, data):
    """The existing type a YAML doc describes: same manufacturer (by name)
    and part number - or, without a part number, the same name. Returns
    (type, None) or (None, why-not) when ambiguous."""
    mfr = str(data.get("manufacturer") or "").strip()
    pn = str(data.get("part_number") or "").strip()
    name = str(data.get("model") or "").strip()
    qs = model_cls.objects.filter(tenant=tenant, manufacturer__name__iexact=mfr)
    hits = list(qs.filter(part_number=pn)[:2]) if pn else list(qs.filter(name=name)[:2])
    if len(hits) > 1:
        return None, f"more than one {mfr} type has part number {pn or name} - skipped."
    return (hits[0] if hits else None), None


def import_pack(tenant, files: PackFiles, *, dry_run: bool = True) -> PackResult:
    """Import every device type and module type YAML in the pack with its
    models. Inside one transaction, rolled back on ``dry_run`` (which also
    stores no file). Audited as ordinary saves, with the pack as the cause."""
    from django.db import transaction

    from audit.context import cause

    from .devicetype_import import import_devicetype_yaml, import_moduletype_yaml
    from .models import DeviceType, ModuleType

    result = PackResult()
    names = files.names()
    manifest = files.read("pack.yaml", MAX_YAML_BYTES) if "pack.yaml" in names else None
    if manifest:
        try:
            meta = yaml.safe_load(manifest) or {}
        except yaml.YAMLError:
            meta = {}
        if isinstance(meta, dict):
            result.name = str(meta.get("name") or meta.get("id") or "")
            result.version = str(meta.get("version") or "")
    yamls = [n for n in names
             if n.startswith(("module-types/", "device-types/"))
             and n.endswith((".yaml", ".yml"))][:MAX_YAML_FILES]
    # Module types first: a device type's scan doesn't need them, but a
    # reader sees the parts before the chassis that holds them.
    yamls.sort(key=lambda n: (not n.startswith("module-types/"), n))
    referenced: set[str] = set()
    label = f"manage.py import_model_pack {result.name or files.source.name}"
    if result.version:
        label += f" {result.version}"
    with cause(label), transaction.atomic():
        for path in yamls:
            kind = "module-type" if path.startswith("module-types/") else "device-type"
            tr = TypeResult(kind=kind, path=path)
            result.types.append(tr)
            try:
                text = files.read(path, MAX_YAML_BYTES).decode("utf-8")
                data = yaml.safe_load(text)
            except (ValidationError, UnicodeDecodeError, yaml.YAMLError) as exc:
                tr.action, tr.notes = "error", [f"Not readable: {exc}"]
                continue
            if not isinstance(data, dict) or not data.get("manufacturer") or not data.get(
                    "model"):
                tr.action, tr.notes = "error", ["Needs manufacturer and model."]
                continue
            tr.name = str(data.get("model"))
            block = data.get("model3d")
            for p in model3d_paths(block):
                if (c := _clean_path(p)) is not None:
                    referenced.add(c)
            model_cls = ModuleType if kind == "module-type" else DeviceType
            obj, why = _match(model_cls, tenant, data)
            if why:
                tr.action, tr.notes = "error", [why]
                continue
            with transaction.atomic():
                if obj is None:
                    importer = (import_moduletype_yaml if kind == "module-type"
                                else import_devicetype_yaml)
                    kwargs = {} if kind == "module-type" else {"image_inventory": set()}
                    rep = importer(tenant, text, files=None, **kwargs)
                    if not rep.get("ok"):
                        tr.action, tr.notes = "error", [rep.get("error") or "Not imported."]
                        continue
                    obj = model_cls.objects.get(pk=rep["id"])
                    tr.action = "created"
                    tr.notes += [n for n in rep.get("skipped") or []
                                 if not n.startswith(("model3d:", "front_image:",
                                                      "rear_image:"))]
                else:
                    tr.action = "matched"
                    tr.name = obj.name
                tr.notes += apply_model3d(obj, block, files, dry_run=dry_run) or [
                    "no model3d block."]
                # Rack-face images render in a browser (api.model_studio):
                # the type's page offers them to its next editor.
                if kind == "device-type" and not dry_run:
                    from .model_studio import pending

                    if pending(obj):
                        tr.notes.append("images: pending - the type's page offers "
                                        "to generate them.")
        if dry_run:
            transaction.set_rollback(True)
    result.unused_models = [n for n in names
                            if n.startswith("models/") and n.endswith(".glb")
                            and n not in referenced]
    return result
