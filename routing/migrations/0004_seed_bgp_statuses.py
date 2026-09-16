# BGP sessions and routing instances carry a status: give every existing
# tenant the built-in vocabulary. New tenants get it from bootstrap.

from django.db import migrations


def seed(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


class Migration(migrations.Migration):

    dependencies = [
        ("routing", "0003_bgp"),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
