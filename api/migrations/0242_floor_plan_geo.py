import math

from django.db import migrations, models

EARTH_CIRCUMFERENCE_M = 40_075_016.686
MAX_LAT = 85.05112878


def _merc_y(lat):
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    return (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0


def _lat_of(my):
    return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * my))))


def _bbox(raw):
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        vals = [float(v) for v in raw]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in vals):
        return None
    s, w, n, e = vals
    if not (-MAX_LAT <= s < n <= MAX_LAT and -180 <= w < e <= 180):
        return None
    return [s, w, n, e]


def backfill(apps, schema_editor):
    """The geo anchor of each plan made from the Site map, from the
    ``state.from_map`` it was made with. Snapshots and views are left out:
    their grid is a crop, not the box."""
    FloorPlan = apps.get_model("api", "FloorPlan")
    rows = FloorPlan.objects.filter(
        kind="plan", crop__isnull=True, geo_bbox__isnull=True, state__has_key="from_map"
    )
    for plan in rows.iterator():
        fm = (plan.state or {}).get("from_map")
        if not isinstance(fm, dict):
            continue
        bbox = _bbox(fm.get("bbox"))
        if bbox is None:
            continue
        s, w, n, e = bbox
        mid = _lat_of((_merc_y(n) + _merc_y(s)) / 2.0)
        per = EARTH_CIRCUMFERENCE_M * math.cos(math.radians(mid))
        width_m = (e - w) / 360.0 * per
        basemap = fm.get("basemap") if fm.get("basemap") in ("map", "sat") else ""
        zoom = fm.get("zoom")
        plan.geo_bbox = bbox
        plan.geo_mpc = width_m / max(1, plan.grid_width)
        plan.geo_zoom = zoom if isinstance(zoom, int) and 0 <= zoom <= 30 else None
        plan.geo_basemap = basemap
        plan.geo_captured_at = plan.created_at if basemap and plan.background_image else None
        plan.save(update_fields=[
            "geo_bbox", "geo_mpc", "geo_zoom", "geo_basemap", "geo_captured_at",
        ])


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0241_floor_plan_risers"),
    ]

    operations = [
        migrations.AddField(
            model_name="floorplan",
            name="geo_bbox",
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="floorplan",
            name="geo_mpc",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="floorplan",
            name="geo_zoom",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="floorplan",
            name="geo_basemap",
            field=models.CharField(
                blank=True, choices=[("", "None"), ("map", "Map"), ("sat", "Satellite")],
                db_default="", default="", max_length=8,
            ),
        ),
        migrations.AddField(
            model_name="floorplan",
            name="geo_captured_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
