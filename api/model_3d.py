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
    for key in ("buffers", "images"):
        items = doc.get(key) or []
        if not isinstance(items, list):
            raise ValidationError(f"The file's {key} are malformed.")
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValidationError(f"The file's {key} are malformed.")
            uri = item.get("uri")
            if uri is None:
                # The BIN chunk (buffer 0), or an image in a buffer view.
                if key == "buffers" and not (i == 0 and has_bin):
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


def type_url(dt) -> str | None:
    if not dt.model_3d:
        return None
    return f"/api/device-types/{dt.pk}/model/?v={version_of(dt.model_3d)}"


def device_url(device) -> str | None:
    """The device's own download URL, serving its effective model."""
    owner = effective_owner(device)
    if owner is None:
        return None
    return f"/api/devices/{device.pk}/model/?v={version_of(owner.model_3d)}"


def effective_owner(device):
    """The device when it has its own model, else its type when that has one,
    else None."""
    if device.model_3d:
        return device
    dt = device.device_type
    if dt is not None and dt.model_3d:
        return dt
    return None


def effective(device, type_viewable: bool = False) -> dict | None:
    """What the 3D room draws for ``device``: ``{url, source, fit, up,
    front}`` or None. An inherited model points at the type's URL when the
    reader may view the type, so every device of it shares one download;
    otherwise at the device's own, which serves the same file."""
    owner = effective_owner(device)
    if owner is None:
        return None
    source = "device" if owner is device else "type"
    url = type_url(owner) if source == "type" and type_viewable else device_url(device)
    return {"url": url, "source": source, **options_of(owner)}


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


def handle(request, obj, filename_stem: str):
    """GET/POST/DELETE on an object's ``model/`` action. ``obj`` came from
    ``get_object()``, so the caller's view or change scope already holds."""
    from django.core.files.base import ContentFile
    from django.http import Http404
    from rest_framework import status
    from rest_framework.exceptions import ValidationError as DRFValidationError
    from rest_framework.response import Response

    if request.method == "GET":
        from .models import Device

        owner = effective_owner(obj) if isinstance(obj, Device) else obj
        if owner is None or not owner.model_3d:
            raise Http404("No 3D model.")
        return serve(owner.model_3d, f"{filename_stem}.glb")
    if request.method == "DELETE":
        if obj.model_3d:
            obj.model_3d.delete(save=False)
            obj.model_3d = None
            obj.save()
        return Response(status=status.HTTP_204_NO_CONTENT)
    upload = request.FILES.get("file")
    if upload is None:
        raise DRFValidationError({"file": "Choose a .glb file."})
    try:
        data = read_upload(upload)
        validate_glb(data)
    except ValidationError as exc:
        raise DRFValidationError({"file": exc.messages}) from exc
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
    old = obj.model_3d.name if obj.model_3d else None
    obj.model_3d.save("model.glb", ContentFile(data), save=False)
    obj.save()
    if old and old != obj.model_3d.name:
        obj.model_3d.storage.delete(old)
    return None
