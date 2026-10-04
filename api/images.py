"""Server-side downscaling for uploaded rack-face photos.

Phone photos arrive at 4000+ px and the faceplate / rack-elevation renders
never resolve more than ~2000 CSS px across, so oversized uploads only cost
bandwidth, memory, and (via EXIF rotation) sideways panels. Downscaling here
keeps every consumer honest without a per-upload knob: the aspect ratio is
always preserved - the resize never warps.

A photo also leaves here without its metadata - EXIF with the GPS position
and the camera's serial, XMP, IPTC, comments, PNG text - since device type
photos are served without a login (#291). Only a small photo that carries
none passes through byte-identical.
"""
from io import BytesIO

from django.core.files.base import ContentFile

MAX_EDGE = 2000

# What a decoded photo may carry that drawing it needs or that says nothing
# about who took it where: colour profile, density, transparency and encoder
# flags. Any other key is metadata, and the photo is re-saved without it - an
# unknown key costs a re-encode, never a leak.
_PLAIN_INFO = frozenset({
    "adobe", "adobe_transform", "aspect", "background", "chromaticity", "dpi",
    "duration", "gamma", "icc_profile", "interlace", "jfif", "jfif_density",
    "jfif_unit", "jfif_version", "loop", "progression", "progressive", "srgb",
    "transparency",
})
# What a re-saved photo keeps.
_KEPT_INFO = ("icc_profile", "transparency", "dpi")


def carries_metadata(img) -> bool:
    """Whether the decoded image ``img`` holds anything beyond its pixels and
    the plain keys above."""
    return bool(img.getexif()) or any(k not in _PLAIN_INFO for k in img.info)


def downscale_image(uploaded, max_edge: int = MAX_EDGE):
    """Return ``uploaded`` untouched when its longest edge fits ``max_edge``
    and it carries no metadata; else a copy under the same name, resized
    proportionally where it is too large, without its metadata.

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
    # A photo turned by its EXIF orientation carries EXIF, so it is re-saved
    # upright here too.
    if max(img.size) <= max_edge and not carries_metadata(img):
        uploaded.seek(0)
        return uploaded
    oriented = ImageOps.exif_transpose(img)
    w, h = oriented.size
    if max(w, h) > max_edge:
        scale = max_edge / max(w, h)
        oriented = oriented.resize(
            (max(1, round(w * scale)), max(1, round(h * scale))),
            Image.LANCZOS,
        )
    # Save from a clean slate: some writers copy a key such as a JPEG
    # comment from the image's info unless it is gone.
    oriented.info = {k: img.info[k] for k in _KEPT_INFO if k in img.info}
    buf = BytesIO()
    kwargs = {"optimize": True}
    if "icc_profile" in oriented.info:
        kwargs["icc_profile"] = oriented.info["icc_profile"]
    if fmt in ("JPEG", "JPG"):
        fmt = "JPEG"
        kwargs["quality"] = 85
        if oriented.mode not in ("RGB", "L"):
            oriented = oriented.convert("RGB")
    oriented.save(buf, format=fmt, **kwargs)
    return ContentFile(buf.getvalue(), name=getattr(uploaded, "name", "image"))
