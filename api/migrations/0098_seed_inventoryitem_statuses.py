# Extend every tenant's built-in Status catalog with the inventory-item
# lifecycle values (active / planned / failed / spare). Required system data:
# the hardware-health UI colours parts by status, so the kind must resolve.
# Idempotent — seed_builtin_statuses merges into existing rows by slug.
from django.db import migrations


def seed(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0097_inventoryitem_capacity_bytes_inventoryitem_kind_and_more"),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
