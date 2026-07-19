"""Promote the flattened circuit A/Z site FKs into CircuitTermination rows,
then drop the old columns. Reverse restores the site-only data (per-side
speeds/xconnect collected after this migration would be lost on rollback)."""
from django.db import migrations


def forwards(apps, schema_editor):
    Circuit = apps.get_model("api", "Circuit")
    CircuitTermination = apps.get_model("api", "CircuitTermination")
    rows = []
    for c in Circuit.objects.exclude(
        termination_a_site__isnull=True, termination_z_site__isnull=True
    ).only("id", "termination_a_site_id", "termination_z_site_id"):
        if c.termination_a_site_id:
            rows.append(CircuitTermination(
                circuit_id=c.id, term_side="A", site_id=c.termination_a_site_id
            ))
        if c.termination_z_site_id:
            rows.append(CircuitTermination(
                circuit_id=c.id, term_side="Z", site_id=c.termination_z_site_id
            ))
    CircuitTermination.objects.bulk_create(rows)


def backwards(apps, schema_editor):
    Circuit = apps.get_model("api", "Circuit")
    CircuitTermination = apps.get_model("api", "CircuitTermination")
    for t in CircuitTermination.objects.filter(site__isnull=False).only(
        "circuit_id", "term_side", "site_id"
    ):
        field = "termination_a_site_id" if t.term_side == "A" else "termination_z_site_id"
        Circuit.objects.filter(pk=t.circuit_id).update(**{field: t.site_id})


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0054_circuittermination_consoleport_consoleporttemplate_and_more"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
        migrations.RemoveField(model_name="circuit", name="termination_a_site"),
        migrations.RemoveField(model_name="circuit", name="termination_z_site"),
    ]
