# Floor-plan snapshots: a plan's kind ("plan", or "view" - a live view of
# a rectangle of its source), its source and the rectangle, and the part of
# a CAD file a snapshot's copy renders. Every existing plan is a "plan"
# (db_default); the rest are nullable. No data to move.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0229_applicationflow_name_generated'),
    ]

    operations = [
        migrations.AddField(
            model_name='floorplan',
            name='crop',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='floorplan',
            name='kind',
            field=models.CharField(choices=[('plan', 'Plan'), ('view', 'View')], db_default='plan', default='plan', max_length=8),
        ),
        migrations.AddField(
            model_name='floorplan',
            name='snapshot_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='floorplan',
            name='source',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='snapshots', to='api.floorplan'),
        ),
        migrations.AddField(
            model_name='floorplandrawing',
            name='clip',
            field=models.JSONField(blank=True, null=True),
        ),
    ]
