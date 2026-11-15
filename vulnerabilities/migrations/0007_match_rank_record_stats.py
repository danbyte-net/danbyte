# The match list's order as stored columns, and the per-record counts and
# match groups the record list, the rails and the summary read (#520).
#
# Not atomic: the rank and score backfill commits in batches of BATCH rows,
# so a tenant with hundreds of thousands of matches neither holds one huge
# transaction nor rewrites the table in one statement. The order index is
# built after the backfill (once), then each tenant's per-record counts are
# computed from its matches. Every step can run again with the same result.

import uuid

import django.db.models.deletion
from django.db import migrations, models

BATCH = 10000
RANK_SQL = """
UPDATE vulnerabilities_vulnerabilitymatch m
   SET rank = CASE m.priority WHEN 'fix_first' THEN 0 WHEN 'high' THEN 1
                              WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
       cvss_score = c.cvss_score
  FROM vulnerabilities_cve c
 WHERE c.id = m.cve_id AND m.id = ANY(%s)
"""


def backfill_rank(apps, schema_editor):
    Match = apps.get_model("vulnerabilities", "VulnerabilityMatch")
    conn = schema_editor.connection
    last = None
    while True:
        qs = Match.objects.order_by("pk")
        if last is not None:
            qs = qs.filter(pk__gt=last)
        ids = list(qs.values_list("pk", flat=True)[:BATCH])
        if not ids:
            return
        with conn.cursor() as cur:
            cur.execute(RANK_SQL, [ids])
        last = ids[-1]


def backfill_stats(apps, schema_editor):
    from vulnerabilities import record_stats

    Match = apps.get_model("vulnerabilities", "VulnerabilityMatch")
    Stat = apps.get_model("vulnerabilities", "VulnerabilityRecordStat")
    Group = apps.get_model("vulnerabilities", "VulnerabilityMatchGroup")
    tenants = (Match.objects.filter(resolved_at__isnull=True).order_by()
               .values_list("tenant_id", flat=True).distinct())
    for tenant_id in list(tenants):
        record_stats.refresh(tenant_id, models=(Match, Stat, Group))


class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ('core', '0066_deploymentsettings_discovery_enabled'),
        ('vulnerabilities', '0006_tenant_state'),
    ]

    operations = [
        migrations.CreateModel(
            name='VulnerabilityRecordStat',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('priority', models.CharField(choices=[('fix_first', 'Fix first'), ('high', 'High'), ('medium', 'Medium'), ('low', 'Low')], max_length=10)),
                ('rank', models.PositiveSmallIntegerField()),
                ('devices', models.PositiveIntegerField()),
                ('virtual_machines', models.PositiveIntegerField()),
                ('installs', models.PositiveIntegerField()),
                ('matches', models.PositiveIntegerField()),
                ('excepted', models.PositiveIntegerField()),
                ('first_seen_at', models.DateTimeField(blank=True, null=True)),
                ('last_first_seen_at', models.DateTimeField(blank=True, null=True)),
                ('cve', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='vulnerabilities.cve')),
                ('tenant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='vulnerability_record_stats', to='core.tenant')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('tenant', 'cve'), name='uniq_vuln_record_stat')],
            },
        ),
        migrations.CreateModel(
            name='VulnerabilityMatchGroup',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('priority', models.CharField(choices=[('fix_first', 'Fix first'), ('high', 'High'), ('medium', 'Medium'), ('low', 'Low')], max_length=10)),
                ('site_id', models.UUIDField(blank=True, null=True)),
                ('platform_id', models.UUIDField(blank=True, null=True)),
                ('application_id', models.UUIDField(blank=True, null=True)),
                ('via', models.CharField(choices=[('platform', 'Platform'), ('application', 'Application'), ('package', 'Package'), ('os_build', 'OS build')], max_length=12)),
                ('confidence', models.CharField(choices=[('exact', 'Exact'), ('range', 'Range'), ('partial', 'Partial')], max_length=8)),
                ('first_seen_at', models.DateTimeField()),
                ('excepted', models.BooleanField()),
                ('matches', models.PositiveIntegerField()),
                ('cve', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='vulnerabilities.cve')),
                ('tenant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='vulnerability_match_groups', to='core.tenant')),
            ],
            options={
                'indexes': [models.Index(fields=['tenant', 'cve'], name='vuln_match_group_cve')],
            },
        ),
        migrations.AddField(
            model_name='vulnerabilitymatch',
            name='cvss_score',
            field=models.DecimalField(blank=True, decimal_places=1, max_digits=3, null=True),
        ),
        migrations.AddField(
            model_name='vulnerabilitymatch',
            name='rank',
            field=models.PositiveSmallIntegerField(db_default=4, default=4),
        ),
        migrations.RunPython(backfill_rank, migrations.RunPython.noop, elidable=True),
        migrations.AddIndex(
            model_name='vulnerabilitymatch',
            index=models.Index(models.F('tenant'), models.F('rank'), models.OrderBy(models.F('cvss_score'), descending=True, nulls_last=True), models.F('cve'), models.F('id'), condition=models.Q(('resolved_at__isnull', True)), name='vuln_match_open_order'),
        ),
        migrations.RunPython(backfill_stats, migrations.RunPython.noop, elidable=True),
    ]
