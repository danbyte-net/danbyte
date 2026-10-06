"""No volume in the compose files is mounted over the app's code (#332).

Docker fills a named volume from the image only when the volume is created,
so one mounted over a code folder serves that folder's first copy forever and
hides every later release's code."""
from pathlib import Path

import yaml
from django.conf import settings
from django.test import SimpleTestCase

ROOT = Path(settings.BASE_DIR)
# What the image keeps under /app that is data, not code.
DATA_DIRS = {"staticfiles", "media", "backup-archives"}


class ComposeVolumeTests(SimpleTestCase):
    def mounts(self, path):
        doc = yaml.safe_load(path.read_text())
        for name, service in (doc.get("services") or {}).items():
            for vol in service.get("volumes") or []:
                target = vol.get("target") if isinstance(vol, dict) else vol.split(":")[1]
                yield name, target

    def test_no_volume_covers_code(self):
        files = sorted(ROOT.glob("docker-compose*.yml"))
        self.assertTrue(files)
        for path in files:
            for service, target in self.mounts(path):
                if not target.startswith("/app/"):
                    continue
                top = target.removeprefix("/app/").split("/")[0]
                with self.subTest(file=path.name, service=service, target=target):
                    self.assertIn(top, DATA_DIRS, f"{target} covers /app/{top}")
                    self.assertFalse((ROOT / top / "__init__.py").exists())

    def test_backups_land_on_the_backups_volume(self):
        doc = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
        backup_dir = doc["x-app-env"]["DANBYTE_BACKUP_DIR"]
        for name in ("backend", "workers"):
            self.assertIn(f"backups:{backup_dir}", doc["services"][name]["volumes"], name)
