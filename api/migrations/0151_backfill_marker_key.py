# Freeze each existing port's current name as its marker identity: photo
# markers reference today's names, and from here on the visible name may be
# renamed freely without orphaning placed ports.
from django.db import migrations
from django.db.models import F


def backfill(apps, schema_editor):
    for model in ("Interface", "FrontPort", "RearPort"):
        apps.get_model("api", model).objects.filter(marker_key="").update(
            marker_key=F("name")
        )


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0150_frontport_marker_key_interface_marker_key_and_more"),
    ]
    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
