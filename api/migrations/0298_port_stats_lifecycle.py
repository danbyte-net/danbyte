# The Port utilization list's stored port counts per device and the Lifecycle
# page's row view (#535).
#
# DevicePortStat: table only - its rows are built after the upgrade, batch by
# batch and resumable, by `manage.py list_summaries` (api.list_summaries),
# never in one transaction here. LifecycleEntry: a view over its sources
# (api.lifecycle_view), nothing to fill.

import django.db.models.deletion
from django.db import migrations, models

from api.lifecycle_view import CREATE_SQL, DROP_SQL


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0297_mac_summary'),
        ('core', '0068_cable_ways_mode'),
    ]

    operations = [
        migrations.CreateModel(
            name='LifecycleEntry',
            fields=[
                ('id', models.CharField(max_length=64, primary_key=True, serialize=False)),
                ('kind', models.CharField(max_length=16)),
                ('source', models.CharField(max_length=16)),
                ('name', models.CharField(max_length=255)),
                ('item_id', models.UUIDField(null=True)),
                ('item_name', models.CharField(max_length=255, null=True)),
                ('version', models.CharField(blank=True, max_length=255)),
                ('entered_start', models.DateField(null=True)),
                ('entered_end', models.DateField(null=True)),
                ('warranty_end', models.DateField(null=True)),
                ('cov_contract_end', models.DateField(null=True)),
            ],
            options={
                'db_table': 'api_lifecycle_entry',
                'managed': False,
            },
        ),
        migrations.CreateModel(
            name='DevicePortStat',
            fields=[
                ('device', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, primary_key=True, related_name='port_stat', serialize=False, to='api.device')),
                ('if_total', models.PositiveIntegerField(default=0)),
                ('if_connected', models.PositiveIntegerField(default=0)),
                ('if_reserved', models.PositiveIntegerField(default=0)),
                ('if_marked', models.PositiveIntegerField(default=0)),
                ('virt_total', models.PositiveIntegerField(default=0)),
                ('virt_connected', models.PositiveIntegerField(default=0)),
                ('virt_reserved', models.PositiveIntegerField(default=0)),
                ('virt_marked', models.PositiveIntegerField(default=0)),
                ('fp_total', models.PositiveIntegerField(default=0)),
                ('fp_connected', models.PositiveIntegerField(default=0)),
                ('fp_reserved', models.PositiveIntegerField(default=0)),
                ('fp_marked', models.PositiveIntegerField(default=0)),
                ('refreshed_at', models.DateTimeField(auto_now=True)),
                ('tenant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='core.tenant')),
            ],
            options={
                'indexes': [models.Index(fields=['tenant'], name='device_port_stat_tenant')],
            },
        ),
        migrations.RunSQL(CREATE_SQL, DROP_SQL),
    ]
