"""Moved to :mod:`api.reports.cover`; kept for one release so older
imports keep working."""

from .reports.cover import *  # noqa: F401, F403
from .reports.cover import (  # noqa: F401
    BACKGROUND_CHOICES,
    HEX,
    IMAGE_TYPES,
    MAX_IMAGE_BYTES,
    STYLES,
    Cover,
    CoverImageRejected,
    Look,
    clean_image,
    cover_css,
    cover_for_request,
    cover_html,
    look_for,
    with_colors,
)
