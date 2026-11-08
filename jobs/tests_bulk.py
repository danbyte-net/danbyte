"""Bulk requeue and cancel on the Jobs queue: each job answers as its single
requeue or cancel does, and both need ``jobs.manage``."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile


class JobBulkTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser("jobs-root", password="x")
        self.plain = User.objects.create_user("jobs-plain", password="x")
        UserProfile.objects.create(user=self.plain, role="custom")
        self.client.force_login(self.admin)

    def post(self, action, ids):
        return self.client.post(f"/api/jobs/{action}/", {"ids": ids}, format="json")

    def test_requeue_answers_each_job(self):
        with mock.patch("jobs.rq_introspect.requeue_job",
                        side_effect=lambda i: i == "failed-1") as requeue:
            r = self.post("bulk-requeue", ["failed-1", "done-1", "failed-1"])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {
            "done": ["failed-1"],
            "skipped": [{"id": "done-1", "reason": "Only failed jobs can be requeued."}],
        })
        self.assertEqual(requeue.call_count, 2)

    def test_cancel_answers_each_job(self):
        with mock.patch("jobs.rq_introspect.cancel_job",
                        side_effect=lambda i: i != "gone") as cancel:
            r = self.post("bulk-cancel", ["q-1", "gone"])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["done"], ["q-1"])
        self.assertEqual(r.json()["skipped"][0]["id"], "gone")
        self.assertEqual(cancel.call_count, 2)

    def test_needs_jobs_manage(self):
        self.client.force_login(self.plain)
        with mock.patch("jobs.rq_introspect.cancel_job") as cancel, \
                mock.patch("jobs.rq_introspect.requeue_job") as requeue:
            self.assertEqual(self.post("bulk-cancel", ["q-1"]).status_code, 403)
            self.assertEqual(self.post("bulk-requeue", ["q-1"]).status_code, 403)
        cancel.assert_not_called()
        requeue.assert_not_called()

    def test_refuses_a_bad_selection(self):
        for ids in ([], "q-1", [1], ["x" * 200], ["q"] * 501):
            self.assertEqual(self.post("bulk-cancel", ids).status_code, 400, ids)
