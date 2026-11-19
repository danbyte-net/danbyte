"""Cable pathways in a rack (docs/dcim/racks.md → Pathways, the export spec
§14 v1.13).

A rack has **pathways** - the vertical cable managers and corner channels
on its sides, its cable **entries** (roof cut-outs, brush grommets, floor
openings), its **0U channels** (where vertical PDUs mount) and the
horizontal managers in its units. Each one comes from, in this order:

1. the rack's **kit** - the ``path:vertical:*``, ``entry:*`` and
   ``channel:0u:*`` parts of its model (``scan_pathways``, stored on the kit
   at import), scaled to the rack's units and depth; or, for a rack without
   a kit (or a kit imported before Danbyte read them), the **defaults** of its
   frame (``FRAME_DEFAULTS``);
2. its **rack type**: ``RackPathway`` rows on the type (``rack_type`` set);
3. the **rack** itself: ``RackPathway`` rows on the rack.

A row with a ``key`` overlays the inherited pathway of that key: its set
fields replace the inherited ones (blank and null inherit) and ``hidden``
hides or shows it. A row without a key is a pathway of its own (``type`` or
``manual``). The inherited ones are never rows until someone changes one or
links something to it (a 0U device's ``mount_pathway``): ``pin`` makes the
overlay row then, so everything that points at a pathway points at a row.

``resolve_rack`` / ``resolve_type`` give the merged list; ``check`` the
field errors of a row about to be saved.
"""
from __future__ import annotations

import math
import re

KIND_CHOICES = [("vertical", "Vertical"), ("horizontal", "Horizontal"),
                ("entry", "Entry"), ("channel", "0U channel")]
SUBKIND_CHOICES = [("finger", "Finger"), ("d-ring", "D-ring"), ("channel", "Channel"),
                   ("lacing", "Lacing bar"), ("brush", "Brush"), ("open", "Open"),
                   ("gland", "Gland"), ("sealed", "Sealed")]
SIDE_CHOICES = [("left", "Left"), ("right", "Right")]
FACE_CHOICES = [("front", "Front"), ("rear", "Rear"), ("full", "Full depth")]
SURFACE_CHOICES = [("top", "Roof"), ("bottom", "Floor"), ("side", "Side panel")]
SOURCES = ("kit", "default", "type", "manual")

KINDS = tuple(v for v, _ in KIND_CHOICES)
#: The subkinds each kind takes (spec §14: ``danbyte_kind``).
SUBKINDS = {
    "vertical": ("finger", "d-ring", "channel", "lacing"),
    "horizontal": ("finger", "d-ring", "channel", "lacing", "brush"),
    "entry": ("open", "brush", "gland", "sealed"),
    "channel": (),
}
#: A pathway's usable share of its cross-section (TIA-569 style), in %.
DEFAULT_FILL_PCT = 40
#: The largest inner size or opening (mm).
SIZE_MAX = 2000
#: Frames that have a roof, a floor and side panels.
ENCLOSED = ("cabinet", "wall-cabinet")

#: Fields a row can set; on an overlay a blank or null one inherits.
VALUE_FIELDS = ("kind", "subkind", "side", "face", "surface", "u_from", "u_to", "offset_mm",
                "depth_mm", "x_mm", "y_mm", "inner_w_mm", "inner_d_mm", "fill_limit_pct",
                "accessory_type", "device", "name", "description")

VERTICAL = re.compile(r"^path:vertical:(left|right):(front|rear|full)$")
ENTRY = re.compile(r"^entry:(top|bottom|side):([a-z0-9][a-z0-9-]*)$")
CHANNEL = re.compile(r"^channel:0u:(left|right):(front|rear)$")
#: Which of a side's vertical pathways a kit installs when its ``kit.yaml``
#: does not say (``pathways: {installed: [...]}``): the faces its frame
#: installs (a cabinet: its front managers and its rear corner channels),
#: else the first it has in ``INSTALLED_FACE`` (a 2-post's full-depth
#: managers). The others are add-ons, hidden until shown.
INSTALLED_FACE = ("rear", "full", "front")
INSTALLED_BY_FRAME = {"cabinet": ("front", "rear")}
#: The sides a manager's cables enter from (spec §14 v1.16 ``danbyte_open``).
OPEN_CHOICES = ("front", "rear", "inner", "outer", "ends")
#: A manager's wall when the kit does not show one (mm).
WALL_MM = 2.0


# ── reading a kit ───────────────────────────────────────────────────────────

def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _mm(v):
    n = _num(v)
    return round(n) if n is not None and 0 < n <= SIZE_MAX else None


def _subkind(raw, kind: str) -> str:
    v = str(raw or "").strip().lower()
    return v if v in SUBKINDS.get(kind, ()) else ""


def scan_pathways(doc: dict, fit: dict | None, ref_w_mm: float, ref_d_mm: float):
    """The pathways a kit's model names (spec §14 v1.13) - a list of
    ``{key, kind, side, face, surface, subkind, inner_w_mm, inner_d_mm, …}``
    in the kit's reference rack - and notes on them.

    * ``path:vertical:<side>:<face>``: a vertical manager or channel, its
      inner size and kind from its child ``path`` empty;
    * ``entry:<top|bottom|side>:<name>``: an opening, ``danbyte_w`` /
      ``danbyte_h`` / ``danbyte_kind``, with ``on`` the roof or base part it
      belongs to (the rack's Look picks which) and its place as a share of
      the rack's width (``fx``, from the left) and depth (``fd``, from the
      front);
    * ``channel:0u:<side>:<face>``: a 0U channel, ``danbyte_depth`` (mm from
      the front rail), ``danbyte_len_u`` (at the reference height) and its
      lower end above unit 1 (``offset_mm``).

    Each name is read once (a roof's entries once per roof variant)."""
    from .model_anchors import _world
    from .rack_kits import part_name

    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    world = _world(doc)
    parent: dict[int, int] = {}
    for i, n in enumerate(nodes):
        for c in n.get("children") or []:
            if isinstance(c, int) and 0 <= c < len(nodes):
                parent.setdefault(c, i)
    u1 = (fit or {}).get("u1_mm")
    ref_u = (fit or {}).get("ref_u")
    front = _front_plane(doc, world)
    out: list[dict] = []
    notes: list[str] = []
    seen: set[tuple[str, str]] = set()

    def extras(i):
        e = nodes[i].get("extras")
        return e if isinstance(e, dict) else {}

    for i in sorted(world):
        name = part_name(str(nodes[i].get("name") or ""))
        m = VERTICAL.match(name)
        if m:
            if (name, "") in seen:
                continue
            seen.add((name, ""))
            path = next((c for c in nodes[i].get("children") or []
                         if isinstance(c, int) and 0 <= c < len(nodes)
                         and part_name(str(nodes[c].get("name") or "")) == "path"), None)
            ex = extras(path) if path is not None else {}
            if path is None:
                notes.append(f"{name}: no path empty; its inner size is unknown.")
            item = {"key": name, "kind": "vertical", "side": m[1], "face": m[2],
                    "subkind": _subkind(ex.get("danbyte_kind"), "vertical") or "channel",
                    "inner_w_mm": _mm(ex.get("danbyte_inner_w")),
                    "inner_d_mm": _mm(ex.get("danbyte_inner_d"))}
            if path is not None and (item["inner_w_mm"] is None or item["inner_d_mm"] is None):
                notes.append(f"{name}: danbyte_inner_w / danbyte_inner_d missing.")
            geo = _vertical_geo(doc, world, i, path, ex, item, front)
            if geo is not None:
                item["geo"] = geo
            out.append(item)
            continue
        m = ENTRY.match(name)
        if m:
            p = parent.get(i)
            on = part_name(str(nodes[p].get("name") or "")) if p is not None else ""
            if (name, on) in seen:
                continue
            seen.add((name, on))
            ex = extras(i)
            fx, fd = _entry_place(nodes, world, i, p, ref_w_mm, ref_d_mm)
            item = {"key": name, "kind": "entry", "surface": m[1], "on": on,
                    "subkind": _subkind(ex.get("danbyte_kind"), "entry") or "open",
                    "inner_w_mm": _mm(ex.get("danbyte_w")),
                    "inner_d_mm": _mm(ex.get("danbyte_h")), "fx": fx, "fd": fd}
            if m[1] == "side":
                item["side"] = "left" if world[i][0][3] < 0 else "right"
            if item["inner_w_mm"] is None or item["inner_d_mm"] is None:
                notes.append(f"{name}: danbyte_w / danbyte_h missing.")
            out.append(item)
            continue
        m = CHANNEL.match(name)
        if m:
            if (name, "") in seen:
                continue
            seen.add((name, ""))
            ex = extras(i)
            depth = _num(ex.get("danbyte_depth"))
            length = _num(ex.get("danbyte_len_u"))
            item = {"key": name, "kind": "channel", "side": m[1], "face": m[2],
                    "depth_mm": round(depth) if depth is not None and depth >= 0 else None,
                    "len_u": round(length) if length is not None and length >= 1 else None,
                    "ref_u": ref_u}
            if u1 is not None:
                item["offset_mm"] = max(0, round(world[i][1][3] * 1000 - u1))
            out.append(item)
    out.sort(key=lambda p: (KINDS.index(p["kind"]), p["key"], p.get("on", "")))
    return out, notes


def _front_plane(doc: dict, world: dict) -> float:
    """The kit's front plane (glTF z, m): the glTF z = 0 plane of §14, or a
    frame part standing ahead of it (a 2-post's base plate) - as
    api.rack_kits.kit_fit measures the rail's inset from."""
    from .model_anchors import subtree_box
    from .rack_kits import PARTS, part_name

    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    front = 0.0
    for i in world:
        name = part_name(str(nodes[i].get("name") or ""))
        if name not in PARTS or name.startswith(("door:", "label:", "pdu:")):
            continue
        box = subtree_box(doc, i, world)
        if box is not None:
            front = max(front, box[1][2])
    return front


def _vertical_geo(doc, world, i, path, ex, item, front) -> dict | None:
    """Where a vertical manager is in the kit's reference rack (mm): its
    mesh across (``x0``..``x1``, right of the centre seen from the front),
    the centre of its inner cross-section across (``cx``, its ``path``
    empty), its depth from the front (``d0``..``d1``), its wall, and how
    cables enter it (``open``, ``pitch_mm``: spec §14 v1.16). A manager
    stretched in depth is a 1000 mm mesh from its front edge: its real
    depth is its inner depth and walls."""
    from .model_anchors import subtree_box

    nodes = doc.get("nodes") or []
    box = subtree_box(doc, i, world)
    if box is None:
        return None
    (x0, _y0, z0), (x1, _y1, z1) = box
    extras = nodes[i].get("extras") if isinstance(nodes[i].get("extras"), dict) else {}
    stretch = str(extras.get("danbyte_stretch") or "").lower()
    w_mesh = (x1 - x0) * 1000
    inner_w, inner_d = item["inner_w_mm"], item["inner_d_mm"]
    wall = max(0.0, (w_mesh - inner_w) / 2) if inner_w else WALL_MM
    wall = min(wall, 25.0)
    if "y" in stretch:
        d0 = (front - world[i][2][3]) * 1000
        d1 = d0 + (inner_d + 2 * wall if inner_d else 90.0)
    else:
        d0, d1 = (front - z1) * 1000, (front - z0) * 1000
    cx = world[path][0][3] * 1000 if path is not None else (x0 + x1) * 500
    geo = {"x0": round(x0 * 1000, 1), "x1": round(x1 * 1000, 1), "cx": round(cx, 1),
           "d0": round(d0, 1), "d1": round(d1, 1), "wall": round(wall, 1)}
    opened = str(ex.get("danbyte_open") or "").strip().lower()
    if opened in OPEN_CHOICES:
        geo["open"] = opened
    pitch = _num(ex.get("danbyte_pitch_mm"))
    if pitch is not None and 5 <= pitch <= 500:
        geo["pitch_mm"] = round(pitch, 2)
    return geo


def _entry_place(nodes, world, i, p, ref_w, ref_d) -> tuple[float, float]:
    """An entry's place as shares of the rack's width (from the left) and
    depth (from the front). On a part stretched across (a roof, a plinth) its
    local place along the 1000 mm reference mesh is that share already, as
    the room stretches it; elsewhere it is read off the reference rack."""
    stretch, ref = "", 1000.0
    if p is not None:
        e = nodes[p].get("extras") if isinstance(nodes[p].get("extras"), dict) else {}
        stretch = str(e.get("danbyte_stretch") or "").lower()
        ref = _num(e.get("danbyte_ref_mm")) or 1000.0
    t = nodes[i].get("translation") if isinstance(nodes[i].get("translation"), list) else None
    w = world[i]
    if t and len(t) == 3 and "x" in stretch:
        fx = t[0] * 1000 / ref
    else:
        fx = (w[0][3] * 1000 + ref_w / 2) / ref_w
    if t and len(t) == 3 and "y" in stretch:
        fd = -t[2] * 1000 / ref
    else:
        fd = -w[2][3] * 1000 / ref_d
    return round(min(max(fx, 0.0), 1.0), 3), round(min(max(fd, 0.0), 1.0), 3)


def kit_summary(pathways: list[dict]) -> str:
    """One import note: what the kit's pathways are."""
    if not pathways:
        return "pathways: none."
    n = {k: sum(1 for p in pathways if p["kind"] == k) for k in KINDS}
    entries = len({p["key"] for p in pathways if p["kind"] == "entry"})
    parts = []
    if n["vertical"]:
        parts.append(f"{n['vertical']} vertical")
    if entries:
        parts.append(f"{entries} entr{'y' if entries == 1 else 'ies'}")
    if n["channel"]:
        parts.append(f"{n['channel']} 0U channel{'s' if n['channel'] != 1 else ''}")
    return f"pathways: {', '.join(parts)}."


def manager_pathway(doc: dict) -> dict | None:
    """A cable-manager accessory's ``path`` empty (spec §14): ``{kind,
    inner_w_mm, inner_d_mm}``, or None without one."""
    from .rack_kits import part_name

    for n in doc.get("nodes") if isinstance(doc.get("nodes"), list) else []:
        if part_name(str(n.get("name") or "")) != "path":
            continue
        ex = n.get("extras") if isinstance(n.get("extras"), dict) else {}
        return {"kind": _subkind(ex.get("danbyte_kind"), "vertical") or "channel",
                "inner_w_mm": _mm(ex.get("danbyte_inner_w")),
                "inner_d_mm": _mm(ex.get("danbyte_inner_d"))}
    return None


# ── what a frame has without a kit ──────────────────────────────────────────

#: A rack with no kit (or a kit without pathway data) gets these from its
#: frame (the plan §1): a cabinet its front vertical managers and rear
#: corner channels, a roof and a floor entry and rear 0U channels; a wall cabinet a roof and a floor
#: entry; a 2-post a vertical finger manager each side; an open 4-post none.
FRAME_DEFAULTS: dict[str, list[dict]] = {
    "cabinet": [
        {"key": "path:vertical:left:front", "kind": "vertical", "side": "left",
         "face": "front", "subkind": "channel", "inner_w_mm": 50, "inner_d_mm": 90},
        {"key": "path:vertical:right:front", "kind": "vertical", "side": "right",
         "face": "front", "subkind": "channel", "inner_w_mm": 50, "inner_d_mm": 90},
        {"key": "path:vertical:left:rear", "kind": "vertical", "side": "left", "face": "rear",
         "subkind": "channel", "inner_w_mm": 50, "inner_d_mm": 90},
        {"key": "path:vertical:right:rear", "kind": "vertical", "side": "right",
         "face": "rear", "subkind": "channel", "inner_w_mm": 50, "inner_d_mm": 90},
        {"key": "entry:top:roof", "kind": "entry", "surface": "top", "subkind": "brush",
         "inner_w_mm": 200, "inner_d_mm": 80, "fx": 0.5, "fd": 0.85},
        {"key": "entry:bottom:floor", "kind": "entry", "surface": "bottom", "subkind": "open",
         "inner_w_mm": 400, "inner_d_mm": 100, "fx": 0.5, "fd": 0.85},
        {"key": "channel:0u:left:rear", "kind": "channel", "side": "left", "face": "rear"},
        {"key": "channel:0u:right:rear", "kind": "channel", "side": "right", "face": "rear"},
    ],
    "wall-cabinet": [
        {"key": "entry:top:roof", "kind": "entry", "surface": "top", "subkind": "brush",
         "inner_w_mm": 200, "inner_d_mm": 80, "fx": 0.5, "fd": 0.7},
        {"key": "entry:bottom:floor", "kind": "entry", "surface": "bottom", "subkind": "open",
         "inner_w_mm": 200, "inner_d_mm": 80, "fx": 0.5, "fd": 0.7},
    ],
    "2-post": [
        {"key": "path:vertical:left:full", "kind": "vertical", "side": "left", "face": "full",
         "subkind": "finger", "inner_w_mm": 150, "inner_d_mm": 120},
        {"key": "path:vertical:right:full", "kind": "vertical", "side": "right",
         "face": "full", "subkind": "finger", "inner_w_mm": 150, "inner_d_mm": 120},
    ],
    "4-post": [],
}


# ── resolving ───────────────────────────────────────────────────────────────

def _blank_item(**kw) -> dict:
    item = {"key": "", "id": None, "source": "", "kind": "", "subkind": "", "side": "",
            "face": "", "surface": "", "u_from": None, "u_to": None, "offset_mm": None,
            "depth_mm": None, "x_mm": None, "y_mm": None, "inner_w_mm": None,
            "inner_d_mm": None, "fill_limit_pct": None, "accessory_type": None,
            "device": None, "name": "", "description": "", "hidden": False, "addon": False,
            "orphan": False, "overridden": [], "geo": None}
    item.update(kw)
    return item


class Frame:
    """What the pathways of one rack (or rack type) are laid out in: its
    frame, kit, roof and base, units and outer size, its rail (19, 21 or 23
    inch) and its Look's rail depth."""

    def __init__(self, *, frame, kit, top, base, side_panels, start, units,
                 width_mm, depth_mm, rail_width=19, rail_depth_mm=None, desc=False):
        self.frame, self.kit, self.top, self.base = frame, kit, top, base
        self.side_panels = side_panels
        self.start, self.units = start, units
        self.width_mm, self.depth_mm = width_mm, depth_mm
        self.rail_width, self.rail_depth_mm, self.desc = rail_width, rail_depth_mm, desc

    @property
    def top_unit(self) -> int:
        return self.start + self.units - 1

    @classmethod
    def of_rack(cls, rack) -> Frame:
        from .rack_look import resolve

        look = resolve(rack)
        rt = rack.rack_type if rack.rack_type_id else None
        width = rack.outer_width_mm or (rt.outer_width_mm if rt else None)
        depth = rack.outer_depth_mm or (rt.outer_depth_mm if rt else None)
        return cls(frame=look["frame"], kit=look["kit"], top=look["top"], base=look["base"],
                   side_panels=look["side_panels"], start=rack.starting_unit,
                   units=rack.u_height, width_mm=width, depth_mm=depth,
                   rail_width=rack.width or 19, rail_depth_mm=look.get("rail_depth_mm"),
                   desc=bool(rack.desc_units))

    @classmethod
    def of_type(cls, rt) -> Frame:
        return cls(frame=rt.frame, kit=rt.kit if rt.kit_id else None, top=rt.top,
                   base=rt.base, side_panels=rt.side_panels, start=rt.starting_unit,
                   units=rt.u_height, width_mm=rt.outer_width_mm, depth_mm=rt.outer_depth_mm,
                   rail_width=getattr(rt, "width", 19) or 19,
                   rail_depth_mm=getattr(rt, "rail_depth_mm", None),
                   desc=bool(getattr(rt, "desc_units", False)))


def _ref(values, fallback: int) -> int:
    return int(values[0]) if values else fallback


def _installed(raw: list[dict], frame: str) -> dict[str, set[str]]:
    """``{side: faces}`` of the vertical pathways a kit installs: the ones its
    ``kit.yaml`` names (``installed`` on each, api.rack_kits.read_kit), else
    the frame's rule (``INSTALLED_BY_FRAME``, ``INSTALLED_FACE``)."""
    verticals = [p for p in raw if p["kind"] == "vertical"]
    if any("installed" in p for p in verticals):
        out: dict[str, set[str]] = {"left": set(), "right": set()}
        for p in verticals:
            if p.get("installed"):
                out.setdefault(p["side"], set()).add(p["face"])
        return out
    out = {}
    for side in ("left", "right"):
        faces = {p["face"] for p in verticals if p["side"] == side}
        want = set(INSTALLED_BY_FRAME.get(frame, ())) & faces
        if not want:
            first = next((f for f in INSTALLED_FACE if f in faces), "")
            want = {first} if first else set()
        out[side] = want
    return out


def mark_installed(pathways: list[dict], keys, notes: list[str]) -> None:
    """Mark the kit's vertical pathways its ``kit.yaml`` installs
    (``pathways: {installed: [...]}``); None: the kit does not say, and the
    frame's rule applies (``_installed``)."""
    if keys is None:
        return
    keys = set(keys)
    have = {p["key"] for p in pathways if p["kind"] == "vertical"}
    for k in sorted(keys - have):
        notes.append(f"pathways.installed: {k} is not a vertical pathway of the model.")
    for p in pathways:
        if p["kind"] == "vertical":
            p["installed"] = p["key"] in keys


def _kit_geo(kit) -> dict[str, dict]:
    """``{key: geo}`` of a kit's vertical pathways read from its model, for a
    kit imported before Danbyte stored where they are (cached per kit and
    version; {} without a readable model)."""
    from django.core.cache import cache

    field = getattr(kit, "model_3d", None)
    pk = getattr(kit, "pk", None)
    if not field or pk is None:
        return {}
    stamp = getattr(kit, "updated_at", None)
    key = f"rack-kit-geo:{pk}:{stamp.timestamp() if stamp else ''}"
    hit = cache.get(key)
    if hit is not None:
        return hit
    out: dict[str, dict] = {}
    try:
        from .model_3d import validate_glb

        with field.open("rb") as fh:
            doc = validate_glb(fh.read())
        parts = getattr(kit, "parts", None) or {}
        fit = (parts.get("post:segment") or {}).get("fit")
        got, _ = scan_pathways(doc, fit, _ref(kit.widths_mm, 600), _ref(kit.depths_mm, 1000))
        out = {p["key"]: p["geo"] for p in got if p.get("geo")}
    except Exception:  # noqa: BLE001 - a missing or unreadable file: nominal places
        out = {}
    cache.set(key, out, 24 * 3600)
    return out


def base_items(fr: Frame) -> list[dict]:
    """The kit's pathways scaled to the frame, else the frame's defaults."""
    kit = fr.kit
    scanned = getattr(kit, "pathways", None) if kit is not None else None
    if scanned is not None:
        source = "kit"
        raw = scanned
        ref_w = _ref(kit.widths_mm, fr.width_mm or 600)
        ref_d = _ref(kit.depths_mm, fr.depth_mm or 1000)
    else:
        source = "default"
        raw = FRAME_DEFAULTS.get(fr.frame, [])
        ref_w, ref_d = fr.width_mm or 600, fr.depth_mm or 1000
    width = fr.width_mm or ref_w
    depth = fr.depth_mm or ref_d
    on_parts = {f"top:{fr.top}", f"base:{fr.base}"}
    if fr.side_panels:
        on_parts |= {"side:panel", "side:panel:infill", "side:panel:edge"}
    installed = _installed(raw, fr.frame) if source == "kit" else {}
    lazy = None
    if source == "kit" and any(p["kind"] == "vertical" and "geo" not in p for p in raw):
        lazy = _kit_geo(kit)
    channels = (getattr(kit, "parts", None) or {}) if source == "kit" else {}
    out: list[dict] = []
    keys: set[str] = set()
    for p in raw:
        if p["key"] in keys:
            continue
        if p["kind"] == "entry" and p.get("on") and p["on"] not in on_parts:
            continue
        keys.add(p["key"])
        item = _blank_item(key=p["key"], source=source, kind=p["kind"],
                           subkind=p.get("subkind") or "", side=p.get("side") or "",
                           face=p.get("face") or "", surface=p.get("surface") or "",
                           inner_w_mm=p.get("inner_w_mm"), inner_d_mm=p.get("inner_d_mm"))
        ref = {"w": ref_w, "d": ref_d}
        if p["kind"] == "vertical":
            item["u_from"], item["u_to"] = fr.start, fr.top_unit
            if (p["face"] == "full" and fr.frame != "2-post"
                    and item["inner_d_mm"] is not None):
                # A full-depth manager runs front to back: it grows with the rack.
                item["inner_d_mm"] = max(1, min(SIZE_MAX, item["inner_d_mm"] + depth - ref_d))
            if source == "kit" and p["face"] not in installed.get(p["side"], set()):
                item["hidden"] = item["addon"] = True
            geo = p.get("geo") or (lazy or {}).get(p["key"])
            if geo:
                ref["geo"] = geo
        elif p["kind"] == "entry":
            item["x_mm"] = round((p.get("fx", 0.5) - 0.5) * width)
            item["y_mm"] = round(p.get("fd", 0.5) * depth)
        elif p["kind"] == "channel":
            length = fr.units
            if p.get("len_u") and p.get("ref_u"):
                length = fr.units - (p["ref_u"] - p["len_u"])
            elif p.get("len_u"):
                length = p["len_u"]
            length = max(1, min(fr.units, length))
            item["u_from"], item["u_to"] = fr.start, fr.start + length - 1
            item["offset_mm"] = p.get("offset_mm")
            d = p.get("depth_mm")
            if d is not None and p["face"] == "rear":
                d = max(0, d + depth - ref_d)
            item["depth_mm"] = d
            at = (channels.get(p["key"]) or {}).get("at")
            if isinstance(at, list) and len(at) == 3:
                ref["at"] = at
        item["_ref"] = ref
        out.append(item)
    return out


# ── where a pathway is, in the rack (mm) ───────────────────────────────────

#: A rack unit and the height of unit 1 without a kit (api.pathfinding's).
U_MM = 44.45
BASE_MM = 100.0
#: The frame over the top unit without a kit (the room's RACK_CAP_M).
CAP_MM = 30.0
#: The 19-inch, 21-inch and 23-inch rail openings (mm), as the room draws.
OPENING_MM = {10: 222.0, 19: 450.0, 21: 500.0, 23: 551.0}
#: Without a kit the room's rails stand this share of the depth in from
#: the front and the rear (world RAIL_INSET_FRAC, 0.45 from the centre).
RAIL_FRAC = 0.05


def kit_fit(fr: Frame) -> dict | None:
    kit = fr.kit
    parts = getattr(kit, "parts", None) if kit is not None else None
    if not isinstance(parts, dict) or not getattr(kit, "model_3d", None):
        return None
    fit = (parts.get("post:segment") or {}).get("fit")
    return fit if isinstance(fit, dict) else None


class Room:
    """A frame's measurements in the rack's own millimetres - ``x`` right of
    the centre seen from the front, ``y`` behind the front, ``z`` above the
    floor - as the 3D room draws the rack (world rackBaseM, rackRailPlanesM,
    rackFootprintM): unit 1's bottom, the frame over the top unit, the rail
    planes and the opening."""

    def __init__(self, fr: Frame):
        self.fr = fr
        fit = kit_fit(fr)
        self.fit = fit
        self.width = float(fr.width_mm or OPENING_MM.get(fr.rail_width, 450.0) + 150)
        self.depth = float(fr.depth_mm or 1000)
        self.base = float(fit["u1_mm"]) if fit else BASE_MM
        self.cap = float(fit["cap_mm"]) if fit else CAP_MM
        self.opening = OPENING_MM.get(fr.rail_width, 450.0)
        if fit:
            front = min(float(fit["rail_inset_mm"]), self.depth / 2)
            if fr.frame == "2-post":
                rear = front
            elif fr.rail_depth_mm:
                rear = min(self.depth, front + float(fr.rail_depth_mm))
            else:
                rear = self.depth - front
        elif fr.frame == "2-post":
            front = rear = self.depth / 2
        else:
            front = self.depth * RAIL_FRAC
            rear = (min(self.depth, front + float(fr.rail_depth_mm)) if fr.rail_depth_mm
                    else self.depth * (1 - RAIL_FRAC))
        self.rail_front, self.rail_rear = front, rear

    @property
    def top(self) -> float:
        """The roof's top (the rack's height)."""
        return self.base + self.fr.units * U_MM + self.cap

    def slot(self, u: float) -> float:
        """Unit ``u``'s place from the bottom (0 the lowest), as drawn."""
        i = u - self.fr.start
        return (self.fr.units - 1 - i) if self.fr.desc else i

    def z_mid(self, u: float) -> float:
        return self.base + (self.slot(u) + 0.5) * U_MM

    def z_span(self, lo, hi) -> tuple[float, float]:
        a = self.base + self.slot(lo) * U_MM
        b = self.base + self.slot(hi) * U_MM
        return min(a, b), max(a, b) + U_MM


def _sign(side: str) -> float:
    return -1.0 if side == "left" else 1.0


def _r(v: float) -> float:
    return round(v, 1)


def _vertical_place(it: dict, room: Room, ref: dict) -> dict:
    fr = room.fr
    sign = _sign(it["side"])
    w_in = float(it["inner_w_mm"] or 50)
    d_in = float(it["inner_d_mm"] or 90)
    geo = ref.get("geo")
    open_frame = fr.frame not in ENCLOSED
    if geo:
        ref_w, ref_d = float(ref["w"]), float(ref["d"])
        wall = float(geo.get("wall", WALL_MM))
        shift = (room.opening - 450.0) / 2

        def across(v: float) -> float:
            if open_frame:
                return v + math_copysign(shift, v)
            # Enclosed: as far in from the nearer side as in the kit.
            return math_copysign(room.width / 2 - (ref_w / 2 - abs(v)), v)

        xs = sorted((across(geo["x0"]), across(geo["x1"])))
        cx = across(geo["cx"])
        # Depths in the kit are from its front; its rail stands ``inset``
        # behind it. Without a fit, the rack's front is the kit's.
        inset = float(room.fit["rail_inset_mm"]) if room.fit else room.rail_front
        d0, d1 = float(geo["d0"]), float(geo["d1"])
        if it["face"] == "rear":
            y0, y1 = room.depth - (ref_d - d0), room.depth - (ref_d - d1)
        else:
            # From the front rail, as the kit stands it from its own.
            y0 = room.rail_front + (d0 - inset)
            y1 = room.rail_front + (d1 - inset)
            if it["face"] == "full" and fr.frame != "2-post":
                # Grown with the rack (its inner depth, ``base_items``).
                y1 = y0 + d_in + 2 * wall
        if y1 - y0 < 2 * wall + 1:
            y1 = y0 + d_in + 2 * wall
        x0, x1 = xs
    else:
        wall = WALL_MM
        outer = w_in + 2 * wall
        if fr.frame == "2-post":
            # Outside the posts, as a 2-post's finger managers stand.
            cx = sign * (room.width / 2 + outer / 2)
            y0 = room.rail_front - d_in / 2 - wall
        else:
            if open_frame:
                cx = sign * (room.opening / 2 + 40 + outer / 2)
            else:
                # Between the rail opening and the side panel.
                cx = sign * (room.opening / 2 + (room.width - room.opening) / 4)
            if it["face"] == "rear":
                y0 = room.depth - 30 - d_in - 2 * wall
            else:
                y0 = 30.0
        y1 = y0 + d_in + 2 * wall
        if it["face"] == "full" and fr.frame != "2-post":
            y1 = max(y1, room.depth - 30)
        x0, x1 = cx - outer / 2, cx + outer / 2
    z0, z1 = room.z_span(it["u_from"], it["u_to"])
    out = {"x0": _r(x0), "x1": _r(x1), "y0": _r(y0), "y1": _r(y1), "z0": _r(z0),
           "z1": _r(z1), "cx": _r(cx), "cy": _r((y0 + y1) / 2), "wall": _r(wall),
           "open": (geo or {}).get("open") or _default_open(it, fr),
           "pitch_mm": (geo or {}).get("pitch_mm")}
    if out["pitch_mm"] is None and it["subkind"] in ("finger", "d-ring"):
        out["pitch_mm"] = U_MM
    return out


def math_copysign(a: float, b: float) -> float:
    return math.copysign(a, b if b != 0 else 1.0)


def _default_open(it: dict, fr: Frame) -> str:
    """Where cables enter a manager whose kit does not say: a finger manager
    or D-ring from the gear's face (the rack's front, a 2-post's both), a
    corner channel from the gear (its inner side)."""
    if it["subkind"] in ("finger", "d-ring", "lacing"):
        return "front" if it["face"] != "rear" else "rear"
    return "inner"


def _place(it: dict, room: Room, ref: dict | None) -> dict | None:
    """The pathway's place in the rack (mm, ``Room``'s axes): a manager's
    box and the centre of its inner cross-section, an entry's opening, a
    0U channel's line."""
    ref = ref or {"w": room.width, "d": room.depth}
    kind = it["kind"]
    if kind == "vertical" and it["side"] and it["u_from"] is not None:
        return _vertical_place(it, room, ref)
    if kind == "horizontal" and it["u_from"] is not None:
        d_in = float(it["inner_d_mm"] or 80)
        if it["face"] == "rear":
            y0, y1 = room.rail_rear, room.rail_rear + d_in
        else:
            y0, y1 = room.rail_front - d_in, room.rail_front
        z0, z1 = room.z_span(it["u_from"], it["u_to"] or it["u_from"])
        half = room.opening / 2
        return {"x0": -half, "x1": half, "y0": _r(y0), "y1": _r(y1), "z0": _r(z0),
                "z1": _r(z1), "cx": 0.0, "cy": _r((y0 + y1) / 2), "wall": WALL_MM,
                "open": "front" if it["face"] != "rear" else "rear", "pitch_mm": None}
    if kind == "entry":
        x = float(it["x_mm"] if it["x_mm"] is not None else 0)
        y = float(it["y_mm"] if it["y_mm"] is not None else room.depth / 2)
        surface = it["surface"] or "top"
        if surface == "bottom":
            z = 0.0
        elif surface == "side":
            x, z = _sign(it["side"] or "left") * room.width / 2, room.top / 2
        else:
            z = room.top
        return {"x": _r(x), "y": _r(y), "z": _r(z), "w": float(it["inner_w_mm"] or 200),
                "d": float(it["inner_d_mm"] or 80)}
    if kind == "channel" and it["side"] and it["u_from"] is not None:
        at = ref.get("at")
        if at:
            ref_w, ref_d = float(ref["w"]), float(ref["d"])
            v = at[0] * 1000
            x = math_copysign(room.width / 2 - (ref_w / 2 - abs(v)), v)
            d = -at[2] * 1000
            y = d if d <= ref_d / 2 else room.depth - (ref_d - d)
        else:
            x = _sign(it["side"]) * (room.width / 2 - 30)
            if it["depth_mm"] is not None:
                y = room.rail_front + float(it["depth_mm"])
            else:
                y = room.depth - 60 if it["face"] != "front" else 60.0
        z0, z1 = room.z_span(it["u_from"], it["u_to"])
        return {"x": _r(x), "y": _r(min(max(y, 0.0), room.depth)), "z0": _r(z0), "z1": _r(z1)}
    return None


def _source_of_key(key: str) -> str:
    if key.startswith("type:"):
        return "type"
    return "kit" if key.startswith(("path:", "entry:", "channel:")) else "default"


def _apply(item: dict, row) -> None:
    """Overlay a row's set fields on an inherited item."""
    changed = []
    for f in VALUE_FIELDS:
        v = getattr(row, f"{f}_id") if f in ("accessory_type", "device") else getattr(row, f)
        if v is None or v == "":
            continue
        if f in ("accessory_type", "device"):
            v = getattr(row, f)
        if item.get(f) != v:
            changed.append(f)
        item[f] = v
    if row.hidden is not None:
        if row.hidden != item["hidden"]:
            changed.append("hidden")
        item["hidden"] = row.hidden
    item["overridden"] = sorted(set(item["overridden"]) | set(changed))


def _own(row, source: str) -> dict:
    item = _blank_item(key=f"{source}:{row.pk}", source=source)
    for f in VALUE_FIELDS:
        v = getattr(row, f) if f not in ("accessory_type", "device") else (
            getattr(row, f) if getattr(row, f"{f}_id") else None)
        item[f] = v if v is not None else item[f]
    item["hidden"] = bool(row.hidden)
    return item


def layer(items: list[dict], rows, *, own_source: str, ids: bool) -> list[dict]:
    """``items`` with ``rows`` laid over them: overlays by key, own rows
    added (``own_source``). ``ids``: the rows are this level's, so their
    ids go on the items they make or change."""
    by_key = {it["key"]: it for it in items}
    out = list(items)
    for row in rows:
        if row.key:
            it = by_key.get(row.key)
            if it is None:
                it = _blank_item(key=row.key, source=_source_of_key(row.key), orphan=True)
                by_key[row.key] = it
                out.append(it)
            _apply(it, row)
            if ids:
                it["id"] = str(row.pk)
        else:
            it = _own(row, own_source)
            if ids:
                it["id"] = str(row.pk)
            by_key[it["key"]] = it
            out.append(it)
    return out


def _accessory_sizes(item: dict) -> None:
    acc = item.get("accessory_type")
    pw = getattr(acc, "pathway", None) if acc is not None else None
    if not isinstance(pw, dict):
        return
    for f, k in (("inner_w_mm", "inner_w_mm"), ("inner_d_mm", "inner_d_mm")):
        if item[f] is None and pw.get(k):
            item[f] = pw[k]
    if not item["subkind"] and pw.get("kind"):
        item["subkind"] = pw["kind"]


def finish(items: list[dict], fr: Frame) -> list[dict]:
    """Effective values: a horizontal manager's units from its device, a
    vertical one's sizes from its accessory, the fill limit, the label and
    its place in the rack (``geo``, ``Room``'s millimetres)."""
    room = Room(fr)
    for it in items:
        dev = it.get("device")
        if it["kind"] == "horizontal" and dev is not None and dev.position is not None:
            if it["u_from"] is None:
                it["u_from"] = dev.position
            if it["u_to"] is None:
                h = (dev.device_type.u_height if dev.device_type_id else 1) or 1
                it["u_to"] = dev.position + max(1, int(h)) - 1
        if it["kind"] == "horizontal" and it["u_to"] is None:
            it["u_to"] = it["u_from"]
        if it["kind"] in ("vertical", "channel") and it["u_from"] is None:
            it["u_from"], it["u_to"] = fr.start, fr.top_unit
        _accessory_sizes(it)
        it["fill_limit_pct"] = it["fill_limit_pct"] or DEFAULT_FILL_PCT
        it["label"] = label(it)
        it["geo"] = _place(it, room, it.pop("_ref", None))
    items.sort(key=lambda i: (KINDS.index(i["kind"]) if i["kind"] in KINDS else 9,
                              i["side"], i["surface"], i["face"], i["u_from"] or 0, i["label"]))
    return items


_FACE_WORD = {"front": "front", "rear": "rear", "full": "full depth"}
_SURFACE_WORD = {"top": "Roof", "bottom": "Floor", "side": "Side"}


def label(it: dict) -> str:
    """A pathway's name, else one made from where it is."""
    if it.get("name"):
        return it["name"]
    side = it.get("side") or ""
    face = _FACE_WORD.get(it.get("face") or "", "")
    if it["kind"] == "vertical":
        return " ".join(w for w in (side.capitalize(), face) if w) or "Vertical"
    if it["kind"] == "channel":
        return " ".join(w for w in ("0U", side, face) if w)
    if it["kind"] == "entry":
        tail = it["key"].split(":", 2)[2] if it["key"].count(":") >= 2 and \
            it["key"].startswith("entry:") else ""
        return " ".join(w for w in (_SURFACE_WORD.get(it.get("surface") or "", "Entry"),
                                    side if it.get("surface") == "side" else "", tail) if w)
    if it["kind"] == "horizontal":
        u = f"U{it['u_from']}" if it.get("u_from") else ""
        return " ".join(w for w in (u, face) if w) or "Horizontal"
    return it["key"]


def rows_of(qs):
    return list(qs.select_related("accessory_type", "device__device_type").order_by(
        "created_at", "id"))


def resolve_type(rt, rows=None) -> list[dict]:
    """A rack type's pathways: its kit's (or its frame's) with its own rows
    laid over them."""
    fr = Frame.of_type(rt)
    if rows is None:
        rows = rows_of(rt.pathways.all())
    return finish(layer(base_items(fr), rows, own_source="type", ids=True), fr)


def resolve_rack(rack, rows=None, type_rows=None) -> list[dict]:
    """A rack's pathways: its kit's (or its frame's), its type's rows, then
    its own."""
    fr = Frame.of_rack(rack)
    items = base_items(fr)
    if rack.rack_type_id:
        if type_rows is None:
            type_rows = rows_of(rack.rack_type.pathways.all())
        items = layer(items, type_rows, own_source="type", ids=False)
    if rows is None:
        rows = rows_of(rack.pathways.all())
    return finish(layer(items, rows, own_source="manual", ids=True), fr)


# ── checking a row ──────────────────────────────────────────────────────────

def _faces_meet(a: str, b: str) -> bool:
    return a == b or "full" in (a, b) or not a or not b


def _units_meet(a: dict, b: dict) -> bool:
    if None in (a["u_from"], a["u_to"], b["u_from"], b["u_to"]):
        return False
    return a["u_from"] <= b["u_to"] and b["u_from"] <= a["u_to"]


def _clash(it: dict, other: dict) -> bool:
    if other["hidden"] or other["kind"] != it["kind"] or other["key"] == it["key"]:
        return False
    if it["kind"] == "vertical":
        return it["side"] == other["side"] and _faces_meet(it["face"], other["face"]) \
            and _units_meet(it, other)
    if it["kind"] == "channel":
        return it["side"] == other["side"] and it["face"] == other["face"] \
            and it["depth_mm"] == other["depth_mm"] and _units_meet(it, other)
    if it["kind"] == "horizontal":
        return _faces_meet(it["face"], other["face"]) and _units_meet(it, other)
    return False


def check(row) -> dict[str, str]:
    """Field errors for ``row`` (unsaved, its tenant, rack / rack type set):
    the pathway it overlays must be one its rack inherits, a pathway of its
    own needs its kind and where it is, and the merged pathway must fit the
    frame, stay in its units and not overlap a shown one of its kind."""
    errors: dict[str, str] = {}
    if (row.rack_id is None) == (row.rack_type_id is None):
        return {"rack_id": "Give a rack or a rack type, not both."}
    owner = row.rack if row.rack_id else row.rack_type
    if owner.tenant_id != row.tenant_id:
        return {"rack_id": "Not found."}
    for f in ("accessory_type", "device"):
        obj = getattr(row, f) if getattr(row, f"{f}_id") else None
        if obj is not None and obj.tenant_id != row.tenant_id:
            errors[f"{f}_id"] = "Not found."
    if errors:
        return errors
    if row.rack_id:
        others = [r for r in rows_of(row.rack.pathways.all()) if r.pk != row.pk]
        items = resolve_rack(row.rack, rows=[*others, row])
        fr = Frame.of_rack(row.rack)
        base = resolve_rack(row.rack, rows=[r for r in others if r.key])
    else:
        others = [r for r in rows_of(row.rack_type.pathways.all()) if r.pk != row.pk]
        items = resolve_type(row.rack_type, rows=[*others, row])
        fr = Frame.of_type(row.rack_type)
        base = resolve_type(row.rack_type, rows=[r for r in others if r.key])
    if row.key and any(r.key == row.key for r in others):
        return {"key": "That pathway has its row already; edit it instead."}
    if row.key:
        inherited = next((b for b in base if b["key"] == row.key and not b["orphan"]), None)
        if inherited is None:
            return {"key": "Not a pathway this rack inherits."}
        if row.kind and row.kind != inherited["kind"]:
            return {"kind": "An inherited pathway keeps its kind."}
        it = next(i for i in items if i["key"] == row.key)
    else:
        if not row.kind:
            return {"kind": "Pick a kind."}
        it = next(i for i in items if i["key"].endswith(f":{row.pk}"))
    return _check_item(it, items, fr, row)


def _check_item(it: dict, items: list[dict], fr: Frame, row) -> dict[str, str]:
    errors: dict[str, str] = {}
    kind = it["kind"]
    if it["subkind"] and it["subkind"] not in SUBKINDS.get(kind, ()):
        allowed = SUBKINDS.get(kind, ())
        errors["subkind"] = (f"One of {', '.join(allowed)}." if allowed
                             else "A 0U channel has no subkind.")
    if kind in ("vertical", "channel"):
        if not it["side"]:
            errors["side"] = "Pick a side."
        if not it["face"]:
            errors["face"] = "Pick front, rear or full depth."
    if kind == "channel" and it["face"] == "full":
        errors["face"] = "A 0U channel is at the front or the rear."
    if kind == "vertical" and fr.frame == "2-post" and it["face"] and it["face"] != "full":
        errors["face"] = "A 2-post frame has no front or rear; use full depth."
    if kind == "entry":
        if fr.frame not in ENCLOSED:
            errors["surface"] = "An open frame has no roof, floor or panels to pass through."
        elif not it["surface"]:
            errors["surface"] = "Pick the roof, the floor or a side panel."
        elif it["surface"] == "side":
            if not it["side"]:
                errors["side"] = "Pick the side panel."
            elif not fr.side_panels:
                errors["surface"] = "This rack has no side panels."
    if kind == "horizontal":
        if row.rack_type_id and row.device_id:
            errors["device_id"] = "A rack type has no devices; set the units instead."
        dev = it["device"]
        if dev is not None and row.rack_id and dev.rack_id != row.rack_id:
            errors["device_id"] = "Not a device in this rack."
        elif dev is not None and dev.position is None:
            errors["device_id"] = "That device is not in a unit."
        if it["u_from"] is None and "device_id" not in errors:
            errors["u_from"] = "Give its unit, or its device."
    acc = it["accessory_type"]
    if acc is not None:
        if acc.kind != "cable-manager":
            errors["accessory_type_id"] = "Pick a cable manager."
        elif kind == "vertical" and acc.u_height:
            errors["accessory_type_id"] = f"{acc.name} is a {acc.u_height}U manager; " \
                                          "a vertical one is 0U."
        elif kind not in ("vertical", "horizontal"):
            errors["accessory_type_id"] = "Only managers take a cable manager model."
    lo, hi = it["u_from"], it["u_to"]
    if lo is not None and not fr.start <= lo <= fr.top_unit:
        errors["u_from"] = f"Not a unit of this rack (U{fr.start}-U{fr.top_unit})."
    if hi is not None and not fr.start <= hi <= fr.top_unit:
        errors["u_to"] = f"Not a unit of this rack (U{fr.start}-U{fr.top_unit})."
    if lo is not None and hi is not None and hi < lo and "u_to" not in errors:
        errors["u_to"] = "Below the first unit."
    if kind not in ("vertical", "channel", "horizontal") and (row.u_from or row.u_to):
        errors["u_from"] = "An entry has no units."
    if errors or it["hidden"]:
        return errors
    for other in items:
        if _clash(it, other):
            span = (f" (U{other['u_from']}-U{other['u_to']})"
                    if other["u_from"] is not None else "")
            errors["u_from"] = f"Overlaps {other['label']}{span}. Hide one or move it."
            break
    return errors


def pin(rack, key: str, *, tenant):
    """The rack's row for its pathway ``key``, made (an overlay that changes
    nothing) when there is none yet. None when the rack has no such
    pathway."""
    from .models import RackPathway

    row = rack.pathways.filter(key=key).first()
    if row is not None:
        return row
    if key.startswith(("manual:",)):
        return rack.pathways.filter(pk=key.split(":", 1)[1]).first()
    if not any(i["key"] == key and not i["orphan"] for i in resolve_rack(rack)):
        return None
    return RackPathway.objects.create(tenant=tenant, rack=rack, key=key)
