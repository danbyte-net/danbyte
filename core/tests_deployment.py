"""Deployment Email & Delivery settings — endpoint + secret handling."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from .models import DeploymentSettings


class DeploymentSettingsApiTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", "admin@acme.com", "pw"
        )

    def test_requires_manage_permission(self):
        reader = get_user_model().objects.create_user("reader", "r@acme.com", "pw")
        self.client.force_login(reader)
        self.assertEqual(self.client.get("/api/deployment/email/").status_code, 403)

    def test_get_returns_singleton_without_secret(self):
        self.client.force_login(self.admin)
        r = self.client.get("/api/deployment/email/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("smtp_password_set", r.json())
        self.assertNotIn("smtp_password", r.json())
        self.assertNotIn("secrets", r.json())

    def test_put_sets_encrypted_password(self):
        self.client.force_login(self.admin)
        r = self.client.put(
            "/api/deployment/email/",
            {
                "email_enabled": True,
                "smtp_host": "smtp.acme.com",
                "smtp_password": "topsecret",
                "smtp_security": "ssl",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["smtp_password_set"])
        obj = DeploymentSettings.load()
        self.assertEqual(obj.secrets.get("password"), "topsecret")
        self.assertEqual(obj.smtp_security, "ssl")

    def test_blank_password_keeps_existing(self):
        obj = DeploymentSettings.load()
        obj.secrets = {"password": "keepme"}
        obj.save()
        self.client.force_login(self.admin)
        self.client.put(
            "/api/deployment/email/",
            {"smtp_host": "smtp.new.com", "smtp_password": ""},
            format="json",
        )
        obj = DeploymentSettings.load()
        self.assertEqual(obj.secrets.get("password"), "keepme")
        self.assertEqual(obj.smtp_host, "smtp.new.com")

    def test_singleton_enforced(self):
        a = DeploymentSettings.load()
        b = DeploymentSettings.load()
        self.assertEqual(a.pk, b.pk)
        self.assertEqual(DeploymentSettings.objects.count(), 1)


class DeviceFieldVisibilityApiTests(APITestCase):
    URL = "/api/deployment/device-fields/"
    DEFAULTS = {
        "comments": True,
        "location": True,
        "cluster": False,
        "airflow": False,
        "latitude": True,
        "longitude": True,
    }

    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", "admin@acme.com", "pw"
        )

    def test_requires_manage_permission(self):
        reader = get_user_model().objects.create_user("reader", "r@acme.com", "pw")
        self.client.force_login(reader)
        self.assertEqual(self.client.get(self.URL).status_code, 403)

    def test_get_returns_defaults_when_empty(self):
        self.client.force_login(self.admin)
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), self.DEFAULTS)

    def test_put_persists_and_get_reflects(self):
        self.client.force_login(self.admin)
        r = self.client.put(
            self.URL, {"cluster": True, "airflow": True}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["cluster"])
        self.assertTrue(body["airflow"])
        # Others keep their defaults.
        self.assertTrue(body["comments"])
        self.assertTrue(body["location"])
        self.assertTrue(body["latitude"])
        self.assertTrue(body["longitude"])
        # Persisted to the singleton and reflected on a fresh GET.
        obj = DeploymentSettings.load()
        self.assertTrue(obj.device_field_visibility["cluster"])
        self.assertTrue(obj.device_field_visibility["airflow"])
        self.assertEqual(self.client.get(self.URL).json(), body)

    def test_unknown_keys_ignored(self):
        self.client.force_login(self.admin)
        r = self.client.put(
            self.URL, {"bogus": True, "cluster": True}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("bogus", r.json())
        self.assertNotIn("bogus", DeploymentSettings.load().device_field_visibility)


class SystemUpdatesApiTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", "admin@acme.com", "pw"
        )

    def test_requires_manage(self):
        reader = get_user_model().objects.create_user("r", "r@acme.com", "pw")
        self.client.force_login(reader)
        self.assertEqual(self.client.get("/api/system/updates/").status_code, 403)

    def test_lists_releases_and_flags_update(self):
        from unittest.mock import patch

        self.client.force_login(self.admin)
        fake = [
            {"tag": "v0.2.0", "name": "0.2.0", "body": "## New\n- stuff",
             "published_at": "2026-07-06T00:00:00Z", "prerelease": False,
             "has_binary": False},
            {"tag": "v0.1.0", "name": "0.1.0", "body": "", "published_at": None,
             "prerelease": False, "has_binary": False},
        ]
        # Pin the running version too — the assertion below broke every time a
        # real release bumped danbyte.__version__ past the fixture tags.
        with patch("core.github.list_releases", return_value=fake), \
             patch("core.version.system_version",
                   return_value={"version": "0.1.0"}):
            r = self.client.get("/api/system/updates/")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual(d["current"]["version"], "0.1.0")
        self.assertTrue(d["update_available"])  # 0.2.0 > running 0.1.0
        tags = {x["tag"]: x for x in d["releases"]}
        self.assertTrue(tags["v0.1.0"]["is_current"])
        self.assertFalse(tags["v0.2.0"]["is_current"])
        self.assertIn("New", tags["v0.2.0"]["body"])  # changelog surfaced

    def test_stable_channel_hides_prereleases(self):
        from unittest.mock import patch

        self.client.force_login(self.admin)
        fake = [{"tag": "v0.3.0-rc1", "name": "rc", "body": "", "published_at": None,
                 "prerelease": True, "has_binary": False}]
        with patch("core.github.list_releases", return_value=fake):
            r = self.client.get("/api/system/updates/").json()
        self.assertEqual(r["releases"], [])          # stable channel filters it
        self.assertFalse(r["update_available"])

    def test_release_repo_token_write_only(self):
        self.client.force_login(self.admin)
        r = self.client.put(
            "/api/deployment/email/",
            {"release_repo_url": "https://github.com/acme/danbyte",
             "release_repo_token": "ghp_x"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["release_repo_token_set"])
        self.assertNotIn("release_repo_token", r.json())


class UpgradeLockTests(SimpleTestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from core import upgrade

        self.upgrade = upgrade
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for name, path in {
            "LOCK_FILE": root / ".upgrade.lock",
            "LOCK_GUARD_FILE": root / ".upgrade.lock.guard",
            "STATUS_FILE": root / ".upgrade-status.json",
            "BUNDLE_UPLOAD": root / ".upgrade-bundle.tar.gz",
        }.items():
            patcher = patch.object(upgrade, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_only_one_concurrent_caller_acquires_the_slot(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier

        barrier = Barrier(2)

        def acquire():
            barrier.wait()
            return self.upgrade._acquire_upgrade_lock()

        with ThreadPoolExecutor(max_workers=2) as pool:
            owners = list(pool.map(lambda _: acquire(), range(2)))
        self.assertEqual(sum(owner is not None for owner in owners), 1)

    def test_only_one_process_acquires_the_slot(self):
        import multiprocessing
        from unittest.mock import patch

        ctx = multiprocessing.get_context("fork")
        barrier = ctx.Barrier(2)
        results = ctx.Queue()

        def acquire():
            barrier.wait()
            results.put(self.upgrade._acquire_upgrade_lock())

        with patch("core.upgrade._legacy_upgrade_running", return_value=False):
            processes = [ctx.Process(target=acquire) for _ in range(2)]
            for process in processes:
                process.start()
            owners = [results.get(timeout=5) for _ in processes]
            for process in processes:
                process.join(timeout=5)
                self.assertEqual(process.exitcode, 0)
        self.assertEqual(sum(owner is not None for owner in owners), 1)

    def test_upload_lock_cannot_be_stolen_before_status_is_written(self):
        owner = self.upgrade._acquire_upgrade_lock()
        self.assertIsNotNone(owner)
        # Reproduce the old race: the previous run's terminal status remains
        # visible while the new request is still streaming its upload.
        self.upgrade.STATUS_FILE.write_text('{"state":"done"}')
        competing_owners = []

        class RacingUpload:
            def chunks(inner_self):
                competing_owners.append(
                    self.upgrade._acquire_upgrade_lock()
                )
                yield b"first"
                yield b"second"

        self.upgrade._store_uploaded_bundle(RacingUpload())
        self.assertEqual(competing_owners, [None])
        self.assertEqual(self.upgrade.BUNDLE_UPLOAD.read_bytes(), b"firstsecond")

    def test_only_owner_can_release_and_later_upgrade_can_acquire(self):
        owner = self.upgrade._acquire_upgrade_lock()
        self.assertIsNotNone(owner)
        self.assertFalse(self.upgrade._release_upgrade_lock("wrong-owner"))
        self.assertIsNone(self.upgrade._acquire_upgrade_lock())
        self.assertTrue(self.upgrade._release_upgrade_lock(owner))
        self.assertIsNotNone(self.upgrade._acquire_upgrade_lock())

    def test_systemd_and_detached_launches_are_checked_without_real_systemd(self):
        from unittest.mock import patch

        owner = self.upgrade._acquire_upgrade_lock()
        self.upgrade._set_upgrade_lock_phase(
            owner,
            "launched",
            via="detached",
            child_pid=4242,
            child_pid_start="start",
            launched_at=0,
        )
        with patch("core.upgrade._pid_matches", return_value=True):
            self.assertTrue(self.upgrade._upgrade_running())

        self.upgrade._set_upgrade_lock_phase(
            owner, "launched", via="systemd-run", launched_at=0
        )
        with patch("core.upgrade._systemd_unit_active", return_value=True):
            self.assertTrue(self.upgrade._upgrade_running())
        with patch("core.upgrade._systemd_unit_active", return_value=False), \
             patch.object(self.upgrade, "LOCK_LAUNCH_GRACE_SECONDS", 0):
            self.assertFalse(self.upgrade._upgrade_running())
            self.assertIsNotNone(self.upgrade._acquire_upgrade_lock())

    def test_systemd_probe_is_tri_state(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        cases = (
            (SimpleNamespace(returncode=1, stdout="", stderr="Failed to connect to bus"), None),
            (SimpleNamespace(returncode=3, stdout="inactive\n", stderr=""), False),
            (
                SimpleNamespace(
                    returncode=4,
                    stdout="",
                    stderr="Unit danbyte-upgrade.service could not be found.",
                ),
                False,
            ),
            (SimpleNamespace(returncode=3, stdout="deactivating\n", stderr=""), True),
        )
        for result, expected in cases:
            with self.subTest(result=result), patch(
                "core.upgrade.subprocess.run", return_value=result
            ):
                self.assertIs(self.upgrade._systemd_unit_active(), expected)

    def test_no_lock_still_reconciles_systemd_and_legacy_status(self):
        from unittest.mock import patch

        with patch("core.upgrade._systemd_unit_active", return_value=True):
            self.assertIsNone(self.upgrade._acquire_upgrade_lock())

        self.upgrade.STATUS_FILE.write_text('{"state":"running"}')
        with patch("core.upgrade._systemd_unit_active", return_value=False):
            # Inactive systemd does not disprove a legacy detached process.
            self.assertIsNone(self.upgrade._acquire_upgrade_lock())

        self.upgrade.STATUS_FILE.write_text('{"state":"done"}')
        with patch("core.upgrade._systemd_unit_active", return_value=False):
            self.assertIsNotNone(self.upgrade._acquire_upgrade_lock())

    def test_legacy_failed_status_blocks_during_old_script_rollback(self):
        from unittest.mock import patch

        self.upgrade.STATUS_FILE.write_text('{"state":"failed"}')
        with patch("core.upgrade._systemd_unit_active", return_value=False), patch(
            "core.upgrade._status_age", return_value=10
        ):
            self.assertIsNone(self.upgrade._acquire_upgrade_lock())
        with patch("core.upgrade._systemd_unit_active", return_value=False), patch(
            "core.upgrade._status_age",
            return_value=self.upgrade.LEGACY_FAILED_GRACE_SECONDS + 1,
        ):
            self.assertIsNotNone(self.upgrade._acquire_upgrade_lock())

    def test_prelaunch_failure_marker_does_not_create_a_legacy_deadlock(self):
        from unittest.mock import patch

        self.upgrade.STATUS_FILE.write_text(
            '{"state":"failed","launch_attempted":false}'
        )
        with patch("core.upgrade._systemd_unit_active", return_value=None):
            self.assertIsNotNone(self.upgrade._acquire_upgrade_lock())

    def test_unknown_systemd_state_does_not_expire_a_running_structured_lock(self):
        from unittest.mock import patch

        owner = self.upgrade._acquire_upgrade_lock()
        self.upgrade.STATUS_FILE.write_text('{"state":"running"}')
        self.upgrade._set_upgrade_lock_phase(
            owner,
            "launched",
            via="systemd-run",
            launched_at=0,
        )
        with patch("core.upgrade._systemd_unit_active", return_value=None), patch.object(
            self.upgrade, "LOCK_LAUNCH_GRACE_SECONDS", 0
        ):
            self.assertTrue(self.upgrade._upgrade_running())
            self.assertIsNone(self.upgrade._acquire_upgrade_lock())

    def test_pid_identity_uncertainty_is_fail_closed(self):
        from unittest.mock import patch

        with patch("core.upgrade._process_identity", return_value=("S", "new")):
            self.assertFalse(self.upgrade._pid_matches(42, "old"))
            self.assertIsNone(self.upgrade._pid_matches(42, None))
        with patch("core.upgrade._process_identity", return_value=(None, None)), patch(
            "core.upgrade.os.kill", side_effect=PermissionError
        ):
            self.assertIsNone(self.upgrade._pid_matches(42, "old"))

    def test_launch_handoff_records_systemd_attempt_and_detached_pid(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch

        owner = self.upgrade._acquire_upgrade_lock()
        seen_during_systemd = {}

        def accept_systemd(*args, **kwargs):
            seen_during_systemd.update(
                json.loads(self.upgrade.LOCK_FILE.read_text())
            )
            return SimpleNamespace(returncode=0)

        with patch("core.upgrade.subprocess.run", side_effect=accept_systemd):
            self.assertEqual(
                self.upgrade._launch_command(["/bin/true"], owner),
                "systemd-run",
            )
        self.assertEqual(seen_during_systemd["owner"], owner)
        self.assertEqual(seen_during_systemd["via"], "systemd-run")

        self.assertTrue(self.upgrade._release_upgrade_lock(owner))
        owner = self.upgrade._acquire_upgrade_lock()
        child = SimpleNamespace(pid=4242)
        with patch("core.upgrade.subprocess.run", side_effect=OSError), \
             patch("core.upgrade.subprocess.Popen", return_value=child), \
             patch("core.upgrade._process_identity", return_value=("S", "start")):
            self.assertEqual(
                self.upgrade._launch_command(["/bin/true"], owner),
                "detached",
            )
        detached = json.loads(self.upgrade.LOCK_FILE.read_text())
        self.assertEqual(detached["owner"], owner)
        self.assertEqual(detached["via"], "detached")
        self.assertEqual(detached["child_pid"], 4242)
        self.assertEqual(detached["child_pid_start"], "start")

    def test_systemd_timeout_with_unknown_state_never_falls_back(self):
        import subprocess
        from unittest.mock import patch

        owner = self.upgrade._acquire_upgrade_lock()
        self.upgrade._write_start_status("v1.0.0", owner)
        with patch(
            "core.upgrade.subprocess.run",
            side_effect=subprocess.TimeoutExpired("systemd-run", 15),
        ), patch("core.upgrade._systemd_unit_active", return_value=None), patch(
            "core.upgrade.subprocess.Popen"
        ) as popen:
            with self.assertRaises(self.upgrade.UpgradeLaunchUncertain):
                self.upgrade._launch_command(["/bin/true"], owner)
        popen.assert_not_called()
        self.assertTrue(self.upgrade.LOCK_FILE.exists())
        with patch("core.upgrade._systemd_unit_active", return_value=None):
            self.assertIsNone(self.upgrade._acquire_upgrade_lock())

    def test_systemd_timeout_falls_back_only_when_unit_is_confirmed_inactive(self):
        import subprocess
        from types import SimpleNamespace
        from unittest.mock import patch

        owner = self.upgrade._acquire_upgrade_lock()
        self.upgrade._write_start_status("v1.0.0", owner)
        child = SimpleNamespace(pid=4242)
        with patch(
            "core.upgrade.subprocess.run",
            side_effect=subprocess.TimeoutExpired("systemd-run", 15),
        ), patch("core.upgrade._systemd_unit_active", return_value=False), patch(
            "core.upgrade.subprocess.Popen", return_value=child
        ) as popen, patch(
            "core.upgrade._process_identity", return_value=("S", "start")
        ):
            self.assertEqual(
                self.upgrade._launch_command(["/bin/true"], owner),
                "detached",
            )
        popen.assert_called_once()

    def test_nonzero_systemd_result_with_unknown_state_never_falls_back(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        owner = self.upgrade._acquire_upgrade_lock()
        self.upgrade._write_start_status("v1.0.0", owner)
        result = SimpleNamespace(returncode=1, stdout="", stderr="bus unavailable")
        with patch("core.upgrade.subprocess.run", return_value=result), patch(
            "core.upgrade._systemd_unit_active", return_value=None
        ), patch("core.upgrade.subprocess.Popen") as popen:
            with self.assertRaises(self.upgrade.UpgradeLaunchUncertain):
                self.upgrade._launch_command(["/bin/true"], owner)
        popen.assert_not_called()

    def test_metadata_failure_after_popen_retains_the_lock(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch

        owner = self.upgrade._acquire_upgrade_lock()
        self.upgrade._write_start_status("v1.0.0", owner)
        real_set_phase = self.upgrade._set_upgrade_lock_phase
        writes = 0

        def fail_after_popen(*args, **kwargs):
            nonlocal writes
            writes += 1
            if writes >= 3:
                raise OSError("disk full")
            return real_set_phase(*args, **kwargs)

        child = SimpleNamespace(pid=4242)
        with patch("core.upgrade.subprocess.run", side_effect=FileNotFoundError), patch(
            "core.upgrade.subprocess.Popen", return_value=child
        ), patch(
            "core.upgrade._process_identity", return_value=("S", "start")
        ), patch(
            "core.upgrade._set_upgrade_lock_phase", side_effect=fail_after_popen
        ):
            with self.assertRaises(self.upgrade.UpgradeLaunchUncertain):
                self.upgrade._launch_command(["/bin/true"], owner)

        lock = json.loads(self.upgrade.LOCK_FILE.read_text())
        self.assertEqual(lock["via"], "detached")
        self.assertFalse(lock["launch_confirmed"])
        self.assertIsNone(lock["child_pid"])
        self.assertIsNone(self.upgrade._acquire_upgrade_lock())

    def test_scripts_publish_failed_only_after_rollback(self):
        for script in (
            self.upgrade.UPGRADE_SCRIPT,
            self.upgrade.BUNDLE_SCRIPT,
        ):
            with self.subTest(script=script):
                source = script.read_text()
                self.assertIn(
                    "status running rollback 0\n  rollback",
                    source,
                )
                self.assertLess(
                    source.index("status running rollback 0"),
                    source.index('status failed "$1" 0'),
                )


class SystemUpgradeApiTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", "admin@acme.com", "pw"
        )
        self.client.force_login(self.admin)
        self._clear_upgrade_files()
        self.addCleanup(self._clear_upgrade_files)

    @staticmethod
    def _clear_upgrade_files():
        # STATUS_FILE + LOCK_FILE live on disk in BASE_DIR; clear them between
        # tests so a prior test's "running" marker / lock doesn't 409 the next.
        from core import upgrade
        for p in (
            upgrade.STATUS_FILE,
            upgrade.LOCK_FILE,
            upgrade.LOCK_GUARD_FILE,
            upgrade.BUNDLE_UPLOAD,
        ):
            try:
                p.unlink()
            except OSError:
                pass

    def test_status_idle_by_default(self):
        r = self.client.get("/api/system/upgrade/status/")
        self.assertEqual(r.status_code, 200)
        self.assertIn(r.json().get("state"), ("idle", "running", "done", "failed"))

    def test_requires_manage(self):
        reader = get_user_model().objects.create_user("r", "r@acme.com", "pw")
        self.client.force_login(reader)
        self.assertEqual(
            self.client.post("/api/system/upgrade/", {"version": "v0.1.0"},
                             format="json").status_code, 403)

    def test_rejects_unknown_version(self):
        from unittest.mock import patch
        # No such release → 400, nothing launched.
        with patch("core.github.list_releases", return_value=[]), \
             patch("core.upgrade._launch") as launch:
            r = self.client.post("/api/system/upgrade/",
                                  {"version": "v9.9.9"}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        launch.assert_not_called()

    def test_valid_version_launches(self):
        from unittest.mock import patch
        rel = [{"tag": "v0.1.0", "name": "0.1.0", "body": "", "published_at": None,
                "prerelease": False, "has_binary": False}]
        with patch("core.github.list_releases", return_value=rel), \
             patch("core.upgrade._launch", return_value="systemd-run") as launch:
            r = self.client.post("/api/system/upgrade/",
                                  {"version": "v0.1.0"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["launched"])
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[0], "v0.1.0")
        self.assertTrue(launch.call_args.args[1])

    def test_airgapped_rejects_repo_version(self):
        # disable_update_check → the repo-version path is refused (upload only),
        # and _valid_target must never reach out to list releases.
        from unittest.mock import patch

        from core.models import DeploymentSettings
        s = DeploymentSettings.load()
        s.disable_update_check = True
        s.save()
        with patch("core.github.list_releases") as lr, \
             patch("core.upgrade._launch") as launch:
            r = self.client.post("/api/system/upgrade/",
                                  {"version": "v0.1.0"}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        lr.assert_not_called()
        launch.assert_not_called()

    def test_bundle_install_downloads_verified_bundle(self):
        # No .git → the git updater would fail; start_upgrade must fetch the
        # verified bundle and run the bundle upgrader instead.
        from unittest.mock import patch
        rel = [{"tag": "v0.1.0", "name": "0.1.0", "body": "", "published_at": None,
                "prerelease": False, "has_binary": False}]
        with patch("core.github.list_releases", return_value=rel), \
             patch("core.upgrade._is_git_install", return_value=False), \
             patch("core.upgrade._download_release_bundle",
                   return_value="/tmp/b.tar.gz") as dl, \
             patch("core.upgrade._launch_bundle",
                   return_value="systemd-run") as lb, \
             patch("core.upgrade._launch") as git_launch:
            r = self.client.post("/api/system/upgrade/",
                                  {"version": "v0.1.0"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        dl.assert_called_once_with("v0.1.0")
        lb.assert_called_once()
        self.assertEqual(lb.call_args.args[0], "/tmp/b.tar.gz")
        self.assertTrue(lb.call_args.args[1])
        git_launch.assert_not_called()  # never use the git path on a bundle install

    def test_bundle_download_failure_surfaces_502(self):
        from unittest.mock import patch
        rel = [{"tag": "v0.1.0", "name": "0.1.0", "body": "", "published_at": None,
                "prerelease": False, "has_binary": False}]
        with patch("core.github.list_releases", return_value=rel), \
             patch("core.upgrade._is_git_install", return_value=False), \
             patch("core.upgrade._download_release_bundle",
                   side_effect=RuntimeError("no bundle asset")):
            r = self.client.post("/api/system/upgrade/",
                                  {"version": "v0.1.0"}, format="json")
        self.assertEqual(r.status_code, 502, r.content)
        self.assertIn("no bundle asset", r.json()["detail"])
        from core import upgrade
        self.assertFalse(upgrade.LOCK_FILE.exists())


class AutoUpgradeTests(APITestCase):
    def setUp(self):
        self.s = DeploymentSettings.load()

    def test_window_blank_is_always(self):
        from core.auto_upgrade import in_update_window
        self.s.update_window_days = ""
        self.s.update_window_start = ""
        self.s.update_window_end = ""
        self.assertTrue(in_update_window(self.s))

    def test_window_day_and_time(self):
        import datetime
        from unittest.mock import patch

        from core.auto_upgrade import in_update_window
        self.s.update_window_days = "sun"
        self.s.update_window_start = "02:00"
        self.s.update_window_end = "04:00"
        # A Sunday at 03:00 → inside; a Monday → outside.
        sun3 = datetime.datetime(2026, 7, 5, 3, 0)   # Sun
        mon3 = datetime.datetime(2026, 7, 6, 3, 0)   # Mon
        sun5 = datetime.datetime(2026, 7, 5, 5, 0)   # Sun, after window
        self.assertTrue(in_update_window(self.s, sun3))
        self.assertFalse(in_update_window(self.s, mon3))
        self.assertFalse(in_update_window(self.s, sun5))

    def test_check_disabled(self):
        from core.auto_upgrade import check_and_upgrade
        self.s.auto_update_enabled = False
        self.s.save()
        self.assertEqual(check_and_upgrade()["skipped"], "disabled")

    def test_check_upgrades_when_newer(self):
        from unittest.mock import patch

        from core.auto_upgrade import check_and_upgrade
        self.s.auto_update_enabled = True
        self.s.update_window_days = ""
        self.s.update_window_start = ""
        self.s.update_window_end = ""
        self.s.save()
        rels = [{"tag": "v9.9.9", "name": "9.9.9", "body": "", "published_at": None,
                 "prerelease": False, "has_binary": False}]
        with patch("core.github.list_releases", return_value=rels), \
             patch("core.upgrade.start_upgrade") as up, \
             patch("core.upgrade._acquire_upgrade_lock", return_value="owner"), \
             patch("core.upgrade._upgrade_running", return_value=False):
            r = check_and_upgrade()
        self.assertEqual(r.get("upgrading"), "v9.9.9")
        up.assert_called_once_with("v9.9.9", "owner")

    def test_airgapped_skips_before_any_fetch(self):
        # disable_update_check must short-circuit even with auto-update ON, and
        # must never call list_releases (no outbound network on an airgapped box).
        from unittest.mock import patch

        from core.auto_upgrade import check_and_upgrade
        self.s.auto_update_enabled = True
        self.s.disable_update_check = True
        self.s.save()
        with patch("core.github.list_releases") as lr:
            r = check_and_upgrade()
        self.assertEqual(r["skipped"], "airgapped")
        lr.assert_not_called()


class SystemUpdatesAirgappedTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", "admin@acme.com", "pw"
        )

    def test_updates_endpoint_no_fetch_when_airgapped(self):
        from unittest.mock import patch
        s = DeploymentSettings.load()
        s.disable_update_check = True
        s.save()
        self.client.force_login(self.admin)
        with patch("core.github.list_releases") as lr:
            r = self.client.get("/api/system/updates/")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertTrue(d["disabled"])
        self.assertEqual(d["releases"], [])
        self.assertFalse(d["update_available"])
        lr.assert_not_called()


class SystemInfoTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", "admin@acme.com", "pw"
        )

    def test_info_is_instant_and_never_fetches_the_repo(self):
        # The info endpoint must render version + environment WITHOUT ever
        # contacting the release repo — that's what makes the version load
        # instantly even when the repo check is slow/failing/airgapped.
        from unittest.mock import patch

        self.client.force_login(self.admin)
        with patch("core.github.list_releases") as lr:
            r = self.client.get("/api/system/info/")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        for key in ("version", "python", "django", "postgres"):
            self.assertIn(key, d)
        self.assertTrue(d["python"])
        self.assertTrue(d["django"])
        lr.assert_not_called()

    def test_info_requires_manage(self):
        user = get_user_model().objects.create_user("plain", password="pw")
        self.client.force_login(user)
        r = self.client.get("/api/system/info/")
        self.assertEqual(r.status_code, 403)


class UpgradeCancelTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", "admin@acme.com", "pw"
        )

    def test_cancel_clears_a_stuck_lock(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        self.client.force_login(self.admin)
        with tempfile.TemporaryDirectory() as d:
            lock = Path(d) / ".upgrade.lock"
            guard = Path(d) / ".upgrade.lock.guard"
            status = Path(d) / ".upgrade-status.json"
            bundle = Path(d) / ".upgrade-bundle.tar.gz"
            # A stale lock from an interrupted detached upgrade whose child
            # process is long gone (pid can't match anything alive).
            lock.write_text(json.dumps({
                "owner": "stale", "phase": "running", "via": "detached",
                "child_pid": 2 ** 31 - 1,
            }))
            status.write_text(json.dumps({"state": "running", "step": "deploy"}))
            with patch.multiple(
                "core.upgrade",
                LOCK_FILE=lock, LOCK_GUARD_FILE=guard,
                STATUS_FILE=status, BUNDLE_UPLOAD=bundle,
            ):
                r = self.client.post("/api/system/upgrade/cancel/")
            self.assertEqual(r.status_code, 200, r.content)
            self.assertTrue(r.json()["cleared"])
            self.assertTrue(r.json()["had_lock"])
            self.assertFalse(lock.exists())
            self.assertFalse(status.exists())

    def test_cancel_requires_manage(self):
        user = get_user_model().objects.create_user("plain", password="pw")
        self.client.force_login(user)
        r = self.client.post("/api/system/upgrade/cancel/")
        self.assertEqual(r.status_code, 403)


class HealthApiTests(APITestCase):
    def test_health_is_public_and_reports_version(self):
        # No auth — a load balancer / install-smoke hits it anonymously.
        r = self.client.get("/api/health/")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual(d["status"], "ok")
        self.assertTrue(d["database"])
        self.assertIn("version", d)
