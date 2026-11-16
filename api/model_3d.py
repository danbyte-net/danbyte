"""Uploaded 3D models for device types and devices (binary glTF only).

A model is a file a browser loads and parses, so what is stored has to be
something the 3D room can open on its own: one self-contained GLB. The
checks here run before anything is written:

* the 12-byte header: magic ``glTF``, version 2, and a declared length equal
  to the file's size;
* the size cap, ``settings.DEVICE_MODEL_MAX_BYTES`` (25 MB by default);
* the JSON chunk: it parses, says glTF 2.x, and every buffer and image
  either rides inside the file (the BIN chunk or a buffer view) or is a
  ``data:`` URI - no external reference, so a model can't make a viewer's
  browser fetch from anywhere;
* required extensions: only the ones the room's loader handles without a
  decoder fetched from elsewhere. Draco and Basis textures need a WASM
  decoder Danbyte does not ship, so they are refused.

Files are served through the type's or device's ``model/`` action, never
from ``/media/`` (api.media_views serves nothing under ``device-models/``).
"""
from __future__ import annotations

import json
import struct

from django.conf import settings
from django.core.exceptions import ValidationError

GLB_MAGIC = b"glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
CONTENT_TYPE = "model/gltf-binary"
DEFAULT_MAX_BYTES = 25 * 1024 * 1024

#: Extensions a model may *require*: what three's GLTFLoader reads itself,
#: plus meshopt, whose decoder is bundled with the app. Ones a model only
#: *uses* are not checked - a loader that does not know one ignores it.
SUPPORTED_REQUIRED = frozenset({
    "KHR_materials_anisotropy",
    "KHR_materials_clearcoat",
    "KHR_materials_dispersion",
    "KHR_materials_emissive_strength",
    "KHR_materials_ior",
    "KHR_materials_iridescence",
    "KHR_materials_sheen",
    "KHR_materials_specular",
    "KHR_materials_transmission",
    "KHR_materials_unlit",
    "KHR_materials_volume",
    "KHR_mesh_quantization",
    "KHR_texture_transform",
    "KHR_lights_punctual",
    "EXT_materials_bump",
    "EXT_mesh_gpu_instancing",
    "EXT_meshopt_compression",
    "EXT_texture_webp",
    "EXT_texture_avif",
})


def max_bytes() -> int:
    return int(getattr(settings, "DEVICE_MODEL_MAX_BYTES", DEFAULT_MAX_BYTES))


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.0f} MB"


def _is_meshopt_fallback(buffer: dict) -> bool:
    ext = (buffer.get("extensions") or {}).get("EXT_meshopt_compression")
    return isinstance(ext, dict) and ext.get("fallback") is True


def validate_glb(data: bytes) -> dict:
    """The parsed JSON chunk of ``data``, or ValidationError saying why the
    file is refused."""
    cap = max_bytes()
    if len(data) > cap:
        raise ValidationError(f"The model is larger than {_mb(cap)}.")
    if len(data) < 20 or data[:4] != GLB_MAGIC:
        raise ValidationError("Not a binary glTF (.glb) file.")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise ValidationError(f"glTF version {version} is not supported; export glTF 2.0.")
    if length != len(data):
        raise ValidationError("The file's declared length does not match its size.")
    chunk_len, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != CHUNK_JSON or 20 + chunk_len > len(data):
        raise ValidationError("The file has no readable glTF JSON chunk.")
    try:
        doc = json.loads(data[20:20 + chunk_len].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValidationError("The file's glTF JSON does not parse.") from exc
    if not isinstance(doc, dict):
        raise ValidationError("The file's glTF JSON does not parse.")
    asset = doc.get("asset")
    if not isinstance(asset, dict) or not str(asset.get("version", "")).startswith("2."):
        raise ValidationError("The file does not say glTF 2.0.")
    has_bin = False
    offset = 20 + chunk_len + (-chunk_len % 4)
    if offset + 8 <= len(data):
        bin_len, bin_type = struct.unpack_from("<II", data, offset)
        has_bin = bin_type == CHUNK_BIN and offset + 8 + bin_len <= len(data)
    used = doc.get("extensionsUsed") or []
    meshopt = isinstance(used, list) and "EXT_meshopt_compression" in used
    for key in ("buffers", "images"):
        items = doc.get(key) or []
        if not isinstance(items, list):
            raise ValidationError(f"The file's {key} are malformed.")
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValidationError(f"The file's {key} are malformed.")
            uri = item.get("uri")
            if uri is None:
                # The BIN chunk (buffer 0), an image in a buffer view, or a
                # meshopt fallback buffer: gltfpack's compressed output
                # declares one with no data, for loaders that can't decode
                # (ours can, so nothing is read from it).
                if key == "buffers" and not (i == 0 and has_bin) and not (
                    meshopt and _is_meshopt_fallback(item)
                ):
                    raise ValidationError("A buffer has no data.")
                continue
            if not isinstance(uri, str) or not uri.startswith("data:"):
                raise ValidationError(
                    "The model refers to external files. Export it as one "
                    "self-contained .glb."
                )
    required = doc.get("extensionsRequired") or []
    if not isinstance(required, list):
        raise ValidationError("The file's required extensions are malformed.")
    unknown = sorted({str(e) for e in required} - SUPPORTED_REQUIRED)
    if unknown:
        raise ValidationError(
            "The model needs extensions the 3D room can't read: " + ", ".join(unknown) + "."
        )
    return doc


def read_upload(upload) -> bytes:
    """The upload's bytes, refusing early when it is over the cap."""
    cap = max_bytes()
    size = getattr(upload, "size", None)
    if size is not None and size > cap:
        raise ValidationError(f"The model is larger than {_mb(cap)}.")
    data = upload.read(cap + 1)
    if len(data) > cap:
        raise ValidationError(f"The model is larger than {_mb(cap)}.")
    return data


def version_of(field) -> str:
    """A token that changes whenever the stored file does: its random name."""
    import os

    return os.path.splitext(os.path.basename(field.name))[0][:12]


def options_of(obj) -> dict:
    return {
        "fit": obj.model_3d_fit or "auto",
        "up": obj.model_3d_up or "y",
        "front": obj.model_3d_front or "+z",
    }
def _owner_base(obj) -> str:
    from .models import DeviceType, ModuleType

    if isinstance(obj, DeviceType):
        return f"/api/device-types/{obj.pk}"
    if isinstance(obj, ModuleType):
        return f"/api/module-types/{obj.pk}"
    return f"/api/devices/{obj.pk}"


def type_url(dt) -> str | None:
    """A device type's or module type's own download URL."""
    if not dt.model_3d:
        return None
    return f"{_owner_base(dt)}/model/?v={version_of(dt.model_3d)}"


def far_type_url(dt) -> str | None:
    """A type's far-distance model URL - only beside the full model."""
    if not dt.model_3d or not dt.model_3d_far:
        return None
    return f"{_owner_base(dt)}/model-far/?v={version_of(dt.model_3d_far)}"


def device_url(device) -> str | None:
    """The device's own download URL, serving its effective model."""
    owner = effective_owner(device)
    if owner is None:
        return None
    return f"/api/devices/{device.pk}/model/?v={version_of(owner.model_3d)}"


def device_far_url(device) -> str | None:
    owner = effective_owner(device)
    if owner is None or not owner.model_3d_far:
        return None
    return f"/api/devices/{device.pk}/model-far/?v={version_of(owner.model_3d_far)}"


def effective_owner(device):
    """The device when it has its own model, else its type when that has one,
    else None."""
    if device.model_3d:
        return device
    dt = device.device_type
    if dt is not None and dt.model_3d:
        return dt
    return None


def has_bays(owner) -> bool:
    return bool(owner is not None and (owner.model_anchors or {}).get("bays"))


# ── installed parts ─────────────────────────────────────────────────────────

def installed_parts(devices, user=None, tenant=None) -> None:
    """Load what each device has in its module bays, for the devices whose
    drawn model names bays, in one batch: stored on each as
    ``_installed_parts`` - ``[{name, position, module, type, type_viewable}]``
    in bay order, ``module`` / ``type`` None for an empty bay.

    With ``user`` (and ``tenant``) only the bays and modules the reader may
    view count, and a module type's own URL is used only where the reader may
    view the type. A device whose model names no bays gets ``[]``."""
    from auth_api import rbac

    from .anchor_names import prime as prime_anchor_names
    from .models import Module, ModuleBay, ModuleType
    from .natural import natural_key

    devices = list(devices)
    wanted = [d for d in devices if has_bays(effective_owner(d))]
    for d in devices:
        d._installed_parts = []
    if not wanted:
        prime_anchor_names(devices)
        return
    ids = [d.id for d in wanted]
    bays = ModuleBay.objects.filter(device_id__in=ids).order_by()
    modules = (Module.objects.filter(device_id__in=ids)
               .select_related("module_type", "status").order_by())
    if user is not None:
        bays = rbac.restrict_queryset(bays, user, tenant, "modulebay", "view")
        modules = rbac.restrict_queryset(modules, user, tenant, "module", "view")
    by_bay = {m.module_bay_id: m for m in modules}
    viewable: set = set()
    type_ids = {m.module_type_id for m in by_bay.values()}
    if type_ids:
        qs = ModuleType.objects.filter(id__in=type_ids)
        if user is not None:
            qs = rbac.restrict_queryset(qs.filter(tenant=tenant), user, tenant,
                                        "moduletype", "view")
        viewable = set(qs.values_list("id", flat=True))
    per: dict = {}
    for b in bays:
        m = by_bay.get(b.id)
        per.setdefault(b.device_id, []).append({
            "name": b.name, "position": b.position, "module": m,
            "type": m.module_type if m else None,
            "type_viewable": bool(m and m.module_type_id in viewable),
        })
    for d in wanted:
        d._installed_parts = sorted(per.get(d.id, []), key=lambda r: natural_key(r["name"]))
    # A stack member's anchors resolve against its types' templates: loaded
    # here for the batch too.
    prime_anchor_names(devices)


def parts_of(device) -> list:
    """The device's ``installed_parts`` rows, loading them (without a
    reader's scope) when no batch did."""
    if not hasattr(device, "_installed_parts"):
        installed_parts([device])
    return device._installed_parts


def _part_urls(device, row) -> dict | None:
    mt = row["type"]
    if mt is None or not mt.model_3d:
        return None
    if row["type_viewable"]:
        return {"url": type_url(mt), "far_url": far_type_url(mt)}
    m = row["module"]
    return {
        "url": f"/api/devices/{device.pk}/module-model/{m.pk}/?v={version_of(mt.model_3d)}",
        "far_url": (f"/api/devices/{device.pk}/module-model-far/{m.pk}/"
                    f"?v={version_of(mt.model_3d_far)}" if mt.model_3d_far else None),
    }


def effective(device, type_viewable: bool = False, *, load_parts: bool = True) -> dict | None:
    """What the 3D room draws for ``device``: ``{url, far_url, source, fit,
    up, front, bays, empty_mode}`` or None. An inherited model points at the
    type's URL when the reader may view the type, so every device of it
    shares one download; otherwise at the device's own, which serves the
    same file.

    ``bays`` lists the device's module bays when the model names bays (its
    ``bay:`` anchors, api.model_anchors): each ``{name, position, installed,
    part}``, ``part`` the installed module type's model URLs (``url``,
    ``far_url``) or null. Call ``installed_parts`` first for many devices;
    with ``load_parts`` False a device it wasn't called for lists none."""
    owner = effective_owner(device)
    if owner is None:
        return None
    source = "device" if owner is device else "type"
    shared = source == "type" and type_viewable
    out = {
        "url": type_url(owner) if shared else device_url(device),
        "far_url": far_type_url(owner) if shared else device_far_url(device),
        "source": source, **options_of(owner),
        "bays": [], "empty_mode": "filler",
    }
    mode = (owner.model_anchors or {}).get("empty_mode")
    if mode in ("filler", "hole", "nothing"):
        out["empty_mode"] = mode
    if has_bays(owner) and (load_parts or hasattr(device, "_installed_parts")):
        out["bays"] = [
            {"name": r["name"], "position": r["position"],
             "installed": r["module"] is not None, "part": _part_urls(device, r)}
            for r in parts_of(device)
        ]
    return out


def serve(field, filename: str):
    """The stored model as a download: never sniffed, never inline."""
    from django.http import FileResponse, Http404

    try:
        fh = field.open("rb")
    except (FileNotFoundError, ValueError) as exc:
        raise Http404("The stored model is missing.") from exc
    resp = FileResponse(
        fh, content_type=CONTENT_TYPE, as_attachment=True, filename=filename
    )
    resp["X-Content-Type-Options"] = "nosniff"
    resp["Content-Security-Policy"] = "sandbox; default-src 'none'"
    resp["Cache-Control"] = "private, max-age=86400"
    return resp


def serve_module(device, module_id, far: bool = False):
    """An installed module's model, served through its device (``module-
    model/<id>/``) for a reader who may view the device and the module but
    not the module type. ``device`` came from ``get_object()``."""
    from django.http import Http404

    row = next((r for r in parts_of(device)
                if r["module"] is not None and str(r["module"].pk) == str(module_id)), None)
    mt = row["type"] if row else None
    field = (mt.model_3d_far if far else mt.model_3d) if mt is not None else None
    if mt is None or not mt.model_3d or not field:
        raise Http404("No 3D model.")
    from django.utils.text import slugify

    stem = slugify(mt.name) or "module"
    return serve(field, f"{stem}{'.far' if far else ''}.glb")


def handle(request, obj, filename_stem: str, *, far: bool = False):
    """GET/POST/DELETE on an object's ``model/`` (or, with ``far``,
    ``model-far/``) action. ``obj`` came from ``get_object()``, so the
    caller's view or change scope already holds. Answers a Response, or for
    a POST that stored the file the upload's scan report
    (api.model_anchors.scan_result) for ``respond`` to send with the object."""
    from django.http import Http404
    from rest_framework import status
    from rest_framework.exceptions import ValidationError as DRFValidationError
    from rest_framework.response import Response

    from . import model_anchors
    from .models import Device

    field_name = "model_3d_far" if far else "model_3d"
    if request.method == "GET":
        owner = effective_owner(obj) if isinstance(obj, Device) else obj
        field = getattr(owner, field_name) if owner is not None else None
        if owner is None or not owner.model_3d or not field:
            raise Http404("No 3D model.")
        return serve(field, f"{filename_stem}{'.far' if far else ''}.glb")
    if request.method == "DELETE":
        names = [field_name] if far else ["model_3d", "model_3d_far"]
        changed = False
        for name in names:
            f = getattr(obj, name)
            if f:
                f.delete(save=False)
                setattr(obj, name, None)
                changed = True
        if changed:
            if not far:
                # Ports mapped onto the model and its anchors go with it
                # (api.model_ports, api.model_anchors).
                obj.model_ports = None
                obj.model_anchors = None
            obj.save()
        return Response(status=status.HTTP_204_NO_CONTENT)
    upload = request.FILES.get("file")
    if upload is None:
        raise DRFValidationError({"file": "Choose a .glb file."})
    if far and not obj.model_3d:
        raise DRFValidationError({"file": "Upload the full model first."})
    try:
        data = read_upload(upload)
        doc = validate_glb(data)
    except ValidationError as exc:
        raise DRFValidationError({"file": exc.messages}) from exc
    anchors, report = model_anchors.scan_result(obj, doc, far=far)
    if far:
        store(obj, data, far=True)
        return report
    errors = {}
    for key, choices in (
        ("fit", ("auto", "native")),
        ("up", ("y", "z")),
        ("front", ("+z", "-z", "+x", "-x")),
    ):
        val = request.data.get(key)
        if val in (None, ""):
            continue
        if val not in choices:
            errors[key] = f"One of {', '.join(choices)}."
        else:
            setattr(obj, f"model_3d_{key}", val)
    if errors:
        raise DRFValidationError(errors)
    obj.model_ports = _kept_ports(request, obj)
    obj.model_anchors = anchors
    store(obj, data)
    return report


def store(obj, data: bytes, *, far: bool = False) -> None:
    """Save checked model bytes on ``obj`` (and the row), removing the file
    it replaces."""
    from django.core.files.base import ContentFile

    field = obj.model_3d_far if far else obj.model_3d
    old = field.name if field else None
    field.save("model.glb", ContentFile(data), save=False)
    obj.save()
    if old and old != field.name:
        field.storage.delete(old)


def respond(out, data):
    """A ``handle`` result as the action's answer: its Response, or the
    object's ``data`` with the upload's ``model_scan`` report."""
    from rest_framework.response import Response

    if not isinstance(out, dict):
        return out
    return Response({**data, "model_scan": out})


def _kept_ports(request, obj):
    """The port mapping a replaced model keeps: none, unless the upload asks
    to keep it (``keep_ports=1``) and names the new model's upright size
    (``ports_bounds``, JSON ``[w, h, d]``) with the old one's proportions -
    then the mapping stays, rescaled to the new bounds."""
    from rest_framework.exceptions import ValidationError as DRFValidationError

    from .model_ports import similar_bounds

    doc = obj.model_ports
    if not doc or str(request.data.get("keep_ports", "")).lower() not in ("1", "true", "yes"):
        return None
    try:
        bounds = json.loads(request.data.get("ports_bounds") or "null")
    except ValueError as exc:
        raise DRFValidationError({"ports_bounds": "Three numbers, as JSON."}) from exc
    if not similar_bounds(doc.get("bounds"), bounds):
        return None
    return {**doc, "bounds": [round(float(b), 6) for b in bounds]}
