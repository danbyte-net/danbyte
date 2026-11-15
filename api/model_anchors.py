"""Named anchors in an uploaded 3D model (``model_anchors``).

A model made to the export spec (docs/dcim/model-packs.md) names the nodes
Danbyte reads, exactly, in the glTF JSON:

* ``bay:<module bay name>`` - an empty where an installed module's origin
  goes; its transform is the module's pose in the chassis;
* ``empty:<module bay name>`` - the cover drawn while that bay is empty;
* ``port:<interface name>`` - a port, its local +Y pointing out of it
  (Blender's +Z after the exporter's +Y-up conversion). A module's ports keep
  their template's ``{module}`` token;
* ``led:<id>`` and ``led:port:<interface name>`` - status lights, each its
  own mesh with the material ``LED``.

The names are read from the glTF JSON, never from a loader's object names:
three.js drops ``:`` and ``/`` and turns spaces into ``_``. gltfpack ``-kn``
keeps a named node and moves its mesh onto a child, so a node's meshes are
its own plus its descendants'.

``scan`` turns the JSON into the stored doc::

    {"v": 1,
     "box": [[minx, miny, minz], [maxx, maxy, maxz]],   # every mesh, as authored
     "bays": {"PS-0": {"node": 75, "m": [16 numbers, row-major]}},
     "empties": {"PS-0": 82},
     "ports": {"Te1/0/1": {"node": 145, "p": [x, y, z], "n": [x, y, z],
                           "s": [w, h], "r": r, "u": [x, y, z]}},
     "leds": {"SYS": {"node": 139, "led_material": true,
                      "box": [[minx, miny, minz], [maxx, maxy, maxz]]}},
     "empty_mode": "filler"}          # from a pack's YAML, kept on rescans

A port empty may carry its opening's exact size as glTF node ``extras``
(export spec v1.4): ``danbyte_w`` and ``danbyte_h``, the opening's width
and height in metres along the empty's local X and Y as seen from the
front (Blender's X / Y; glTF's X / Z after the +Y-up conversion), and an
optional corner radius ``danbyte_r``. The scan stores them as ``s`` and
``r`` in model units (the parents' scale applied, the empty's own not) with
``u``, the opening's width axis (local +X) in the model frame. Everything
that sizes a port box - the 3D markers (via ``port_doc``) and a face
image's ``image_ports`` (``opening`` / ``opening_extent``) - reads them
from here: one reader of the extras. A port without them has no ``s`` and
falls back to the standard size for its type.

A port or LED inside an ``empty:`` cover also records ``"cover": <bay>``:
it shows only while that cover does. An LED's ``box`` is its meshes'
(descendants' too) as authored - what api.model_projection projects onto a
pack's rendered faces; LEDs scanned before it was recorded have none.

``port_doc`` builds the ``model_ports`` doc (api.model_ports) a device's
drawn model gets from these anchors: the chassis' ports plus each installed
module's, posed at its bay, in the chassis' upright frame.
"""
from __future__ import annotations

import math

ANCHORS_VERSION = 1
PREFIXES = ("bay:", "empty:", "port:", "led:")
EMPTY_MODES = ("filler", "hole", "nothing")
LED_MATERIAL = "LED"
#: The largest port opening (m) the size extras may name - a typo guard.
MAX_OPENING_M = 0.5
#: Warnings listed in an upload's answer at most; the rest are counted.
MAX_WARNINGS = 40

_IDENTITY = [[1.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0], [0, 0, 0, 1.0]]
# Normalised integer accessors: the divisor that maps them to -1..1 / 0..1.
_NORM = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}


# ── matrices (4x4, row-major nested lists) ─────────────────────────────────

def _mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _num(v, default=0.0) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and \
        math.isfinite(v) else default


def _vec(v, n, default):
    if isinstance(v, list) and len(v) == n:
        return [_num(x, d) for x, d in zip(v, default, strict=False)]
    return list(default)


def node_matrix(node: dict):
    """A glTF node's local transform: ``matrix`` (column-major) or T·R·S."""
    m = node.get("matrix")
    if isinstance(m, list) and len(m) == 16:
        c = [_num(x) for x in m]
        return [[c[j * 4 + i] for j in range(4)] for i in range(4)]
    tx, ty, tz = _vec(node.get("translation"), 3, (0.0, 0.0, 0.0))
    x, y, z, w = _vec(node.get("rotation"), 4, (0.0, 0.0, 0.0, 1.0))
    sx, sy, sz = _vec(node.get("scale"), 3, (1.0, 1.0, 1.0))
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    return [
        [r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, tx],
        [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, ty],
        [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def apply_point(m, p):
    return [m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] for i in range(3)]


def apply_dir(m, d):
    return [m[i][0] * d[0] + m[i][1] * d[1] + m[i][2] * d[2] for i in range(3)]


def unit(v):
    length = math.sqrt(sum(x * x for x in v))
    if length < 1e-12:
        return [0.0, 0.0, 1.0]
    return [x / length for x in v]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _length(v) -> float:
    return math.sqrt(sum(x * x for x in v))


def flat(m) -> list:
    return [round(m[i][j], 7) for i in range(4) for j in range(4)]


def unflat(f) -> list:
    if not (isinstance(f, list) and len(f) == 16):
        return [row[:] for row in _IDENTITY]
    return [[_num(f[i * 4 + j]) for j in range(4)] for i in range(4)]


# ── the scan ────────────────────────────────────────────────────────────────

def _world(doc: dict) -> dict[int, list]:
    """Every node reachable from the default scene, with its world matrix.
    A malformed or cyclic hierarchy stops where it breaks."""
    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    scenes = doc.get("scenes") if isinstance(doc.get("scenes"), list) else []
    idx = doc.get("scene", 0)
    scene = scenes[idx] if isinstance(idx, int) and 0 <= idx < len(scenes) else (
        scenes[0] if scenes else None)
    roots = scene.get("nodes", []) if isinstance(scene, dict) else list(range(len(nodes)))
    out: dict[int, list] = {}
    stack = [(r, _IDENTITY) for r in roots if isinstance(r, int)]
    while stack:
        i, parent = stack.pop()
        if not (0 <= i < len(nodes)) or i in out or not isinstance(nodes[i], dict):
            continue
        m = _mul(parent, node_matrix(nodes[i]))
        out[i] = m
        for c in nodes[i].get("children") or []:
            if isinstance(c, int):
                stack.append((c, m))
    return out


def _accessor_box(doc: dict, acc_index):
    accs = doc.get("accessors") or []
    if not isinstance(acc_index, int) or not (0 <= acc_index < len(accs)):
        return None
    acc = accs[acc_index]
    if not isinstance(acc, dict):
        return None
    lo, hi = acc.get("min"), acc.get("max")
    if not (isinstance(lo, list) and isinstance(hi, list) and len(lo) == 3 and len(hi) == 3):
        return None
    lo, hi = [_num(x) for x in lo], [_num(x) for x in hi]
    if acc.get("normalized"):
        div = _NORM.get(acc.get("componentType"))
        if div:
            lo = [max(x / div, -1.0) for x in lo]
            hi = [max(x / div, -1.0) for x in hi]
    return lo, hi


def _mesh_box(doc: dict, mesh_index):
    meshes = doc.get("meshes") or []
    if not isinstance(mesh_index, int) or not (0 <= mesh_index < len(meshes)):
        return None
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for prim in (meshes[mesh_index] or {}).get("primitives") or []:
        attrs = prim.get("attributes") if isinstance(prim, dict) else None
        box = _accessor_box(doc, (attrs or {}).get("POSITION"))
        if box is None:
            continue
        lo = [min(a, b) for a, b in zip(lo, box[0], strict=False)]
        hi = [max(a, b) for a, b in zip(hi, box[1], strict=False)]
    return (lo, hi) if lo[0] <= hi[0] else None


def _corners(lo, hi):
    return [[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]


def scene_box(doc: dict, world: dict | None = None):
    """The bounding box of every mesh as authored (each mesh's accessor box
    through its world matrix) - what three's ``Box3.setFromObject`` gives
    the loaded scene. None when the file has no meshes."""
    world = _world(doc) if world is None else world
    nodes = doc.get("nodes") or []
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for i, m in world.items():
        box = _mesh_box(doc, nodes[i].get("mesh"))
        if box is None:
            continue
        for c in _corners(*box):
            p = apply_point(m, c)
            lo = [min(a, b) for a, b in zip(lo, p, strict=False)]
            hi = [max(a, b) for a, b in zip(hi, p, strict=False)]
    if lo[0] > hi[0]:
        return None
    return [[round(x, 6) for x in lo], [round(x, 6) for x in hi]]


def _subtree(doc: dict, i: int) -> list[int]:
    nodes = doc.get("nodes") or []
    out: list[int] = []
    seen: set[int] = set()
    stack = [i]
    while stack:
        n = stack.pop()
        if n in seen or not (0 <= n < len(nodes)) or not isinstance(nodes[n], dict):
            continue
        seen.add(n)
        out.append(n)
        stack.extend(c for c in nodes[n].get("children") or [] if isinstance(c, int))
    return out


def subtree_box(doc: dict, i: int, world: dict):
    """The box of node ``i``'s meshes and its descendants', as authored."""
    nodes = doc.get("nodes") or []
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for n in _subtree(doc, i):
        if n not in world:
            continue
        box = _mesh_box(doc, nodes[n].get("mesh"))
        if box is None:
            continue
        for c in _corners(*box):
            p = apply_point(world[n], c)
            lo = [min(a, b) for a, b in zip(lo, p, strict=False)]
            hi = [max(a, b) for a, b in zip(hi, p, strict=False)]
    if lo[0] > hi[0]:
        return None
    return [[round(x, 6) for x in lo], [round(x, 6) for x in hi]]


def _covers(doc: dict, world: dict) -> dict[int, str]:
    """Each node under an ``empty:<bay>`` node, with that bay's name."""
    nodes = doc.get("nodes") or []
    out: dict[int, str] = {}
    for i in world:
        name = nodes[i].get("name")
        if isinstance(name, str) and name.startswith("empty:") and len(name) > 6:
            for n in _subtree(doc, i):
                out.setdefault(n, name[6:])
    return out


def _materials_under(doc: dict, i: int) -> set[str]:
    """The material names of node ``i``'s meshes and its descendants' (a
    ``-kn`` export moves a named node's mesh onto a child)."""
    nodes, meshes = doc.get("nodes") or [], doc.get("meshes") or []
    mats = doc.get("materials") or []
    out: set[str] = set()
    seen: set[int] = set()
    stack = [i]
    while stack:
        n = stack.pop()
        if n in seen or not (0 <= n < len(nodes)) or not isinstance(nodes[n], dict):
            continue
        seen.add(n)
        mi = nodes[n].get("mesh")
        if isinstance(mi, int) and 0 <= mi < len(meshes):
            for prim in (meshes[mi] or {}).get("primitives") or []:
                k = prim.get("material") if isinstance(prim, dict) else None
                name = ""
                if isinstance(k, int) and 0 <= k < len(mats) and isinstance(mats[k], dict):
                    name = str(mats[k].get("name") or "")
                out.add(name)
        stack.extend(c for c in nodes[n].get("children") or [] if isinstance(c, int))
    return out


def _extra(extras: dict, key: str):
    v = extras.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return float(v)


def _opening(node: dict, m) -> dict | None:
    """A port empty's opening from its ``danbyte_w`` / ``danbyte_h`` /
    ``danbyte_r`` extras, in model units: ``{"s": [w, h], "r": r, "u":
    width axis}``. None without both sizes, or with one out of range."""
    extras = node.get("extras")
    if not isinstance(extras, dict):
        return None
    w, h = _extra(extras, "danbyte_w"), _extra(extras, "danbyte_h")
    if w is None or h is None or not (0 < w <= MAX_OPENING_M and 0 < h <= MAX_OPENING_M):
        return None
    r = _extra(extras, "danbyte_r")
    # The extras are in the empty's own frame; its parents' scale carries
    # them into model units, its own scale (an empty's display size) not.
    local = node_matrix(node)
    own_x = _length([local[k][0] for k in range(3)]) or 1.0
    own_z = _length([local[k][2] for k in range(3)]) or 1.0
    wx = apply_dir(m, [1, 0, 0])
    hz = apply_dir(m, [0, 0, 1])
    sw, sh = _length(wx) / own_x, _length(hz) / own_z
    if sw < 1e-12 or sh < 1e-12:
        return None
    out = {"s": [round(w * sw, 7), round(h * sh, 7)],
           "u": [round(x, 5) for x in unit(wx)]}
    if r is not None and r > 0:
        out["r"] = round(min(r, w / 2, h / 2) * min(sw, sh), 7)
    return out


def opening(anchor) -> tuple[float, float, float, list, list] | None:
    """A stored port anchor's opening: ``(w, h, r, u, n)`` in model units -
    width, height, corner radius, width axis, outward normal - or None when
    the model gave no size (the caller's per-type table applies)."""
    if not isinstance(anchor, dict):
        return None
    s = anchor.get("s")
    if not (isinstance(s, list) and len(s) == 2):
        return None
    w, h = _num(s[0]), _num(s[1])
    if w <= 0 or h <= 0:
        return None
    n = unit(_vec(anchor.get("n"), 3, (0.0, 0.0, 1.0)))
    u = _vec(anchor.get("u"), 3, (1.0, 0.0, 0.0))
    # Keep the width axis in the opening's plane.
    d = sum(a * b for a, b in zip(u, n, strict=False))
    u = unit([a - d * b for a, b in zip(u, n, strict=False)])
    return w, h, max(0.0, _num(anchor.get("r"))), u, n


def opening_extent(u, n, w: float, h: float) -> tuple[float, float]:
    """The opening's axis-aligned extent on a face seen along Z (its X and
    Y spans): a rectangle ``w`` along ``u`` by ``h`` along ``n × u``, turned
    however the port is. A face image's ``image_ports`` box is this over the
    face frame (with ``u``/``n`` in the frame the face is projected in)."""
    v = unit(cross(n, u))
    return (abs(u[0]) * w + abs(v[0]) * h, abs(u[1]) * w + abs(v[1]) * h)


def scan(doc: dict) -> tuple[dict, list[str]]:
    """The anchors of a parsed glTF JSON (``api.model_3d.validate_glb``'s
    result), and warnings about the names themselves (duplicates, LEDs
    without the LED material). Only nodes in the default scene count."""
    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    world = _world(doc)
    covers = _covers(doc, world)
    out = {"v": ANCHORS_VERSION, "box": scene_box(doc, world),
           "bays": {}, "empties": {}, "ports": {}, "leds": {}}
    warnings: list[str] = []
    for i in sorted(world):
        name = nodes[i].get("name")
        if not isinstance(name, str) or not name.startswith(PREFIXES):
            continue
        prefix, _, rest = name.partition(":")
        if not rest:
            warnings.append(f"“{name}” has no name after the prefix.")
            continue
        key = {"bay": "bays", "empty": "empties", "port": "ports", "led": "leds"}[prefix]
        if rest in out[key]:
            warnings.append(f"“{name}” is in the model twice; the first one counts.")
            continue
        m = world[i]
        if key == "bays":
            out["bays"][rest] = {"node": i, "m": flat(m)}
        elif key == "empties":
            out["empties"][rest] = i
        elif key == "ports":
            out["ports"][rest] = {
                "node": i,
                "p": [round(x, 6) for x in apply_point(m, [0, 0, 0])],
                "n": [round(x, 5) for x in unit(apply_dir(m, [0, 1, 0]))],
                **(_opening(nodes[i], m) or {}),
            }
            if i in covers:
                out["ports"][rest]["cover"] = covers[i]
        else:
            mats = _materials_under(doc, i)
            ok = mats == {LED_MATERIAL}
            out["leds"][rest] = {"node": i, "led_material": ok}
            box = subtree_box(doc, i, world)
            if box is not None:
                out["leds"][rest]["box"] = box
            if i in covers:
                out["leds"][rest]["cover"] = covers[i]
            if not ok:
                warnings.append(f"“{name}” does not use the material “{LED_MATERIAL}”.")
    return out, warnings


def counts(anchors: dict | None) -> dict:
    a = anchors or {}
    return {k: len(a.get(k) or {}) for k in ("bays", "empties", "ports", "leds")}


def summary(anchors: dict | None) -> str:
    """``"7 bays, 53 ports, 54 LEDs"`` - what the upload found."""
    c = counts(anchors)
    parts = []
    for key, one, many in (("bays", "bay", "bays"), ("ports", "port", "ports"),
                           ("leds", "LED", "LEDs")):
        n = c[key]
        parts.append(f"{n} {one if n == 1 else many}")
    return ", ".join(parts)


# ── checking against the type ───────────────────────────────────────────────

def template_names(obj) -> tuple[list[str] | None, list[str]]:
    """The module bay names (None on a module type: it has no bays) and
    interface names the model's anchors should match, for a device type, a
    module type or a device with its own model."""
    from .models import Device, DeviceType, ModuleType

    if isinstance(obj, DeviceType):
        return (list(obj.module_bay_templates.values_list("name", flat=True)),
                list(obj.interface_templates.values_list("name", flat=True)))
    if isinstance(obj, ModuleType):
        return None, list(obj.interface_templates.values_list("name", flat=True))
    if isinstance(obj, Device):
        return (list(obj.module_bays.values_list("name", flat=True)),
                list(obj.interfaces.values_list("name", flat=True)))
    return [], []


def mismatches(anchors: dict, bay_names, interface_names) -> list[str]:
    """Names in the model with nothing to match in the type, and the type's
    bays the model has no anchor for. Warnings only: a model may cover part
    of a type, and the names can be fixed on either side."""
    out: list[str] = []
    bays = anchors.get("bays") or {}
    empties = anchors.get("empties") or {}
    ports = anchors.get("ports") or {}
    leds = anchors.get("leds") or {}
    ifaces = set(interface_names or [])
    if bay_names is None:
        for b in bays:
            out.append(f"bay:{b} - a module's model holds no bays; it is ignored.")
    else:
        known = set(bay_names)
        for b in bays:
            if b not in known:
                out.append(f"bay:{b} matches no module bay.")
        for b in bay_names:
            if b not in bays:
                out.append(f"Module bay “{b}” has no bay:{b} anchor.")
    for e in empties:
        if e not in bays:
            out.append(f"empty:{e} has no bay:{e} beside it.")
    for p in ports:
        if p not in ifaces:
            out.append(f"port:{p} matches no interface.")
    if ports:
        missing = [i for i in interface_names or [] if i not in ports]
        if missing:
            n = len(missing)
            out.append(f"{n} interface{'s' if n != 1 else ''} without a port: anchor "
                       f"(first: {missing[0]}).")
    for led in leds:
        if led.startswith("port:") and led[5:] not in ifaces:
            out.append(f"led:{led} matches no interface.")
    return out


def far_mismatches(near: dict | None, far: dict) -> list[str]:
    """What a far LOD lacks of the full model's bays, covers and LEDs."""
    out = []
    for key, prefix in (("bays", "bay"), ("empties", "empty"), ("leds", "led")):
        mine = (near or {}).get(key) or {}
        theirs = far.get(key) or {}
        for name in mine:
            if name not in theirs:
                out.append(f"The far model has no {prefix}:{name}.")
    return out


def capped(warnings: list[str]) -> list[str]:
    if len(warnings) <= MAX_WARNINGS:
        return warnings
    rest = len(warnings) - MAX_WARNINGS
    return warnings[:MAX_WARNINGS] + [f"…and {rest} more."]


def scan_result(obj, doc: dict, *, far: bool = False) -> tuple[dict, dict]:
    """The anchors to store for ``obj``'s new model (``doc`` its parsed JSON)
    and the upload's report ``{summary, counts, warnings}``. A far LOD is
    compared with the full model instead of the type."""
    anchors, warnings = scan(doc)
    if far:
        warnings += far_mismatches(obj.model_anchors, anchors)
    else:
        bay_names, ifaces = template_names(obj)
        warnings += mismatches(anchors, bay_names, ifaces)
        mode = (obj.model_anchors or {}).get("empty_mode")
        if mode in EMPTY_MODES:
            anchors["empty_mode"] = mode
    report = {"summary": summary(anchors), "counts": counts(anchors),
              "warnings": capped(warnings)}
    return anchors, report


def report_for(obj) -> dict | None:
    """The stored model's report, recomputed against the type as it is now."""
    anchors = obj.model_anchors
    if not anchors or not obj.model_3d:
        return None
    bay_names, ifaces = template_names(obj)
    return {"summary": summary(anchors), "counts": counts(anchors),
            "warnings": capped(mismatches(anchors, bay_names, ifaces))}


# ── ports from anchors ──────────────────────────────────────────────────────

def _upright(up: str, front: str):
    """The room's up/front turn as a 4x4 (api.model_ports._rotation)."""
    from .model_ports import _rotation

    r = _rotation(up, front)
    return [r[0] + [0.0], r[1] + [0.0], r[2] + [0.0], [0.0, 0.0, 0.0, 1.0]]


def _port_points(anchors):
    ports = (anchors or {}).get("ports")
    for name, a in (ports.items() if isinstance(ports, dict) else ()):
        if isinstance(a, dict):
            yield (str(name), _vec(a.get("p"), 3, (0.0, 0.0, 0.0)),
                   _vec(a.get("n"), 3, (0.0, 0.0, 1.0)), opening(a))


def posed_opening(m, op):
    """An ``opening`` carried through a transform ``m`` (a module's bay)."""
    if op is None:
        return None
    w, h, r, u, n = op
    v = unit(cross(n, u))
    su, sv = _length(apply_dir(m, u)), _length(apply_dir(m, v))
    return w * su, h * sv, r * min(su, sv), unit(apply_dir(m, u)), unit(apply_dir(m, n))


def port_doc(owner, parts) -> dict | None:
    """The ``model_ports`` doc the anchors give ``owner``'s model (a device
    type's or a device's own) with ``parts`` installed: ``[(bay_name,
    render, module_anchors)]``, ``render`` turning a module template's name
    into the device's interface name. None when no port anchor applies or
    the model's box is unknown."""
    anchors = owner.model_anchors or {}
    box = anchors.get("box")
    if not (isinstance(box, list) and len(box) == 2):
        return None
    points: list[tuple[str, list, list, tuple | None]] = []
    for name, p, n, op in _port_points(anchors):
        points.append((name, p, n, op))
    bays = anchors.get("bays") or {}
    for bay_name, render, mod in parts:
        bay = bays.get(bay_name)
        if not isinstance(bay, dict):
            continue
        m = unflat(bay.get("m"))
        for name, p, n, op in _port_points(mod):
            points.append((render(name), apply_point(m, p), apply_dir(m, n),
                           posed_opening(m, op)))
    if not points:
        return None
    r = _upright(owner.model_3d_up or "y", owner.model_3d_front or "+z")
    box = (_vec(box[0], 3, (0.0, 0.0, 0.0)), _vec(box[1], 3, (0.0, 0.0, 0.0)))
    corners = [apply_point(r, c) for c in _corners(*box)]
    lo = [min(c[i] for c in corners) for i in range(3)]
    hi = [max(c[i] for c in corners) for i in range(3)]
    size = [b - a for a, b in zip(lo, hi, strict=False)]
    if min(size) <= 0:
        return None
    longest = max(size)
    ports, seen = [], set()
    for name, p, n, op in points:
        if not name or len(name) > 64 or name in seen:
            continue
        seen.add(name)
        q = apply_point(r, p)
        entry = {
            "kind": "interface", "name": name,
            "p": [round(min(1.0, max(0.0, (q[i] - lo[i]) / size[i])), 5) for i in range(3)],
            "n": [round(x, 5) for x in unit(apply_dir(r, n))],
        }
        if op is not None:
            w, h, rad, u, _n = op
            # Shares of the upright box's longest edge: the model is fitted
            # with one uniform scale, so the room turns them into metres
            # with its fitted size alone.
            entry["s"] = [round(w / longest, 6), round(h / longest, 6)]
            entry["u"] = [round(x, 5) for x in unit(apply_dir(r, u))]
            if rad > 0:
                entry["r"] = round(rad / longest, 6)
        ports.append(entry)
    return {"bounds": [round(s, 6) for s in size], "ports": ports}
