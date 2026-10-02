"""Photo-port marker resolution.

A device type's photos carry markers (``image_ports``: ``{front: [...],
rear: [...]}`` of ``{kind, name, x, y, w, h}``) that name component
TEMPLATES, not components. Turning a marker into the device's real port is
shared by the face-ports endpoint and anything else that anchors on a photo:

* ``effective_image_ports`` - which layout applies (device override, else the
  type's);
* ``render_marker_name`` - ``{position}`` rendered for a stack member;
* ``ComponentIndex`` - rendered name → already-loaded component, with the
  marker_key / exact / tolerant precedence.

Loading the components (and any prefetches) stays with the caller, and so
does SNMP drift: nothing here queries.
"""
from __future__ import annotations

from .models import render_component_name

# Photo-port marker kind (hyphenated, as saved in DeviceType.image_ports) →
# (device component relation, CableTermination kind). Drives face-ports.
# Inventory items (disk bays…) and module bays (line-card slots) are
# placeable but not cable-able, hence the None termination kind: a part
# answers "what health", a bay answers "occupied or free".
FACE_PORT_KINDS: dict[str, tuple[str, str | None]] = {
    "interface": ("interfaces", "interface"),
    "console-port": ("console_ports", "console_port"),
    "console-server-port": ("console_server_ports", "console_server_port"),
    "power-port": ("power_ports", "power_port"),
    "power-outlet": ("power_outlets", "power_outlet"),
    "front-port": ("front_ports", "front_port"),
    "rear-port": ("rear_ports", "rear_port"),
    "aux-port": ("aux_ports", "aux_port"),
    "antenna": ("antennas", None),
    "inventory-item": ("inventory_items", None),
    "module-bay": ("module_bays", None),
}


def effective_image_ports(device) -> dict | None:
    """The marker layout this device's photos use, or None when it has none.

    A device-level override (special devices) replaces the type's layout
    wholesale; null inherits."""
    if device.image_ports is not None:
        layout = device.image_ports
    else:
        dt = device.device_type
        layout = dt.image_ports if dt else None
    return layout or None


def render_marker_name(raw: str, vc_position: int | None) -> str:
    """The component name a marker stands for on this device: ``{position}``
    renders to the stack member number, so member 2's markers find member 2's
    ports."""
    return render_component_name(raw, vc_position)


def _fold(name: str) -> str:
    # The same normalization the frontend's normalizePortName applies.
    return name.strip().lower()


class ComponentIndex:
    """Rendered marker name → component, over one relation's loaded rows.

    Precedence, first component winning within each step:

    1. exact ``marker_key`` - the frozen marker identity survives a rename of
       the visible name (Interface/Front/RearPort carry one; other kinds fall
       through to name matching);
    2. exact name;
    3. ``marker_key`` ignoring case and surrounding whitespace;
    4. name ignoring case and surrounding whitespace.

    The tolerant steps matter: imported photo markers routinely disagree
    with the live component names by case alone ("Psu 1" vs "PSU 1"), and an
    exact-only match silently left those markers unresolved."""

    __slots__ = ("components", "_exact", "_folded")

    def __init__(self, components):
        self.components = list(components)
        exact: dict[str, object] = {}
        folded: dict[str, object] = {}
        for c in self.components:
            mk = getattr(c, "marker_key", "") or ""
            if mk:
                exact.setdefault(mk, c)
                folded.setdefault(_fold(mk), c)
        for c in self.components:
            exact.setdefault(c.name, c)
            folded.setdefault(_fold(c.name), c)
        self._exact = exact
        self._folded = folded

    def match(self, name: str):
        """The component a rendered marker name resolves to, or None."""
        comp = self._exact.get(name)
        if comp is None:
            comp = self._folded.get(_fold(name))
        return comp


# ── the photo document ───────────────────────────────────────────────────────
# A type's ``image_ports`` (or a device's override) also keeps, per side, the
# editor's ``view``: the display ``scale`` and the photo's calibration
# (``cal``, #277) - two guides at fractions of the photo's width with the real
# distance between them, and the rail's centreline as a fraction of its
# height. The guides give the photo's true width: span / (right - left).

def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_image_ports_doc(value):
    """Check a photo document; DRF field errors for anything off."""
    from rest_framework.exceptions import ValidationError

    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValidationError('image_ports must be {"front": [...], "rear": [...]}.')
    total = 0
    for side in ("front", "rear"):
        markers = value.get(side, [])
        if not isinstance(markers, list):
            raise ValidationError(f"{side} must be a list of markers.")
        total += len(markers)
        for m in markers:
            if not isinstance(m, dict):
                raise ValidationError("Each marker must be an object.")
            kind = m.get("kind", "interface")
            if kind not in FACE_PORT_KINDS:
                raise ValidationError(f"Unknown marker kind {kind!r}.")
            name = m.get("name")
            if not isinstance(name, str) or not name or len(name) > 64:
                raise ValidationError("Markers need a name (≤64 chars).")
            for k in ("x", "y", "w", "h"):
                v = m.get(k)
                if not _num(v) or not (0 <= v <= 1):
                    raise ValidationError(f"Marker {k} must be a number in 0..1.")
    if total > 512:
        raise ValidationError("Too many markers (max 512).")
    view = value.get("view")
    if view is not None:
        if not isinstance(view, dict):
            raise ValidationError("view must be an object.")
        for side, v in view.items():
            if side not in ("front", "rear") or not isinstance(v, dict):
                raise ValidationError('view keys are "front" / "rear" objects.')
            scale = v.get("scale")
            if scale is not None and (not _num(scale) or not (0.1 <= scale <= 8)):
                raise ValidationError("view scale must be a number in 0.1..8, or null for fit.")
            _check_calibration(v.get("cal"))
    return value


def _check_calibration(cal) -> None:
    from rest_framework.exceptions import ValidationError

    if cal is None:
        return
    if not isinstance(cal, dict):
        raise ValidationError("view cal must be an object.")
    left, right = cal.get("left", 0), cal.get("right", 1)
    if not all(_num(x) and 0 <= x <= 1 for x in (left, right)):
        raise ValidationError("cal left and right are fractions of the photo's width, 0..1.")
    if right - left < 0.02:
        raise ValidationError("cal guides must stand apart, left before right.")
    span = cal.get("span_mm")
    if not _num(span) or not (1 <= span <= 5000):
        raise ValidationError("cal span_mm is the real distance between the guides, 1..5000 mm.")
    rail = cal.get("rail")
    if rail is not None and (not _num(rail) or not (0 <= rail <= 1)):
        raise ValidationError("cal rail is a fraction of the photo's height, 0..1, or null.")


def calibration(doc, side: str = "front") -> dict | None:
    """``side``'s calibration as saved in a photo document, or None."""
    view = doc.get("view") if isinstance(doc, dict) else None
    entry = view.get(side) if isinstance(view, dict) else None
    cal = entry.get("cal") if isinstance(entry, dict) else None
    if not isinstance(cal, dict) or not _num(cal.get("span_mm")):
        return None
    left, right = cal.get("left", 0), cal.get("right", 1)
    if not (_num(left) and _num(right)) or right - left <= 0:
        return None
    return {
        "left": left, "right": right, "span_mm": cal["span_mm"], "rail": cal.get("rail"),
        # The whole photo's true width.
        "photo_mm": round(cal["span_mm"] / (right - left), 1),
    }


def effective_calibration(device, side: str = "front") -> dict | None:
    """The calibration a device's photo uses: its own override's for that
    side, else its type's. A device inherits until it sets its own."""
    cal = calibration(device.image_ports, side)
    if cal is None and device.device_type_id is not None:
        cal = calibration(device.device_type.image_ports, side)
    return cal


def drop_calibration(doc, side: str):
    """``doc`` without ``side``'s calibration: a replaced or cleared photo's
    guides no longer stand where the old one's did. Returns ``doc`` itself
    when it holds none."""
    view = doc.get("view") if isinstance(doc, dict) else None
    entry = view.get(side) if isinstance(view, dict) else None
    if not isinstance(entry, dict) or "cal" not in entry:
        return doc
    # Prune what empties: a side with nothing left, then the view itself.
    rest = {k: v for k, v in entry.items() if k != "cal"}
    view = {**view, side: rest} if rest else {k: v for k, v in view.items() if k != side}
    if view:
        return {**doc, "view": view}
    return {k: v for k, v in doc.items() if k != "view"}
