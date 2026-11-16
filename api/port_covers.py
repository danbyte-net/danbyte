"""Port covers on 3D models (docs/dcim/model-packs.md → Port covers).

A model names a removable blank or dust plug in a port ``cover:port:<interface
name>`` (export spec v1.5; api.model_anchors stores them as ``port_covers``).
The model is drawn as authored - every cover in place - and a device hides
the covers of its ports that are in use: cabled (a ``CableTermination`` on the
interface) or marked connected. A type's own view and its generated faces
have no cabling, so they keep every cover.

``hidden_covers`` answers that for many devices at once, in one query, for one
reader: only interfaces the reader may view count, so without interface view
the covers stay as authored and nothing about the cabling leaks. The names
match as port anchors' do (api.anchor_names): on stack member 2 a model's
``cover:port:StackPort1/1`` is the member's ``StackPort2/1``; a module's
``{module}`` takes its bay's position. The answer names covers as the placed
model does: the chassis' as authored, a module's with ``{module}``
substituted (frontend model-assembly ``placedPart``).
"""
from __future__ import annotations


def cover_names(anchors) -> list[str]:
    """The ``port_covers`` names of a stored anchors doc."""
    covers = (anchors or {}).get("port_covers")
    return [str(k) for k in covers] if isinstance(covers, dict) else []


def _wanted(device, owner) -> list[tuple[str | None, str, str]]:
    """``[(bay or None, cover name as drawn, interface name)]`` for one
    device: its chassis' covers, and each installed module's."""
    from .anchor_names import chassis_interface, module_interface
    from .models import render_module_name

    out = []
    if owner is not None:
        for name in cover_names(owner.model_anchors):
            out.append((None, name, chassis_interface(device, name)))
    for row in getattr(device, "_installed_parts", ()):
        mt = row.get("type")
        if mt is None or row.get("module") is None:
            continue
        for raw in cover_names(mt.model_anchors):
            out.append((row["name"], render_module_name(raw, row["position"]),
                        module_interface(device, mt, raw, row["position"])))
    return out


def has_covers(device, owner) -> bool:
    """Whether ``device``'s drawn model (or an installed part's) has port
    covers - checked before its parts are loaded on the chassis' alone."""
    if owner is not None and cover_names(owner.model_anchors):
        return True
    return any(cover_names(r["type"].model_anchors)
               for r in getattr(device, "_installed_parts", ())
               if r.get("type") is not None and r.get("module") is not None)


def in_use(device_ids, user, tenant) -> dict[str, set[str]]:
    """``{device id: {interface name}}`` - the interfaces of ``device_ids``
    the reader may view that are cabled or marked connected. One query."""
    from django.db.models import Exists, OuterRef, Q

    from auth_api import rbac

    from .models import CableTermination, Interface

    if not device_ids:
        return {}
    qs = Interface.objects.filter(device__tenant=tenant, device_id__in=list(device_ids))
    if not getattr(user, "is_superuser", False):
        qs = rbac.restrict_queryset(qs, user, tenant, "interface", "view")
    cabled = CableTermination.objects.filter(interface_id=OuterRef("pk"))
    out: dict[str, set[str]] = {}
    for dev_id, name in (qs.filter(Q(mark_connected=True) | Q(Exists(cabled)))
                         .order_by().values_list("device_id", "name")):
        out.setdefault(str(dev_id), set()).add(name)
    return out


def hidden_covers(devices, owners: dict, user, tenant) -> dict[str, dict]:
    """``{device id: {"covers": [...], "bay_covers": {bay: [...]}}}`` - the
    covers to hide on each device's drawn model. ``owners`` maps a device's
    id to its model's owner (api.model_3d.effective_owner); the devices'
    ``_installed_parts`` are loaded (api.model_3d.installed_parts). A
    device with nothing to hide gets empty lists."""
    wanted = {str(d.id): _wanted(d, owners.get(d.id)) for d in devices}
    used = in_use([d.id for d in devices if wanted[str(d.id)]], user, tenant)
    out: dict[str, dict] = {}
    for d in devices:
        key = str(d.id)
        names = used.get(key, set())
        covers: list[str] = []
        bays: dict[str, list[str]] = {}
        for bay, drawn, iface in wanted[key]:
            if iface not in names:
                continue
            if bay is None:
                covers.append(drawn)
            else:
                bays.setdefault(bay, []).append(drawn)
        out[key] = {"covers": sorted(set(covers)),
                    "bay_covers": {b: sorted(set(v)) for b, v in bays.items()}}
    return out
