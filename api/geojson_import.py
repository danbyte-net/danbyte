"""Read a region boundary out of a GeoJSON / QGIS export (#80).

Regions already draw OpenStreetMap boundaries; this is the other half - your
own shapes, from a GIS. The awkward part isn't the parsing, it's the size: a
municipality traced in QGIS routinely lands at several megabytes, while the
boundary field is capped at 400 KB because the map has to ship it to a browser.
So the geometry is **simplified until it fits**, by Ramer-Douglas-Peucker in
plain Python - no GEOS or shapely, because an airgapped install must not need
a system library to load a polygon.

Coordinates must be WGS84 lon/lat (EPSG:4326, what RFC 7946 mandates). A
projected export - metres, feet, a national grid - is refused with a message
saying to reproject, rather than silently drawing the region in the Gulf of
Guinea where projected coordinates land once read as degrees.
"""
from __future__ import annotations

import json

#: Matches RegionSerializer.validate_boundary - the map has to send this to a
#: browser, so it is a payload budget, not an arbitrary number.
MAX_BYTES = 400_000

#: How many features a FeatureCollection may contribute before we stop. A
#: region is one shape (possibly multi-part), not a whole cadastral layer.
MAX_FEATURES = 500

#: Simplification tolerances in degrees, tried in order. ~1e-5 deg is about a
#: metre; the last is coarse enough for a country on a zoomed-out map.
TOLERANCES = [0.0, 1e-5, 5e-5, 1e-4, 5e-4, 1e-3, 5e-3, 1e-2, 5e-2]


class GeoJSONError(ValueError):
    """The upload isn't a boundary we can store."""


def _perpendicular_distance(pt, start, end) -> float:
    """Distance from ``pt`` to the segment start-end, in coordinate units."""
    (x, y), (x1, y1), (x2, y2) = pt, start, end
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    # Project onto the segment, clamped to its ends.
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    px, py = x1 + t * dx, y1 + t * dy
    return ((x - px) ** 2 + (y - py) ** 2) ** 0.5


def simplify(points: list, tolerance: float) -> list:
    """Ramer-Douglas-Peucker. Iterative, because a ring with 100k vertices
    would blow the recursion limit on the naive version."""
    if tolerance <= 0 or len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        worst, index = 0.0, first
        for i in range(first + 1, last):
            d = _perpendicular_distance(points[i], points[first], points[last])
            if d > worst:
                worst, index = d, i
        if worst > tolerance:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    return [p for p, k in zip(points, keep, strict=True) if k]


def _simplify_ring(ring: list, tolerance: float) -> list | None:
    """Simplify one closed ring, or None when it collapses.

    A ring needs four positions (three corners plus the repeated closing one);
    below that it is no longer an area and is dropped rather than stored as a
    degenerate shape the map would render as nothing.
    """
    if len(ring) < 4:
        return None
    out = simplify(ring, tolerance)
    if out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def _simplify_geometry(geom: dict, tolerance: float) -> dict:
    kind = geom["type"]
    if kind == "Polygon":
        rings = [_simplify_ring(r, tolerance) for r in geom["coordinates"]]
        rings = [r for r in rings if r]
        return {"type": "Polygon", "coordinates": rings}
    polys = []
    for poly in geom["coordinates"]:
        rings = [_simplify_ring(r, tolerance) for r in poly]
        rings = [r for r in rings if r]
        if rings:
            polys.append(rings)
    return {"type": "MultiPolygon", "coordinates": polys}


def _positions(geom: dict):
    """Every coordinate pair in a Polygon/MultiPolygon."""
    if geom["type"] == "Polygon":
        for ring in geom["coordinates"]:
            yield from ring
    else:
        for poly in geom["coordinates"]:
            for ring in poly:
                yield from ring


def _check_wgs84(geom: dict) -> None:
    """Refuse projected coordinates, loudly.

    Read as degrees, a metre-based grid puts everything off West Africa. A
    clear refusal beats a region silently drawn in the wrong hemisphere.
    """
    for pos in _positions(geom):
        if not isinstance(pos, (list, tuple)) or len(pos) < 2:
            raise GeoJSONError("A coordinate must be a [longitude, latitude] pair.")
        lon, lat = pos[0], pos[1]
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            raise GeoJSONError("Coordinates must be numbers.")
        if not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
            raise GeoJSONError(
                "Coordinates are outside longitude/latitude range - this looks "
                "like a projected export. Reproject it to WGS84 (EPSG:4326) "
                "and try again."
            )


def _named_crs(doc: dict) -> str:
    """The legacy `crs` member's name, when it isn't WGS84. RFC 7946 dropped
    `crs` (everything is WGS84), but QGIS still writes it for other systems."""
    crs = doc.get("crs")
    if not isinstance(crs, dict):
        return ""
    name = str((crs.get("properties") or {}).get("name") or "")
    ok = ("CRS84", "4326")
    return "" if any(token in name for token in ok) else name


def _geometries(doc) -> list[dict]:
    """Every Polygon/MultiPolygon in the document, in file order."""
    if not isinstance(doc, dict):
        raise GeoJSONError("Expected a GeoJSON object.")
    kind = doc.get("type")
    if kind in ("Polygon", "MultiPolygon"):
        return [doc]
    if kind == "Feature":
        geom = doc.get("geometry")
        return _geometries(geom) if isinstance(geom, dict) else []
    if kind == "GeometryCollection":
        out: list[dict] = []
        for g in doc.get("geometries") or []:
            if isinstance(g, dict):
                out.extend(_geometries(g))
        return out
    if kind == "FeatureCollection":
        out = []
        for feat in (doc.get("features") or [])[:MAX_FEATURES]:
            if isinstance(feat, dict):
                out.extend(_geometries(feat))
        return out
    return []


def _merge(geoms: list[dict]) -> dict:
    """One geometry from many.

    Several features become a MultiPolygon rather than being thinned to the
    first: an export of "the islands" is genuinely several parts of one region,
    and keeping only one would quietly lose the rest.
    """
    polys: list = []
    for g in geoms:
        if g["type"] == "Polygon":
            polys.append(g["coordinates"])
        else:
            polys.extend(g["coordinates"])
    if len(polys) == 1:
        return {"type": "Polygon", "coordinates": polys[0]}
    return {"type": "MultiPolygon", "coordinates": polys}


def boundary_from_geojson(raw: bytes | str) -> tuple[dict, dict]:
    """Parse, validate and fit an upload. Returns ``(geometry, report)``.

    ``report`` carries what was done - features used, vertices before/after,
    the tolerance it settled on - so the UI can say why the shape it drew is
    coarser than the file.
    """
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8-sig")
        except UnicodeDecodeError as err:
            raise GeoJSONError(
                "That isn't a text GeoJSON file. Shapefiles and GeoPackages "
                "need exporting to GeoJSON first."
            ) from err
    try:
        doc = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as err:
        raise GeoJSONError(f"Not valid JSON: {err}") from err

    named = _named_crs(doc) if isinstance(doc, dict) else ""
    if named:
        raise GeoJSONError(
            f"The file declares coordinate system '{named}'. Reproject it to "
            "WGS84 (EPSG:4326) - GeoJSON boundaries are longitude/latitude."
        )

    geoms = _geometries(doc)
    if not geoms:
        raise GeoJSONError(
            "No Polygon or MultiPolygon found - a boundary needs an area, not "
            "points or lines."
        )
    geom = _merge(geoms)
    _check_wgs84(geom)

    before = sum(1 for _ in _positions(geom))
    # Always run the ring pass, tolerance 0 included: it is what enforces "at
    # least four positions, closed", so a degenerate shape can't slip through
    # just because the file was small enough to skip simplification.
    normalised = _simplify_geometry(geom, 0.0)
    if not normalised["coordinates"]:
        raise GeoJSONError(
            "No usable area in that file - the shapes have too few points to "
            "enclose anything."
        )
    for tolerance in TOLERANCES:
        candidate = _simplify_geometry(geom, tolerance) if tolerance else normalised
        if not candidate["coordinates"]:
            continue
        size = len(json.dumps(candidate))
        if size <= MAX_BYTES:
            return candidate, {
                "features": len(geoms),
                "vertices_before": before,
                "vertices_after": sum(1 for _ in _positions(candidate)),
                "tolerance": tolerance,
                "bytes": size,
            }
    raise GeoJSONError(
        "The boundary is still too detailed after simplification. Simplify it "
        "in your GIS (QGIS: Vector → Geometry Tools → Simplify) and re-export."
    )
