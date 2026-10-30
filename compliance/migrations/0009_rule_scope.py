"""Compliance rules gain several object types, a scope and conditions.

``object_types`` takes over from ``object_type``: each existing rule gets
``[object_type]``, so it judges exactly what it judged before. ``scope`` and
``condition`` start empty (null), and an existing rule keeps its own check.
Rules already filled are left alone, so a second run changes nothing. Reverse
is a no-op: the columns go with the schema step.
"""
import django.contrib.postgres.fields
from django.db import migrations, models


def fill_object_types(apps, schema_editor):
    ComplianceRule = apps.get_model("compliance", "ComplianceRule")
    for rule in ComplianceRule.objects.filter(object_types=[]).exclude(object_type=""):
        rule.object_types = [rule.object_type]
        rule.save(update_fields=["object_types"])


class Migration(migrations.Migration):

    dependencies = [
        ('compliance', '0008_eolproduct_custom'),
    ]

    operations = [
        migrations.AddField(
            model_name='compliancerule',
            name='condition',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='compliancerule',
            name='object_types',
            field=django.contrib.postgres.fields.ArrayField(base_field=models.CharField(max_length=20), blank=True, db_default=models.Value([], django.contrib.postgres.fields.ArrayField(base_field=models.CharField(max_length=20), size=None)), default=list, size=None),
        ),
        migrations.AddField(
            model_name='compliancerule',
            name='scope',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='compliancerule',
            name='check_type',
            field=models.CharField(choices=[('required', 'Field must be set'), ('forbidden', 'Field must be empty'), ('regex', 'Field must match a pattern'), ('required_tag', 'Must carry a tag'), ('required_cf', 'Custom field must be set'), ('eol_status', 'End-of-life status'), ('coverage', 'Support coverage'), ('software_target', 'Software target'), ('expression', 'Conditions')], max_length=16),
        ),
        migrations.RunPython(fill_object_types, migrations.RunPython.noop),
    ]
