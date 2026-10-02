"""The 3D geometry of racks, their devices and cabinets.

The floor plan's 3D room (``FloorPlanViewSet.scene``) and a rack page's 3D
view (``RackViewSet.scene``, #248) draw a rack from the same dicts, so a rack
looks the same in both. Static structure only: live state keeps coming from
the floor plan's ``state`` action and the rack's ``port-state``.
"""
from __future__ import annotations

from django.db.models import Prefetch

from .face_ports import effective_image_ports

# Every relation of a rack's devices that ``device_geo`` reads.
RACK_DEVICE_LOOKUPS = (
    "devices__device_type", "devices__role",
    "devices__status", "devices__primary_ip",
    "devices__power_ports", "devices__power_outlets",
)


def load_racks(racks, devices=None) -> dict:
    """``{rack id: rack}`` for the ``racks`` queryset, with everything
    ``rack_geo`` reads prefetched. ``devices`` (a Device queryset) narrows
    each rack's devices - to the ones a caller may view; None keeps all."""
    lookups: list = list(RACK_DEVICE_LOOKUPS)
    if devices is not None:
        lookups.insert(0, Prefetch("devices", queryset=devices))
    return {r.id: r for r in racks.prefetch_related(*lookups)}


def power_feed_types(racks) -> dict:
    """Power port id → the type of the feed its cable reaches ("primary" /
    "redundant"), for every inlet in ``racks`` that is cabled to a feed.

    Which redundant feed powers each PDU - the data-driven A/B signal the 3D
    room tints vertical strips by (primary vs redundant), instead of guessing
    from a name."""
    from .models import CableTermination

    inlet_ids = [
        p.id
        for r in racks
        for d in r.devices.all()
        for p in d.power_ports.all()
    ]
    feed_type_by_port: dict = {}
    if inlet_ids:
        # Two queries for the whole plan: the inlets' cables, then the
        # feed on the far end of each of those cables - not one query per
        # inlet (a 2,400-device hall paid 600 of them per scene load).
        inlet_terms = list(
            CableTermination.objects.filter(
                power_port_id__in=inlet_ids, cable__isnull=False
            ).values_list("power_port_id", "cable_id")
        )
        feed_by_cable = dict(
            CableTermination.objects.filter(
                cable_id__in={c for _, c in inlet_terms}, power_feed__isnull=False
            ).values_list("cable_id", "power_feed__type")
        )
        for port_id, cable_id in inlet_terms:
            if cable_id in feed_by_cable:
                feed_type_by_port[port_id] = feed_by_cable[cable_id]
    return feed_type_by_port


def image_url(request):
    """An image field → its absolute URL, or None when it is empty."""

    def img(f):
        return request.build_absolute_uri(f.url) if f else None

    return img


def device_geo(d, img, feed_types) -> dict:
    """One racked device: placement, footprint, look and power names.
    ``img`` is ``image_url(request)``; ``feed_types`` is
    ``power_feed_types(...)``."""
    dt = d.device_type
    return {
        "id": str(d.id),
        "name": d.name,
        "position": d.position,
        # Stack member number: `{position}` in a photo marker's name
        # renders to it, so member 2's ports anchor on their markers.
        "vc_position": d.vc_position,
        "face": d.face or "",
        "rack_side": d.rack_side or "",
        # Zero-U side mounting - position is None for these; the 3D
        # room draws them as vertical strips on the named rail.
        "mount": d.mount or "",
        "mount_offset_mm": d.mount_offset_mm,
        "mount_span_u": d.mount_span_u,
        "u_height": dt.u_height if dt else 1,
        "rack_width": (dt.rack_width if dt else "full") or "full",
        "is_full_depth": dt.is_full_depth if dt else True,
        # Port labels on this device's quads: inherit / on / off.
        "port_labels": d.port_labels,
        # Effective airflow (device override, else type default) so the
        # 3D room can draw intake/exhaust glyphs. "" = unknown/passive.
        "airflow": d.effective_airflow,
        "role_color": d.role.color if d.role_id else "",
        "role_name": d.role.name if d.role_id else "",
        "device_type": dt.name if dt else "",
        "status": {"name": d.status.name, "color": d.status.color}
        if d.status_id else None,
        "primary_ip": d.primary_ip.ip_address
        if d.primary_ip_id else None,
        "serial_number": d.serial_number or "",
        "front_image": img(dt.front_image if dt else None),
        "rear_image": img(dt.rear_image if dt else None),
        "has_faceplate": bool(dt and dt.faceplate),
        # Photo-anchored port markers (per device type; denormalized
        # here like front_image so the 3D face can overlay them).
        "image_ports": effective_image_ports(d),
        # The device's REAL power component names - the room lays out
        # deterministic clickable quads (and cable anchors) for any of
        # these that no photo marker covers, incl. PDU strip outlets.
        "power_ports": [p.name for p in d.power_ports.all()],
        "power_outlets": [o.name for o in d.power_outlets.all()],
        # Per-outlet/-port phase leg (A/B/C, "" if unset) - the vertical
        # PDU strip colours its cells by this. Keyed by name so the
        # existing name-list consumers are untouched.
        # feed_leg lives on outlets (which leg of the feed each socket
        # carries); inlets have no leg, so only outlets contribute.
        "power_legs": {
            o.name: o.feed_leg for o in d.power_outlets.all()
        },
        # "primary" | "redundant" | "" - which redundant feed powers
        # this PDU (its whole strip tints by it: the A/B story).
        "power_feed_type": next(
            (
                feed_types[p.id]
                for p in d.power_ports.all()
                if p.id in feed_types
            ),
            "",
        ),
    }


def rack_geo(r, img, feed_types) -> dict:
    """One rack and the devices it holds, as the 3D views draw it."""
    return {
        "id": str(r.id),
        "name": r.name,
        "u_height": r.u_height,
        "starting_unit": r.starting_unit,
        "desc_units": r.desc_units,
        "width": r.width,
        "outer_width_mm": r.outer_width_mm,
        "outer_depth_mm": r.outer_depth_mm,
        "devices": [
            device_geo(d, img, feed_types)
            for d in r.devices.all()
            # Positioned gear AND side-mounted 0U strips - a mounted
            # PDU has no U position but very much exists in the room.
            if d.position is not None or d.mount
        ],
    }


def cabinet_geo(c, device_count: int) -> dict:
    """A cabinet as a closed box: the room shows the enclosure, not its
    plate. An unrecorded outer size is the plate plus 50 mm, 200 mm deep."""
    return {
        "id": str(c.id),
        "name": c.name,
        "outer_width_mm": c.outer_width_mm or c.inner_width_mm + 50,
        "outer_height_mm": c.outer_height_mm or c.inner_height_mm + 50,
        "outer_depth_mm": c.outer_depth_mm or 200,
        "device_count": device_count,
    }
