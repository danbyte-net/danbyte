"""No volume in the compose files is mounted over the app's code (#332).

Docker fills a named volume from the image only when the volume is created,
so one mounted over a code folder serves that folder's first copy forever and
hides every later release's code."""
import re
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


class ComposeInternalUrlTests(SimpleTestCase):
    """Scripts in the workers container reach the API on the backend service:
    nothing listens on the workers' own 127.0.0.1:8000."""

    def test_prod_points_every_app_service_at_the_backend(self):
        doc = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
        url = doc["x-app-env"]["DANBYTE_INTERNAL_URL"]
        self.assertEqual(url, "${DANBYTE_INTERNAL_URL:-http://backend:8000}")
        self.assertIn("0.0.0.0:8000", doc["services"]["backend"]["command"])
        # The backend must see the setting too, or it refuses the host name.
        for name in ("backend", "workers", "scheduler", "fastlane", "ws"):
            env = doc["services"][name]["environment"]
            self.assertEqual(env.get("DANBYTE_INTERNAL_URL"), url, name)

    def test_dev_workers_point_at_the_backend(self):
        doc = yaml.safe_load((ROOT / "docker-compose.dev.yml").read_text())
        env = doc["services"]["workers"]["environment"]
        self.assertEqual(env["DANBYTE_INTERNAL_URL"], "http://backend:8000")


class ComposeBackendStartTests(SimpleTestCase):
    """The services that wait for a healthy backend must not be left unstarted
    by a backend that is still migrating (#441): the workers stayed Created,
    and every queued job, the bulk SNMP actions among them, never ran."""

    @staticmethod
    def seconds(value: str) -> int:
        units = {"s": 1, "m": 60, "h": 3600}
        return sum(int(n) * units[u] for n, u in re.findall(r"(\d+)([smh])", value))

    def test_start_period_outlasts_a_long_migration(self):
        doc = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
        check = doc["services"]["backend"]["healthcheck"]
        self.assertGreaterEqual(self.seconds(check["start_period"]), 30 * 60)
        waiting = [
            name for name, svc in doc["services"].items()
            if isinstance(svc.get("depends_on"), dict)
            and (svc["depends_on"].get("backend") or {}).get("condition") == "service_healthy"
        ]
        self.assertEqual(sorted(waiting), ["fastlane", "scheduler", "workers", "ws"])
