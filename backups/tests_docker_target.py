"""The Local target of a container install follows the backups volume to its
new mount point (#332), and nothing else moves."""
from importlib import import_module
from pathlib import Path

from django.apps import apps
from django.test import TestCase, override_settings

from backups.models import Backup, BackupTarget

move = import_module("backups.migrations.0002_move_docker_local_target").forwards


class MoveDockerLocalTargetTests(TestCase):
    def setUp(self):
        self.local = BackupTarget.objects.create(name="Local", kind="local",
                                                 config={"path": "/app/backups"})
        self.other = BackupTarget.objects.create(name="NAS", kind="local",
                                                 config={"path": "/mnt/nas"})
        self.run = Backup.objects.create(target=self.local, status="success",
                                         filename="a.tar.gz", location="/app/backups/a.tar.gz")

    def paths(self):
        self.local.refresh_from_db()
        self.other.refresh_from_db()
        self.run.refresh_from_db()
        return self.local.config["path"], self.other.config["path"], self.run.location

    @override_settings(BASE_DIR=Path("/app"), DANBYTE_BACKUP_DIR="/app/backup-archives")
    def test_a_container_target_moves_with_the_volume(self):
        move(apps, None)
        self.assertEqual(self.paths(), ("/app/backup-archives", "/mnt/nas",
                                        "/app/backup-archives/a.tar.gz"))

    @override_settings(BASE_DIR=Path("/app"), DANBYTE_BACKUP_DIR="/app/backups")
    def test_a_container_still_on_the_old_mount_keeps_it(self):
        move(apps, None)
        self.assertEqual(self.paths()[0], "/app/backups")

    @override_settings(BASE_DIR=Path("/opt/danbyte/danbyte"),
                       DANBYTE_BACKUP_DIR="/opt/danbyte/danbyte-backups")
    def test_a_bare_metal_install_is_left_alone(self):
        move(apps, None)
        self.assertEqual(self.paths()[0], "/app/backups")
