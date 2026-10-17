"""Store aggregate prefixes in canonical form (#381).

Rewrites a prefix only when its canonical form is free in the tenant. Two
spellings of one block are both kept as they are; ``manage.py
check_aggregates`` lists them. Nothing is deleted. The reverse is a no-op:
the canonical form is a valid stored value for the previous release.
"""
from django.db import migrations


def forwards(apps, schema_editor):
    from api.aggregate_normalise import plan

    Aggregate = apps.get_model("api", "Aggregate")
    rows = list(Aggregate.objects.values_list("pk", "tenant_id", "prefix"))
    updates, _collisions = plan(rows)
    for pk, prefix in updates.items():
        Aggregate.objects.filter(pk=pk).update(prefix=prefix)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0203_interface_module_template"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
