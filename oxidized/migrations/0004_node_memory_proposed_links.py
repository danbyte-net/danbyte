"""Node memory and proposed links (#398, #399).

``OxidizedNode`` records every node a connection has seen. It is filled here
from the existing links and the last sync's unmatched list, so the first sync
after the upgrade already knows which nodes sat unmatched: a new match for one
of them is proposed, not served. Existing links stay confirmed.
"""

import django.db.models.deletion
import uuid
from django.db import migrations, models


def backfill_nodes(apps, schema_editor):
    Connection = apps.get_model("oxidized", "OxidizedConnection")
    Link = apps.get_model("oxidized", "OxidizedNodeLink")
    Node = apps.get_model("oxidized", "OxidizedNode")
    for conn in Connection.objects.all().iterator():
        names = set(Link.objects.filter(connection=conn).values_list("full_name", flat=True))
        for row in (conn.last_sync_summary or {}).get("unmatched") or []:
            full = str((row or {}).get("full_name") or "").strip()[:255]
            if full:
                names.add(full)
        Node.objects.bulk_create(
            [Node(tenant_id=conn.tenant_id, connection=conn, full_name=n) for n in names],
            ignore_conflicts=True,
        )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0205_fhrpgroup_auth_key_secret_store'),
        ('core', '0060_tenantsettings_capacity_thresholds'),
        ('oxidized', '0003_auto_sync'),
    ]

    operations = [
        migrations.AddField(
            model_name='oxidizednodelink',
            name='proposed',
            field=models.BooleanField(db_default=False, default=False),
        ),
        migrations.CreateModel(
            name='OxidizedNode',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('full_name', models.CharField(max_length=255)),
                ('connection', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='nodes', to='oxidized.oxidizedconnection')),
                ('last_device', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='api.device')),
                ('last_virtual_machine', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='api.virtualmachine')),
                ('tenant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='oxidized_nodes', to='core.tenant')),
            ],
            options={
                'ordering': ['full_name'],
                'constraints': [models.UniqueConstraint(fields=('connection', 'full_name'), name='uniq_oxidized_node_conn_name')],
            },
        ),
        migrations.RunPython(backfill_nodes, migrations.RunPython.noop),
    ]
