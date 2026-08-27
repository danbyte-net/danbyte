"""Push a device type's templates at its whole fleet (#103).

The per-device sync already existed; this is the "don't do it forty times"
version. It runs on the shared import-run machinery, so the interesting parts
are the preview, the per-device permission re-check, and that one broken device
doesn't stop the rest.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .devicetype_sync_tasks import run_devicetype_component_sync
from .models import (
    Device,
    DeviceType,
    DeviceTypeImportRun,
    Interface,
    InterfaceTemplate,
)

User = get_user_model()


class SyncDevicesTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        self.dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.devices = [
            Device.objects.create(
                tenant=self.tenant, name=f"sw{i}", device_type=self.dt
            )
            for i in range(3)
        ]
        # A template added after the fleet was built - exactly the drift this
        # endpoint exists to close.
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Et1/49", type="25gbase-x-sfp28"
        )

    def _post(self, **body):
        """Post, running any queued job inline.

        The enqueue helper falls back to inline only when Redis is *down*; a
        developer box with Redis up would hand the job to a worker and the test
        would assert on a run that hasn't started. Patching the enqueue keeps
        the assertions about the work, not about the queue.
        """
        with mock.patch(
            "api.devicetype_import_tasks._enqueue",
            side_effect=lambda task, run, label: task(str(run.id)),
        ):
            return self.client.post(
                f"/api/device-types/{self.dt.id}/sync-devices/",
                body,
                format="json",
            )

    def test_preview_counts_without_touching_anything(self):
        r = self._post()
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["applied"])
        self.assertEqual(body["totals"]["devices"], 3)
        self.assertEqual(body["totals"]["changing"], 3)
        self.assertEqual(len(body["devices"]), 3)
        self.assertEqual(body["devices"][0]["add"], 1)
        # Nothing was created by looking.
        self.assertEqual(Interface.objects.count(), 0)

    def test_apply_queues_a_run_and_syncs_every_device(self):
        r = self._post(apply=True)
        self.assertEqual(r.status_code, 202, r.content)
        run_id = r.json()["run"]["id"]
        run = DeviceTypeImportRun.objects.get(id=run_id)
        self.assertEqual(run.kind, "component_sync")
        run.refresh_from_db()
        self.assertEqual(run.status, "success")
        self.assertEqual(run.progress["total"], 3)
        self.assertEqual(run.progress["changed"], 3)
        for d in self.devices:
            self.assertTrue(d.interfaces.filter(name="Et1/49").exists())

    def test_a_second_run_is_a_no_op(self):
        self._post(apply=True)
        self._post(apply=True)
        # Idempotent: materialising twice must not duplicate the port.
        for d in self.devices:
            self.assertEqual(d.interfaces.filter(name="Et1/49").count(), 1)

    def test_preview_flags_extras_that_carry_addresses(self):
        # A port the type no longer defines, holding an address: removing it
        # would drop the link, so the preview has to say so.
        iface = Interface.objects.create(device=self.devices[0], name="old0")
        from .models import IPAddress, Prefix

        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address="10.0.0.5",
            assigned_device=self.devices[0], assigned_interface=iface,
        )
        body = self._post().json()
        self.assertEqual(body["totals"]["extra_with_ips"], 1)
        row = next(d for d in body["devices"] if d["name"] == "sw0")
        self.assertEqual(row["interfaces_with_ips"], 1)

    def test_extras_survive_unless_removal_is_asked_for(self):
        Interface.objects.create(device=self.devices[0], name="old0")
        self._post(apply=True)
        self.assertTrue(
            self.devices[0].interfaces.filter(name="old0").exists()
        )
        self._post(apply=True, remove_extra=True)
        self.assertFalse(
            self.devices[0].interfaces.filter(name="old0").exists()
        )

    def test_one_broken_device_does_not_stop_the_fleet(self):
        from .models import sync_device_components as original

        def flaky(device, **kw):
            if device.name == "sw1":
                raise RuntimeError("boom")
            return original(device, **kw)

        with mock.patch(
            "api.models.sync_device_components", side_effect=flaky
        ):
            self._post(apply=True)
        run = DeviceTypeImportRun.objects.get()
        self.assertEqual(run.status, "success")
        self.assertEqual(run.progress["failed"], 1)
        self.assertEqual(run.progress["done"], 3)
        self.assertEqual(run.failures[0]["name"], "sw1")
        # The other two still got their port.
        self.assertTrue(self.devices[0].interfaces.filter(name="Et1/49").exists())
        self.assertTrue(self.devices[2].interfaces.filter(name="Et1/49").exists())

    def test_a_deleted_type_fails_the_run_cleanly(self):
        run = DeviceTypeImportRun.objects.create(
            tenant=self.tenant, kind="component_sync", source_url="",
            options={"device_type": str(self.dt.id)}, created_by=self.admin,
        )
        self.dt.delete()
        run_devicetype_component_sync(str(run.id))
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("no longer exists", run.error)

    def test_the_run_polls_through_the_shared_endpoint(self):
        run_id = self._post(apply=True).json()["run"]["id"]
        r = self.client.get(f"/api/device-types/import-runs/{run_id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["kind"], "component_sync")
