"""The full-page background of a report cover, as a print-ready JPEG.

**Waves** colour a still of rolling waves (``report_assets/cover-waves-*.jpg``,
greyscale, one per orientation) with the tenant's three colours: a gradient
map from the still's brightness, dark towards the horizon colour and light
towards the crest colour, with the wave colour steering the mid tones. The
map is calibrated so the default colours (``DEFAULT_COLORS``) give the
Danbyte blue still. A **plain** background is the horizon colour, and an
**uploaded** photo is cropped to fill the page. Every one gets the same
soft darkening at the top and the bottom, so the white text on it keeps
its contrast.

The result is sized to the paper at ``PX_PER_MM`` and kept in the media
cache (``cache/report-covers/``) per colours, image and size, so a tenant's
covers are coloured once.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

log = logging.getLogger(__name__)

#: Bumped when the drawing changes, so cached images are made again.
VERSION = 1
ASSETS = Path(__file__).resolve().parent / "report_assets"
DEFAULT_COLORS = ("#063d66", "#0b6fb0", "#ffffff")
#: About 150 dpi: enough for a soft background, and a small PDF.
PX_PER_MM = 5.9
QUALITY = 80
#: How much the top and the bottom of the page are darkened, and where the
#: darkening fades out (as a share of the page's height).
TOP_SHADE, TOP_END = 0.18, 0.35
BOTTOM_SHADE, BOTTOM_START = 0.25, 0.70
#: How far the wave colour moves the mid tones: enough to warm or cool
#: them, little enough that the waves stay as soft as the blue still.
WAVE_WEIGHT = 0.35


def _rgb(hex_colour: str) -> np.ndarray:
    h = hex_colour.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


@lru_cache(maxsize=2)
def _still(orientation: str) -> np.ndarray:
    """The greyscale wave still as brightness 0-1."""
    with Image.open(ASSETS / f"cover-waves-{orientation}.jpg") as img:
        return np.asarray(img.convert("L"), dtype=np.float32) / 255.0


def gradient_map(t: np.ndarray, horizon: str, wave: str, crest: str) -> np.ndarray:
    """RGB (0-255) for brightness ``t`` (0-1): from the horizon colour at 0
    to the crest colour at 1, the mid tones moved by how far the wave colour
    is from the default one. With the default colours this is the blue
    still exactly."""
    h, w, c = _rgb(horizon), _rgb(wave), _rgb(crest)
    t = t[..., None]
    base = h + (c - h) * t
    mid = WAVE_WEIGHT * 4.0 * t * (1.0 - t)
    return base + (w - _rgb(DEFAULT_COLORS[1])) * mid


def _shade(px: np.ndarray) -> np.ndarray:
    """Darken the top and the bottom for the white text."""
    rows = (np.arange(px.shape[0], dtype=np.float32) + 0.5) / px.shape[0]
    top = TOP_SHADE * np.clip(1.0 - rows / TOP_END, 0.0, 1.0)
    bottom = BOTTOM_SHADE * np.clip((rows - BOTTOM_START) / (1.0 - BOTTOM_START), 0.0, 1.0)
    return px * (1.0 - top - bottom)[:, None, None]


def _jpeg(px: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.clip(px + 0.5, 0, 255).astype(np.uint8), "RGB").save(
        buf, "JPEG", quality=QUALITY, optimize=True, progressive=True
    )
    return buf.getvalue()


def size_px(width_mm: float, height_mm: float) -> tuple[int, int]:
    return max(16, round(width_mm * PX_PER_MM)), max(16, round(height_mm * PX_PER_MM))


def waves(width: int, height: int, horizon: str, wave: str, crest: str) -> bytes:
    """The wave still, coloured, cropped to ``width`` by ``height``."""
    orientation = "portrait" if height >= width else "landscape"
    still = _still(orientation)
    img = Image.fromarray(np.clip(still * 255.0 + 0.5, 0, 255).astype(np.uint8), "L")
    img = ImageOps.fit(img, (width, height), Image.Resampling.LANCZOS)
    t = np.asarray(img, dtype=np.float32) / 255.0
    return _jpeg(_shade(gradient_map(t, horizon, wave, crest)))


def plain(width: int, height: int, colour: str) -> bytes:
    px = np.broadcast_to(_rgb(colour), (height, width, 3)).astype(np.float32)
    return _jpeg(_shade(px))


def photo(data: bytes, width: int, height: int) -> bytes | None:
    """An uploaded PNG or JPEG cropped to fill the page; None when it can't
    be read."""
    try:
        with Image.open(io.BytesIO(data)) as src:
            src.draft("RGB", (width, height))
            img = ImageOps.fit(src.convert("RGB"), (width, height), Image.Resampling.LANCZOS)
    except Exception:  # noqa: BLE001 - a bad upload falls back to the waves
        return None
    return _jpeg(_shade(np.asarray(img, dtype=np.float32)))


def _cache_path(key: str) -> Path | None:
    from django.conf import settings

    root = getattr(settings, "MEDIA_ROOT", "") or ""
    if not root:
        return None
    digest = hashlib.sha256(f"{VERSION}:{key}".encode()).hexdigest()[:24]
    return Path(root) / "cache" / "report-covers" / f"cover-{digest}.jpg"


def cached(key: str, make) -> bytes | None:
    """``make()``'s JPEG, kept in the media cache under ``key``. A cache that
    can't be read or written is skipped."""
    path = _cache_path(key)
    if path is not None:
        try:
            return path.read_bytes()
        except OSError:
            pass
    data = make()
    if data and path is not None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_bytes(data)
            os.replace(tmp, path)
        except OSError as exc:
            log.warning("report cover: could not cache the background: %s", exc)
    return data


def background(style: str, look, width_mm: float, height_mm: float) -> bytes | None:
    """The JPEG for ``style`` (``waves``, ``plain`` or ``upload``) on a page
    ``width_mm`` by ``height_mm``; None for no background, or an upload that
    is not a photo."""
    w, h = size_px(width_mm, height_mm)
    colours = (look.horizon, look.wave, look.crest)
    if style == "waves":
        return cached(f"waves:{w}x{h}:{':'.join(colours)}", lambda: waves(w, h, *colours))
    if style == "plain":
        return cached(f"plain:{w}x{h}:{look.horizon}", lambda: plain(w, h, look.horizon))
    if style == "upload" and look.image and look.image_type in ("image/png", "image/jpeg"):
        digest = hashlib.sha256(look.image).hexdigest()
        return cached(f"photo:{w}x{h}:{digest}", lambda: photo(look.image, w, h))
    return None
