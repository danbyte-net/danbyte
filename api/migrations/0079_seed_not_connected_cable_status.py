"""Backfill the built-in cable statuses (adds "Not connected") for every
existing tenant.

The built-in catalog gained a ``not_connected`` cable status. New tenants get
it automatically via ``seed_builtin_statuses`` on tenant creation; this migration
closes the gap for tenants that already exist at upgrade time. ``seed_builtin_
statuses`` is idempotent — it only creates rows that are missing, so tenants that
somehow already have every value are untouched.
"""

from django.db import migrations


def seed(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


def noop(apps, schema_editor):
    # Additive seed — nothing to unwind (statuses are user-editable data).
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0078_imageattachment_delete_deviceimage_and_more"),
    ]

    operations = [migrations.RunPython(seed, noop)]
