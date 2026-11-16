"""Ports and LEDs on a device type's rack-face photos, placed on the server.

A browser render (frontend lib/model-studio + floorplan3d/studio) projects
the assembled model's ``port:`` anchors and ``led:`` boxes onto the faces it
rendered. A model pack's Blender renders (docs/dcim/model-packs.md) are
framed to the same contract - the face frame, front from -Z, rear from +Z -
so the server places their ports and LEDs the same way, from the anchors it
stored when it scanned the models (api.model_anchors): the chassis' own,
plus each reference module's posed by its bay's transform.

The numbers both sides use - the port box table, the face and LED
thresholds - are read from the SPA's ``frontend/src/lib/studio-projection
.json``; ``studio-projection.cases.json`` beside it holds cases both test
suites run. The functions below mirror lib/model-studio one for one.

Positions are the room's frame after the model is fitted (device-model
``fittedModel``): metres, Y up, centred on X and Z, standing on y = 0, the
front facing -Z.
"""
from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path

from django.conf import settings

TABLE_PATH = Path(settings.BASE_DIR) / "frontend" / "src" / "lib" / "studio-projection.json"


class ProjectionUnavailable(Exception):
    """The shared table isn't deployed (an install without the SPA source)."""


@lru_cache(maxsize=1)
def table() -> dict:
    try:
        return json.loads(TABLE_PATH.read_text())
    except (OSError, ValueError) as exc:
        raise ProjectionUnavailable(str(exc)) from exc


@lru_cache(maxsize=1)
def _type_rules():
    return [(re.compile(rx), box) for rx, box in table()["port_box_types"]]


def round5(v: float) -> float:
    """JavaScript's ``Math.round(v * 1e5) / 1e5`` (half up, not half even)."""
    return math.floor(v * 1e5 + 0.5) / 1e5


def _clamp01(v: float) -> float:
    return min(1.0, max(0.0, v))


# ── the pure maths (lib/model-studio) ──────────────────────────────────────

def face_frame(frame_mm, model_height_m: float) -> dict:
    w = frame_mm[0] / 1000
    h = frame_mm[1] / 1000 if frame_mm[1] is not None else model_height_m
    return {"w": w, "h": h if h > 0 else model_height_m}


def face_of(n, minimum: float | None = None) -> str | None:
    minimum = table()["face_min"] if minimum is None else minimum
    length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
    if length < 1e-9:
        return None
    z = n[2] / length
    if z <= -minimum:
        return "front"
    if z >= minimum:
        return "rear"
    return None


def nearest_face(p, depth: float, slack: float | None = None) -> str | None:
    if slack is None:
        s = table()["led_slack"]
        slack = max(s["min_m"], depth * s["depth_ratio"])
    front = abs(p[2] + depth / 2)
    rear = abs(p[2] - depth / 2)
    if min(front, rear) > slack:
        return None
    return "front" if front <= rear else "rear"


def project_to_face(p, face: str, frame: dict) -> tuple[float, float]:
    half = frame["w"] / 2
    x = (half - p[0]) / frame["w"] if face == "front" else (p[0] + half) / frame["w"]
    y = (frame["h"] - p[1]) / frame["h"]
    return x, y


def port_box_kind(kind: str, type_: str | None) -> str:
    t = (type_ or "").lower()
    for rx, box in _type_rules():
        if rx.search(t):
            return box
    return table()["port_box_kinds"].get(kind) or table()["port_box_default"]


def port_size_mm(a: dict, kind: str, type_: str | None) -> tuple[float, float]:
    """lib/model-studio portSizeMm: the anchor's own opening size (m) where
    it has one, else the table's box by kind and type."""
    w, h = a.get("w"), a.get("h")
    if isinstance(w, (int, float)) and isinstance(h, (int, float)) and w > 0 and h > 0:
        return w * 1000, h * 1000
    return tuple(table()["port_box_mm"][port_box_kind(kind, type_)])


def image_ports_from_anchors(anchors, index: dict, frame: dict) -> dict:
    """``{doc, unknown, offFace}`` - lib/model-studio imagePortsFromAnchors.
    ``anchors`` are ``{name, p, n, w?, h?}``; ``index`` names each port's
    ``[kind, type]``. An anchor is looked up as api.anchor_names matches
    it, and a marker carries the name it matched: ``Gi1/0/1`` over the
    template ``Gi{position}/0/1`` is placed as the template, which each
    stack member renders as its own port."""
    from .anchor_names import NameMatcher

    names = NameMatcher(index)
    doc: dict[str, list] = {"front": [], "rear": []}
    unknown: list[str] = []
    off: list[str] = []
    seen: set[str] = set()
    for a in anchors:
        name = a["name"]
        if not name or len(name) > 64 or name in seen:
            continue
        seen.add(name)
        face = face_of(a["n"])
        if not face:
            off.append(name)
            continue
        key = names.resolve(name)
        known = index.get(key) if key is not None else None
        if not known:
            unknown.append(name)
        kind = known[0] if known else "interface"
        wmm, hmm = port_size_mm(a, kind, known[1] if known else None)
        x, y = project_to_face(a["p"], face, frame)
        if x < 0 or x > 1 or y < 0 or y > 1:
            off.append(name)
            continue
        doc[face].append({
            "kind": kind, "name": key if known else name, "x": round5(x), "y": round5(y),
            "w": round5(_clamp01(wmm / 1000 / frame["w"])),
            "h": round5(_clamp01(hmm / 1000 / frame["h"])),
        })
    return {"doc": doc, "unknown": unknown, "offFace": off}


def led_source(led_id: str, leds) -> str | None:
    if not isinstance(leds, dict):
        return None
    own = (leds.get(led_id) or {}).get("source") if isinstance(leds.get(led_id), dict) else None
    if own:
        return own
    if led_id.startswith("port:"):
        star = leds.get("port:*")
        return star.get("source") if isinstance(star, dict) else None
    return None


def image_leds_from_boxes(boxes, sources: dict, frame: dict, depth: float) -> dict:
    """``{doc, unknown, offFace}`` - lib/model-studio imageLedsFromBoxes.
    ``boxes`` are ``{id, bay?, min, max}``; ``sources`` maps
    ``"<bay>\\0<id>"`` to the LED's source."""
    min_m = table()["min_led_m"]
    doc: dict[str, list] = {"front": [], "rear": []}
    off: list[str] = []
    seen: set[str] = set()
    for b in boxes:
        bay = b.get("bay")
        key = f"{bay or ''}\u0000{b['id']}"
        if key in seen:
            continue
        seen.add(key)
        c = [(b["min"][i] + b["max"][i]) / 2 for i in range(3)]
        face = nearest_face(c, depth)
        label = f"{bay}: {b['id']}" if bay else b["id"]
        if not face:
            off.append(label)
            continue
        x, y = project_to_face(c, face, frame)
        if x < 0 or x > 1 or y < 0 or y > 1:
            off.append(label)
            continue
        row = {"kind": "led", "name": b["id"]}
        if bay:
            row["bay"] = bay
        source = sources.get(key)
        if source:
            row["source"] = source
        row.update({
            "x": round5(x), "y": round5(y),
            "w": round5(_clamp01(max(b["max"][0] - b["min"][0], min_m) / frame["w"])),
            "h": round5(_clamp01(max(b["max"][1] - b["min"][1], min_m) / frame["h"])),
        })
        doc[face].append(row)
    return {"doc": doc, "unknown": [], "offFace": off}


# ── the fit (floorplan3d/device-model fittedModel) ─────────────────────────

def _rotation(up: str, front: str):
    from .model_ports import _rotation as rot

    return rot(up or "y", front or "+z")


def _apply3(m, v):
    return [m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] for i in range(3)]


def model_scale(size, target, fit: str) -> float:
    """world.ts modelScale: "native" keeps the model's own size, "auto"
    fits it inside the target by the tightest known axis."""
    if fit == "native" or not target:
        return 1.0
    ratios = []
    for want, have in zip((target.get("w"), target.get("h"), target.get("d")), size,
                          strict=False):
        if want and have > 1e-9:
            ratios.append(want / have)
    return min(ratios) if ratios else 1.0


def target_m(size_mm: dict):
    """world.ts modelTargetM for a type: its measured size, else None."""
    vals = {k: size_mm.get(f"{n}_mm") for k, n in (("w", "width"), ("h", "height"),
                                                  ("d", "depth"))}
    if not any(vals.values()):
        return None
    return {k: (float(v) / 1000 if v else None) for k, v in vals.items()}


def _box_corners(lo, hi):
    return [[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]


def _aabb(points):
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    return lo, hi


class Fit:
    """The placed model's transform: turn, uniform scale, then shift so the
    upright box is centred on X and Z and stands on y = 0."""

    def __init__(self, box, up: str, front: str, fit: str, target):
        self.r = _rotation(up, front)
        lo, hi = _aabb([_apply3(self.r, c) for c in _box_corners(*box)])
        size = [b - a for a, b in zip(lo, hi, strict=False)]
        self.scale = model_scale(size, target, fit or "auto")
        c = [(a + b) / 2 for a, b in zip(lo, hi, strict=False)]
        s = self.scale
        self.position = [-c[0] * s, -lo[1] * s, -c[2] * s]

    def point(self, p):
        q = _apply3(self.r, p)
        return [self.position[i] + self.scale * q[i] for i in range(3)]

    def direction(self, n):
        return _apply3(self.r, n)

    def box(self, lo, hi):
        return _aabb([self.point(c) for c in _box_corners(lo, hi)])


# ── a type's faces from its stored anchors ─────────────────────────────────

def _v3(v, default=(0.0, 0.0, 0.0)):
    from .model_anchors import _vec

    return _vec(v, 3, default)


def substitute_module(name: str, position: str) -> str:
    """lib/model-assembly substituteModule."""
    return name.replace("{module}", position) if position else name


def _cover_visible(cover: str | None, known: set[str], drawn: set[str], mode: str) -> bool:
    """lib/model-assembly coverVisibility for one node under ``empty:<cover>``."""
    if not cover:
        return True
    if mode == "nothing":
        return False
    return cover in known and cover not in drawn


def project_type(dt, rows: list[dict] | None = None) -> dict:
    """``image_ports`` and ``image_leds`` for ``dt``'s faces with its
    reference modules (api.model_studio ``_reference_rows``) installed, from
    the anchors stored for the chassis and each module type. Returns
    ``{image_ports, image_leds, notes}``; either doc is None when it can't be
    placed (no anchors, no box, LEDs scanned before boxes were recorded).
    Raises ProjectionUnavailable without the shared table."""
    from .model_anchors import apply_dir, apply_point, unflat
    from .model_studio import _reference_rows, frame_mm, port_index

    table()
    notes: list[str] = []
    anchors = dt.model_anchors if isinstance(dt.model_anchors, dict) else {}
    box = anchors.get("box")
    if not (isinstance(box, list) and len(box) == 2):
        return {"image_ports": None, "image_leds": None,
                "notes": ["ports: the model has no stored box - not placed."]}
    rows = _reference_rows(dt) if rows is None else rows
    mode = anchors.get("empty_mode") if anchors.get("empty_mode") in (
        "filler", "hole", "nothing") else "filler"
    bays = anchors.get("bays") if isinstance(anchors.get("bays"), dict) else {}
    known = {r["name"] for r in rows}
    parts = []
    for r in rows:
        mt = r["type"]
        if mt is None or not mt.model_3d or not isinstance(bays.get(r["name"]), dict):
            continue
        parts.append((r["name"], r["position"], mt, unflat(bays[r["name"]].get("m"))))
    drawn = {p[0] for p in parts}
    fit = Fit((_v3(box[0]), _v3(box[1])), dt.model_3d_up or "y", dt.model_3d_front or "+z",
              dt.model_3d_fit or "auto",
              target_m({f: getattr(dt, f) for f in ("width_mm", "height_mm", "depth_mm")}))

    # The assembled box: the chassis' as authored, with each part posed.
    corners = [fit.point(c) for c in _box_corners(_v3(box[0]), _v3(box[1]))]
    for _bay, _pos, mt, m in parts:
        mbox = (mt.model_anchors or {}).get("box")
        if isinstance(mbox, list) and len(mbox) == 2:
            corners += [fit.point(apply_point(m, c))
                        for c in _box_corners(_v3(mbox[0]), _v3(mbox[1]))]
    lo, hi = _aabb(corners)
    frame = face_frame(frame_mm(dt), hi[1] - lo[1])
    depth = max(hi[2] - lo[2], 1e-3)

    def own(doc, key):
        rows_ = doc.get(key) if isinstance(doc, dict) else None
        return rows_.items() if isinstance(rows_, dict) else ()

    def size(a, m=None) -> dict:
        # The opening's own size (export spec 1.4, read once by
        # api.model_anchors.opening), carried through a module's bay and the
        # fit, as its extent on the face; else the table decides.
        from .model_anchors import opening, opening_extent, posed_opening

        op = opening(a)
        if op is not None and m is not None:
            op = posed_opening(m, op)
        if op is None:
            return {}
        w, h, _r, u, n = op
        ew, eh = opening_extent(fit.direction(u), fit.direction(n), w, h)
        return {"w": ew * fit.scale, "h": eh * fit.scale}

    ports = []
    for name, a in own(anchors, "ports"):
        if isinstance(a, dict) and _cover_visible(a.get("cover"), known, drawn, mode):
            ports.append({"name": str(name), "p": fit.point(_v3(a.get("p"))),
                          "n": fit.direction(_v3(a.get("n"), (0.0, 0.0, 1.0))), **size(a)})
    for _bay, pos, mt, m in parts:
        for name, a in own(mt.model_anchors, "ports"):
            if isinstance(a, dict):
                ports.append({
                    "name": substitute_module(str(name), pos),
                    "p": fit.point(apply_point(m, _v3(a.get("p")))),
                    "n": fit.direction(apply_dir(m, _v3(a.get("n"), (0.0, 0.0, 1.0)))),
                    **size(a, m),
                })
    placed = image_ports_from_anchors(ports, port_index(dt, rows), frame)
    if placed["unknown"]:
        notes.append(f"ports: {len(placed['unknown'])} match no component "
                     f"(first: {placed['unknown'][0]}) - placed as interfaces.")
    if placed["offFace"]:
        notes.append(f"ports: {len(placed['offFace'])} on neither face "
                     f"(first: {placed['offFace'][0]}).")
    image_ports = placed["doc"] if (placed["doc"]["front"] or placed["doc"]["rear"]) else None

    boxes, sources, missing = [], {}, 0
    for led_id, a in own(anchors, "leds"):
        if not isinstance(a, dict):
            continue
        if not isinstance(a.get("box"), list):
            missing += 1
            continue
        if not _cover_visible(a.get("cover"), known, drawn, mode):
            continue
        blo, bhi = fit.box(_v3(a["box"][0]), _v3(a["box"][1]))
        boxes.append({"id": str(led_id), "min": blo, "max": bhi})
        sources[f"\u0000{led_id}"] = led_source(str(led_id), dt.model_leds)
    for bay, pos, mt, m in parts:
        for led_id, a in own(mt.model_anchors, "leds"):
            if not isinstance(a, dict):
                continue
            if not isinstance(a.get("box"), list):
                missing += 1
                continue
            lid = substitute_module(str(led_id), pos)
            pts = [fit.point(apply_point(m, c))
                   for c in _box_corners(_v3(a["box"][0]), _v3(a["box"][1]))]
            blo, bhi = _aabb(pts)
            boxes.append({"id": lid, "bay": bay, "min": blo, "max": bhi})
            sources[f"{bay}\u0000{lid}"] = led_source(lid, mt.model_leds)
    image_leds = None
    if missing:
        notes.append(f"LEDs: {missing} were scanned before LED boxes were recorded - "
                     "the type's next browser render places them.")
    else:
        leds = image_leds_from_boxes(boxes, sources, frame, depth)
        if leds["offFace"]:
            notes.append(f"LEDs: {len(leds['offFace'])} on neither face "
                         f"(first: {leds['offFace'][0]}).")
        image_leds = leds["doc"]
    return {"image_ports": image_ports, "image_leds": image_leds, "notes": notes}
