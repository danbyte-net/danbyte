"""Server-side downscaling for uploaded rack-face photos.

Phone photos arrive at 4000+ px and the faceplate / rack-elevation renders
never resolve more than ~2000 CSS px across, so oversized uploads only cost
bandwidth, memory, and (via EXIF rotation) sideways panels. Downscaling here
keeps every consumer honest without a per-upload knob: the aspect ratio is
always preserved - the resize never warps.

A photo also leaves here without its metadata - EXIF with the GPS position
and the camera's serial, XMP, IPTC, comments, PNG text - since device type
photos are served without a login (#291). Only a small photo that carries
none passes through byte-identical. A re-saved animation keeps its frames,
timing, loop count and disposal, and a lossless WebP stays lossless (#309).
"""
from io import BytesIO

from django.core.files.base import ContentFile

MAX_EDGE = 2000

# What a decoded photo may carry that drawing it needs or that says nothing
# about who took it where: colour profile, density, transparency, encoder
# flags, animation timing and the readers' own bookkeeping. Any other key is
# metadata, and the photo is re-saved without it - an unknown key costs a
# re-encode, never a leak. Checked against what Pillow 12 reads from clean
# JPEG, PNG, APNG, GIF and WebP files, static and animated (#309).
_PLAIN_INFO = frozenset({
    "adobe", "adobe_transform", "aspect", "background", "bbox", "blend",
    "chromaticity", "default_image", "disposal", "dpi", "duration", "gamma",
    "icc_profile", "interlace", "jfif", "jfif_density", "jfif_unit",
    "jfif_version", "loop", "progression", "progressive", "srgb", "timestamp",
    "transparency", "version",
})
# The GIF application extensions that only hold the loop count. Any other
# one - XMP, ICC, a tool's own - is metadata.
_GIF_LOOP_EXTENSIONS = (b"NETSCAPE2.0", b"ANIMEXTS1.0")
# What a re-saved photo keeps.
_KEPT_INFO = ("icc_profile", "transparency", "dpi")
# Formats whose extra frames are an animation to keep. A multi-picture JPEG
# (MPO) is not: its first picture is the photo.
_ANIMATED_FORMATS = ("GIF", "PNG", "WEBP")


def carries_metadata(img, data: bytes | None = None) -> bool:
    """Whether the decoded image ``img`` holds anything beyond its pixels and
    the plain keys above.

    ``data``, the file's bytes, lets a GIF be judged whole: Pillow reads a
    comment or application extension only with the frame it precedes, and
    ``img`` stands at the first. Without it the first frame decides.
    """
    if img.getexif():
        return True
    for key, value in img.info.items():
        if key == "extension":
            ident = value[0] if isinstance(value, tuple) and value else None
            if not (isinstance(ident, bytes) and ident.startswith(_GIF_LOOP_EXTENSIONS)):
                return True
        elif key not in _PLAIN_INFO:
            return True
    if img.format == "GIF" and data is not None:
        try:
            return any(not _plain_gif_extension(label, ident)
                       for label, ident in _gif_extensions(data))
        except (IndexError, ValueError):
            return True  # malformed past what Pillow decoded: re-save, never leak
    return False


def _plain_gif_extension(label: int, ident: bytes) -> bool:
    """Graphic control blocks and the loop-count application extension are
    bookkeeping; a comment, plain text or any other application extension is
    metadata."""
    if label == 0xF9:
        return True
    return label == 0xFF and ident.startswith(_GIF_LOOP_EXTENSIONS)


def _gif_extensions(data: bytes):
    """The ``(label, first sub-block)`` of every extension block in the GIF
    ``data``, whichever frame it precedes. Image data is skipped, not decoded."""
    flags = data[10]
    pos = 13 + ((3 << ((flags & 7) + 1)) if flags & 0x80 else 0)
    while pos < len(data):
        intro = data[pos]
        pos += 1
        if intro == 0x3B:  # trailer
            return
        if intro == 0x21:  # extension: label, then sub-blocks until an empty one
            label = data[pos]
            pos += 1
            first = b""
            while size := data[pos]:
                first = first or data[pos + 1:pos + 1 + size]
                pos += 1 + size
            pos += 1
            yield label, first
        elif intro == 0x2C:  # image: descriptor, local table, LZW size, sub-blocks
            lflags = data[pos + 8]
            pos += 9 + ((3 << ((lflags & 7) + 1)) if lflags & 0x80 else 0) + 1
            while size := data[pos]:
                pos += 1 + size
            pos += 1
        else:
            raise ValueError(f"unknown GIF block {intro:#x}")


def _webp_is_lossless(data: bytes) -> bool:
    """Whether any frame of the WebP ``data`` is coded losslessly (a VP8L
    chunk, at the top level or inside an animation frame). Pillow does not
    say, so the RIFF chunks are walked; nothing is decoded."""
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return False

    def chunks(start, end):
        pos = start
        while pos + 8 <= end:
            size = int.from_bytes(data[pos + 4:pos + 8], "little")
            yield data[pos:pos + 4], pos + 8, pos + 8 + size
            pos += 8 + size + (size & 1)

    end = min(len(data), 8 + int.from_bytes(data[4:8], "little"))
    for fourcc, body, body_end in chunks(12, end):
        if fourcc == b"VP8L":
            return True
        if fourcc == b"ANMF":  # 16 bytes of frame header, then the frame's chunks
            if any(sub == b"VP8L" for sub, _, _ in chunks(body + 16, body_end)):
                return True
    return False


def _clean_frame(frame, max_edge: int, animated: bool):
    """A copy of ``frame`` turned upright, resized proportionally where it is
    too large, carrying only the kept info keys."""
    from PIL import Image, ImageOps

    out = ImageOps.exif_transpose(frame)
    w, h = out.size
    if max(w, h) > max_edge:
        scale = max_edge / max(w, h)
        # Pillow resizes a palette frame with NEAREST; in an animation that
        # would make the first frame blockier than the rest.
        if animated and out.mode in ("P", "1"):
            out = out.convert("RGBA")
        out = out.resize(
            (max(1, round(w * scale)), max(1, round(h * scale))),
            Image.LANCZOS,
        )
    # Save from a clean slate: some writers copy a key such as a JPEG
    # comment from the image's info unless it is gone.
    out.info = {k: frame.info[k] for k in _KEPT_INFO if k in frame.info}
    return out


def downscale_image(uploaded, max_edge: int = MAX_EDGE):
    """Return ``uploaded`` untouched when its longest edge fits ``max_edge``
    and it carries no metadata; else a copy under the same name, resized
    proportionally where it is too large, without its metadata.

    EXIF orientation is applied first so a rotated phone photo lands upright
    even when it needs no resize. An animated GIF, WebP or APNG keeps every
    frame with its duration, the loop count and the disposal; a lossless
    WebP is written lossless again. Files Pillow cannot decode pass through -
    the ImageField's own validation decides their fate.
    """
    from PIL import Image, ImageSequence

    try:
        img = Image.open(uploaded)
        img.load()
    except Exception:  # noqa: BLE001 - not an image; let field validation rule
        uploaded.seek(0)
        return uploaded
    fmt = (img.format or "PNG").upper()
    # A GIF is judged on all its blocks and a WebP's coding read from its
    # chunks, so those two are read whole.
    data = None
    if fmt in ("GIF", "WEBP"):
        uploaded.seek(0)
        data = uploaded.read()
    uploaded.seek(0)
    # A photo turned by its EXIF orientation carries EXIF, so it is re-saved
    # upright here too.
    if max(img.size) <= max_edge and not carries_metadata(img, data):
        return uploaded
    animated = fmt in _ANIMATED_FORMATS and getattr(img, "n_frames", 1) > 1
    frames, durations, disposals = [], [], []
    for frame in (ImageSequence.Iterator(img) if animated else (img,)):
        frame.load()  # a WebP frame's timing is read with its pixels
        durations.append(frame.info.get("duration", 0))
        disposals.append(getattr(frame, "disposal_method", frame.info.get("disposal", 0)))
        frames.append(_clean_frame(frame, max_edge, animated))
    first = frames[0]
    buf = BytesIO()
    kwargs = {"optimize": True}
    if "icc_profile" in first.info:
        kwargs["icc_profile"] = first.info["icc_profile"]
    if fmt in ("JPEG", "JPG"):
        fmt = "JPEG"
        kwargs["quality"] = 85
        if first.mode not in ("RGB", "L"):
            first = first.convert("RGB")
    elif fmt == "WEBP" and _webp_is_lossless(data):
        kwargs["lossless"] = True
    if animated:
        kwargs.update(save_all=True, append_images=frames[1:], duration=durations)
        if "loop" in img.info:
            kwargs["loop"] = img.info["loop"]
        if fmt in ("GIF", "PNG"):
            # Frames come composited; the writers derive the deltas from the
            # disposal, so it is passed on and APNG blending is not.
            kwargs["disposal"] = disposals
    first.save(buf, format=fmt, **kwargs)
    return ContentFile(buf.getvalue(), name=getattr(uploaded, "name", "image"))
