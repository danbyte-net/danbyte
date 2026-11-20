"""The model pack checker: the review a pack gets before Danbyte ships or
installs it (docs/dcim/model-packs.md#checking-a-pack, the export spec's
sections 4, 5, 8 and 12).

``check_pack`` runs on a pack folder or zip (api.model_pack.PackFiles) and
needs no database unless a ``tenant`` is given, which only widens where a
render's module part numbers may be found. ``manage.py check_model_pack``
prints it; the in-app installer's check (api.model_pack_install) stores it
and refuses to install a pack with errors.

What it checks:

* the archive: paths, links, file types and sizes (api.model_pack);
* ``pack.yaml``: present, with ``name``, ``id``, ``version`` and
  ``license``, and its ``types`` lists the pack's YAML;
* every ``.glb``: ``api.model_3d.validate_glb``, the triangle and file size
  budgets for a chassis or a module and its far LOD;
* every image: a WebP or PNG Pillow can verify, within the size caps;
* each type's names: ``bay:``, ``empty:``, ``port:`` and ``led:port:``
  against the YAML's ``module-bays`` and ``interfaces`` (``{module}`` as
  written), LEDs on the ``LED`` material, the far LOD's names, ``leds:``
  keys against the model's ``led:`` nodes (equal on a module type), port
  opening sizes (a warning when missing);
* accessory types (``accessory-types/``, api.port_plugs): name, kind,
  ``fits``, ``parts`` / ``standard`` / ``wavelength_nm``, a cord's
  ``cable:`` block and ``model3d.file``, the model valid and within its
  budget (a transceiver 1,500 triangles, a cord or plug 2,000), the
  ``port:<connector>`` / ``cable`` empties stacking needs, listed under
  ``types: accessory:``, and no part number claimed twice;
* rack kits (``rack-kits/<Vendor>/<NAME>/kit.yaml``, api.rack_kits): name,
  frame, ``model3d.file`` and ``far``, the parts the room reads
  (``post:segment`` at least), stretched parts' ``danbyte_ref_mm``, doors'
  ``hinge`` empties, the kit's 20,000 and the far box's 2,000 triangles,
  listed under ``types: rack-kit:``;
* rack types (``rack-types/``): manufacturer and model, the ``look:``
  values, a ``look.kit`` naming a kit in the pack (or the tenant), listed
  under ``types: rack-type:``;
* renders: the files, WebP or PNG, front and rear exactly the type's face
  frame at 2000 px, a transparent background, ``model_sha256`` equal to the
  ``.glb``, and ``modules`` naming real bays and module types in the pack
  (or the tenant).
"""
from __future__ import annotations

import fnmatch
import hashlib
import io
import math
import re
from dataclasses import asdict, dataclass, field

import yaml
from django.core.exceptions import ValidationError

from .model_pack import (
    MAX_YAML_BYTES,
    RENDER_FACES,
    PackFiles,
    _clean_path,
    face_px,
)

#: Triangle and file budgets (the export spec, section 5): (full, far).
BUDGETS = {
    "device-type": {"triangles": (150_000, 15_000)},
    "module-type": {"triangles": (30_000, 3_000)},
}
FILE_BUDGET = (8 * 1024 * 1024, 1024 * 1024)
#: A module under this many triangles needs no far LOD.
FAR_OPTIONAL_BELOW = 5_000
#: The largest image a pack may carry, in pixels per side.
MAX_IMAGE_SIDE = 4096
RACK_FACE_MM = 482.6
RACK_UNIT_MM = 44.45
PACK_KEYS = ("name", "id", "version", "license")


@dataclass
class Finding:
    level: str          # "error" | "warning"
    path: str
    message: str


@dataclass
class Part:
    """One type's row in the report table."""
    kind: str           # "device-type" | "module-type" | "accessory-type" | "rack-kit" | "rack-type"
    path: str
    part: str = ""
    triangles: int | None = None
    far_triangles: int | None = None
    bytes: int | None = None
    far_bytes: int | None = None
    bays: int = 0
    ports: int = 0
    leds: int = 0
    errors: int = 0
    warnings: int = 0


@dataclass
class CheckReport:
    pack: dict = field(default_factory=dict)
    parts: list[Part] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)

    @property
    def errors(self) -> int:
        return sum(1 for f in self.findings if f.level == "error")

    @property
    def warnings(self) -> int:
        return sum(1 for f in self.findings if f.level == "warning")

    @property
    def ok(self) -> bool:
        return self.errors == 0

    def to_dict(self) -> dict:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings,
                "pack": self.pack, "parts": [asdict(p) for p in self.parts],
                "findings": [asdict(f) for f in self.findings]}


# ── glTF numbers ────────────────────────────────────────────────────────────

def triangles(doc: dict) -> int:
    """Triangles the default scene draws: each mesh node's primitives, a
    mesh used twice counted twice. Points and lines count none."""
    from .model_anchors import _world

    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    meshes = doc.get("meshes") if isinstance(doc.get("meshes"), list) else []
    accessors = doc.get("accessors") if isinstance(doc.get("accessors"), list) else []

    def count(i) -> int:
        if isinstance(i, int) and 0 <= i < len(accessors) and isinstance(accessors[i], dict):
            n = accessors[i].get("count")
            return n if isinstance(n, int) and n > 0 else 0
        return 0

    total = 0
    for i in _world(doc):
        mi = nodes[i].get("mesh") if isinstance(nodes[i], dict) else None
        if not isinstance(mi, int) or not (0 <= mi < len(meshes)):
            continue
        for prim in (meshes[mi] or {}).get("primitives") or []:
            if not isinstance(prim, dict):
                continue
            mode = prim.get("mode", 4)
            n = count(prim.get("indices")) if "indices" in prim else count(
                (prim.get("attributes") or {}).get("POSITION"))
            if mode == 4:
                total += n // 3
            elif mode in (5, 6):
                total += max(n - 2, 0)
    return total


def _stem(path: str) -> str:
    """A pack file's name without folder or extension; a rack kit's folder
    name (``rack-kits/Generic/CABINET/kit.yaml``)."""
    parts = path.split("/")
    name = parts[-1].rsplit(".", 1)[0]
    return parts[-2] if name == "kit" and len(parts) > 1 else name


def _frame_mm(data: dict) -> tuple[float, float | None]:
    """A YAML type's face frame (mm), as Danbyte computes it for a type
    imported from it (api.model_studio.frame_mm)."""
    try:
        w = float(data.get("width_mm") or 0) or None
    except (TypeError, ValueError):
        w = None
    if w is None:
        w = RACK_FACE_MM / 2 if str(data.get("rack_width") or "") == "half" else RACK_FACE_MM
    try:
        raw_u = float(data.get("u_height", 1) or 0)
    except (TypeError, ValueError):
        raw_u = 0
    u = max(0, math.ceil(raw_u))
    h = u * RACK_UNIT_MM if u else None
    if h is None:
        try:
            h = float(data.get("height_mm") or 0) or None
        except (TypeError, ValueError):
            h = None
    return round(w, 2), (round(h, 2) if h is not None else None)


#: The YAML lists besides ``interfaces`` whose names a ``port:`` may use.
PORT_KEYS = ("power-ports", "console-ports", "console-server-ports", "aux-ports",
             "power-outlets", "front-ports", "rear-ports")


def _names(data: dict, key: str) -> list[str]:
    rows = data.get(key)
    if not isinstance(rows, list):
        return []
    return [str(r["name"]) for r in rows if isinstance(r, dict) and r.get("name") not in (None, "")]


# ── the checker ─────────────────────────────────────────────────────────────

class _Checker:
    def __init__(self, files: PackFiles, tenant=None, known_parts=()):
        self.files = files
        self.tenant = tenant
        self.known_parts = set(known_parts)
        self.report = CheckReport()
        self.names = files.names()
        self.sizes = files.sizes()
        self.glbs: dict[str, tuple[bytes, dict] | None] = {}
        self.referenced: set[str] = set()
        self.accessories: dict[str, dict] = {}
        self.kits: dict[str, dict] = {}
        self.rack_types: dict[str, dict] = {}

    def add(self, level, path, message, part: Part | None = None):
        self.report.findings.append(Finding(level, path, message))
        if part is not None:
            if level == "error":
                part.errors += 1
            else:
                part.warnings += 1

    # files ------------------------------------------------------------

    def glb(self, rel: str):
        """``(bytes, doc)`` of a pack glb that validates, else None (with
        the error added once)."""
        from . import model_3d

        if rel in self.glbs:
            return self.glbs[rel]
        got = None
        try:
            data = self.files.read(rel, model_3d.max_bytes())
        except ValidationError as exc:
            self.add("error", rel, " ".join(exc.messages))
            data = None
        if data is not None:
            try:
                got = (data, model_3d.validate_glb(data))
            except ValidationError as exc:
                self.add("error", rel, " ".join(exc.messages))
        self.glbs[rel] = got
        return got

    def image(self, rel: str):
        """``(format, (w, h), image bytes)`` of a pack image that verifies,
        else None (with the error added)."""
        from PIL import Image

        from .model_studio import IMAGE_FORMATS, MAX_IMAGE_BYTES

        try:
            data = self.files.read(rel, MAX_IMAGE_BYTES)
        except ValidationError as exc:
            self.add("error", rel, " ".join(exc.messages))
            return None
        if data is None:
            return None
        try:
            img = Image.open(io.BytesIO(data))
            fmt, size = (img.format or "").upper(), tuple(img.size)
            if max(size) > MAX_IMAGE_SIDE:
                self.add("error", rel, f"{size[0]} × {size[1]} px; an image may be "
                                       f"{MAX_IMAGE_SIDE} px a side.")
                return None
            img.verify()
        except Exception:  # noqa: BLE001 - Pillow raises many kinds
            self.add("error", rel, "Not an image Pillow can read.")
            return None
        if fmt not in IMAGE_FORMATS:
            self.add("error", rel, "Not a WebP or PNG.")
            return None
        return fmt, size, data

    # pack.yaml --------------------------------------------------------

    def manifest(self, yamls: dict[str, dict]):
        if "pack.yaml" not in self.names:
            self.add("error", "pack.yaml", "The pack has no pack.yaml.")
            return
        try:
            meta = yaml.safe_load(self.files.read("pack.yaml", MAX_YAML_BYTES) or b"")
        except (ValidationError, yaml.YAMLError) as exc:
            self.add("error", "pack.yaml", f"Not readable: {exc}")
            return
        if not isinstance(meta, dict):
            self.add("error", "pack.yaml", "Not a mapping.")
            return
        self.report.pack = {k: str(meta[k]) for k in (*PACK_KEYS, "author", "spec")
                            if meta.get(k) not in (None, "")}
        for k in PACK_KEYS:
            if meta.get(k) in (None, ""):
                self.add("error", "pack.yaml", f"No {k}.")
        requires, bad = read_requires(meta)
        if requires:
            self.report.pack["requires"] = requires
        if bad:
            self.add("warning", "pack.yaml", bad)
        types = meta.get("types")
        if not isinstance(types, dict):
            self.add("warning", "pack.yaml", "No types: list.")
            return
        for kind, key in (("device-type", "device"), ("module-type", "module")):
            listed = types.get(key) or []
            listed = {str(x) for x in listed} if isinstance(listed, list) else set()
            have = {str(d.get("part_number") or d.get("model") or "")
                    for p, d in yamls.items() if p.startswith(kind + "s/")}
            for pn in sorted(listed - have):
                self.add("error", "pack.yaml", f"types.{key} lists {pn}, which has no YAML.")
            for pn in sorted(have - listed):
                self.add("warning", "pack.yaml", f"types.{key} doesn't list {pn}.")
        listed = types.get("accessory") or []
        listed = {str(x) for x in listed} if isinstance(listed, list) else set()
        have = {str(d.get("name") or "") for d in self.accessories.values()}
        for name in sorted(listed - have):
            self.add("error", "pack.yaml", f"types.accessory lists {name}, which has no YAML.")
        for name in sorted(have - listed):
            if name:
                self.add("warning", "pack.yaml", f"types.accessory doesn't list {name}.")
        for key, docs, attr in (("rack-kit", self.kits, "name"),
                                ("rack-type", self.rack_types, "model")):
            listed = types.get(key) or []
            listed = {str(x) for x in listed} if isinstance(listed, list) else set()
            # Listed by its name, or by its file's (a rack type's model is a
            # sentence: "Generic 42U 600x1000 cabinet").
            names = {path: {str(d.get(attr) or ""), _stem(path)} - {""} for path, d in docs.items()}
            known = set().union(*names.values()) if names else set()
            for name in sorted(listed - known):
                self.add("error", "pack.yaml", f"types.{key} lists {name}, which has no YAML.")
            for path, own in sorted(names.items()):
                if not own & listed:
                    self.add("warning", "pack.yaml",
                             f"types.{key} doesn't list {str(docs[path].get(attr) or _stem(path))}.")

    # an accessory -----------------------------------------------------

    def accessory_parts(self):
        """A part number two accessories claim draws whichever sorts first."""
        from .port_plugs import part_key

        claimed: dict[str, str] = {}
        for path, doc in sorted(self.accessories.items()):
            raw = doc.get("parts")
            for p in raw if isinstance(raw, list) else []:
                key = part_key(str(p))
                if key in claimed and claimed[key] != path:
                    self.add("warning", path, f"parts: {p} is also listed by {claimed[key]}.")
                claimed.setdefault(key, path)

    def accessory(self, path: str, data):
        from .port_plugs import empty_warnings, read_accessory, triangle_budget

        row = Part(kind="accessory-type", path=path,
                   part=str(data.get("name") or "") if isinstance(data, dict) else "")
        self.report.parts.append(row)
        fields, notes = read_accessory(path, data)
        for n in notes:
            self.add("warning" if fields is not None else "error", path, n, row)
        if fields is None:
            return
        self.catalog_photos(data.get("model3d") if isinstance(data, dict) else None)
        rel = fields["file"]
        self.referenced.add(rel)
        if rel not in self.names:
            self.add("error", path, f"model3d.file {rel} is not in the pack.", row)
            return
        got = self.glb(rel)
        if got is None:
            row.errors += 1
            return
        data_bytes, doc = got
        row.triangles, row.bytes = triangles(doc), len(data_bytes)
        budget = triangle_budget(fields["kind"])
        if row.triangles > budget:
            self.add("warning", rel, f"{row.triangles} triangles; a {fields['kind']}'s "
                                     f"budget is {budget}.", row)
        for w in empty_warnings(doc, fields):
            self.add("warning", rel, w, row)

    # a rack kit and a rack type -------------------------------------

    def kit(self, path: str, data):
        from .rack_kits import FAR_TRIANGLES, KIT_TRIANGLES, kit_errors, read_kit, scan_parts

        row = Part(kind="rack-kit", path=path,
                   part=str(data.get("name") or "") if isinstance(data, dict) else "")
        self.report.parts.append(row)
        fields, notes = read_kit(path, data)
        for n in notes:
            self.add("warning" if fields is not None else "error", path, n, row)
        if fields is None:
            return
        row.part = fields["name"]
        for key in ("file", "far"):
            rel = fields[key]
            if rel is None:
                if key == "far":
                    self.add("warning", path, "No model3d.far; far off the room draws "
                                              "the plain box.", row)
                continue
            self.referenced.add(rel)
            if rel not in self.names:
                self.add("error", path, f"model3d.{key} {rel} is not in the pack.", row)
                continue
            got = self.glb(rel)
            if got is None:
                row.errors += 1
                continue
            data_bytes, doc = got
            tri = triangles(doc)
            if key == "far":
                row.far_triangles, row.far_bytes = tri, len(data_bytes)
                if tri > FAR_TRIANGLES:
                    self.add("warning", rel, f"{tri} triangles; a kit's far box's budget "
                                             f"is {FAR_TRIANGLES}.", row)
                continue
            row.triangles, row.bytes = tri, len(data_bytes)
            if tri > KIT_TRIANGLES:
                self.add("warning", rel, f"{tri} triangles; a kit's budget is "
                                         f"{KIT_TRIANGLES}.", row)
            parts, scan_notes = scan_parts(doc)
            row.ports = len(parts)
            errs = set(kit_errors(scan_notes))
            for n in scan_notes:
                self.add("error" if n in errs else "warning", rel, n, row)
            from .rack_pathways import mark_installed, scan_pathways

            seg = parts.get("post:segment") or {}
            got, path_notes = scan_pathways(doc, seg.get("fit"), *_ref_size(fields))
            mark_installed(got, fields.get("installed"), path_notes)
            for n in path_notes:
                self.add("warning", rel, n, row)

    def rack_type(self, path: str, data):
        from .rack_kits import find_kit, read_look

        row = Part(kind="rack-type", path=path,
                   part=str(data.get("model") or "") if isinstance(data, dict) else "")
        self.report.parts.append(row)
        if not isinstance(data, dict) or not data.get("manufacturer") or not data.get("model"):
            self.add("error", path, "Needs manufacturer and model.", row)
            return
        notes: list[str] = []
        look = read_look(data, notes)
        for n in notes:
            self.add("warning", path, n, row)
        name = look.get("kit_name")
        if name:
            in_pack = {str(d.get("name") or "").lower() for d in self.kits.values()}
            if name.lower() not in in_pack and not (
                    self.tenant is not None and find_kit(self.tenant, name) is not None):
                self.add("error", path, f"look.kit {name} is not a kit in the pack.", row)

    # a type -----------------------------------------------------------

    def part(self, kind: str, path: str, data: dict, module_parts: set[str]):
        from .led_state import validate_bindings
        from .model_anchors import far_mismatches, scan

        row = Part(kind=kind, path=path,
                   part=str(data.get("part_number") or data.get("model") or ""))
        self.report.parts.append(row)
        if kind == "device-type":
            self.bay_modules(path, data, module_parts, row)
        block = data.get("model3d")
        if block in (None, "", {}):
            self.add("warning", path, "No model3d block.", row)
            return
        if not isinstance(block, dict):
            self.add("error", path, "model3d is not a mapping.", row)
            return
        rel = _clean_path(block.get("file"))
        if rel is None:
            self.add("error", path, "model3d.file is missing or leaves the pack.", row)
            return
        self.referenced.add(rel)
        if rel not in self.names:
            self.add("error", path, f"model3d.file {rel} is not in the pack.", row)
            return
        got = self.glb(rel)
        if got is None:
            row.errors += 1
            return
        data_bytes, doc = got
        tri_full, tri_far = BUDGETS[kind]["triangles"]
        row.triangles, row.bytes = triangles(doc), len(data_bytes)
        if row.triangles > tri_full:
            self.add("error", rel, f"{row.triangles} triangles; the budget is {tri_full}.", row)
        if row.bytes > FILE_BUDGET[0]:
            self.add("error", rel, f"{row.bytes} bytes; the budget is {FILE_BUDGET[0]}.", row)

        anchors, scan_warnings = scan(doc)
        for w in scan_warnings:
            self.add("error", rel, w, row)
        bays, ports, leds = anchors["bays"], anchors["ports"], anchors["leds"]
        row.bays, row.ports, row.leds = len(bays), len(ports), len(leds)
        bay_names = set(_names(data, "module-bays"))
        ifaces = _names(data, "interfaces")
        # A port: anchor names an interface or another port-like component:
        # a console port, a power inlet (spec 1.6), an aux port, …
        iface_set = set(ifaces)
        for key in PORT_KEYS:
            iface_set.update(_names(data, key))
        if kind == "module-type":
            for b in bays:
                self.add("error", rel, f"bay:{b} - a module's model holds no bays.", row)
        else:
            for b in bays:
                if b not in bay_names:
                    self.add("error", rel, f"bay:{b} matches no module bay in the YAML.", row)
            for b in sorted(bay_names - set(bays)):
                self.add("warning", rel, f"Module bay “{b}” has no bay:{b} anchor.", row)
        for e in anchors["empties"]:
            if e not in bays:
                self.add("error", rel, f"empty:{e} has no bay:{e} beside it.", row)
        for p in ports:
            if p not in iface_set:
                self.add("error", rel,
                         f"port:{p} matches no interface or other port in the YAML.", row)
        missing = [i for i in ifaces if i not in ports]
        if missing and (ports or kind == "device-type"):
            self.add("warning", rel, f"{len(missing)} interface{'s' if len(missing) != 1 else ''}"
                                     f" without a port: anchor (first: {missing[0]}).", row)
        unsized = [p for p, a in ports.items() if "s" not in a]
        if unsized:
            self.add("warning", rel, f"{len(unsized)} port{'s' if len(unsized) != 1 else ''} "
                                     "without danbyte_w / danbyte_h opening sizes "
                                     f"(first: {unsized[0]}).", row)
        for led in leds:
            if led.startswith("port:") and led[5:] not in iface_set:
                self.add("error", rel, f"led:{led} matches no interface in the YAML.", row)

        # leds: bindings against the model's lights.
        bindings, notes = validate_bindings(block.get("leds"))
        for n in notes:
            self.add("error", path, f"model3d.{n}", row)
        for key in bindings:
            exact = not any(c in key for c in "*?[")
            if exact and key not in leds:
                self.add("error", path, f"model3d.leds.{key}: the model has no led:{key}.", row)
            elif not exact and not any(fnmatch.fnmatchcase(led, key) for led in leds):
                self.add("warning", path, f"model3d.leds.{key}: matches no led: in the model.",
                         row)
        for led in leds:
            if not any(led == k or fnmatch.fnmatchcase(led, k) for k in bindings):
                level = "error" if kind == "module-type" else "warning"
                self.add(level, path, f"led:{led} has no model3d.leds entry, so it stays off.",
                         row)

        # The far LOD.
        far = block.get("far")
        if far not in (None, ""):
            frel = _clean_path(far)
            if frel is None or frel not in self.names:
                self.add("error", path, f"model3d.far {far} is not in the pack.", row)
            else:
                self.referenced.add(frel)
                fgot = self.glb(frel)
                if fgot is None:
                    row.errors += 1
                else:
                    fdata, fdoc = fgot
                    row.far_triangles, row.far_bytes = triangles(fdoc), len(fdata)
                    if row.far_triangles > tri_far:
                        self.add("error", frel, f"{row.far_triangles} triangles; the far "
                                                f"budget is {tri_far}.", row)
                    if row.far_bytes > FILE_BUDGET[1]:
                        self.add("error", frel, f"{row.far_bytes} bytes; the far budget is "
                                                f"{FILE_BUDGET[1]}.", row)
                    fanchors, fwarn = scan(fdoc)
                    for w in fwarn:
                        self.add("error", frel, w, row)
                    for m in far_mismatches(anchors, fanchors):
                        self.add("error", frel, m, row)
        elif kind == "device-type" or row.triangles >= FAR_OPTIONAL_BELOW:
            self.add("warning", path, "No far LOD (model3d.far).", row)

        if kind == "device-type":
            self.renders(path, data, block, data_bytes, bays, bay_names, module_parts, row)
        else:
            # A module type's photos are the library's (its website shows
            # them); Danbyte doesn't import them and they aren't strays.
            self.catalog_photos(block)

    def catalog_photos(self, block) -> None:
        """Photos a module or accessory type names: for the library only."""
        renders = block.get("renders") if isinstance(block, dict) else None
        if not isinstance(renders, dict):
            return
        for face in RENDER_FACES:
            rel = _clean_path(renders.get(face)) if renders.get(face) else None
            if rel:
                self.referenced.add(rel)

    def renders(self, path, data, block, glb_bytes, bays, bay_names, module_parts, row):
        renders = block.get("renders")
        if renders in (None, "", {}):
            return
        if not isinstance(renders, dict):
            self.add("error", path, "model3d.renders is not a mapping.", row)
            return
        frame = _frame_mm(data)
        expect = face_px(frame)
        for face in RENDER_FACES:
            p = renders.get(face)
            if p in (None, ""):
                if face != "iso":
                    self.add("warning", path, f"renders.{face}: none.", row)
                continue
            rel = _clean_path(p)
            if rel is None or rel not in self.names:
                self.add("error", path, f"renders.{face}: {p} is not in the pack.", row)
                continue
            self.referenced.add(rel)
            got = self.image(rel)
            if got is None:
                row.errors += 1
                continue
            _fmt, size, img_bytes = got
            if face != "iso":
                if expect is None:
                    # The import skips such a face with a note; it is no
                    # reason to refuse the pack.
                    self.add("warning", rel, "The type has no rack units or height to frame "
                                             "the face against: not imported.", row)
                elif size != tuple(expect):
                    self.add("error", rel, f"{size[0]} × {size[1]} px; the type's face frame "
                                           f"({frame[0]} × {frame[1]} mm) needs "
                                           f"{expect[0]} × {expect[1]}.", row)
            if not _transparent(img_bytes):
                self.add("error", rel, "No transparent background.", row)
        raw = renders.get("model_sha256")
        claimed = (raw.strip().lower() if isinstance(raw, str) else
                   ("" if raw is None else str(raw)))
        actual = hashlib.sha256(glb_bytes).hexdigest()
        if not claimed:
            self.add("error", path, "renders.model_sha256: none.", row)
        elif claimed != actual:
            self.add("error", path, f"renders.model_sha256 is {claimed[:12]}…; the .glb is "
                                    f"{actual[:12]}…. Re-render from the shipped model.", row)
        modules = renders.get("modules")
        if modules in (None, "", {}):
            return
        if not isinstance(modules, dict):
            self.add("error", path, "renders.modules is not a mapping.", row)
            return
        for bay, pn in modules.items():
            bay, pn = str(bay), str(pn or "").strip()
            if bay not in bay_names:
                self.add("error", path, f"renders.modules.{bay}: no module bay of this name.",
                         row)
            elif bay not in bays:
                self.add("error", path, f"renders.modules.{bay}: the model has no bay:{bay}.",
                         row)
            if pn and pn not in module_parts and not self._in_tenant(pn):
                where = "the pack or the tenant" if self.tenant is not None else "the pack"
                self.add("error", path, f"renders.modules.{bay}: module type {pn} is not in "
                                        f"{where}.", row)

    def bay_modules(self, path, data, module_parts, row):
        """``module-bays: - modules: [...]``: a list of part numbers; one
        the pack doesn't ship (nor the tenant hold) only warns - another
        pack, or the library, may bring it."""
        from .module_suggestions import clean

        bays = data.get("module-bays")
        for r in bays if isinstance(bays, list) else ():
            if not isinstance(r, dict) or "modules" not in r:
                continue
            try:
                parts = clean(r.get("modules"))
            except ValueError as exc:
                self.add("error", path, f"module-bays.{r.get('name')}.modules: {exc}", row)
                continue
            missing = [p for p in parts if p not in module_parts and not self._in_tenant(p)]
            if missing:
                where = "the pack or the tenant" if self.tenant is not None else "the pack"
                self.add("warning", path, f"module-bays.{r.get('name')}.modules: "
                                          f"{', '.join(missing[:3])}"
                                          f"{', …' if len(missing) > 3 else ''} not in {where}.",
                         row)

    def _in_tenant(self, pn: str) -> bool:
        if pn in self.known_parts:
            return True
        if self.tenant is None:
            return False
        from .models import ModuleType

        return ModuleType.objects.filter(tenant=self.tenant, part_number=pn).exists()

    # run --------------------------------------------------------------

    def run(self) -> CheckReport:
        from .port_plugs import ACCESSORY_DIR
        from .rack_kits import RACK_TYPE_DIR, is_kit_yaml

        for r in self.files.refusals():
            self.add("error", r.split(":", 1)[0], r)
        yamls: dict[str, dict] = {}
        for p in self.names:
            if p.startswith(ACCESSORY_DIR) and p.endswith((".yaml", ".yml")):
                try:
                    doc = yaml.safe_load(
                        (self.files.read(p, MAX_YAML_BYTES) or b"").decode("utf-8"))
                except (ValidationError, UnicodeDecodeError, yaml.YAMLError) as exc:
                    self.add("error", p, f"Not readable: {exc}")
                    continue
                self.accessories[p] = doc if isinstance(doc, dict) else {}
                self.accessory(p, doc)
                continue
            if (is_kit_yaml(p) or p.startswith(RACK_TYPE_DIR)) and p.endswith(
                    (".yaml", ".yml")):
                try:
                    doc = yaml.safe_load(
                        (self.files.read(p, MAX_YAML_BYTES) or b"").decode("utf-8"))
                except (ValidationError, UnicodeDecodeError, yaml.YAMLError) as exc:
                    self.add("error", p, f"Not readable: {exc}")
                    continue
                (self.kits if is_kit_yaml(p) else self.rack_types)[p] = (
                    doc if isinstance(doc, dict) else {})
                continue
            if not p.startswith(("device-types/", "module-types/")) or not p.endswith(
                    (".yaml", ".yml")):
                continue
            try:
                doc = yaml.safe_load((self.files.read(p, MAX_YAML_BYTES) or b"").decode("utf-8"))
            except (ValidationError, UnicodeDecodeError, yaml.YAMLError) as exc:
                self.add("error", p, f"Not readable: {exc}")
                continue
            if not isinstance(doc, dict) or not doc.get("manufacturer") or not doc.get("model"):
                self.add("error", p, "Needs manufacturer and model.")
                continue
            yamls[p] = doc
        self.accessory_parts()
        for p in sorted(self.kits):
            self.kit(p, self.kits[p])
        for p in sorted(self.rack_types):
            self.rack_type(p, self.rack_types[p])
        self.manifest(yamls)
        module_parts = {str(d.get("part_number") or d.get("model"))
                        for p, d in yamls.items() if p.startswith("module-types/")}
        for p in sorted(yamls, key=lambda n: (not n.startswith("module-types/"), n)):
            kind = "module-type" if p.startswith("module-types/") else "device-type"
            self.part(kind, p, yamls[p], module_parts)
        for p in self.names:
            ext = p.lower().rsplit(".", 1)[-1]
            if ext == "glb" and p not in self.referenced:
                self.glb(p)
                self.add("warning", p, "No YAML names this model.")
            elif ext in ("webp", "png") and p not in self.referenced:
                self.image(p)
                self.add("warning", p, "No YAML names this image.")
        return self.report


def _transparent(data: bytes) -> bool:
    """Has the image an alpha channel with at least one see-through pixel."""
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data))
        if "A" not in img.getbands() and "transparency" not in img.info:
            return False
        alpha = img.convert("RGBA").getchannel("A")
        return alpha.getextrema()[0] < 255
    except Exception:  # noqa: BLE001
        return False


def check_pack(files: PackFiles, *, tenant=None, known_parts=()) -> CheckReport:
    """Check a whole pack. ``tenant`` lets a render's module part numbers be
    found among the tenant's module types too; ``known_parts``, among the
    module types of the other packs in its bundle."""
    return _Checker(files, tenant, known_parts).run()


#: A pack id (pack.yaml ``id``, a bundle's pack folder): lower case, digits,
#: ``.``, ``_`` and ``-``.
PACK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")


def read_requires(meta: dict) -> tuple[list[str], str]:
    """``requires:`` of a pack.yaml: the pack ids it needs, and what was
    wrong with the list (empty when nothing)."""
    raw = meta.get("requires")
    if raw in (None, "", []):
        return [], ""
    if not isinstance(raw, list):
        return [], "requires: not a list of pack ids - ignored."
    out, bad = [], []
    for x in raw:
        v = str(x).strip() if isinstance(x, str | int) else ""
        if PACK_ID_RE.match(v) and v != str(meta.get("id") or ""):
            if v not in out:
                out.append(v)
        else:
            bad.append(str(x)[:40])
    return out, (f"requires: {', '.join(bad[:3])} not a pack id - ignored." if bad else "")


def check_source(source, *, tenant=None) -> CheckReport:
    """Check a pack folder or zip by path; a refused archive comes back as
    a report of its refusals."""
    import zipfile

    from .model_pack import PackRefused

    try:
        files = PackFiles(source)
    except PackRefused as exc:
        rep = CheckReport()
        rep.findings = [Finding("error", m.split(":", 1)[0], m) for m in exc.messages]
        return rep
    except zipfile.BadZipFile:
        return CheckReport(findings=[Finding("error", str(source), "Not a zip file.")])
    try:
        return check_pack(files, tenant=tenant)
    finally:
        files.close()


def _ref_size(fields: dict) -> tuple[int, int]:
    """A kit's reference width and depth (its first listed sizes, mm)."""
    return ((fields.get("widths_mm") or [600])[0], (fields.get("depths_mm") or [1000])[0])
