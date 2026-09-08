"""/api/backups/: gating, targets, schedules, back-up-now, upload, download,
preview, restore confirmation and the maintenance exemption."""
from __future__ import annotations

import os
import tempfile
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from backups import maintenance
from backups.archive import Writer
from backups.models import Backup, BackupSchedule, BackupTarget, RestoreRun
from core.models import DeploymentSettings, Organization, Tenant


class _Base(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.override = override_settings(
            DANBYTE_BACKUP_DIR=os.path.join(self.tmp.name, "backups"),
            MONITORING_SECRET_KEY="api-test-key",
        )
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.addCleanup(maintenance.leave)
        org = Organization.objects.create(name="O", slug="o")
        Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        self.client.force_login(self.admin)
        self.target = BackupTarget.objects.create(
            name="Local", kind="local", config={"path": os.path.join(self.tmp.name, "store")},
            is_default=True,
        )

    def _archive(self, manifest_extra=None) -> Backup:
        """A real encrypted archive on the local target, as a finished backup row."""
        from backups.engine import applied_migrations

        manifest = {"format": 1, "components": ["db"], "applied_migrations": applied_migrations(),
                    "counts": {"tenant": 1}, "files": {"db.dump": {"size": 5}}, "version": "test",
                    "deployment_name": "Danbyte", **(manifest_extra or {})}
        path = os.path.join(self.tmp.name, "made.dbk")
        with Writer(path, "api-test-key") as w:
            w.add_json("manifest.json", manifest)
            w.add_bytes("db.dump", b"PGDMP")
        backend = self.target.backend()
        location = backend.put(path, "made.dbk")
        return Backup.objects.create(
            kind="manual", target=self.target, components=["db"], status="success",
            filename="made.dbk", location=location, size=os.path.getsize(path), manifest=manifest,
        )


class GateTests(_Base):
    def test_non_deployment_admin_is_refused(self):
        user = get_user_model().objects.create_user("u", "u@e.com", "x")
        self.client.force_login(user)
        for url in ("/api/backups/", "/api/backups/targets/", "/api/backups/schedules/",
                    "/api/backups/status/", "/api/backups/restore-runs/"):
            self.assertEqual(self.client.get(url).status_code, 403, url)
        self.assertEqual(self.client.post("/api/backups/", {}, content_type="application/json").status_code, 403)

    def test_status(self):
        r = self.client.get("/api/backups/status/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["deployment_name"], "Danbyte")
        self.assertIn("local", [k["kind"] for k in r.json()["storage_kinds"]])
        self.assertIsNone(r.json()["maintenance"])


class TargetTests(_Base):
    def test_crud_and_default_switch(self):
        r = self.client.post("/api/backups/targets/", {
            "name": "Bucket", "kind": "s3", "config": {"bucket": "b", "prefix": "p"},
            "credentials": {"access_key": "a", "secret_key": "s"}, "is_default": True,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("credentials", r.json())
        self.assertTrue(r.json()["has_credentials"])
        self.assertEqual(r.json()["location"], "s3://b/p")
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_default)
        # a blank secret on edit keeps the stored one
        r2 = self.client.patch(f"/api/backups/targets/{r.json()['id']}/",
                               {"credentials": {"access_key": "a2", "secret_key": ""}},
                               content_type="application/json")
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(BackupTarget.objects.get(pk=r.json()["id"]).credentials,
                         {"access_key": "a2", "secret_key": "s"})
        # the (now non-default, unused) local target can go; the s3 default cannot
        self.assertEqual(self.client.delete(f"/api/backups/targets/{self.target.id}/").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/backups/targets/{r.json()['id']}/").status_code, 400)

    def test_validation(self):
        r = self.client.post("/api/backups/targets/", {"name": "x", "kind": "local", "config": {}},
                             content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("config", r.json())
        r = self.client.post("/api/backups/targets/", {"name": "x", "kind": "ftp", "config": {}},
                             content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_probe(self):
        r = self.client.post(f"/api/backups/targets/{self.target.id}/test/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["ok"])
        bad = BackupTarget.objects.create(name="Bad", kind="local", config={"path": "/proc/nope"})
        r = self.client.post(f"/api/backups/targets/{bad.id}/test/")
        self.assertEqual(r.status_code, 400)
        bad.refresh_from_db()
        self.assertTrue(bad.last_error)


class ScheduleTests(_Base):
    def test_create_validates_and_reports_next_run(self):
        r = self.client.post("/api/backups/schedules/", {
            "name": "Nightly", "components": ["db", "media"], "target": str(self.target.id),
            "cadence": {"frequency": "daily", "at": "02:30"}, "retention": {"max_count": 7},
        }, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["cadence_label"], "daily at 02:30")
        self.assertIsNotNone(r.json()["next_run_at"])
        r = self.client.post("/api/backups/schedules/", {
            "name": "Bad", "components": ["db"], "target": str(self.target.id),
            "cadence": {"frequency": "yearly"},
        }, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("cadence", r.json())

    def test_run_now_does_not_stamp_the_occurrence(self):
        s = BackupSchedule.objects.create(name="N", components=["db"], target=self.target,
                                          cadence={"frequency": "daily", "at": "02:00"})
        with mock.patch("backups.schedules.enqueue_backup") as enq:
            r = self.client.post(f"/api/backups/schedules/{s.id}/run/")
        self.assertEqual(r.status_code, 201, r.content)
        enq.assert_called_once()
        s.refresh_from_db()
        self.assertIsNone(s.last_run_at)
        self.assertEqual(Backup.objects.get(pk=r.json()["id"]).schedule_id, s.id)


class BackupTests(_Base):
    def test_back_up_now_enqueues(self):
        with mock.patch("backups.api_views.enqueue_backup") as enq:
            r = self.client.post("/api/backups/", {"components": ["db", "config"]},
                                 content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        enq.assert_called_once()
        self.assertEqual(r.json()["components"], ["db", "config"])
        self.assertEqual(r.json()["target_name"], "Local")
        self.assertEqual(r.json()["created_by_name"], "root")

    def test_refused_during_a_restore(self):
        maintenance.enter("restore", "x")
        # /api/backups/ itself is behind the 503; the status probe is not exempt either,
        # only restore-runs and health are (the dialog polls those)
        self.assertEqual(self.client.post("/api/backups/", {}, content_type="application/json").status_code, 503)
        self.assertEqual(self.client.get("/api/backups/restore-runs/").status_code, 200)

    def test_download_streams_the_archive(self):
        b = self._archive()
        r = self.client.get(f"/api/backups/{b.id}/download/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Disposition"], 'attachment; filename="made.dbk"')
        body = b"".join(r.streaming_content)
        self.assertEqual(len(body), b.size)
        self.assertTrue(body.startswith(b"DBK1"))

    def test_delete_and_protect(self):
        b = self._archive()
        r = self.client.post(f"/api/backups/{b.id}/protect/", {"protected": True}, content_type="application/json")
        self.assertTrue(r.json()["protected"])
        self.assertEqual(self.client.delete(f"/api/backups/{b.id}/").status_code, 400)
        self.client.post(f"/api/backups/{b.id}/protect/", {"protected": False}, content_type="application/json")
        self.assertEqual(self.client.delete(f"/api/backups/{b.id}/").status_code, 204)
        self.assertFalse(Backup.objects.filter(pk=b.pk).exists())
        self.assertFalse(os.path.exists(b.location))

    def test_upload_reads_the_manifest_and_refuses_a_foreign_key(self):
        path = os.path.join(self.tmp.name, "other.dbk")
        with Writer(path, "api-test-key") as w:
            w.add_json("manifest.json", {"format": 1, "components": ["db", "media"], "counts": {"device": 3}})
            w.add_bytes("db.dump", b"PGDMP")
        with open(path, "rb") as fh:
            r = self.client.post("/api/backups/upload/", {"file": SimpleUploadedFile("from host2.dbk", fh.read())})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["kind"], "uploaded")
        self.assertEqual(r.json()["components"], ["db", "media"])
        self.assertEqual(r.json()["summary"]["counts"], {"device": 3})
        self.assertTrue(r.json()["filename"].startswith("from-host2-"))
        self.assertTrue(os.path.exists(r.json()["location"]))

        with Writer(path, "some-other-host") as w:
            w.add_json("manifest.json", {"format": 1, "components": ["db"]})
        with open(path, "rb") as fh:
            r = self.client.post("/api/backups/upload/", {"file": SimpleUploadedFile("x.dbk", fh.read())})
        self.assertEqual(r.status_code, 400)
        self.assertIn("MONITORING_SECRET_KEY", r.json()["file"][0])

        r = self.client.post("/api/backups/upload/", {"file": SimpleUploadedFile("x.dbk", b"garbage" * 10)})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Not a Danbyte backup", r.json()["file"][0])


class RestoreTests(_Base):
    def test_preview(self):
        b = self._archive()
        r = self.client.get(f"/api/backups/{b.id}/preview/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["can_restore"], r.json()["checks"])
        self.assertEqual(r.json()["counts"], {"tenant": 1})

    def test_restore_needs_the_typed_name_then_enqueues(self):
        b = self._archive()
        DeploymentSettings.objects.update_or_create(pk=DeploymentSettings.load().pk, defaults={"deployment_name": "Lab"})
        r = self.client.post(f"/api/backups/{b.id}/restore/", {"confirm": "nope"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Lab", r.json()["confirm"][0])
        with mock.patch("backups.api_views.enqueue_restore") as enq:
            r = self.client.post(f"/api/backups/{b.id}/restore/", {"confirm": "Lab", "components": ["db"]},
                                 content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        enq.assert_called_once()
        run = RestoreRun.objects.get(pk=r.json()["id"])
        self.assertEqual(run.components, ["db"])
        self.assertEqual(run.created_by, self.admin)
        # a second one is refused while the first is queued
        r = self.client.post(f"/api/backups/{b.id}/restore/", {"confirm": "Lab"}, content_type="application/json")
        self.assertEqual(r.status_code, 409)
        # and the run is readable
        self.assertEqual(self.client.get(f"/api/backups/restore-runs/{run.id}/").json()["backup_filename"], "made.dbk")

    def test_restore_refused_when_the_preview_fails(self):
        b = self._archive({"applied_migrations": ["api.9999_future"]})
        r = self.client.post(f"/api/backups/{b.id}/restore/", {"confirm": "Danbyte"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("newer Danbyte", r.json()["detail"])
        self.assertFalse(RestoreRun.objects.exists())
