"""What a power or cooling source takes down with it (#434).

The ``affected`` action of the power panel, power feed, cooling source and
cooling feed endpoints walks downstream - source → its feeds → the racks they
deliver to → the devices in those racks - and says, per rack and device, how
hard the work would hit it: an **outage** where the rack has no other feed of
the same kind, **reduced redundancy** where another feed still serves it. The
answer carries ``impacts`` in the shape the maintenance event create and
``ingest`` take, so planning maintenance on a source prefills its impact list.

Cooling also follows the hoses: a device whose cooling intake reaches a
feed of the work - directly or behind a CDU (``api.cooling_trace``) - is
affected wherever it stands. A device with intakes takes its level from
them: an **outage** when every feed its intakes reach is part of the work,
**reduced redundancy** when one is not; a device without takes its rack's.
Each cooling device carries its ``path``, the hops from source to device.

Read-only. The walk is worked out on every feed, so a rack's level never
depends on what the caller may see; the answer lists only the feeds, racks
and devices the caller may view.
"""
from __future__ import annotations

from django.db.models import Q

from auth_api import rbac

from .models import CoolingFeed, Device, PowerFeed, Rack

OUTAGE = "outage"
REDUCED = "reduced_redundancy"

# Feed model → its RBAC slug.
_FEED_SLUGS = {PowerFeed: "powerfeed", CoolingFeed: "coolingfeed"}


def affected(user, tenant, root, feeds) -> dict:
    """Downstream of ``root`` (a panel, source or single feed) through
    ``feeds`` (a queryset of the feeds that go with it)."""
    feed_model = feeds.model
    feed_slug = _FEED_SLUGS[feed_model]
    going = list(feeds.filter(tenant=tenant).select_related("rack").order_by("name"))
    going_ids = {f.pk for f in going}
    rack_ids = {f.rack_id for f in going if f.rack_id}
    backed = set(
        feed_model.objects.filter(tenant=tenant, rack_id__in=rack_ids)
        .exclude(pk__in=going_ids)
        .values_list("rack_id", flat=True)
    )
    level = {rid: REDUCED if rid in backed else OUTAGE for rid in rack_ids}

    visible_feeds = set(
        rbac.restrict_queryset(
            feed_model.objects.filter(pk__in=going_ids), user, tenant, feed_slug, "view"
        ).values_list("pk", flat=True)
    )
    racks = list(
        rbac.restrict_queryset(
            Rack.objects.filter(tenant=tenant, pk__in=rack_ids), user, tenant, "rack", "view"
        ).order_by("name")
    )
    cooling = feed_model is CoolingFeed
    device_q = Q(rack_id__in=rack_ids)
    if cooling:
        from .cooling_trace import downstream

        device_q |= Q(pk__in=list(downstream(going_ids, tenant)))
    devices = list(
        rbac.restrict_queryset(
            Device.objects.filter(device_q, tenant=tenant),
            user, tenant, "device", "view",
        ).select_related("rack").order_by("name")
    )
    dev_level = {d.pk: level.get(d.rack_id, OUTAGE) for d in devices}
    dev_path: dict = {}
    if cooling:
        from .cooling_trace import mask, paths_for

        for pk, paths in paths_for(devices, tenant).items():
            fed = {p["feed_id"] for p in paths if p["feed_id"] is not None}
            if fed:
                dev_level[pk] = OUTAGE if fed <= going_ids else REDUCED
            # The path through the work first, else the device's first.
            ordered = sorted(paths, key=lambda p: p["feed_id"] not in going_ids)
            dev_path[pk] = mask(ordered[:1], user, tenant)[0] if ordered else None

    root_slug = root._meta.model_name
    impacts = [{"object_type": root_slug, "object_id": str(root.pk), "level": OUTAGE}]
    if not isinstance(root, feed_model):
        impacts += [
            {"object_type": feed_slug, "object_id": str(f.pk), "level": OUTAGE}
            for f in going if f.pk in visible_feeds
        ]
    impacts += [
        {"object_type": "rack", "object_id": str(r.pk), "level": level[r.pk]}
        for r in racks
    ]
    impacts += [
        {"object_type": "device", "object_id": str(d.pk), "level": dev_level[d.pk]}
        for d in devices
    ]
    return {
        "feeds": [
            {
                "id": str(f.pk),
                "name": f.name,
                "type": f.type,
                "rack": {"id": str(f.rack.pk), "name": f.rack.name} if f.rack else None,
            }
            for f in going if f.pk in visible_feeds
        ],
        "racks": [
            {"id": str(r.pk), "name": r.name, "level": level[r.pk]} for r in racks
        ],
        "devices": [
            {
                "id": str(d.pk),
                "name": d.name,
                "level": dev_level[d.pk],
                "rack": {"id": str(d.rack.pk), "name": d.rack.name} if d.rack else None,
                **({"path": dev_path.get(d.pk)} if cooling else {}),
            }
            for d in devices
        ],
        "impacts": impacts,
    }
