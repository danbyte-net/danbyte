"""Automatic node sync per Oxidized connection (#385).

``auto_sync`` is added as False, so every connection that exists at upgrade
time keeps syncing only when someone presses Sync nodes. The model default -
on, for connections created from here on - is set afterwards; it is a Python
default only, so that second step changes no row. The column defaults (off,
30 minutes) cover inserts from processes still on the previous release.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('oxidized', '0002_vm_links'),
    ]

    operations = [
        migrations.AddField(
            model_name='oxidizedconnection',
            name='auto_sync',
            field=models.BooleanField(db_default=False, default=False),
        ),
        migrations.AlterField(
            model_name='oxidizedconnection',
            name='auto_sync',
            field=models.BooleanField(db_default=False, default=True),
        ),
        migrations.AddField(
            model_name='oxidizedconnection',
            name='last_sync_attempt_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='oxidizedconnection',
            name='sync_interval_minutes',
            field=models.PositiveSmallIntegerField(choices=[(5, '5 minutes'), (10, '10 minutes'), (15, '15 minutes'), (30, '30 minutes'), (60, '1 hour')], db_default=30, default=30),
        ),
    ]
