"""Signal-driven webhooks and auto-deploys wait for the commit (#357)."""
from __future__ import annotations

from unittest import mock

from django.db import transaction
from django.test import TestCase

from api.models import Site
from core.models import Organization, Tenant
from integrations import dispatch as D
from integrations.models import AutomationTarget, Webhook
from integrations.webhooks import deliver_webhook


class _Boom(Exception):
    pass


class WebhookOnCommitTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        Webhook.objects.create(
            tenant=self.tenant, name="all", payload_url="http://x.test/h",
            object_types=["*"], on_create=True, on_update=True, on_delete=True,
        )
        self.queue = mock.Mock()
        patcher = mock.patch("django_rq.get_queue", return_value=self.queue)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _events(self):
        return [(c.args[2], c.args[3], c.args[5].get("name")) for c in
                self.queue.enqueue.call_args_list if c.args[0] is deliver_webhook]

    def test_rolled_back_create_is_not_queued(self):
        with self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(_Boom), transaction.atomic():
                Site.objects.create(tenant=self.tenant, name="ghost-site")
                raise _Boom
        self.assertFalse(Site.objects.filter(name="ghost-site").exists())
        self.assertEqual(self._events(), [])

    def test_nothing_is_queued_before_commit(self):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            Site.objects.create(tenant=self.tenant, name="ams")
            self.assertEqual(self._events(), [])
        for cb in callbacks:
            cb()
        self.assertEqual(self._events(), [("created", "site", "ams")])

    def test_committed_create_is_queued_once(self):
        with self.captureOnCommitCallbacks(execute=True):
            Site.objects.create(tenant=self.tenant, name="ams")
        self.assertEqual(self._events(), [("created", "site", "ams")])

    def test_rolled_back_savepoint_drops_only_its_own_events(self):
        with self.captureOnCommitCallbacks(execute=True):
            Site.objects.create(tenant=self.tenant, name="kept")
            with self.assertRaises(_Boom), transaction.atomic():
                Site.objects.create(tenant=self.tenant, name="row-that-failed")
                raise _Boom
        self.assertEqual(self._events(), [("created", "site", "kept")])

    def test_delete_carries_the_snapshot_taken_before_the_delete(self):
        site = Site.objects.create(tenant=self.tenant, name="gone")
        with self.captureOnCommitCallbacks(execute=True):
            site.delete()
        self.assertEqual(self._events(), [("deleted", "site", "gone")])

    def test_rolled_back_delete_is_not_queued(self):
        site = Site.objects.create(tenant=self.tenant, name="stays")
        self.queue.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(_Boom), transaction.atomic():
                site.delete()
                raise _Boom
        self.assertTrue(Site.objects.filter(name="stays").exists())
        self.assertEqual(self._events(), [])

    def test_queue_down_at_commit_does_not_raise(self):
        self.queue.enqueue.side_effect = ConnectionError("redis down")
        with self.captureOnCommitCallbacks(execute=True):
            Site.objects.create(tenant=self.tenant, name="ams")
        self.assertTrue(Site.objects.filter(name="ams").exists())


class AutoDeployOnCommitTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        AutomationTarget.objects.create(
            tenant=self.tenant, name="awx", kind="awx", base_url="https://awx.test",
            job_template_id="7", token="tok", auto_on_change=True, object_types=["site"],
        )

    def test_rolled_back_change_is_not_deployed(self):
        with mock.patch.object(D, "enqueue_deploy") as enq, \
                self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(_Boom), transaction.atomic():
                Site.objects.create(tenant=self.tenant, name="ghost")
                raise _Boom
        enq.assert_not_called()

    def test_committed_change_is_deployed_after_commit(self):
        with mock.patch.object(D, "enqueue_deploy") as enq, \
                self.captureOnCommitCallbacks(execute=False) as callbacks:
            Site.objects.create(tenant=self.tenant, name="ams")
            enq.assert_not_called()
        with mock.patch.object(D, "enqueue_deploy") as enq:
            for cb in callbacks:
                cb()
        enq.assert_called_once()
        self.assertEqual(enq.call_args.kwargs.get("event"), "auto")
