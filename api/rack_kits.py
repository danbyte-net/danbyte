"""Rack kits and rack types from model packs (docs/dcim/model-packs.md →
Rack kits, the export spec §14).

A pack may carry **rack kits** - one style of rack as a kit of named
parts, which the 3D room assembles to each rack's own height, width and
depth::

    rack-kits/<Vendor>/<NAME>/kit.yaml
    models/<Vendor>/<NAME>.kit.glb      # every part, as named objects
    models/<Vendor>/<NAME>.far.glb      # one box for far off

and **rack types** with their Look (``rack-types/<Vendor>/*.yaml``, a
NetBox rack-type file plus ``rail_depth_mm`` and a ``look:`` block whose
``kit`` names a kit by name).

``apply_kit`` imports a kit into the tenant's ``RackKit`` rows (matched by
vendor and name), ``apply_rack_type`` a rack type into ``RackType`` (matched
by name; created through api.devicetype_import.import_racktype_yaml). Both
are called by api.model_pack.import_pack; api.model_pack_check reviews them.

``kit_doc`` is a kit as the 3D room reads it: its model URLs and parts.
Permissions are the rack type grant: a reader who may view rack types gets
the kit's own URL (one download for a whole room); anyone else reads it
through the rack (``/api/racks/<id>/kit-model/``).
"""
from __future__ import annotations

import posixpath
import re

from django.core.exceptions import ValidationError

from .rack_look import (
    BASE_CHOICES,
    COLOURS,
    DOOR_CHOICES,
    FRAME_CHOICES,
    HINGE_CHOICES,
    TOP_CHOICES,
    clean_colour,
)

KIT_DIR = "rack-kits/"
RACK_TYPE_DIR = "rack-types/"
KIT_FILE = "kit.yaml"
FRAMES = tuple(v for v, _ in FRAME_CHOICES)
#: The export spec's budgets (§14): the kit's unique parts, and the far box.
KIT_TRIANGLES = 20_000
FAR_TRIANGLES = 2_000
#: The reference length a stretched part is modelled at (mm).
REF_MM = 1000
NAME_MAX = 100

#: The part names the room reads (§14). ``post:segment`` is the one every
#: kit needs; the rest are used when the rack's Look asks for them. Doors
#: and side panels may come split (v1.15): ``door:<kind>:stile`` / ``:rail``
#: / ``:infill`` and ``side:panel:edge`` / ``:infill``, the whole leaf kept
#: as the fallback.
_DOOR_KINDS = ("perforated", "glass", "solid")
PARTS = (
    "post:segment", "post:top", "post:bottom", "beam:width", "beam:depth",
    "corner:top", "corner:bottom", "top:vented", "top:solid", "top:fans", "top:brush",
    "base:plinth", "base:casters", "base:feet", "base:plate", "base:panel", "side:panel",
    "side:panel:edge", "side:panel:infill",
    *(f"door:{k}" for k in _DOOR_KINDS),
    *(f"door:{k}:{p}" for k in _DOOR_KINDS for p in ("stile", "rail", "infill")),
    "door:handle", "door:hinge", "door:lock", "label:u", "wall:bracket", "pdu:bracket",
)
#: 0U channels (§14 v1.13): ``channel:0u:<left|right>:<front|rear>``, where
#: the room seats a rack's side-mounted 0U devices.
CHANNEL = re.compile(r"^channel:0u:(left|right):(front|rear)$")
#: Names the spec defines that the room does not draw yet (pathways, cable
#: entries, brush strips): known, so not noted as unknown.
KNOWN_PREFIXES = ("path:", "entry:", "brush:", "channel:0u:")
REQUIRED = ("post:segment",)
DOORS = ("door:perforated", "door:glass", "door:solid")
_STRETCH = re.compile(r"^[xyz]{1,3}$")
_SUFFIX = re.compile(r"\.\d{3}$")


def part_name(node_name: str) -> str:
    """A node's part name: Blender's ``.001`` suffix dropped."""
    return _SUFFIX.sub("", node_name or "")


def vendor_name(path: str) -> tuple[str, str]:
    """``rack-kits/<Vendor>/<NAME>/kit.yaml`` → ``(Vendor, NAME)``."""
    parts = path.split("/")
    if len(parts) == 4:
        return parts[1], parts[2]
    if len(parts) == 3:
        return "", parts[1]
    return "", ""


def is_kit_yaml(path: str) -> bool:
    return path.startswith(KIT_DIR) and posixpath.basename(path) == KIT_FILE


def _mm_list(raw, key: str, notes: list[str]) -> list[int]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        notes.append(f"{key}: not a list - ignored.")
        return []
    out = []
    for v in raw[:16]:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 100 <= v <= 3000:
            notes.append(f"{key}: {v!r} is not a size in mm - ignored.")
        elif round(v) not in out:
            out.append(round(v))
    return out


def read_kit(path: str, data) -> tuple[dict | None, list[str]]:
    """The fields of a ``kit.yaml`` - ``{vendor, name, frame, widths_mm,
    depths_mm, colours, file, far}`` - or None and why not."""
    from .model_pack import _clean_path

    if not isinstance(data, dict):
        return None, ["Not a mapping."]
    vendor, folder = vendor_name(path)
    name = str(data.get("name") or folder or "").strip()
    if not name:
        return None, ["Needs a name."]
    if len(name) > NAME_MAX:
        return None, [f"The name is longer than {NAME_MAX} characters."]
    notes: list[str] = []
    if folder and name != folder:
        notes.append(f"name: {name} differs from its folder {folder}.")
    frame = str(data.get("frame") or "").strip().lower()
    if frame not in FRAMES:
        return None, [f"frame: {data.get('frame')!r} is not one of {', '.join(FRAMES)}."]
    block = data.get("model3d")
    rel = _clean_path(block.get("file")) if isinstance(block, dict) else None
    if rel is None:
        return None, ["model3d.file: missing or leaves the pack."]
    far = _clean_path(block.get("far")) if block.get("far") else None
    if block.get("far") and far is None:
        notes.append("model3d.far: leaves the pack - ignored.")
    colours: dict[str, str] = {}
    raw = data.get("colours")
    if raw is not None and not isinstance(raw, dict):
        notes.append("colours: not a mapping - ignored.")
        raw = {}
    for k, v in (raw or {}).items():
        try:
            hexv = clean_colour(v)
        except ValueError:
            notes.append(f"colours.{k}: {v!r} is not a hex colour - ignored.")
            continue
        colours[str(k)[:16]] = COLOURS.get(hexv, hexv)
    return {"vendor": vendor[:100], "name": name, "frame": frame,
            "widths_mm": _mm_list(data.get("widths_mm"), "widths_mm", notes),
            "depths_mm": _mm_list(data.get("depths_mm"), "depths_mm", notes),
            "colours": colours, "file": rel, "far": far}, notes


def scan_parts(doc: dict) -> tuple[dict, list[str]]:
    """The kit's parts by name - ``{name: {stretch, ref_mm, hinge}}`` - and
    what is wrong with them: a missing ``post:segment``, a stretched part
    without its reference length, a door without its ``hinge`` empty.
    Unknown names are noted (a later release may read them)."""
    from .model_anchors import _world

    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    world = _world(doc)
    parts: dict[str, dict] = {}
    notes: list[str] = []
    unknown: set[str] = set()
    seen: dict[str, int] = {}
    for i in world:
        node = nodes[i]
        raw = part_name(str(node.get("name") or ""))
        extras = node.get("extras") if isinstance(node.get("extras"), dict) else {}
        if CHANNEL.match(raw):
            if raw not in parts:
                parts[raw] = _channel(world[i], extras)
            continue
        if raw not in PARTS:
            if ":" in raw and raw not in ("hinge", "rail") and not raw.startswith(
                    KNOWN_PREFIXES):
                unknown.add(raw)
            continue
        if raw in parts:
            continue
        seen[raw] = i
        stretch = str(extras.get("danbyte_stretch") or "").strip().lower()
        if stretch and not _STRETCH.match(stretch):
            notes.append(f"{raw}: danbyte_stretch {stretch!r} is not x, y, z or a mix.")
            stretch = ""
        ref = extras.get("danbyte_ref_mm")
        if stretch and ref is None:
            notes.append(f"{raw}: stretched along {stretch} without danbyte_ref_mm; "
                         f"{REF_MM} is used.")
        if ref is not None and (isinstance(ref, bool) or not isinstance(ref, (int, float))
                                or ref <= 0):
            notes.append(f"{raw}: danbyte_ref_mm {ref!r} is not a length.")
            ref = None
        children = [c for c in node.get("children") or [] if isinstance(c, int)
                    and 0 <= c < len(nodes)]
        hinge = any(part_name(str(nodes[c].get("name") or "")) == "hinge" for c in children)
        parts[raw] = {"stretch": "".join(sorted(set(stretch))),
                      "ref_mm": float(ref) if ref else (REF_MM if stretch else None),
                      "hinge": hinge}
        if raw in DOORS and not hinge:
            notes.append(f"{raw}: no hinge empty; the door swings on its edge.")
    for r in REQUIRED:
        if r not in parts:
            notes.append(f"no {r}; the kit can't build a rack.")
    fit = kit_fit(doc, world, seen)
    if fit is not None:
        parts["post:segment"]["fit"] = fit
    for u in sorted(unknown):
        notes.append(f"{u}: not a part Danbyte reads - ignored.")
    return dict(sorted(parts.items())), notes


#: The EIA-310 unit (m).
U_M = 0.04445
#: Parts that are not the frame's own outline: doors open, a strip or a
#: bracket sits inside it.
_NOT_FRAME = ("door:", "label:", "pdu:")


def kit_fit(doc: dict, world: dict, nodes: dict[str, int]) -> dict | None:
    """Where the kit's reference rack has its units and rails, so the room
    stands a kit-built rack's gear where the kit's posts are: ``u1_mm`` the
    bottom of unit 1 above the floor, ``rail_inset_mm`` the front rail's
    face behind the rack's front (the front-most frame part, or the glTF
    z = 0 plane of §14), ``cap_mm`` the frame above the top unit, ``ref_u``
    the reference rack's units, and ``post_outer_mm`` / ``post_depth_mm`` the
    post's outer side from the centre and its depth behind the rail face.
    None without a ``post:segment``."""
    from .model_anchors import subtree_box

    seg = nodes.get("post:segment")
    if seg is None or seg not in world:
        return None
    m = world[seg]
    u1, rail_z = m[1][3], m[2][3]
    front = 0.0
    top = None
    roofs = []
    for name, i in nodes.items():
        if name.startswith(_NOT_FRAME) or i not in world:
            continue
        box = subtree_box(doc, i, world)
        if box is None:
            continue
        lo, hi = box
        front = max(front, hi[2])
        if name.startswith("top:"):
            roofs.append(hi[1])
            continue
        stretch = ""
        extras = (doc.get("nodes") or [])[i].get("extras")
        if isinstance(extras, dict):
            stretch = str(extras.get("danbyte_stretch") or "").lower()
        if "z" not in stretch:
            top = hi[1] if top is None else max(top, hi[1])
    if roofs:
        top = max(top or 0.0, min(roofs))
    post_top = nodes.get("post:top")
    ends = subtree_box(doc, post_top, world) if post_top in world else None
    span = (ends[0][1] if ends else (top or u1)) - u1
    ref_u = max(1, round(span / U_M))
    cap = (top - (u1 + ref_u * U_M)) if top is not None else 0.0
    out = {"u1_mm": round(u1 * 1000, 1), "rail_inset_mm": round((front - rail_z) * 1000, 1),
           "cap_mm": round(max(cap, 0.0) * 1000, 1), "ref_u": ref_u}
    post = subtree_box(doc, seg, world)
    if post is not None:
        # The post's outer side (|x|) and its depth behind the rail face.
        out["post_outer_mm"] = round(max(abs(post[0][0]), abs(post[1][0])) * 1000, 1)
        out["post_depth_mm"] = round((rail_z - post[0][2]) * 1000, 1)
    return out


def _channel(m, extras: dict) -> dict:
    """A 0U channel empty as the room seats a device on it: ``at`` its lower
    end and ``out`` the way its devices face (its local +Z, level), both in
    the kit's glTF frame (m), with the empty's ``danbyte_depth`` (mm from the
    front rail) and ``danbyte_len_u`` when given."""
    def num(v):
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    out = {"stretch": "", "ref_mm": None, "hinge": False,
           "at": [round(m[0][3], 4), round(m[1][3], 4), round(m[2][3], 4)],
           "out": [round(m[0][2], 4) + 0.0, round(m[2][2], 4) + 0.0]}
    if num(extras.get("danbyte_depth")) is not None:
        out["depth_mm"] = round(num(extras["danbyte_depth"]), 1)
    if num(extras.get("danbyte_len_u")) is not None:
        out["len_u"] = round(num(extras["danbyte_len_u"]))
    return out


def kit_errors(notes: list[str]) -> list[str]:
    """The scan notes that stop a kit from working."""
    return [n for n in notes if "can't build" in n]


def apply_kit(tenant, path: str, data, files, *, dry_run: bool = False,
              pack_name: str = "", pack_version: str = ""):
    """Import one ``kit.yaml``: ``(action, name, id, notes)``, action
    ``created`` / ``matched`` / ``error``."""
    from . import model_3d
    from .model_pack_check import triangles
    from .models import RackKit

    fields, notes = read_kit(path, data)
    if fields is None:
        return "error", "", "", notes
    name = fields["name"]
    blobs = {}
    for key in ("file", "far"):
        rel = fields[key]
        if rel is None:
            continue
        try:
            blob = files.read(rel, model_3d.max_bytes())
        except ValidationError as exc:
            return "error", name, "", [*notes, f"model3d.{key}: {' '.join(exc.messages)}"]
        if blob is None:
            return "error", name, "", [*notes, f"model3d.{key}: {rel} is not in the pack."]
        try:
            doc = model_3d.validate_glb(blob)
        except ValidationError as exc:
            return "error", name, "", [*notes, f"model3d.{key}: {' '.join(exc.messages)}"]
        blobs[key] = (blob, doc)
    parts, scan_notes = scan_parts(blobs["file"][1])
    if kit_errors(scan_notes):
        return "error", name, "", [*notes, *scan_notes]
    notes += [f"model: {n}" for n in scan_notes]
    tri = triangles(blobs["file"][1])
    notes.append(f"model: {tri} triangles, {len(parts)} parts.")
    if tri > KIT_TRIANGLES:
        notes.append(f"model: over the {KIT_TRIANGLES:,}-triangle budget for a kit.")
    far_tri = triangles(blobs["far"][1]) if "far" in blobs else None
    if far_tri is not None and far_tri > FAR_TRIANGLES:
        notes.append(f"far: {far_tri} triangles, over the {FAR_TRIANGLES:,} budget.")
    obj = RackKit.objects.filter(tenant=tenant, vendor=fields["vendor"], name=name).first()
    action = "matched" if obj is not None else "created"
    if obj is None:
        obj = RackKit(tenant=tenant, vendor=fields["vendor"], name=name)
    for f in ("frame", "widths_mm", "depths_mm", "colours"):
        setattr(obj, f, fields[f])
    obj.parts = parts
    obj.pack_import = {"pack": {"name": pack_name, "version": pack_version},
                       "file": fields["file"], "far": fields["far"], "triangles": tri,
                       "far_triangles": far_tri}
    from .model_pack_update import keep_meta

    notes += keep_meta(obj, data, "rack kits")
    notes.append(f"{fields['frame']} kit.")
    if dry_run:
        return action, name, "", notes
    obj.save()
    model_3d.store(obj, blobs["file"][0])
    if "far" in blobs:
        model_3d.store(obj, blobs["far"][0], far=True)
    elif obj.model_3d_far:
        old = obj.model_3d_far
        obj.model_3d_far = None
        obj.save()
        old.storage.delete(old.name)
    return action, name, str(obj.pk), notes


# ── rack types ──────────────────────────────────────────────────────────────

_LOOK_CHOICES = {
    "front_door": DOOR_CHOICES, "rear_door": DOOR_CHOICES, "hinge": HINGE_CHOICES,
    "top": TOP_CHOICES, "base": BASE_CHOICES,
}
#: NetBox ``form_factor`` → frame.
FORM_FACTORS = {
    "2-post-frame": "2-post", "4-post-frame": "4-post", "4-post-cabinet": "cabinet",
    "wall-frame": "2-post", "wall-frame-vertical": "2-post",
    "wall-cabinet": "wall-cabinet", "wall-cabinet-vertical": "wall-cabinet",
}


def read_look(data: dict, notes: list[str]) -> dict:
    """The Look fields a rack-type YAML gives: its ``look:`` block, its
    ``frame`` or NetBox ``form_factor``, ``rail_depth_mm`` or NetBox
    ``mounting_depth``. ``kit`` stays a name (``kit_name``). A bad value is
    noted and left out."""
    out: dict = {}
    look = data.get("look")
    if look is not None and not isinstance(look, dict):
        notes.append("look: not a mapping - ignored.")
        look = {}
    look = dict(look or {})
    frame = look.pop("frame", None) or data.get("frame")
    if frame is None and data.get("form_factor"):
        frame = FORM_FACTORS.get(str(data["form_factor"]).strip().lower())
        if frame is None:
            notes.append(f"form_factor {data['form_factor']!r} not recognised - skipped")
    if frame is not None:
        if str(frame) in FRAMES:
            out["frame"] = str(frame)
        else:
            notes.append(f"frame {frame!r} not one of {', '.join(FRAMES)} - dropped")
    depth = data.get("rail_depth_mm", data.get("mounting_depth"))
    if depth == 0 and not isinstance(depth, bool):
        # No rear rail (a 2-post frame): the same as leaving it out.
        depth = None
    if depth not in (None, ""):
        if isinstance(depth, bool) or not isinstance(depth, (int, float)) or not (
                100 <= depth <= 2000):
            notes.append(f"rail_depth_mm {depth!r} is not 100-2000 mm - dropped")
        else:
            out["rail_depth_mm"] = round(depth)
    for key, choices in _LOOK_CHOICES.items():
        if key in look:
            v = str(look.pop(key) or "").strip().lower()
            if v in {c for c, _ in choices}:
                out[key] = v
            else:
                notes.append(f"look.{key} {v!r} not recognised - dropped")
    for key in ("side_panels", "blanking_fill"):
        if key in look:
            v = look.pop(key)
            if isinstance(v, bool):
                out[key] = v
            else:
                notes.append(f"look.{key} {v!r} is not true or false - dropped")
    if "colour" in look:
        v = look.pop("colour")
        try:
            out["colour"] = clean_colour(v)
        except ValueError:
            notes.append(f"look.colour {v!r} not a colour - dropped")
    if "kit" in look:
        v = look.pop("kit")
        if isinstance(v, str) and v.strip():
            out["kit_name"] = v.strip()[:NAME_MAX]
        else:
            notes.append(f"look.kit {v!r} is not a kit name - dropped")
    for k in sorted(map(str, look)):
        notes.append(f"look.{k}: not a key Danbyte reads - ignored")
    return out


def find_kit(tenant, name: str, vendor: str = ""):
    """The tenant's kit named ``name`` - the one of ``vendor`` first."""
    from .models import RackKit

    qs = RackKit.objects.filter(tenant=tenant, name__iexact=name)
    return qs.filter(vendor__iexact=vendor).first() or qs.order_by("vendor").first()


def set_look(rt, look: dict, notes: list[str], vendor: str = "") -> None:
    """Set a rack type's Look from ``read_look``'s fields (unsaved). A type
    that names a kit but no frame takes the kit's frame: the kit says what
    it builds."""
    for k, v in look.items():
        if k != "kit_name":
            setattr(rt, k, v)
    if "kit_name" in look:
        kit = find_kit(rt.tenant, look["kit_name"], vendor)
        if kit is None:
            notes.append(f"look.kit: no kit named {look['kit_name']} - drawn without one.")
        rt.kit = kit
        if kit is not None and "frame" not in look:
            rt.frame = kit.frame


def apply_rack_type(tenant, path: str, text: str, data, *, dry_run: bool = False):
    """Import one rack-type YAML from a pack: ``(action, name, id, notes)``.
    A rack type of the same name is matched and its Look updated; a new one
    is created with it (api.devicetype_import.import_racktype_yaml)."""
    from .devicetype_import import import_racktype_yaml
    from .models import RackType

    if not isinstance(data, dict) or not data.get("manufacturer") or not data.get("model"):
        return "error", "", "", ["Needs manufacturer and model."]
    name = str(data["model"]).strip()
    vendor = path.split("/")[1] if path.count("/") >= 2 else ""
    rt = RackType.objects.filter(tenant=tenant, name=name).first()
    if rt is None:
        rep = import_racktype_yaml(tenant, text, kit_vendor=vendor)
        if not rep.get("ok"):
            return "error", name, "", [rep.get("error") or "Not imported."]
        rt = RackType.objects.get(tenant=tenant, name=name)
        action, notes = "created", list(rep.get("skipped") or [])
    else:
        action, notes = "matched", []
        set_look(rt, read_look(data, notes), notes, vendor)
        rt.save()
    notes.append(f"look: {rt.frame}, {rt.front_door} / {rt.rear_door} doors"
                 + (f", kit {rt.kit.name}" if rt.kit_id else "") + ".")
    return action, name, "" if dry_run else str(rt.pk), notes


# ── the room ────────────────────────────────────────────────────────────────

def may_view(user, tenant) -> bool:
    from auth_api import rbac

    return rbac.has_action(user, tenant, "racktype", "view")


def kit_doc(kit, rack, shared: bool) -> dict | None:
    """A kit as the 3D room reads it: ``{id, name, frame, parts, fit, colours,
    widths_mm, depths_mm, model_url, far_url}`` (``fit``: ``kit_fit``'s, null
    for a kit imported before Danbyte read it) (the first width and depth
    are the reference cabinet's); the URLs the kit's own for a reader who may view
    rack types (``shared``), else through ``rack``. None without a model."""
    from .model_3d import version_of

    if kit is None or not kit.model_3d:
        return None

    def url(far: bool) -> str | None:
        field = kit.model_3d_far if far else kit.model_3d
        if not field:
            return None
        v = version_of(field)
        q = f"?far=1&v={v}" if far else f"?v={v}"
        if shared:
            return f"/api/rack-kits/{kit.pk}/model/{q}"
        return f"/api/racks/{rack.pk}/kit-model/{q}"

    parts = kit.parts or {}
    seg = parts.get("post:segment")
    fit = seg.get("fit") if isinstance(seg, dict) else None
    return {"id": str(kit.pk), "name": kit.name, "frame": kit.frame,
            "parts": parts, "fit": fit if isinstance(fit, dict) else None,
            "colours": kit.colours or {},
            "widths_mm": kit.widths_mm or [], "depths_mm": kit.depths_mm or [],
            "model_url": url(False), "far_url": url(True)}
