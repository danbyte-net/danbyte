"""Rack-face images generated from a device type's 3D model ("studio").

The browser renders them (frontend lib/model-studio + floorplan3d/studio):
the assembled model - chassis plus the reference configuration's modules,
covers elsewhere - through orthographic cameras fitted to the rack face, and
a three-quarter view. It projects every ``port:`` anchor and ``led:`` node
onto the faces, and posts the lot here. This module owns what the server
decides:

* the frame the faces are fitted to (``frame_mm``) and the modules shown
  (``model_reference``, checked by ``validate_reference``);
* a token for the model state an image set was made from, so a type whose
  model, reference modules or size changed reads as *pending*;
* the never-overwrite rule: a face or port map not made here (uploaded by
  hand, imported from the library) is replaced only when the request names it
  in ``overwrite`` - what the user confirmed.

``images_generated`` on the type records ``{front|rear|iso|image_ports|
image_leds: token}``; a hand upload or a hand-edited port map drops its key.

A model pack can ship the faces rendered in Blender (api.model_pack,
``model3d.renders``). Those keys hold ``"pack"`` instead of a token, and
``pack_import["images"]`` says what they were made from: the pack, the
model's sha256 (and the stored file's version once it matched), the frame
and the modules shown. They count as generated - a browser render replaces
them without asking - and are current while the stored model, the frame and
the reference modules (by part number) are still the ones they show.
"""
from __future__ import annotations

import hashlib
import json
import uuid

from django.core.exceptions import ValidationError as DjangoValidationError

#: The images a type may have generated.
FACES = ("front", "rear", "iso")
#: Everything generation may write, in the order it is reported.
TARGETS = (*FACES, "image_ports", "image_leds")
#: Rack geometry (mm): a full-width 19-inch face across the ears, one unit.
RACK_FACE_MM = 482.6
RACK_UNIT_MM = 44.45
#: An uploaded generated image's cap (a 2000 px WebP face is a few hundred kB).
MAX_IMAGE_BYTES = 8 * 1024 * 1024
#: LEDs one image set may place.
MAX_LEDS = 2048
IMAGE_FORMATS = ("WEBP", "PNG")
#: What ``images_generated`` holds for an image a model pack shipped.
PACK = "pack"


# ── the frame and the token ─────────────────────────────────────────────────

def frame_mm(dt) -> list:
    """``[width, height]`` of the faces in mm: the type's width, else the
    rack face (half of it for half-width gear); its rack units, else its
    height, else None (the model's own height)."""
    if dt.width_mm:
        w = float(dt.width_mm)
    else:
        w = RACK_FACE_MM / 2 if dt.rack_width == "half" else RACK_FACE_MM
    if dt.u_height:
        h = dt.u_height * RACK_UNIT_MM
    elif dt.height_mm:
        h = float(dt.height_mm)
    else:
        h = None
    return [round(w, 2), round(h, 2) if h is not None else None]


def _reference_rows(dt) -> list[dict]:
    """The type's module bays in natural order, each with the reference
    module type (or None) - without a reader's scope."""
    from .models import ModuleType
    from .natural import natural_key

    ref = dt.model_reference if isinstance(dt.model_reference, dict) else {}
    bays = sorted(dt.module_bay_templates.all(), key=lambda b: natural_key(b.name))
    ids = {str(v) for v in ref.values() if isinstance(v, str)}
    types = {}
    if ids:
        try:
            types = {str(m.id): m for m in ModuleType.objects.filter(
                tenant_id=dt.tenant_id, id__in=ids)}
        except DjangoValidationError:
            types = {}
    return [{"name": b.name, "position": b.position, "type": types.get(str(ref.get(b.name)))}
            for b in bays]


def token(dt, rows: list[dict] | None = None) -> str:
    """What the generated images depend on, hashed: the model file, how it
    is fitted, the face frame and each reference module's model."""
    from .model_3d import version_of

    if not dt.model_3d:
        return ""
    rows = _reference_rows(dt) if rows is None else rows
    parts = [
        version_of(dt.model_3d), dt.model_3d_fit, dt.model_3d_up, dt.model_3d_front,
        json.dumps(frame_mm(dt)),
        *(str(getattr(dt, f) or "") for f in ("width_mm", "height_mm", "depth_mm")),
    ]
    for r in rows:
        mt = r["type"]
        if mt is not None and mt.model_3d:
            parts.append(f"{r['name']}={r['position']}={mt.id}={version_of(mt.model_3d)}")
    return hashlib.sha256("\u0000".join(parts).encode()).hexdigest()[:16]


def generated(dt) -> dict:
    g = dt.images_generated
    return g if isinstance(g, dict) else {}


def pack_images(dt) -> dict:
    """What the type's pack-rendered images were made from (or {})."""
    meta = dt.pack_import if isinstance(dt.pack_import, dict) else {}
    images = meta.get("images")
    return images if isinstance(images, dict) else {}


def reference_parts(rows: list[dict]) -> dict:
    """``{bay: part number}`` of the reference modules - how a pack's
    ``renders.modules`` names them."""
    return {r["name"]: (r["type"].part_number or r["type"].name)
            for r in rows if r["type"] is not None}


def pack_current(dt, rows: list[dict] | None = None) -> bool:
    """Whether the pack's renders still show the type: the model they were
    rendered from (sha256 matched at import, the stored file unchanged
    since), the same face frame and the same modules."""
    from .model_3d import version_of

    meta = pack_images(dt)
    if not meta or meta.get("stale") or not dt.model_3d:
        return False
    if meta.get("model_version") != version_of(dt.model_3d):
        return False
    if meta.get("frame_mm") != frame_mm(dt):
        return False
    rows = _reference_rows(dt) if rows is None else rows
    return reference_parts(rows) == (meta.get("modules") or {})


def pending(dt, current: str | None = None) -> bool:
    """A type with a model whose images are missing or were made from an
    older model state. Faces made by hand don't count: they stay."""
    if not dt.model_3d:
        return False
    made = generated(dt)
    pack_ok = None
    for face in FACES:
        f = getattr(dt, f"{face}_image")
        if not f:
            return True
        if face not in made:
            continue
        if made[face] == PACK:
            if pack_ok is None:
                pack_ok = pack_current(dt)
            if not pack_ok:
                return True
            continue
        current = token(dt) if current is None else current
        if made[face] != current:
            return True
    return False


def sources(dt) -> dict:
    """Where each face came from: ``pack``, ``generated`` (a browser
    render), ``uploaded`` (by hand or the library) or None (no image)."""
    made = generated(dt)
    out = {}
    for face in FACES:
        if not getattr(dt, f"{face}_image"):
            out[face] = None
        elif face not in made:
            out[face] = "uploaded"
        else:
            out[face] = "pack" if made[face] == PACK else "generated"
    return out


def images_source(dt) -> dict:
    """The serializer's ``images_source``: each face's source and, when a
    face came from a pack, which pack and whether it still matches."""
    faces = sources(dt)
    pack = None
    if PACK in faces.values():
        meta = dt.pack_import if isinstance(dt.pack_import, dict) else {}
        info = meta.get("pack") if isinstance(meta.get("pack"), dict) else {}
        images = pack_images(dt)
        pack = {"name": info.get("name") or "", "version": info.get("version") or "",
                "current": pack_current(dt), "note": images.get("note") or ""}
    return {**faces, "pack": pack}


def hand_made(dt) -> list[str]:
    """What generation would only replace when asked: a face with an image
    or a port map with markers that were not generated here."""
    made = generated(dt)
    out = [face for face in FACES if getattr(dt, f"{face}_image") and face not in made]
    if _has_markers(dt.image_ports) and "image_ports" not in made:
        out.append("image_ports")
    return out


def _has_markers(doc) -> bool:
    return isinstance(doc, dict) and any(doc.get(s) for s in ("front", "rear"))


def forget(dt, *keys: str) -> bool:
    """Drop ``keys`` from what the type says was generated (a hand upload or
    edit replaced them). Returns True when anything changed; not saved."""
    made = generated(dt)
    if not any(k in made for k in keys):
        return False
    rest = {k: v for k, v in made.items() if k not in keys}
    dt.images_generated = rest or None
    return True


def markers_changed(old, new) -> bool:
    """Whether a port-map write moves, adds or removes markers - not only
    the zoom or calibration under ``view``."""
    def markers(doc):
        doc = doc if isinstance(doc, dict) else {}
        return [doc.get("front") or [], doc.get("rear") or []]
    return markers(old) != markers(new)


# ── the reference configuration ─────────────────────────────────────────────

def validate_reference(dt, value, user=None, tenant=None):
    """``value`` cleaned for ``dt.model_reference``, or DRF's ValidationError.
    Each key is one of the type's module bays and the chassis model has its
    ``bay:`` node; each value a module type of the type's tenant the user may
    view, with a 3D model. Empty clears it (covers everywhere)."""
    from rest_framework.exceptions import ValidationError

    from auth_api import rbac

    from .models import ModuleType

    if value in (None, {}):
        return None
    if not isinstance(value, dict):
        raise ValidationError("Map module bay names to module type ids.")
    if len(value) > 256:
        raise ValidationError("Too many bays.")
    bays = set(dt.module_bay_templates.values_list("name", flat=True))
    anchored = set(((dt.model_anchors or {}).get("bays") or {}).keys())
    errors: dict[str, str] = {}
    ids: dict[str, str] = {}
    for bay, mt_id in value.items():
        if not isinstance(bay, str) or bay not in bays:
            errors[str(bay)[:64]] = "No module bay of this name."
            continue
        if dt.model_3d and anchored and bay not in anchored:
            errors[bay] = "The 3D model has no bay of this name."
            continue
        if not isinstance(mt_id, str):
            errors[bay] = "A module type id."
            continue
        ids[bay] = mt_id
    qs = ModuleType.objects.filter(tenant_id=dt.tenant_id)
    if user is not None:
        qs = rbac.restrict_queryset(qs, user, tenant or dt.tenant, "moduletype", "view")
    try:
        found = {str(m.id): m for m in qs.filter(id__in=set(ids.values()))}
    except DjangoValidationError:
        found = {}
    out = {}
    for bay, mt_id in ids.items():
        mt = found.get(mt_id)
        if mt is None:
            errors[bay] = "No such module type."
        elif not mt.model_3d:
            errors[bay] = f"{mt.name} has no 3D model."
        else:
            out[bay] = str(mt.id)
    if errors:
        raise ValidationError(errors)
    return out or None


# ── what the studio renders ─────────────────────────────────────────────────

def _port_index_of(owners) -> dict:
    """``{name: [kind, type]}`` over ``(kind, rows, render)`` triples."""
    out: dict[str, list] = {}
    for kind, rows, render in owners:
        for row in rows:
            name = render(row.name)
            out.setdefault(name, [kind, str(getattr(row, "type", "") or "")])
    return out


_TEMPLATE_RELS = (
    ("interface", "interface_templates"),
    ("console-port", "console_port_templates"),
    ("console-server-port", "console_server_port_templates"),
    ("power-port", "power_port_templates"),
    ("power-outlet", "power_outlet_templates"),
    ("front-port", "front_port_templates"),
    ("rear-port", "rear_port_templates"),
    ("aux-port", "aux_port_templates"),
)


def _leds_of(owner) -> dict:
    leds = owner.model_leds
    return leds if isinstance(leds, dict) else {}


def port_index(dt, rows: list[dict]) -> dict:
    """``{name: [kind, type]}`` of the type's components and the reference
    modules' interfaces (named for their bay) - what a port anchor names."""
    from .models import render_module_name

    owners = [(kind, getattr(dt, rel).all(), str) for kind, rel in _TEMPLATE_RELS]
    for r in rows:
        mt = r["type"]
        if mt is not None and mt.model_3d:
            pos = r["position"]
            owners.append(("interface", mt.interface_templates.all(),
                           lambda n, pos=pos: render_module_name(n, pos)))
    return _port_index_of(owners)


def type_payload(dt, user=None, tenant=None) -> dict:
    """``GET /api/device-types/{id}/studio/``: what the renderer needs - the
    model, its frame, the reference modules per bay (with their models,
    LED sources and port names), the port kinds by name and the token to
    send back with the images."""
    from auth_api import rbac

    from .model_3d import far_type_url, options_of, type_url
    from .models import ModuleType, render_module_name

    rows = _reference_rows(dt)
    visible = set()
    want = {r["type"].id for r in rows if r["type"] is not None}
    if want:
        qs = ModuleType.objects.filter(id__in=want)
        if user is not None:
            qs = rbac.restrict_queryset(qs, user, tenant or dt.tenant, "moduletype", "view")
        visible = set(qs.values_list("id", flat=True))
    owners = [(kind, getattr(dt, rel).all(), str) for kind, rel in _TEMPLATE_RELS]
    bays = []
    for r in rows:
        mt = r["type"] if r["type"] is not None and r["type"].id in visible else None
        part = None
        if mt is not None and mt.model_3d:
            part = {"url": type_url(mt), "far_url": far_type_url(mt)}
            pos = r["position"]
            owners.append(("interface", mt.interface_templates.all(),
                           lambda n, pos=pos: render_module_name(n, pos)))
        bays.append({
            "name": r["name"], "position": r["position"], "installed": part is not None,
            "part": part,
            "module_type": {"id": str(mt.id), "name": mt.name} if mt is not None else None,
            "leds": _leds_of(mt) if mt is not None else {},
        })
    mode = (dt.model_anchors or {}).get("empty_mode")
    current = token(dt, rows)
    return {
        "model": {
            "url": type_url(dt), **options_of(dt),
            "empty_mode": mode if mode in ("filler", "hole", "nothing") else "filler",
        } if dt.model_3d else None,
        "size_mm": {f: float(getattr(dt, f)) if getattr(dt, f) is not None else None
                    for f in ("width_mm", "height_mm", "depth_mm")},
        "frame_mm": frame_mm(dt),
        "bays": bays,
        "leds": _leds_of(dt),
        "ports": _port_index_of(owners),
        "token": current,
        "pending": pending(dt, current),
        "generated": sorted(generated(dt)),
        "hand_made": hand_made(dt),
        "sources": images_source(dt),
    }


def device_payload(device, user=None, tenant=None) -> dict:
    """``GET /api/devices/{id}/studio/``: the same for one device drawn with
    the modules it has installed (its ``model_3d_effective`` bays), and its
    own components by name. ``covers`` / ``bay_covers`` are the port covers
    its ports in use hide (api.port_covers, as ``user`` may see them); a
    type's render has none. Nothing is stored for a device but its photo
    port override, through the usual PATCH."""
    from .face_ports import FACE_PORT_KINDS
    from .model_3d import effective_owner, parts_of
    from .port_covers import hidden_covers

    dt = device.device_type
    owner = effective_owner(device)
    owners = []
    for kind, (rel, _) in FACE_PORT_KINDS.items():
        if kind in ("antenna", "inventory-item", "module-bay"):
            continue
        owners.append((kind, getattr(device, rel).all(), str))
    leds = {}
    for r in parts_of(device):
        if r["type"] is not None and r["type_viewable"]:
            leds[r["name"]] = _leds_of(r["type"])
    covers = {"covers": [], "bay_covers": {}}
    if user is not None and tenant is not None:
        covers = hidden_covers([device], {device.id: owner}, user, tenant)[str(device.id)]
    return {
        "frame_mm": frame_mm(dt) if dt is not None else None,
        "size_mm": {f: float(getattr(dt, f)) if dt is not None and getattr(dt, f) is not None
                    else None for f in ("width_mm", "height_mm", "depth_mm")},
        "leds": _leds_of(owner) if owner is not None else {},
        "bay_leds": leds,
        "ports": _port_index_of(owners),
        "own_image_ports": _has_markers(device.image_ports),
        **covers,
    }


# ── storing a generated set ─────────────────────────────────────────────────

def _read_image(upload, label: str):
    """The checked upload (a WebP or PNG), re-saved without metadata."""
    from PIL import Image
    from rest_framework.exceptions import ValidationError

    from .images import downscale_image

    size = getattr(upload, "size", None)
    if size is None or size > MAX_IMAGE_BYTES:
        raise ValidationError({label: "The image is too large."})
    try:
        img = Image.open(upload)
        img.verify()
        fmt = (img.format or "").upper()
    except Exception as exc:  # noqa: BLE001 - not an image
        raise ValidationError({label: "Not an image."}) from exc
    if fmt not in IMAGE_FORMATS:
        raise ValidationError({label: "Send a WebP or PNG image."})
    upload.seek(0)
    return downscale_image(upload), fmt.lower()


def _json_field(data, key):
    from rest_framework.exceptions import ValidationError

    raw = data.get(key)
    if raw in (None, ""):
        return None
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValidationError({key: "Not JSON."}) from exc


def validate_image_leds(value):
    """An ``image_leds`` doc: like ``image_ports``, every entry a ``led``
    with a name, an optional bay and source, and a box in 0..1."""
    from rest_framework.exceptions import ValidationError

    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValidationError({"image_leds": 'image_leds must be {"front": [...], "rear": [...]}.'})
    out, total = {}, 0
    for side in ("front", "rear"):
        rows = value.get(side, [])
        if not isinstance(rows, list):
            raise ValidationError({"image_leds": f"{side} must be a list."})
        total += len(rows)
        clean = []
        for m in rows:
            if not isinstance(m, dict) or m.get("kind", "led") != "led":
                raise ValidationError({"image_leds": "Each entry must be an LED."})
            name = m.get("name")
            if not isinstance(name, str) or not name or len(name) > 128:
                raise ValidationError({"image_leds": "LEDs need a name (≤128 chars)."})
            row = {"kind": "led", "name": name}
            for k in ("x", "y", "w", "h"):
                v = m.get(k)
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1:
                    raise ValidationError({"image_leds": f"LED {k} must be a number in 0..1."})
                row[k] = round(float(v), 5)
            for k, cap in (("bay", 64), ("source", 64)):
                v = m.get(k)
                if v is not None:
                    if not isinstance(v, str) or len(v) > cap:
                        raise ValidationError({"image_leds": f"LED {k} must be text."})
                    row[k] = v
            clean.append(row)
        out[side] = clean
    if total > MAX_LEDS:
        raise ValidationError({"image_leds": f"Too many LEDs (max {MAX_LEDS})."})
    return out


def store(dt, request) -> dict:
    """``POST /api/device-types/{id}/studio/`` (multipart): ``front_image``,
    ``rear_image``, ``iso_image`` files, ``image_ports`` / ``image_leds``
    JSON, the ``token`` they were rendered from and ``overwrite`` - the
    comma-separated targets made by hand the user agreed to replace.
    Returns ``{written, kept}``; saves the type."""
    from rest_framework.exceptions import ValidationError

    from .face_ports import drop_calibration, validate_image_ports_doc

    data = request.data
    if not dt.model_3d:
        raise ValidationError({"detail": "The type has no 3D model."})
    current = token(dt)
    if data.get("token") != current:
        raise ValidationError(
            {"token": "The model or its reference modules changed. Generate again."})
    overwrite = {s.strip() for s in str(data.get("overwrite") or "").split(",") if s.strip()}
    made = dict(generated(dt))
    written, kept = [], []

    def allowed(key, present) -> bool:
        if present and key not in made and key not in overwrite:
            kept.append(key)
            return False
        return True

    images = {}
    for face in FACES:
        up = request.FILES.get(f"{face}_image")
        if up is not None:
            images[face] = _read_image(up, f"{face}_image")
    ports = _json_field(data, "image_ports")
    if ports is not None:
        try:
            ports = validate_image_ports_doc(ports)
        except ValidationError as exc:
            raise ValidationError({"image_ports": exc.detail}) from exc
    leds = validate_image_leds(_json_field(data, "image_leds"))

    for face, (img, ext) in images.items():
        field = getattr(dt, f"{face}_image")
        if not allowed(face, bool(field)):
            continue
        if field and face in made:
            # Our own earlier render: nothing else points at the file.
            field.delete(save=False)
        # A new name each time, so no browser keeps showing the last render.
        getattr(dt, f"{face}_image").save(
            f"{face}-{uuid.uuid4().hex[:10]}.{ext}", img, save=False)
        if face != "iso":
            dt.image_ports = drop_calibration(dt.image_ports, face)
        made[face] = current
        written.append(face)

    def face_is_ours(side) -> bool:
        return side in written or (getattr(dt, f"{side}_image") and made.get(side) == current)

    if ports is not None:
        sides = [s for s in ("front", "rear") if ports.get(s)]
        if not all(face_is_ours(s) for s in sides):
            # Markers placed on a hand-made photo would point at nothing there.
            kept.append("image_ports")
        elif allowed("image_ports", _has_markers(dt.image_ports)):
            dt.image_ports = ports
            made["image_ports"] = current
            written.append("image_ports")
    if leds is not None:
        sides = [s for s in ("front", "rear") if leds.get(s)]
        if all(face_is_ours(s) for s in sides):
            dt.image_leds = leds
            made["image_leds"] = current
            written.append("image_leds")
        else:
            kept.append("image_leds")
    dt.images_generated = made or None
    dt.save()
    return {"written": written, "kept": kept}
