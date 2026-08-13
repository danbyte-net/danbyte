# MaintenanceEvent.status: hard-coded word → row in the tenant's editable
# /statuses catalog (api.Status, available_to "maintenanceevent"). The old
# words match the seeded slugs one-to-one, so the backfill is a slug lookup.
# api.0115 (dependency) has already seeded every tenant.
import django.db.models.deletion
from django.db import migrations, models


def backfill(apps, schema_editor):
    MaintenanceEvent = apps.get_model("monitoring", "MaintenanceEvent")
    Status = apps.get_model("api", "Status")
    cache: dict[tuple, object] = {}
    for event in MaintenanceEvent.objects.all().iterator():
        key = (event.tenant_id, event.status)
        row = cache.get(key)
        if row is None:
            row = (
                Status.objects.filter(tenant_id=event.tenant_id, slug=event.status).first()
                or Status.objects.filter(tenant_id=event.tenant_id, slug="tentative").first()
            )
            cache[key] = row
        event.status_ref = row
        event.save(update_fields=["status_ref"])


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0115_status_is_closed_status_suppresses_alerts"),
        ("monitoring", "0069_silence_device_matcher"),
    ]

    operations = [
        migrations.AddField(
            model_name="maintenanceevent",
            name="status_ref",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="maintenance_events",
                to="api.status",
            ),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
        migrations.RemoveIndex(
            model_name="maintenanceevent",
            name="monitoring__tenant__f78dc7_idx",
        ),
        migrations.RemoveField(
            model_name="maintenanceevent",
            name="status",
        ),
        migrations.RenameField(
            model_name="maintenanceevent",
            old_name="status_ref",
            new_name="status",
        ),
        migrations.AlterField(
            model_name="maintenanceevent",
            name="status",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="maintenance_events",
                to="api.status",
            ),
        ),
        migrations.AddIndex(
            model_name="maintenanceevent",
            index=models.Index(
                fields=["tenant", "kind", "status"],
                name="monitoring__tenant__dd0126_idx",
            ),
        ),
    ]
