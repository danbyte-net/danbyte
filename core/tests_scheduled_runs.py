"""ScheduledRun run-log helper + the /api/jobs/scheduled/ endpoint."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from core.models import Organization, ScheduledRun, Tenant
from core.scheduled_runs import record_run


class RecordRunTests(TestCase):
    def test_ok_path_records_summary_and_detail(self):
        with record_run("t1", "Task 1") as run:
            run.note("did 3 things", count=3)
        r = ScheduledRun.objects.get(name="t1")
        self.assertEqual(r.status, "ok")
        self.assertEqual(r.summary, "did 3 things")
        self.assertEqual(r.detail, {"count": 3})
        self.assertIsNotNone(r.finished_at)
        self.assertIsNotNone(r.duration_seconds)

    def test_exception_marks_failed_and_reraises(self):
        with self.assertRaises(ValueError):
            with record_run("t2", "Task 2"):
                raise ValueError("boom")
        r = ScheduledRun.objects.get(name="t2")
        self.assertEqual(r.status, "failed")
        self.assertIn("boom", r.summary)
        self.assertIsNotNone(r.finished_at)

    def test_skip_path(self):
        with record_run("t3", "Task 3") as run:
            run.skip("nothing due")
        r = ScheduledRun.objects.get(name="t3")
        self.assertEqual(r.status, "skipped")
        self.assertEqual(r.summary, "nothing due")

    def test_prunes_to_keep_limit(self):
        from core import scheduled_runs

        orig = scheduled_runs._KEEP_PER_TASK
        scheduled_runs._KEEP_PER_TASK = 3
        try:
            for i in range(6):
                with record_run("t4", "Task 4") as run:
                    run.note(f"run {i}")
            self.assertEqual(ScheduledRun.objects.filter(name="t4").count(), 3)
        finally:
            scheduled_runs._KEEP_PER_TASK = orig


class ScheduledEndpointTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_requires_jobs_manage(self):
        from auth_api.models import UserProfile

        plain = User.objects.create_user("plain", "p@a.c", "pw")
        UserProfile.objects.create(user=plain, role="custom").tenants.add(self.tenant)
        self._login(plain)
        r = self.client.get("/api/jobs/scheduled/")
        self.assertEqual(r.status_code, 403)

    def test_lists_full_catalog_and_last_run(self):
        self._login(self.admin)
        with record_run("digest", "Email digest") as run:
            run.note("sent 2 digest(s)", count=2)
        r = self.client.get("/api/jobs/scheduled/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        names = {t["name"] for t in body["tasks"]}
        # The task that ran, plus a catalog task that never ran, both present.
        self.assertIn("digest", names)
        self.assertIn("dispatch", names)
        digest = next(t for t in body["tasks"] if t["name"] == "digest")
        self.assertEqual(digest["last_run"]["status"], "ok")
        self.assertEqual(digest["last_run"]["summary"], "sent 2 digest(s)")
        never = next(t for t in body["tasks"] if t["name"] == "dispatch")
        self.assertIsNone(never["last_run"])
        self.assertIn("engines", body)
