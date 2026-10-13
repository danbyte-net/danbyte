"""A connection that synced before node memory existed stays incomplete (#411).

0005 marked such a connection incomplete until its next successful sync, and
that sync marked it complete. A sync records only the nodes Oxidized lists at
that moment, so a forgotten node that was away during it was never recorded
and linked straight away when it came back. The flag no longer clears; this
re-marks the connections a pre-release sync already cleared.

A connection created before 0004 added node memory and synced since may have
synced without it, and its first summary is gone, so it is marked incomplete.
A connection created after has had node memory from its first sync.
"""

from django.db import migrations
from django.db.migrations.recorder import MigrationRecorder


def mark_incomplete(apps, schema_editor):
    Connection = apps.get_model("oxidized", "OxidizedConnection")
    applied = (
        MigrationRecorder(schema_editor.connection).migration_qs
        .filter(app="oxidized", name="0004_node_memory_proposed_links")
        .values_list("applied", flat=True).first()
    )
    synced = Connection.objects.filter(last_sync_at__isnull=False)
    if applied is not None:
        synced = synced.filter(created_at__lt=applied)
    synced.update(node_memory_complete=False)


class Migration(migrations.Migration):

    dependencies = [
        ('oxidized', '0005_node_memory_complete'),
    ]

    operations = [
        migrations.RunPython(mark_incomplete, migrations.RunPython.noop),
    ]
