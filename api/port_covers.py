"""Port covers on 3D models (docs/dcim/model-packs.md → Port covers).

A model names a removable blank or dust plug in a port ``cover:port:<interface
name>`` (export spec v1.5; api.model_anchors stores them as ``port_covers``).
The model is drawn as authored - every cover in place - and a device hides
the covers of its ports that are in use: cabled (a ``CableTermination`` on the
interface or power port - a StackPower port's blank) or marked connected. A type's own view and its generated faces
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


def _wanted(device, owner) -> list[tuple[str | None, str, tuple[str, str]]]:
    """``[(bay or None, cover name as drawn, (port kind, port name))]`` for
    one device: its chassis' covers, and each installed module's. A cover
    names an interface, or another port-like component its type has a
    template of (a StackPower power port) as a ``port:`` anchor does."""
    from .anchor_names import chassis_port, module_port
    from .models import render_module_name

    out = []
    if owner is not None:
        for name in cover_names(owner.model_anchors):
            out.append((None, name, chassis_port(device, name)))
    for row in getattr(device, "_installed_parts", ()):
        mt = row.get("type")
        if mt is None or row.get("module") is None:
            continue
        for raw in cover_names(mt.model_anchors):
            out.append((row["name"], render_module_name(raw, row["position"]),
                        module_port(device, mt, raw, row["position"])))
    return out


def has_covers(device, owner) -> bool:
    """Whether ``device``'s drawn model (or an installed part's) has port
    covers - checked before its parts are loaded on the chassis' alone."""
    if owner is not None and cover_names(owner.model_anchors):
        return True
    return any(cover_names(r["type"].model_anchors)
               for r in getattr(device, "_installed_parts", ())
               if r.get("type") is not None and r.get("module") is not None)


#: The port kinds a cover may hide on: (kind, model, rbac slug,
#: CableTermination field, whether it has ``mark_connected``).
_COVER_KINDS = (
    ("interface", "Interface", "interface", "interface", True),
    ("power-port", "PowerPort", "powerport", "power_port", False),
)


def in_use(device_ids, user, tenant, kinds=("interface",)) -> dict[str, set[tuple[str, str]]]:
    """``{device id: {(port kind, name)}}`` - the ports of ``device_ids``
    of ``kinds`` (``interface``, ``power-port``) the reader may view that
    are cabled or (an interface) marked connected. One query (a UNION ALL
    when both kinds are asked for)."""
    from django.apps import apps
    from django.db.models import CharField, Exists, OuterRef, Q, Value

    from auth_api import rbac

    from .models import CableTermination

    if not device_ids:
        return {}
    superuser = getattr(user, "is_superuser", False)
    parts = []
    for kind, model_name, slug, field, connected in _COVER_KINDS:
        if kind not in kinds:
            continue
        model = apps.get_model("api", model_name)
        qs = model.objects.filter(device__tenant=tenant, device_id__in=list(device_ids))
        if not superuser:
            qs = rbac.restrict_queryset(qs, user, tenant, slug, "view")
        used = Q(Exists(CableTermination.objects.filter(**{f"{field}_id": OuterRef("pk")})))
        if connected:
            used |= Q(mark_connected=True)
        parts.append(qs.filter(used).order_by()
                     .annotate(_kind=Value(kind, output_field=CharField()))
                     .values_list("device_id", "_kind", "name"))
    if not parts:
        return {}
    rows = parts[0].union(*parts[1:], all=True) if len(parts) > 1 else parts[0]
    out: dict[str, set] = {}
    for dev_id, kind, name in rows:
        out.setdefault(str(dev_id), set()).add((kind, name))
    return out


def hidden_covers(devices, owners: dict, user, tenant) -> dict[str, dict]:
    """``{device id: {"covers": [...], "bay_covers": {bay: [...]}}}`` - the
    covers to hide on each device's drawn model. ``owners`` maps a device's
    id to its model's owner (api.model_3d.effective_owner); the devices'
    ``_installed_parts`` are loaded (api.model_3d.installed_parts). A
    device with nothing to hide gets empty lists."""
    wanted = {str(d.id): _wanted(d, owners.get(d.id)) for d in devices}
    # Power ports are asked about only when a cover names one.
    kinds = {"interface"} | {port[0] for rows in wanted.values() for _b, _n, port in rows
                             if port[0] == "power-port"}
    used = in_use([d.id for d in devices if wanted[str(d.id)]], user, tenant, kinds)
    out: dict[str, dict] = {}
    for d in devices:
        key = str(d.id)
        names = used.get(key, set())
        covers: list[str] = []
        bays: dict[str, list[str]] = {}
        for bay, drawn, port in wanted[key]:
            if port not in names:
                continue
            if bay is None:
                covers.append(drawn)
            else:
                bays.setdefault(bay, []).append(drawn)
        out[key] = {"covers": sorted(set(covers)),
                    "bay_covers": {b: sorted(set(v)) for b, v in bays.items()}}
    return out


def stack_covers(device, owner, ports: set, hidden) -> list[str]:
    """The chassis covers of ``device`` on ``ports`` (the names of its ports
    in a derived stack or StackPower ring, api.stack_links) that ``hidden``
    does not already name: the client hides them while it draws the ring.
    No query - the device's anchor names are loaded."""
    if not ports or owner is None:
        return []
    from .anchor_names import chassis_port

    have = set(hidden)
    return sorted({name for name in cover_names(owner.model_anchors)
                   if name not in have and chassis_port(device, name)[1] in ports})
