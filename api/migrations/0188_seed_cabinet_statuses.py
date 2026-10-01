# Cabinets carry a status (#277): seed every tenant's catalog with the rack
# vocabulary for them (active / planned / reserved / available / deprecated,
# active the default) so the picker is not empty. Idempotent - merges by slug.

from django.db import migrations


def seed(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0187_cabinets"),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
