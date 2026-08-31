"""Server-side downscaling for uploaded rack-face photos.

Phone photos arrive at 4000+ px and the faceplate / rack-elevation renders
never resolve more than ~2000 CSS px across, so oversized uploads only cost
bandwidth, memory, and (via EXIF rotation) sideways panels. Downscaling here
keeps every consumer honest without a per-upload knob: the aspect ratio is
always preserved - the resize never warps - and small images pass through
byte-identical.
"""
from io import BytesIO

from django.core.files.base import ContentFile

MAX_EDGE = 2000


def downscale_image(uploaded, max_edge: int = MAX_EDGE):
    """Return ``uploaded`` untouched unless its longest edge exceeds
    ``max_edge``; then a proportionally resized copy under the same name.

    EXIF orientation is applied first so a rotated phone photo lands upright
    even when it needs no resize. Files Pillow cannot decode pass through -
    the ImageField's own validation decides their fate.
    """
    from PIL import Image, ImageOps

    try:
        img = Image.open(uploaded)
        img.load()
    except Exception:  # noqa: BLE001 - not an image; let field validation rule
        uploaded.seek(0)
        return uploaded
    fmt = (img.format or "PNG").upper()
    oriented = ImageOps.exif_transpose(img)
    w, h = oriented.size
    if max(w, h) <= max_edge and oriented is img:
        uploaded.seek(0)
        return uploaded
    if max(w, h) > max_edge:
        scale = max_edge / max(w, h)
        oriented = oriented.resize(
            (max(1, round(w * scale)), max(1, round(h * scale))),
            Image.LANCZOS,
        )
    buf = BytesIO()
    kwargs = {"optimize": True}
    if fmt in ("JPEG", "JPG"):
        fmt = "JPEG"
        kwargs["quality"] = 85
        if oriented.mode not in ("RGB", "L"):
            oriented = oriented.convert("RGB")
    oriented.save(buf, format=fmt, **kwargs)
    return ContentFile(buf.getvalue(), name=getattr(uploaded, "name", "image"))
