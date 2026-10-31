"""Ports mapped onto an uploaded 3D model (``model_ports``).

The photo-port pattern (``api.face_ports``), on the model instead of a photo:
a device type's ``model_ports`` names component TEMPLATES by kind and name,
and a device inherits its type's mapping until it sets its own, which then
replaces it wholesale. The doc::

    {"bounds": [w, h, d],
     "ports": [{"kind": "interface", "name": "Gi1/0/1",
                "p": [x, y, z], "n": [nx, ny, nz]}, ...]}

* ``p`` is the port's spot in the model's UPRIGHT bounding box - after the
  up/front fix that stands it on the floor, front on -Z - mapped to 0..1 on
  each axis (x left to right along +X, y bottom to top, z front to back), so
  it survives re-fitting and scaling;
* ``n`` is the surface's outward normal there, in the same upright frame,
  unit length;
* ``bounds`` is the upright box's size in model units when the mapping was
  made: what the 3D room fits the model with before the file has loaded,
  and what a replacement model is compared with ("keep mappings").

Changing the model's up axis or front turns the upright frame, so
``remap_frame`` turns a saved mapping with it. Replacing the model clears
the mapping unless the new model's bounds are close enough to keep it.
"""
from __future__ import annotations

import hashlib
import json
import math

from .face_ports import FACE_PORT_KINDS

#: Ports one mapping holds at most - a big chassis, not a whole hall.
MAX_PORTS = 1024
#: How far a normal may be off unit length and still count as one.
_UNIT_TOL = 0.02
#: How close two models' proportions must be (each axis, relative to the
#: longest) for a mapping to carry over to a replacement.
SIMILAR_TOL = 0.05


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _vec(v) -> bool:
    return isinstance(v, list) and len(v) == 3 and all(_num(x) for x in v)


def validate_model_ports_doc(value):
    """Check a mapping; DRF field errors for anything off. Returns the doc
    with normals renormalised and numbers rounded."""
    from rest_framework.exceptions import ValidationError

    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValidationError('model_ports must be {"bounds": [w, h, d], "ports": [...]}.')
    unknown = set(value) - {"bounds", "ports"}
    if unknown:
        raise ValidationError(f"Unknown keys: {', '.join(sorted(unknown))}.")
    bounds = value.get("bounds")
    if not _vec(bounds) or not all(b > 0 for b in bounds):
        raise ValidationError("bounds is the model's upright size, three positive numbers.")
    ports = value.get("ports", [])
    if not isinstance(ports, list):
        raise ValidationError("ports must be a list.")
    if len(ports) > MAX_PORTS:
        raise ValidationError(f"Too many ports (max {MAX_PORTS}).")
    seen = set()
    out = []
    for m in ports:
        if not isinstance(m, dict):
            raise ValidationError("Each port must be an object.")
        kind = m.get("kind", "interface")
        if kind not in FACE_PORT_KINDS:
            raise ValidationError(f"Unknown port kind {kind!r}.")
        name = m.get("name")
        if not isinstance(name, str) or not name or len(name) > 64:
            raise ValidationError("Ports need a name (≤64 chars).")
        if (kind, name) in seen:
            raise ValidationError(f"{name} is mapped twice.")
        seen.add((kind, name))
        p, n = m.get("p"), m.get("n")
        if not _vec(p) or not all(0 <= x <= 1 for x in p):
            raise ValidationError(f"{name}: p must be three numbers in 0..1.")
        if not _vec(n):
            raise ValidationError(f"{name}: n must be three numbers.")
        length = math.sqrt(sum(x * x for x in n))
        if abs(length - 1) > _UNIT_TOL:
            raise ValidationError(f"{name}: n must be a unit vector.")
        out.append({
            "kind": kind, "name": name,
            "p": [round(x, 5) for x in p],
            "n": [round(x / length, 5) for x in n],
        })
    return {"bounds": [round(float(b), 6) for b in bounds], "ports": out}


def doc_version(doc) -> str:
    """A token that changes whenever the stored mapping does - what the
    editor's save names to refuse a stale overwrite."""
    raw = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def effective_model_ports(device) -> dict | None:
    """The mapping a device's drawn model uses, or None.

    The device's own (an override) when it has one; else its type's, but
    only while the type's model is the one drawn - a device with its own
    model has nothing to borrow from a mapping made on another."""
    if device.model_ports is not None:
        return device.model_ports or None
    if device.model_3d:
        return None
    dt = device.device_type
    if dt is None or not dt.model_3d:
        return None
    return dt.model_ports or None


def similar_bounds(a, b, tol: float = SIMILAR_TOL) -> bool:
    """Whether two upright sizes have the same proportions: a mapping made
    on one lands where it should on the other."""
    if not (_vec(a) and _vec(b)) or min(a) <= 0 or min(b) <= 0:
        return False
    ma, mb = max(a), max(b)
    return all(abs(x / ma - y / mb) <= tol for x, y in zip(a, b, strict=False))


# ── turning the upright frame ───────────────────────────────────────────────
# The room stands a model upright with Euler (rx, ry, 0) in three's YXZ order:
# R = Ry(ry) · Rx(rx) (api.model_3d options; world.ts modelRotation). Every
# combination is a quarter turn, so R is a signed permutation.

def _rotation(up: str, front: str):
    rx = -math.pi / 2 if up == "z" else 0.0
    ry = {"+z": math.pi, "+x": math.pi / 2, "-x": -math.pi / 2}.get(front, 0.0)
    cx, sx = round(math.cos(rx)), round(math.sin(rx))
    cy, sy = round(math.cos(ry)), round(math.sin(ry))
    rot_x = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    rot_y = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    return _mul(rot_y, rot_x)


def _mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _apply(m, v):
    return [sum(m[i][k] * v[k] for k in range(3)) for i in range(3)]


def _transpose(m):
    return [[m[j][i] for j in range(3)] for i in range(3)]


def remap_frame(doc, old: tuple[str, str], new: tuple[str, str]):
    """``doc`` (made with up/front ``old``) for a model now stood up with
    ``new``: each port at the same spot on the model, in the new upright
    frame. Returns ``doc`` itself when nothing turns."""
    if not doc or old == new:
        return doc
    turn = _mul(_rotation(*new), _transpose(_rotation(*old)))
    bounds = doc["bounds"]
    new_bounds = [abs(x) for x in _apply(turn, bounds)]
    ports = []
    for m in doc.get("ports", []):
        centred = [(p - 0.5) * b for p, b in zip(m["p"], bounds, strict=False)]
        moved = _apply(turn, centred)
        ports.append({
            **m,
            "p": [round(min(1.0, max(0.0, c / b + 0.5)), 5) for c, b in zip(moved, new_bounds, strict=False)],
            "n": [round(x, 5) for x in _apply(turn, m["n"])],
        })
    return {"bounds": new_bounds, "ports": ports}


def model_markers(doc) -> list:
    """The mapping's ports as markers ``FacePortLoader`` resolves."""
    ports = doc.get("ports") if isinstance(doc, dict) else None
    return [m for m in ports if isinstance(m, dict)] if isinstance(ports, list) else []



def frame_of(obj) -> tuple[str, str]:
    return (obj.model_3d_up or "y", obj.model_3d_front or "+z")


def follow_frame_change(instance, attrs) -> None:
    """A write that turns a model's up axis or front turns its port mapping
    too, so each port stays on the same spot of the model. Only the owner
    of the drawn model turns: a device's own up/front mean nothing while it
    draws its type's model."""
    if instance is None or not instance.model_3d or "model_ports" in attrs:
        return
    old = frame_of(instance)
    new = (attrs.get("model_3d_up") or old[0], attrs.get("model_3d_front") or old[1])
    if old != new and instance.model_ports:
        attrs["model_ports"] = remap_frame(instance.model_ports, old, new)


def carry_type_frame(device_type, old: tuple[str, str]) -> None:
    """After a type's model turned (``old`` → its frame now), turn the
    overrides of the devices drawing that model as well."""
    new = frame_of(device_type)
    if old == new or not device_type.model_3d:
        return
    for dev in device_type.device_set.filter(model_ports__isnull=False):
        if dev.model_3d:
            continue
        dev.model_ports = remap_frame(dev.model_ports, old, new)
        dev.save(update_fields=["model_ports"])


def payload(obj) -> dict:
    """What the ``model-ports/`` action answers: the object's own mapping and
    its version; on a device also the mapping it draws and where that comes
    from (``own`` / ``type`` / null)."""
    from .models import Device

    out = {"model_ports": obj.model_ports, "version": doc_version(obj.model_ports)}
    if isinstance(obj, Device):
        eff = effective_model_ports(obj)
        out["effective"] = eff
        out["source"] = (
            None if eff is None else "own" if obj.model_ports is not None else "type"
        )
    return out


def handle(request, obj):
    """GET / PUT on an object's ``model-ports/`` action. ``obj`` came from
    ``get_object()``, so the caller's view or change scope already holds.

    PUT ``{"version": <from the GET>, "model_ports": doc | null}`` replaces the
    whole mapping in one write (null clears it; on a device, inherits the
    type's again). A version that is not the stored one is refused with a
    409, so two editors never overwrite each other's work unseen."""
    from rest_framework import status
    from rest_framework.exceptions import ValidationError
    from rest_framework.response import Response

    if request.method == "GET":
        return Response(payload(obj))
    data = request.data if isinstance(request.data, dict) else {}
    if "model_ports" not in data:
        raise ValidationError({"model_ports": "Send the whole mapping, or null."})
    if data.get("version") != doc_version(obj.model_ports):
        return Response(
            {"detail": "The mapping changed since you opened it. Reload to see it.",
             **payload(obj)},
            status=status.HTTP_409_CONFLICT,
        )
    doc = data["model_ports"]
    if doc is not None and not _has_model(obj):
        raise ValidationError({"model_ports": "Upload a 3D model first."})
    try:
        obj.model_ports = validate_model_ports_doc(doc)
    except ValidationError as exc:
        raise ValidationError({"model_ports": exc.detail}) from exc
    obj.save()
    return Response(payload(obj))


def _has_model(obj) -> bool:
    from .models import Device

    if obj.model_3d:
        return True
    return isinstance(obj, Device) and bool(obj.device_type and obj.device_type.model_3d)
