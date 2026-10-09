# Undo the second default status that built-in seeding added (#361).
#
# Until 0.17.2, seeding the built-in statuses (manage.py bootstrap on every
# start and upgrade, and the 0179/0188 data migrations) put the built-in
# default back into default_for even when the operator had made another
# status the default, leaving two defaults for that object type. The Statuses
# API keeps one default per type - saving a default strips the type from
# every other row - so a type with exactly two defaults, one of them the
# built-in default, is that seeding: the other row is the operator's choice.
# Only that pattern is repaired. Any other duplicate is left for the operator.
# Availability that seeding re-added cannot be told from the operator's own,
# so it is not touched.

from django.db import migrations

# The built-in default per object type, frozen at this migration.
BUILTIN_DEFAULT = {"cable": "connected", "maintenanceevent": "tentative"}
FALLBACK_DEFAULT = "active"


def repair(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        rows = list(Status.objects.filter(tenant=tenant))
        types = {t for s in rows for t in (s.default_for or [])}
        for model_slug in sorted(types):
            claimants = [s for s in rows if model_slug in (s.default_for or [])]
            if len(claimants) != 2:
                continue
            builtin = BUILTIN_DEFAULT.get(model_slug, FALLBACK_DEFAULT)
            seeded = [s for s in claimants if s.slug == builtin]
            if len(seeded) != 1:
                continue
            row = seeded[0]
            row.default_for = [t for t in row.default_for if t != model_slug]
            row.save(update_fields=["default_for"])


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0196_upgrade_db_defaults"),
        ("core", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(repair, migrations.RunPython.noop),
    ]
