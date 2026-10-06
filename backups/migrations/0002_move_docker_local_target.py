"""Point a container's Local backup target at the new archive folder (#332).

The container stack mounted its backups volume at /app/backups - the folder of
this app's own code - so Docker served the code from the volume's first copy
and hid every later release's. 0.17.1 mounts the volume at
/app/backup-archives instead; the archives are the same files on the same
volume. A Local target seeded as /app/backups would otherwise write into the
code folder, off the volume, and lose its archives with the container.

Only in the container image (BASE_DIR /app) and only when the backup folder
has moved there: a bare-metal install never has /app/backups.
"""
from pathlib import Path

from django.conf import settings
from django.db import migrations

OLD = "/app/backups"


def forwards(apps, schema_editor):
    new = str(settings.DANBYTE_BACKUP_DIR)
    if Path(settings.BASE_DIR) != Path("/app") or new.rstrip("/") == OLD:
        return
    BackupTarget = apps.get_model("backups", "BackupTarget")
    Backup = apps.get_model("backups", "Backup")
    for target in BackupTarget.objects.filter(kind="local"):
        if str((target.config or {}).get("path") or "").rstrip("/") != OLD:
            continue
        target.config = {**target.config, "path": new}
        target.save(update_fields=["config"])
        for backup in Backup.objects.filter(target=target, location__startswith=OLD + "/"):
            backup.location = new.rstrip("/") + backup.location[len(OLD):]
            backup.save(update_fields=["location"])


class Migration(migrations.Migration):
    dependencies = [("backups", "0001_initial")]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
