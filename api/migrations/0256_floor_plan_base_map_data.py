"""Two background layers: a plan's map background becomes its base layer.

Before this, a floor had one background picture. A plan made from the Site
map (or refreshed from it) had the map render as that picture, marked by
``geo_captured_at``; an uploaded picture cleared the mark. Now the map is a
``FloorPlanMap`` row under the floor, and ``background_image`` is the floor's
own picture drawn over it.

* A floor whose picture is the map (geo anchor, capture date and a picture)
  gets a map row holding that same file - nothing is copied - and its
  picture slot is emptied. The map keeps the floor's opacity.
* On an aligned floor plan the levels sharing one geo box share one row:
  the newest capture (the ground level's on a tie) is kept, the other
  levels' copies are no longer shown (their files stay in storage). Levels
  with that box and no map picture of their own (a basement added without
  the background, an upper floor with its own drawing) are put on it too;
  basements then hide it unless shown by hand.
* Every other picture is the floor's own and stays where it is.

Nothing is deleted. Reversing puts each map back as the picture of the
floors that have no picture of their own.
"""
from django.db import migrations


def _key(bbox):
    try:
        return tuple(round(float(v), 9) for v in bbox)
    except (TypeError, ValueError):
        return None


def _is_map(plan) -> bool:
    return (
        plan.kind == "plan"
        and isinstance(plan.geo_bbox, list) and len(plan.geo_bbox) == 4
        and plan.geo_captured_at is not None
        and bool(plan.background_image)
    )


def forwards(apps, schema_editor):
    FloorPlan = apps.get_model("api", "FloorPlan")
    FloorPlanMap = apps.get_model("api", "FloorPlanMap")

    plans = list(
        FloorPlan.objects.filter(kind="plan", geo_bbox__isnull=False, base_map__isnull=True)
        .select_related("stack").order_by("floor_order", "pk")
    )
    groups: dict = {}
    for p in plans:
        key = _key(p.geo_bbox) if isinstance(p.geo_bbox, list) else None
        if key is None or len(key) != 4:
            continue
        if p.stack_id and p.stack.aligned:
            gk = ("stack", p.stack_id, key)
        else:
            gk = ("plan", p.pk)
        groups.setdefault(gk, []).append(p)

    for members in groups.values():
        with_map = [p for p in members if _is_map(p)]
        if not with_map:
            continue
        # The newest render; the ground level (lowest order of 0 or more)
        # on a tie.
        keeper = sorted(
            with_map,
            key=lambda p: (-p.geo_captured_at.timestamp(), p.floor_order < 0,
                           p.floor_order),
        )[0]
        site_id = keeper.site_id or (keeper.stack.site_id if keeper.stack_id else None)
        if site_id is None:
            continue
        fm = (keeper.state or {}).get("from_map") if isinstance(keeper.state, dict) else None
        attribution = (fm or {}).get("attribution", "") if isinstance(fm, dict) else ""
        row = FloorPlanMap.objects.create(
            tenant_id=keeper.tenant_id,
            site_id=site_id,
            image=keeper.background_image.name,
            bbox=[float(v) for v in keeper.geo_bbox],
            zoom=keeper.geo_zoom,
            basemap=keeper.geo_basemap if keeper.geo_basemap in ("map", "sat") else "map",
            attribution=str(attribution or "")[:512],
            captured_at=keeper.geo_captured_at,
        )
        for p in members:
            was_map = _is_map(p)  # before its geo fields take the map's
            fields = ["base_map", "geo_captured_at", "geo_basemap", "geo_zoom"]
            p.base_map = row
            p.geo_captured_at = row.captured_at
            p.geo_basemap = row.basemap
            p.geo_zoom = row.zoom
            if was_map:
                # Its picture was the map: the map is now the base layer at
                # the opacity the picture had.
                p.map_opacity = p.background_opacity
                p.background_image = None
                fields += ["map_opacity", "background_image"]
            p.save(update_fields=fields)


def backwards(apps, schema_editor):
    FloorPlan = apps.get_model("api", "FloorPlan")
    for p in FloorPlan.objects.filter(base_map__isnull=False).select_related("base_map"):
        if p.background_image:
            continue
        p.background_image = p.base_map.image.name
        p.background_opacity = p.map_opacity
        p.save(update_fields=["background_image", "background_opacity"])


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0255_floor_plan_base_map"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
