# VLANs gain a status (#172): seed every tenant's catalog with the VLAN
# vocabulary (active / reserved / deprecated, active the default) so the
# picker is not empty. Existing VLANs are left without a status, as
# interfaces were in 0140: which ones are really in use is the operator's to
# say, and the bulk edit sets many at once. Idempotent - merges by slug.

from django.db import migrations


def seed(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0178_vlan_status"),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
