"""Nominatim (OpenStreetMap) lookups - the one sanctioned geocoding path.

Usage-policy compliant by construction: callers fire a single request per
explicit operator click (never per keystroke, never on a schedule), the
User-Agent identifies the product, and results are stored on the object so
each lookup happens once. Data © OpenStreetMap contributors, ODbL.
"""

from core.version import system_version

SEARCH_URL = "https://nominatim.openstreetmap.org/search"


def nominatim_search(q: str, *, polygons: bool = False, limit: int = 5) -> list:
    """One Nominatim search; raises on transport/HTTP errors. With
    ``polygons``, boundary geometry comes back pre-simplified so a whole
    country stays a few tens of KB."""
    # Call-time import so tests patching core.ssrf.safe_get take effect.
    from core.ssrf import safe_get

    params: dict = {"q": q, "format": "jsonv2", "limit": limit}
    if polygons:
        params |= {"polygon_geojson": 1, "polygon_threshold": 0.003}
    resp = safe_get(
        SEARCH_URL,
        params=params,
        headers={
            "User-Agent": (
                f"Danbyte/{system_version()['version']} (+https://danbyte.net)"
            )
        },
        timeout=15,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows if isinstance(rows, list) else []
