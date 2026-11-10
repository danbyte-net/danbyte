"""Settings and upload-import endpoints: deployment-admin only, the NVD key
write-only, uploads bounded and parsed by the job."""
from __future__ import annotations

import gzip
import io
import shutil
import tempfile
import zipfile
from datetime import timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry

from . import imports
from .models import Cve, SyncRun, VulnerabilitySettings
from .testing import DJANGO, IOS_XE, data, tracking

SETTINGS = "/api/vulnerabilities/settings/"
IMPORT = "/api/vulnerabilities/import/"


def enable(**extra):
    VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True, **extra})


class Base(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser("root", password="x")
        self.user = User.objects.create_user("plain", password="x")
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)


class SettingsApiTests(Base):
    def test_anonymous_is_refused(self):
        self.assertIn(self.client.get(SETTINGS).status_code, (401, 403))

    def test_non_admin_reads_only_the_switch(self):
        self.client.force_login(self.user)
        self.assertEqual(self.client.get(SETTINGS).json(), {"enabled": False})
        r = self.client.patch(SETTINGS, {"enabled": True}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(VulnerabilitySettings.load().enabled)

    def test_defaults_are_off_and_upload(self):
        self.client.force_login(self.admin)
        body = self.client.get(SETTINGS).json()
        self.assertFalse(body["enabled"])
        self.assertEqual(body["update_source"], "upload")
        self.assertFalse(body["nvd_api_key_set"])
        self.assertEqual(body["records"], 0)
        self.assertIsNone(body["last_run"])

    def test_admin_edits_and_the_key_stays_write_only(self):
        self.client.force_login(self.admin)
        r = self.client.patch(SETTINGS, {
            "enabled": True, "update_source": "server", "nvd_api_key": "sekrit-key-123",
            "nvd_url": "https://nvd-mirror.example.org/", "sync_kev": False,
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn("sekrit-key-123", r.content.decode())
        body = r.json()
        self.assertTrue(body["nvd_api_key_set"])
        self.assertNotIn("nvd_api_key", body)
        self.assertEqual(body["nvd_url"], "https://nvd-mirror.example.org")
        self.assertNotIn("sekrit-key-123", self.client.get(SETTINGS).content.decode())
        # Encrypted at rest.
        with connection.cursor() as cur:
            cur.execute("SELECT secrets FROM vulnerabilities_vulnerabilitysettings")
            self.assertNotIn("sekrit", cur.fetchone()[0])
        self.assertEqual(VulnerabilitySettings.load().secrets, {"nvd_api_key": "sekrit-key-123"})
        # Change-logged, without the secret.
        entries = ChangeLogEntry.objects.filter(
            object_type="vulnerabilities.vulnerabilitysettings")
        self.assertTrue(entries.exists())
        for e in entries:
            self.assertNotIn("sekrit", str(e.__dict__))
        # Blank keeps the key; clear drops it.
        self.client.patch(SETTINGS, {"nvd_api_key": ""}, format="json")
        self.assertTrue(VulnerabilitySettings.load().secrets.get("nvd_api_key"))
        body = self.client.patch(SETTINGS, {"nvd_api_key_clear": True}, format="json").json()
        self.assertFalse(body["nvd_api_key_set"])

    def test_validation(self):
        self.client.force_login(self.admin)
        for body in ({"update_source": "carrier-pigeon"}, {"enabled": "yes"},
                     {"nvd_url": "http://mirror.example"}, {"epss_url": "https://a b"},
                     {"kev_url": 5}, {"nvd_api_key": "x" * 500}):
            with self.subTest(body=body):
                r = self.client.patch(SETTINGS, body, format="json")
                self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(VulnerabilitySettings.load().update_source, "upload")

    def test_run_bookkeeping_stays_out_of_the_change_log(self):
        enable()
        run = SyncRun.objects.create(via="upload", started_at=timezone.now())
        before = ChangeLogEntry.objects.count()
        imports._finish(run, "ok", counts={"records": 1})
        self.assertEqual(ChangeLogEntry.objects.count(), before)
        self.assertEqual(VulnerabilitySettings.load().last_sync_status, "ok")


class ImportApiTests(Base):
    def upload(self, raw: bytes, kind: str = "nvd", name: str = "feed.json"):
        return self.client.post(IMPORT, {"file": SimpleUploadedFile(name, raw), "kind": kind},
                                format="multipart")

    def queued(self, raw: bytes, kind: str = "nvd", name: str = "feed.json"):
        queue = mock.Mock()
        with mock.patch("django_rq.get_queue", return_value=queue):
            r = self.upload(raw, kind, name)
        self.assertEqual(r.status_code, 202, r.content)
        queue.enqueue.assert_called_once()
        func, run_id = queue.enqueue.call_args.args
        self.assertIs(func, imports.run_import_job)
        return run_id

    def test_admin_only_and_off_by_default(self):
        self.client.force_login(self.user)
        self.assertEqual(self.upload(data("nvd_page.json")).status_code, 403)
        self.client.force_login(self.admin)
        self.assertEqual(self.upload(data("nvd_page.json")).status_code, 409)
        self.assertFalse(SyncRun.objects.exists())

    def test_upload_parses_in_the_job(self):
        enable()
        self.client.force_login(self.admin)
        with tracking(IOS_XE):
            run_id = self.queued(gzip.compress(data("nvd_page.json")), name="nvdcve.json.gz")
            run = SyncRun.objects.get(pk=run_id)
            self.assertEqual((run.status, run.via, run.plan["kind"]),
                             ("running", "upload", "nvd"))
            self.assertEqual(run.started_by, self.admin)
            path = imports._upload_path(run.pk)
            self.assertTrue(path.exists())
            imports.run_import_job(run_id)
        run.refresh_from_db()
        self.assertEqual(run.status, "ok", run.error)
        self.assertEqual(run.counts["created"], 1)
        self.assertEqual(run.counts["not_tracked"], 3)
        self.assertFalse(path.exists())
        self.assertEqual(list(Cve.objects.values_list("vuln_id", flat=True)),
                         ["CVE-2023-20198"])
        self.assertEqual(Cve.objects.get().source, "nvd_feed")
        # The run is readable for polling, by the admin only.
        body = self.client.get(f"/api/vulnerabilities/sync/{run_id}/").json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["started_by"], "root")
        settings_body = self.client.get(SETTINGS).json()
        self.assertEqual(settings_body["last_sync_status"], "ok")
        self.assertEqual(settings_body["records"], 1)
        self.client.force_login(self.user)
        self.assertEqual(self.client.get(f"/api/vulnerabilities/sync/{run_id}/").status_code,
                         403)

    def test_osv_zip(self):
        enable()
        self.client.force_login(self.admin)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("GHSA-5hgc-2vfp-mqvc.json", data("osv_django.json"))
            zf.writestr("GHSA-2222-3333-4444.json", data("osv_npm.json"))
            zf.writestr("broken.json", b"{not json")
            zf.writestr("README.txt", b"ignored")
        with tracking(DJANGO):
            run_id = self.queued(buf.getvalue(), kind="osv", name="all.zip")
            imports.run_import_job(run_id)
        run = SyncRun.objects.get(pk=run_id)
        self.assertEqual(run.status, "ok", run.error)
        self.assertEqual((run.counts["created"], run.counts["not_tracked"],
                          run.counts["invalid"]), (1, 1, 1))
        self.assertEqual(Cve.objects.get().vuln_id, "CVE-2024-45230")

    def test_nothing_mapped_is_refused_before_saving(self):
        enable()
        self.client.force_login(self.admin)
        r = self.upload(data("nvd_page.json"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("mapped", r.json()["file"])
        with tracking(IOS_XE):
            # Tracking CPE names does not make an OSV upload useful.
            self.assertEqual(self.upload(data("osv_django.json"), kind="osv").status_code, 400)
        self.assertFalse(SyncRun.objects.exists())

    def test_bad_kind_and_missing_file(self):
        enable()
        self.client.force_login(self.admin)
        self.assertEqual(self.upload(b"x", kind="pdf").status_code, 400)
        r = self.client.post(IMPORT, {"kind": "kev"}, format="multipart")
        self.assertEqual(r.status_code, 400)

    @override_settings(VULN_IMPORT_MAX_BYTES=1024)
    def test_size_limit(self):
        enable()
        self.client.force_login(self.admin)
        r = self.upload(b" " * 5000, kind="kev", name="kev.json")
        self.assertEqual(r.status_code, 413)
        self.assertFalse(SyncRun.objects.filter(status="running").exists())

    def test_one_run_at_a_time_and_a_dead_one_is_abandoned(self):
        enable()
        self.client.force_login(self.admin)
        run_id = self.queued(data("kev.json"), kind="kev", name="kev.json")
        with mock.patch("django_rq.get_queue", return_value=mock.Mock()):
            self.assertEqual(self.upload(data("kev.json"), kind="kev").status_code, 409)
        SyncRun.objects.filter(pk=run_id).update(
            updated_at=timezone.now() - timedelta(seconds=imports.JOB_TIMEOUT * 3))
        self.queued(data("kev.json"), kind="kev", name="kev.json")
        self.assertEqual(SyncRun.objects.get(pk=run_id).status, "abandoned")
        # The abandoned run's job does nothing when it finally runs.
        imports.run_import_job(run_id)
        self.assertEqual(SyncRun.objects.get(pk=run_id).status, "abandoned")

    def test_queue_down_fails_the_run(self):
        enable()
        self.client.force_login(self.admin)
        with mock.patch("django_rq.get_queue", side_effect=ConnectionError("down")):
            r = self.upload(data("kev.json"), kind="kev", name="kev.json")
        self.assertEqual(r.status_code, 503)
        run = SyncRun.objects.get()
        self.assertEqual(run.status, "failed")
        self.assertFalse(imports._upload_path(run.pk).exists())

    def test_broken_file_fails_the_run_with_a_message(self):
        enable()
        self.client.force_login(self.admin)
        with tracking(IOS_XE):
            run_id = self.queued(gzip.compress(b"[1, 2, 3]"))
            imports.run_import_job(run_id)
        run = SyncRun.objects.get(pk=run_id)
        self.assertEqual(run.status, "failed")
        self.assertIn("NVD", run.error)
        self.assertFalse(imports._upload_path(run.pk).exists())

    def test_gzip_bomb_fails_the_run(self):
        enable()
        self.client.force_login(self.admin)
        bomb = gzip.compress(b" " * (4 * 1024 * 1024))
        with tracking(IOS_XE), mock.patch.object(imports, "MAX_UNPACKED_BYTES", 1024 * 1024):
            run_id = self.queued(bomb, name="nvd.json.gz")
            imports.run_import_job(run_id)
        run = SyncRun.objects.get(pk=run_id)
        self.assertEqual(run.status, "failed")
        self.assertIn("unpacks to more than", run.error)

    def test_switched_off_before_the_job_runs(self):
        enable()
        self.client.force_login(self.admin)
        run_id = self.queued(data("kev.json"), kind="kev", name="kev.json")
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        imports.run_import_job(run_id)
        run = SyncRun.objects.get(pk=run_id)
        self.assertEqual(run.status, "failed")
        self.assertIn("turned off", run.error)
