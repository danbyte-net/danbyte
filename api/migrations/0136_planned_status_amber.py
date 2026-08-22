# "Planned" is a transitional state and every chart (utilization bar,
# topology status mode, floorplan tone) already draws it amber; the seeded
# swatch was the one grey holdout. Recolour only rows still on the old
# default - user-recoloured statuses are left alone.

from django.db import migrations

OLD = "#a1a1aa"
NEW = "#f59e0b"


def forward(apps, schema_editor):
    Status = apps.get_model("api", "Status")
    Status.objects.filter(slug="planned", color=OLD).update(color=NEW)


def backward(apps, schema_editor):
    Status = apps.get_model("api", "Status")
    Status.objects.filter(slug="planned", color=NEW).update(color=OLD)


class Migration(migrations.Migration):
    dependencies = [("api", "0135_portreservation")]
    operations = [migrations.RunPython(forward, backward)]
