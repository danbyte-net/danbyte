# The per-host vulnerability summaries the Devices and VMs lists read (#526).
#
# Not atomic: each tenant's summaries are computed from its matches (one
# grouped query) and written in batches of 1,000, and commit tenant by
# tenant. Running it again gives the same rows.

import django.db.models.deletion
import uuid
from django.db import migrations, models


def backfill(apps, schema_editor):
    from vulnerabilities import host_stats

    Match = apps.get_model("vulnerabilities", "VulnerabilityMatch")
    Stat = apps.get_model("vulnerabilities", "VulnerabilityHostStat")
    tenants = (Match.objects.filter(resolved_at__isnull=True).order_by()
               .values_list("tenant_id", flat=True).distinct())
    for tenant_id in list(tenants):
        host_stats.refresh(tenant_id, models=(Match, Stat))


class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ('api', '0281_module_bay_suggested_modules'),
        ('core', '0066_deploymentsettings_discovery_enabled'),
        ('vulnerabilities', '0007_match_rank_record_stats'),
    ]

    operations = [
        migrations.CreateModel(
            name='VulnerabilityHostStat',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('rank', models.PositiveSmallIntegerField()),
                ('open_records', models.PositiveIntegerField()),
                ('kev', models.BooleanField()),
                ('max_cvss', models.DecimalField(blank=True, decimal_places=1, max_digits=3, null=True)),
                ('device', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='vulnerability_stat', to='api.device')),
                ('tenant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='vulnerability_host_stats', to='core.tenant')),
                ('virtual_machine', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='vulnerability_stat', to='api.virtualmachine')),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(models.Q(('device__isnull', False), ('virtual_machine__isnull', True)), models.Q(('device__isnull', True), ('virtual_machine__isnull', False)), _connector='OR'), name='vuln_host_stat_one_host')],
            },
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
