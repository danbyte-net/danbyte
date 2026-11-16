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
      renders:                                # device types: faces rendered in Blender
        front: models/Cisco/C9500-48Y4C.front.webp
        rear: models/Cisco/C9500-48Y4C.rear.webp
        iso: models/Cisco/C9500-48Y4C.iso.webp
        model_sha256: <sha256 of the .glb>
        modules: { PS-0: C9K-PWR-650WAC-R }   # bay -> module part number shown

``apply_model3d`` sets it on a type: each file is checked like an upload
(api.model_3d.validate_glb), scanned for anchors (api.model_anchors) and
stored as the type's model. A lone YAML (no pack around it) has nowhere to
read the files from, so the block is skipped with a note.

``apply_renders`` stores a device type's ``renders`` as its face photos
(api.model_studio: source ``pack``), sets its reference modules from
``modules`` and places the ports and LEDs on them (api.model_projection).

``import_pack`` imports a whole pack: it matches each YAML to an existing
type by manufacturer and part number, creates the ones that are missing
(api.devicetype_import) and sets their models. ``manage.py
import_model_pack`` and the in-app installer (api.model_pack_install) drive
it.

``PackFiles`` refuses an unsafe zip outright (``zip_refusals``: paths out
of the pack, links, odd or encrypted entries, file types a pack doesn't
hold, members over their cap, zip bombs). Nothing is extracted to disk.
"""
from __future__ import annotations

import io
import math
import os
import posixpath
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from django.core.exceptions import ValidationError

from .led_state import SOURCES, validate_bindings
from .model_anchors import EMPTY_MODES

#: What a ``leds:`` entry may take its state from (api.led_state).
LED_SOURCES = SOURCES
#: YAML files a pack may hold at most, and each one's size.
MAX_YAML_FILES = 2000
MAX_YAML_BYTES = 2 * 1024 * 1024
#: The faces a device type's ``renders`` may ship.
RENDER_FACES = ("front", "rear", "iso")


#: The only files a pack may hold (lower-cased suffix). Nothing in a pack is
#: ever executed or extracted to disk: members are read into memory, checked
#: and stored through the model and image validators.
PACK_EXTENSIONS = (".yaml", ".yml", ".glb", ".webp", ".png", ".md")
#: Archive ceilings against zip bombs: members, their unpacked total, and how
#: far one member may inflate past its compressed size.
MAX_PACK_FILES = 5000
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_RATIO = 200
MAX_MD_BYTES = 1024 * 1024
#: Junk an archiver or a file manager adds; never read, so not refused.
_JUNK = ("__MACOSX/",)


class PackRefused(ValidationError):
    """The archive is refused as a whole; ``messages`` say why."""


def _ignored(rel: str) -> bool:
    """A hidden file or folder (``.DS_Store``, ``.git/``) or archiver junk:
    never read, so neither listed nor refused."""
    return rel.startswith(_JUNK) or any(part.startswith(".") for part in rel.split("/"))


def member_cap(rel: str) -> int:
    """The largest a pack file of this kind may be."""
    from . import model_3d
    from .model_studio import MAX_IMAGE_BYTES

    ext = posixpath.splitext(rel)[1].lower()
    if ext == ".glb":
        return model_3d.max_bytes()
    if ext in (".webp", ".png"):
        return MAX_IMAGE_BYTES
    if ext in (".yaml", ".yml"):
        return MAX_YAML_BYTES
    return MAX_MD_BYTES


def zip_refusals(zf: zipfile.ZipFile) -> list[str]:
    """Why a zip can't be read as a pack: a member that leaves the pack
    (absolute, ``..``, a drive, a backslash), a link or device file, an
    encrypted or duplicate member, a file type a pack doesn't hold, a
    member over its size cap or inflating too far, or too many members or
    unpacked bytes in all. Empty when the zip is fine."""
    import stat

    out: list[str] = []
    infos = zf.infolist()
    if len(infos) > MAX_PACK_FILES:
        return [f"The archive holds {len(infos)} entries; a pack may hold {MAX_PACK_FILES}."]
    seen: set[str] = set()
    total = 0
    for info in infos:
        name = info.filename
        if "\x00" in name:
            out.append("An entry's name holds a NUL byte.")
            continue
        mode = (info.external_attr >> 16) & 0o170000
        if mode == stat.S_IFLNK:
            out.append(f"{name}: a symbolic link.")
            continue
        if mode not in (0, stat.S_IFREG, stat.S_IFDIR):
            out.append(f"{name}: not a regular file.")
            continue
        raw = name.rstrip("/") if info.is_dir() else name
        rel = _clean_path(raw)
        if rel is None or rel != raw or "//" in name:
            out.append(f"{name}: the path leaves the pack.")
            continue
        if info.is_dir() or _ignored(rel):
            continue
        if info.flag_bits & 0x1:
            out.append(f"{name}: encrypted.")
            continue
        if rel in seen:
            out.append(f"{name}: in the archive twice.")
            continue
        seen.add(rel)
        if not rel.lower().endswith(PACK_EXTENSIONS):
            out.append(f"{name}: not a file a pack holds ({', '.join(PACK_EXTENSIONS)}).")
            continue
        cap = member_cap(rel)
        if info.file_size > cap:
            out.append(f"{name}: {info.file_size} bytes, over the {cap} a "
                       f"{posixpath.splitext(rel)[1].lower()} may be.")
            continue
        if info.file_size > 1024 * 1024 and info.file_size > MAX_RATIO * max(
                info.compress_size, 1):
            out.append(f"{name}: inflates more than {MAX_RATIO} times.")
            continue
        total += info.file_size
    if total > MAX_UNPACKED_BYTES:
        out.append(f"The archive unpacks to {total} bytes; a pack may unpack to "
                   f"{MAX_UNPACKED_BYTES}.")
    return out


def folder_refusals(root: Path) -> list[str]:
    """The same for a pack folder: links and other non-files, file types a
    pack doesn't hold, and files over their cap."""
    out: list[str] = []
    root = root.resolve()
    count = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        for d in list(dirnames):
            p = here / d
            rel = p.relative_to(root).as_posix()
            if _ignored(rel):
                dirnames.remove(d)
            elif p.is_symlink():
                out.append(f"{rel}: a symbolic link.")
                dirnames.remove(d)
        for f in filenames:
            p = here / f
            rel = p.relative_to(root).as_posix()
            if _ignored(rel):
                continue
            count += 1
            if p.is_symlink():
                out.append(f"{rel}: a symbolic link.")
            elif not p.is_file():
                out.append(f"{rel}: not a regular file.")
            elif not rel.lower().endswith(PACK_EXTENSIONS):
                out.append(f"{rel}: not a file a pack holds ({', '.join(PACK_EXTENSIONS)}).")
            elif p.stat().st_size > member_cap(rel):
                out.append(f"{rel}: over the size cap for its kind.")
    if count > MAX_PACK_FILES:
        out.append(f"The folder holds {count} files; a pack may hold {MAX_PACK_FILES}.")
    return out


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
        """Raises :class:`PackRefused` for a zip :func:`zip_refusals`
        refuses, and ``zipfile.BadZipFile`` for one that isn't a zip."""
        self.source = Path(source)
        self._zip = None
        self._prefix = ""
        if self.source.is_file():
            self._zip = zipfile.ZipFile(self.source)
            refusals = zip_refusals(self._zip)
            if refusals:
                self._zip.close()
                raise PackRefused(refusals)
            names = [n for n in self._zip.namelist()
                     if not n.endswith("/") and not _ignored(n)]
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
                          if n.startswith(self._prefix) and not n.endswith("/")
                          and not _ignored(n[len(self._prefix):]))
        root = self.source.resolve()
        out = []
        for p in root.rglob("*"):
            if p.is_file() and not p.is_symlink():
                rel = p.relative_to(root).as_posix()
                if not _ignored(rel):
                    out.append(rel)
        return sorted(out)

    def sizes(self) -> dict[str, int]:
        """Each file's size in bytes, by pack-relative path."""
        if self._zip is not None:
            return {n[len(self._prefix):]: i.file_size for i in self._zip.infolist()
                    if (n := i.filename).startswith(self._prefix) and not n.endswith("/")
                    and not _ignored(n[len(self._prefix):])}
        root = self.source.resolve()
        return {rel: (root / rel).stat().st_size for rel in self.names()}

    def refusals(self) -> list[str]:
        """Why the pack can't be read safely (a zip that got this far has
        none; a folder is walked)."""
        if self._zip is not None:
            return []
        return folder_refusals(self.source)

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
    out = [str(block[k]) for k in ("file", "far") if isinstance(block.get(k), str)]
    renders = block.get("renders")
    if isinstance(renders, dict):
        out += [str(renders[k]) for k in RENDER_FACES if isinstance(renders.get(k), str)]
    return out


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
    leds, led_notes = validate_bindings(block.get("leds"))
    notes += [f"model3d.{n}" for n in led_notes]
    known = set(anchors.get("leds") or {})
    for key in leds:
        if not any(c in key for c in "*?[") and key not in known:
            notes.append(f"model3d.leds.{key}: the model has no led:{key}.")
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


# ── faces rendered in Blender ───────────────────────────────────────────────

def _half_up(v: float) -> int:
    return int(math.floor(v + 0.5))


def face_px(frame) -> tuple[int, int] | None:
    """The front and rear render's exact size for a face frame (mm):
    2000 px across, the height at the frame's aspect (the export spec,
    §12). None without a frame height."""
    from .model_projection import table

    w, h = frame
    if not w or not h:
        return None
    px = table()["face_width_px"]
    return px, max(1, _half_up(px * h / w))


def _render_image(files, path, face, expect, notes):
    """``(bytes, ext)`` of a render that passes the checks, else None with
    a note."""
    from PIL import Image

    from .model_studio import IMAGE_FORMATS, MAX_IMAGE_BYTES

    try:
        data = files.read(path, MAX_IMAGE_BYTES)
    except ValidationError as exc:
        notes.append(f"renders.{face}: {' '.join(exc.messages)} - skipped.")
        return None
    if data is None:
        notes.append(f"renders.{face}: {path} is not in the pack - skipped.")
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img.verify()
        fmt = (img.format or "").upper()
        size = tuple(img.size)
    except Exception:  # noqa: BLE001 - not an image
        notes.append(f"renders.{face}: {path} is not an image - skipped.")
        return None
    if fmt not in IMAGE_FORMATS:
        notes.append(f"renders.{face}: {path} is not a WebP or PNG - skipped.")
        return None
    if expect is not None and size != tuple(expect):
        notes.append(f"renders.{face}: {path} is {size[0]} × {size[1]} px; the type's face "
                     f"frame needs {expect[0]} × {expect[1]} - skipped.")
        return None
    return data, fmt.lower()


def _map_modules(dt, modules, notes) -> tuple[dict, dict]:
    """``renders.modules`` (bay → part number) as ``({bay: module type},
    {bay: part number})``: the tenant's module types with a 3D model, the
    chassis' manufacturer first when a part number is shared."""
    from .models import ModuleType

    if modules in (None, "", {}):
        return {}, {}
    if not isinstance(modules, dict):
        notes.append("renders.modules: not a mapping - ignored.")
        return {}, {}
    bays = set(dt.module_bay_templates.values_list("name", flat=True))
    anchored = set(((dt.model_anchors or {}).get("bays") or {}).keys())
    found, parts = {}, {}
    for bay, pn in modules.items():
        bay, pn = str(bay), str(pn or "").strip()
        if not pn:
            continue
        parts[bay] = pn
        if bay not in bays:
            notes.append(f"renders.modules.{bay}: no module bay of this name.")
            continue
        if anchored and bay not in anchored:
            notes.append(f"renders.modules.{bay}: the model has no bay:{bay}.")
            continue
        hits = list(ModuleType.objects.filter(tenant_id=dt.tenant_id, part_number=pn)[:20])
        if len(hits) > 1:
            own = [m for m in hits if m.manufacturer_id == dt.manufacturer_id]
            hits = own or hits
        if not hits:
            notes.append(f"renders.modules.{bay}: no module type {pn}.")
        elif len(hits) > 1:
            notes.append(f"renders.modules.{bay}: more than one module type {pn} - ignored.")
        elif not hits[0].model_3d:
            notes.append(f"renders.modules.{bay}: {hits[0].name} has no 3D model.")
        else:
            found[bay] = hits[0]
    return found, parts


def _set_reference(dt, renders, found, notes):
    """Set ``model_reference`` from the renders' modules - unless someone
    changed it since the last pack import set it. Returns the reference the
    pack now owns (or None)."""
    from rest_framework.exceptions import ValidationError as DRFValidationError

    from .model_studio import validate_reference

    meta = dt.pack_import if isinstance(dt.pack_import, dict) else {}
    prev = meta.get("reference") or None
    cur = dt.model_reference or None
    if "modules" not in renders:
        return prev if cur == prev else None
    ref = {bay: str(mt.id) for bay, mt in found.items()} or None
    if cur is not None and cur != prev:
        if cur != ref:
            notes.append("reference modules: set by hand - kept; the renders show "
                         "other modules, so they read as out of date.")
        return None
    try:
        value = validate_reference(dt, ref)
    except DRFValidationError as exc:
        notes.append(f"renders.modules: {exc.detail} - the reference is unchanged.")
        return prev if cur == prev else None
    dt.model_reference = value
    if value != cur:
        notes.append(f"reference modules: {len(value or {})} set from the pack.")
    return value


def _place_ports(dt, found, made, frame, replace_photos, notes):
    """Project the ports and LEDs onto pack faces (api.model_projection)
    with the modules the renders show; updates ``made``."""
    from .face_ports import validate_image_ports_doc
    from .model_projection import ProjectionUnavailable, project_type
    from .model_studio import PACK, _has_markers, validate_image_leds
    from .natural import natural_key

    rows = [{"name": b.name, "position": b.position, "type": found.get(b.name)}
            for b in sorted(dt.module_bay_templates.all(), key=lambda b: natural_key(b.name))]
    try:
        placed = project_type(dt, rows)
    except ProjectionUnavailable:
        notes.append("ports: the projection table isn't deployed - the type's next "
                     "browser render places the ports and LEDs.")
        return
    notes += placed["notes"]

    def ours(doc) -> bool:
        return all(made.get(s) == PACK for s in ("front", "rear") if doc.get(s))

    ports = placed["image_ports"]
    if ports is not None and ours(ports):
        if _has_markers(dt.image_ports) and "image_ports" not in made and not replace_photos:
            notes.append("ports: kept the port markers placed by hand "
                         "(--replace-photos replaces them).")
        else:
            cal = {"left": 0, "right": 1, "span_mm": round(frame[0], 1), "rail": None}
            dt.image_ports = validate_image_ports_doc(
                {**ports, "view": {"front": {"cal": cal}, "rear": {"cal": cal}}})
            made["image_ports"] = PACK
            notes.append(f"ports: {len(ports['front']) + len(ports['rear'])} placed "
                         "on the renders.")
    leds = placed["image_leds"]
    if leds is not None and ours(leds):
        dt.image_leds = validate_image_leds(leds)
        made["image_leds"] = PACK
        notes.append(f"LEDs: {len(leds['front']) + len(leds['rear'])} placed on the renders.")
    elif leds is None and "image_leds" in made:
        # An earlier render's LEDs don't stand on these faces.
        dt.image_leds = None
        made.pop("image_leds")


def apply_renders(dt, block, files: PackFiles, *, pack_name: str = "", pack_version: str = "",
                  dry_run: bool = False, replace_photos: bool = False) -> list[str]:
    """Store a device type's Blender renders (``model3d.renders``) as its
    face photos; the notes for the import report.

    * each file must be in the pack and a WebP or PNG; front and rear must
      be exactly the type's face frame at 2000 px across, else skipped;
    * ``model_sha256`` must be the pack's ``.glb``: otherwise the renders are
      imported but marked out of date;
    * ``modules`` sets the type's ``model_reference`` - unless someone set it
      by hand since (it differs from what the last pack import set);
    * a face uploaded by hand is replaced only with ``replace_photos``; a
      pack or browser render is replaced;
    * the ports and LEDs are projected onto the faces from the stored
      anchors (api.model_projection).
    """
    import hashlib
    import uuid

    from django.core.files.base import ContentFile

    from . import model_3d
    from .face_ports import drop_calibration
    from .images import downscale_image
    from .model_studio import PACK, frame_mm, generated

    renders = block.get("renders") if isinstance(block, dict) else None
    if renders in (None, "", {}):
        return []
    if not isinstance(renders, dict):
        return ["renders: not a mapping - skipped."]
    if not dry_run and not dt.model_3d:
        return ["renders: the type has no 3D model - skipped."]
    notes: list[str] = []

    # The model the renders were made from.
    try:
        glb = files.read(block.get("file"), model_3d.max_bytes())
    except ValidationError:
        glb = None
    actual = hashlib.sha256(glb).hexdigest() if glb else ""
    raw = renders.get("model_sha256")
    # An unquoted all-digit hash reads as a YAML number; compare its digits.
    claimed = raw.strip().lower() if isinstance(raw, str) else ""
    if raw is not None and not isinstance(raw, str):
        claimed = str(raw)
    stale = not claimed or claimed != actual
    note = ""
    if not claimed:
        note = "The pack gives no model_sha256 for its renders."
    elif stale:
        note = "The renders were made from another model file than the pack ships."
    if note:
        notes.append(f"renders: {note} Imported, marked out of date.")

    frame = frame_mm(dt)
    expect = face_px(frame)
    images: dict[str, tuple[bytes, str]] = {}
    for face in RENDER_FACES:
        path = renders.get(face)
        if path in (None, ""):
            continue
        if face != "iso" and expect is None:
            notes.append(f"renders.{face}: the type has no rack units or height to check "
                         "the frame against - skipped.")
            continue
        got = _render_image(files, str(path), face, None if face == "iso" else expect, notes)
        if got is not None:
            images[face] = got

    found, parts = _map_modules(dt, renders.get("modules"), notes)
    reference = _set_reference(dt, renders, found, notes)

    made = dict(generated(dt))
    written, kept = [], []
    for face, (data, ext) in images.items():
        field = getattr(dt, f"{face}_image")
        if field and face not in made and not replace_photos:
            kept.append(face)
            continue
        written.append(face)
        if dry_run:
            continue
        if field and face in made:
            # A render of ours: nothing else points at the file.
            field.delete(save=False)
        img = downscale_image(ContentFile(data, name=f"{face}.{ext}"))
        getattr(dt, f"{face}_image").save(f"{face}-{uuid.uuid4().hex[:10]}.{ext}", img,
                                          save=False)
        if face != "iso":
            dt.image_ports = drop_calibration(dt.image_ports, face)
        made[face] = PACK
    if kept:
        notes.append(f"renders: kept the {', '.join(kept)} photo{'s' if len(kept) > 1 else ''} "
                     "uploaded by hand (--replace-photos replaces them).")
    if written:
        notes.append(f"renders: {', '.join(written)} imported.")
    if dry_run:
        return notes
    older = [f for f in RENDER_FACES if f not in written and made.get(f) == PACK]
    if older and written:
        stale = True
        note = f"{note} The {', '.join(older)} render is from an earlier import.".strip()
    if any(made.get(f) == PACK for f in ("front", "rear")):
        _place_ports(dt, found, made, frame, replace_photos, notes)

    record = {"pack": {"name": pack_name, "version": pack_version}}
    if reference:
        record["reference"] = reference
    if any(made.get(f) == PACK for f in RENDER_FACES):
        record["images"] = {
            "model_sha256": claimed, "model_version": model_3d.version_of(dt.model_3d),
            "frame_mm": frame, "modules": parts, "stale": stale, "note": note,
        }
    dt.pack_import = record
    dt.images_generated = made or None
    dt.save()
    return notes


# ── whole packs ─────────────────────────────────────────────────────────────

@dataclass
class TypeResult:
    kind: str           # "device-type" | "module-type"
    path: str
    name: str = ""
    action: str = ""    # "matched" | "created" | "error"
    notes: list[str] = field(default_factory=list)
    id: str = ""        # the matched or created type (applied runs)


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


def import_pack(tenant, files: PackFiles, *, dry_run: bool = True,
                replace_photos: bool = False, label: str = "",
                progress=None) -> PackResult:
    """Import every device type and module type YAML in the pack with its
    models and renders. Inside one transaction, rolled back on ``dry_run``
    (which also stores no file). Audited as ordinary saves, with ``label``
    (default: the command and the pack) as the cause. ``replace_photos``
    lets renders replace faces uploaded by hand. ``progress(done, total)``
    is called after each YAML."""
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
    if not label:
        label = f"manage.py import_model_pack {result.name or files.source.name}"
        if result.version:
            label += f" {result.version}"
    with cause(label), transaction.atomic():
        for done, path in enumerate(yamls):
            if progress is not None:
                progress(done, len(yamls))
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
                if not dry_run:
                    tr.id = str(obj.pk)
                tr.notes += apply_model3d(obj, block, files, dry_run=dry_run) or [
                    "no model3d block."]
                if kind == "device-type":
                    tr.notes += apply_renders(
                        obj, block, files, pack_name=result.name, pack_version=result.version,
                        dry_run=dry_run, replace_photos=replace_photos)
                # Rack-face images render in a browser (api.model_studio):
                # the type's page offers them to its next editor.
                if kind == "device-type" and not dry_run:
                    from .model_studio import pending

                    if pending(obj):
                        tr.notes.append("images: pending - the type's page offers "
                                        "to generate them.")
        if dry_run:
            transaction.set_rollback(True)
    if progress is not None:
        progress(len(yamls), len(yamls))
    result.unused_models = [n for n in names
                            if n.startswith("models/") and n.endswith(".glb")
                            and n not in referenced]
    return result
