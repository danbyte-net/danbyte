"""Nodes the upgrade could not list count as seen before (#406).

0004 filled node memory from the links and the last sync's unmatched list,
which keeps only the first 1,000 rows. A connection that has synced before
is marked incomplete here, so its next successful sync proposes, rather than
serves, a new match for any node missing from memory, and records every node
it sees. A connection that never synced has seen nothing and stays complete.
This holds whether 0004 ran just now or in an earlier pre-release.
"""

from django.db import migrations, models


def mark_complete(apps, schema_editor):
    Connection = apps.get_model("oxidized", "OxidizedConnection")
    Connection.objects.filter(last_sync_at__isnull=True).update(node_memory_complete=True)
    Connection.objects.filter(last_sync_at__isnull=False).update(node_memory_complete=False)


class Migration(migrations.Migration):

    dependencies = [
        ('oxidized', '0004_node_memory_proposed_links'),
    ]

    operations = [
        migrations.AddField(
            model_name='oxidizedconnection',
            name='node_memory_complete',
            field=models.BooleanField(db_default=False, default=True),
        ),
        migrations.RunPython(mark_complete, migrations.RunPython.noop),
    ]
