"""The cooling path (#434): where a device's coolant comes from.

A device's **cooling intake** takes coolant from a cooling feed, or from an
**outflow** on another device - a CDU - whose own intake is fed in turn. The
hoses are references, not cables. :func:`device_path` walks each intake of a
device upstream - intake → feed → source, or intake → outflow → that
device's intake → … - and :func:`downstream` walks the other way, from feeds
to every device they reach. Both are loop-guarded and stop after
:data:`MAX_DEPTH` devices, and load one level at a time, so a walk costs a
query per level, not per hop.

A path's ``status``:

* ``fed`` - it ends at a cooling feed;
* ``open`` - an intake or a CDU's outflow is connected to nothing upstream;
* ``loop`` - it came back to a device already on the path;
* ``truncated`` - it went deeper than :data:`MAX_DEPTH` devices.

Hops run upstream-first: ``source``, ``feed``, the CDUs, then the device.
:func:`mask` blanks the hops the caller may not view.
"""
from __future__ import annotations

from auth_api import rbac

from .models import CoolingIntake, CoolingOutflow, Device

MAX_DEPTH = 8

FED, OPEN, LOOP, TRUNCATED = "fed", "open", "loop", "truncated"


def _ref(obj) -> dict | None:
    return {"id": str(obj.pk), "name": obj.name} if obj is not None else None


def _intakes(tenant):
    return CoolingIntake.objects.filter(device__tenant=tenant).select_related(
        "device", "cooling_feed__source", "outflow__device"
    )


def _device_hop(device, intake=None, outflow=None) -> dict:
    return {
        "kind": "device",
        "id": str(device.pk),
        "name": device.name,
        "intake": _ref(intake),
        "outflow": _ref(outflow),
    }


def paths_for(devices, tenant) -> dict:
    """``{device id: [path, …]}`` - one path per intake of each device, in
    intake name order; a device without intakes maps to ``[]``. Each path is
    ``{"intake", "status", "hops", "feed_id"}`` - ``feed_id`` the feed it
    ends at, else None."""
    devices = list(devices)
    out: dict = {d.pk: [] for d in devices}
    if not devices:
        return out
    # The walk state per path: (path, the intake to resolve next, devices seen).
    frontier = []
    for intake in _intakes(tenant).filter(device__in=devices).order_by("device_id", "name"):
        path = {
            "intake": _ref(intake),
            "status": OPEN,
            "hops": [_device_hop(intake.device, intake=intake)],
            "feed_id": None,
        }
        out[intake.device_id].append(path)
        frontier.append((path, intake, {intake.device_id}))
    depth = 0
    while frontier:
        nxt = []
        for path, intake, seen in frontier:
            if intake.cooling_feed_id is not None:
                feed = intake.cooling_feed
                path["hops"][:0] = [
                    {"kind": "source", **_ref(feed.source)},
                    {"kind": "feed", **_ref(feed)},
                ]
                path["status"] = FED
                path["feed_id"] = feed.pk
                continue
            outflow = intake.outflow
            if outflow is None or outflow.device.tenant_id != tenant.pk:
                continue  # open
            up = outflow.device
            if up.pk in seen:
                path["status"] = LOOP
                continue
            if depth + 1 >= MAX_DEPTH:
                path["status"] = TRUNCATED
                continue
            hop = _device_hop(up, outflow=outflow)
            path["hops"].insert(0, hop)
            if outflow.intake_id is None:
                continue  # open: the CDU's outflow names no intake
            nxt.append((path, outflow.intake_id, seen | {up.pk}, hop))
        if not nxt:
            break
        loaded = _intakes(tenant).in_bulk([i for _, i, _, _ in nxt])
        frontier = []
        for path, intake_id, seen, hop in nxt:
            intake = loaded.get(intake_id)
            if intake is None:
                continue
            hop["intake"] = _ref(intake)
            frontier.append((path, intake, seen))
        depth += 1
    return out


def downstream(feed_ids, tenant) -> dict:
    """``{device id: depth}`` for every device the feeds reach through
    intakes - depth 1 for an intake on the feed, 2 behind one CDU, … -
    loop-guarded, at most :data:`MAX_DEPTH` deep. A CDU's outflow passes
    coolant on when it names the intake that was reached, or no intake."""
    reached: dict = {}
    intakes = list(
        CoolingIntake.objects.filter(device__tenant=tenant, cooling_feed_id__in=list(feed_ids))
        .values_list("pk", "device_id")
    )
    depth = 1
    while intakes and depth <= MAX_DEPTH:
        new_devices = {d for _, d in intakes if d not in reached}
        for d in new_devices:
            reached[d] = depth
        intake_ids = [i for i, d in intakes if d in new_devices]
        if not intake_ids:
            break
        outflows = CoolingOutflow.objects.filter(
            device_id__in=new_devices, device__tenant=tenant
        ).values_list("pk", "intake_id", "device_id")
        live = {i for i in intake_ids}
        passing = [pk for pk, intake_id, _ in outflows if intake_id is None or intake_id in live]
        intakes = list(
            CoolingIntake.objects.filter(device__tenant=tenant, outflow_id__in=passing)
            .values_list("pk", "device_id")
        ) if passing else []
        depth += 1
    return reached


def mask(paths: list, user, tenant) -> list:
    """The paths with every hop the caller may not view blanked to
    ``{"kind", "hidden": true}``."""
    want: dict = {"device": set(), "feed": set(), "source": set()}
    for p in paths:
        for hop in p["hops"]:
            want[hop["kind"]].add(hop["id"])
    from .models import CoolingFeed, CoolingSource

    models = {"device": (Device, "device"), "feed": (CoolingFeed, "coolingfeed"),
              "source": (CoolingSource, "coolingsource")}
    visible: dict = {}
    for kind, ids in want.items():
        if not ids:
            visible[kind] = set()
            continue
        model, slug = models[kind]
        visible[kind] = {
            str(pk) for pk in rbac.restrict_queryset(
                model.objects.filter(tenant=tenant, pk__in=ids), user, tenant, slug, "view"
            ).values_list("pk", flat=True)
        }
    out = []
    for p in paths:
        hops = [
            hop if hop["id"] in visible[hop["kind"]] else {"kind": hop["kind"], "hidden": True}
            for hop in p["hops"]
        ]
        out.append({**{k: v for k, v in p.items() if k != "feed_id"}, "hops": hops})
    return out


def device_path(device, user, tenant) -> dict:
    """``GET /api/devices/<id>/cooling-path/``: ``{"device", "paths"}`` -
    each intake's path upstream, masked to what the caller may view."""
    paths = paths_for([device], tenant)[device.pk]
    return {"device": _ref(device), "max_depth": MAX_DEPTH, "paths": mask(paths, user, tenant)}
