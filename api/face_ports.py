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
