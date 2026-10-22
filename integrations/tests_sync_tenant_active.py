"""External syncs skip the sources of a deactivated tenant.

The beat queues nothing for them, and a job queued before the tenant was
deactivated returns without syncing.
"""
from unittest import mock

from django.test import TestCase

from core.models import Organization, Tenant

from . import sync_tasks
from .models import IntegrationSettings, VirtualizationSource, WindowsServerConnection


class SyncTenantActiveTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant,
            defaults={"dhcp_sync_enabled": True, "virt_proxmox_enabled": True},
        )
        self.conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dhcp_enabled=True,
        )
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", kind="proxmox", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"}, sync_mode="auto",
        )

    def _deactivate(self):
        self.tenant.is_active = False
        self.tenant.save(update_fields=["is_active"])

    def _beat(self):
        with mock.patch.object(sync_tasks, "django_rq") as rq:
            out = sync_tasks.enqueue_due_syncs()
        return out, rq.get_queue.return_value.enqueue

    def test_the_beat_queues_an_active_tenant(self):
        out, enqueue = self._beat()
        self.assertEqual(out, {"windows_queued": 1, "virt_queued": 1})
        self.assertEqual(enqueue.call_count, 2)

    def test_the_beat_skips_a_deactivated_tenant(self):
        self._deactivate()
        out, enqueue = self._beat()
        self.assertEqual(out, {"windows_queued": 0, "virt_queued": 0})
        enqueue.assert_not_called()

    def test_the_windows_job_skips_a_deactivated_tenant(self):
        self._deactivate()
        with mock.patch("integrations.dhcp_sync.sync_dhcp") as sync:
            out = sync_tasks.run_windows_sync(str(self.conn.id))
        self.assertEqual(out, {"skipped": "tenant-inactive"})
        sync.assert_not_called()

    def test_the_virt_job_skips_a_deactivated_tenant(self):
        self._deactivate()
        with mock.patch("integrations.virt_sync.sync_proxmox") as sync:
            out = sync_tasks.run_virt_sync(str(self.source.id))
        self.assertEqual(out, {"skipped": "tenant-inactive"})
        sync.assert_not_called()

    def test_the_jobs_still_sync_an_active_tenant(self):
        with mock.patch("integrations.dhcp_sync.sync_dhcp", return_value={"ok": 1}) as dhcp:
            self.assertEqual(sync_tasks.run_windows_sync(str(self.conn.id)), {"dhcp": {"ok": 1}})
        dhcp.assert_called_once()
        with mock.patch("integrations.virt_sync.sync_proxmox", return_value={"ok": 1}) as pve:
            self.assertEqual(sync_tasks.run_virt_sync(str(self.source.id)), {"ok": 1})
        pve.assert_called_once()
