# The MAC list's stored summary (#527) and the marks and build state every
# stored list summary keeps (api.list_summaries).
#
# Tables and indexes only: the rows are built after the upgrade, batch by
# batch and resumable, by `manage.py list_summaries` (run at the end of every
# upgrade and nightly), never in one transaction here. Until a tenant's build
# finishes, its MAC list reads the rows built so far and says so.

import django.db.models.deletion
import django.db.models.functions.text
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0296_model_pack_bundles'),
        ('core', '0068_cable_ways_mode'),
        ('routing', '0021_bgp_maximum_prefix_detail'),
    ]

    operations = [
        migrations.CreateModel(
            name='ListSummaryDirty',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('kind', models.CharField(max_length=16)),
                ('key', models.CharField(max_length=64)),
            ],
        ),
        migrations.CreateModel(
            name='ListSummaryState',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('kind', models.CharField(max_length=16)),
                ('built_at', models.DateTimeField(blank=True, null=True)),
                ('started_at', models.DateTimeField(blank=True, null=True)),
                ('cursor', models.CharField(blank=True, default='', max_length=64)),
            ],
        ),
        migrations.CreateModel(
            name='MacSummary',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('key', models.CharField(max_length=64)),
                ('hex', models.CharField(blank=True, default='', max_length=12)),
                ('interfaces', models.PositiveIntegerField(default=0)),
                ('vm_interfaces', models.PositiveIntegerField(default=0)),
                ('ips', models.PositiveIntegerField(default=0)),
                ('mac_objects', models.PositiveIntegerField(default=0)),
                ('vendor_override', models.CharField(blank=True, default='', max_length=255)),
                ('oui_vendor', models.CharField(blank=True, default='', max_length=255)),
                ('oui_source', models.CharField(blank=True, default='', max_length=16)),
                ('learned_port', models.CharField(blank=True, default='', max_length=128)),
                ('refreshed_at', models.DateTimeField(auto_now=True)),
            ],
        ),
        migrations.AddIndex(
            model_name='interface',
            index=models.Index(django.db.models.functions.text.Lower(django.db.models.functions.text.Trim('mac_address')), condition=models.Q(('mac_address', ''), _negated=True), name='iface_mac_key_idx'),
        ),
        migrations.AddIndex(
            model_name='ipaddress',
            index=models.Index(django.db.models.functions.text.Lower(django.db.models.functions.text.Trim('mac_address')), condition=models.Q(('mac_address', ''), _negated=True), name='ip_mac_key_idx'),
        ),
        migrations.AddIndex(
            model_name='macaddress',
            index=models.Index(django.db.models.functions.text.Lower(django.db.models.functions.text.Trim('mac_address')), condition=models.Q(('mac_address', ''), _negated=True), name='macaddr_mac_key_idx'),
        ),
        migrations.AddIndex(
            model_name='vminterface',
            index=models.Index(django.db.models.functions.text.Lower(django.db.models.functions.text.Trim('mac_address')), condition=models.Q(('mac_address', ''), _negated=True), name='vmiface_mac_key_idx'),
        ),
        migrations.AddField(
            model_name='listsummarydirty',
            name='tenant',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='core.tenant'),
        ),
        migrations.AddField(
            model_name='listsummarystate',
            name='tenant',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='core.tenant'),
        ),
        migrations.AddField(
            model_name='macsummary',
            name='learned_device',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='api.device'),
        ),
        migrations.AddField(
            model_name='macsummary',
            name='learned_interface',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='api.interface'),
        ),
        migrations.AddField(
            model_name='macsummary',
            name='tenant',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='core.tenant'),
        ),
        migrations.AddConstraint(
            model_name='listsummarydirty',
            constraint=models.UniqueConstraint(fields=('tenant', 'kind', 'key'), name='list_summary_dirty_uniq'),
        ),
        migrations.AddConstraint(
            model_name='listsummarystate',
            constraint=models.UniqueConstraint(fields=('tenant', 'kind'), name='list_summary_state_uniq'),
        ),
        migrations.AddIndex(
            model_name='macsummary',
            index=models.Index(fields=['tenant', 'hex'], name='mac_summary_tenant_hex'),
        ),
        migrations.AddConstraint(
            model_name='macsummary',
            constraint=models.UniqueConstraint(fields=('tenant', 'key'), name='mac_summary_tenant_key'),
        ),
    ]
