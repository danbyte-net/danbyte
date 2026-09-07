# Interfaces gain a lifecycle status (#105): seed every tenant's catalog with
# the interface vocabulary (active / disabled / planned / not_present /
# decommissioning) and stamp excludes_capacity on the two that mean "this
# port is not real capacity". The flag column is new, so stamping existing
# decommissioning rows here can't overwrite a user's choice - there was no
# choice to make before this migration. Required system data: the SNMP sync
# and utilization paths FK these rows. Idempotent - merges by slug.

from django.db import migrations


def seed(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)
    Status.objects.filter(slug__in=["not_present", "decommissioning"]).update(
        excludes_capacity=True
    )


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0139_interface_status"),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
