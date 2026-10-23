"""Software version and platform target (#395): fields, read-only seen_at and
the ``?software_target=`` list filter on devices and VMs."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Platform,
    VirtualMachine,
)
from core.models import Organization, Tenant


class SoftwareTargetApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.ios = Platform.objects.create(
            tenant=self.tenant, name="IOS-XE", slug="ios-xe", target_version="17.9.5"
        )
        self.loose = Platform.objects.create(tenant=self.tenant, name="Linux", slug="linux")
        ct = ClusterType.objects.create(tenant=self.tenant, name="ESXi", slug="esxi")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="cl", type=ct)
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def names(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(row["name"] for row in r.json()["results"])

    # ── fields ──────────────────────────────────────────────────────────────
    def test_platform_target_round_trips(self):
        r = self.client.patch(
            f"/api/platforms/{self.loose.id}/", {"target_version": "6.8"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["target_version"], "6.8")

    def test_device_version_round_trips_and_seen_at_is_read_only(self):
        d = Device.objects.create(tenant=self.tenant, name="sw1", platform=self.ios)
        r = self.client.patch(
            f"/api/devices/{d.id}/",
            {"software_version": "17.9.4a", "software_version_seen_at": timezone.now().isoformat()},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["software_version"], "17.9.4a")
        self.assertIsNone(body["software_version_seen_at"])
        self.assertEqual(body["platform"]["target_version"], "17.9.5")
        self.assertEqual(body["effective_platform"]["target_version"], "17.9.5")
        d.refresh_from_db()
        self.assertIsNone(d.software_version_seen_at)

    def test_a_typed_version_drops_the_sync_stamp(self):
        d = Device.objects.create(tenant=self.tenant, name="esx", software_version="8.0.3",
                                  software_version_seen_at=timezone.now())
        r = self.client.patch(f"/api/devices/{d.id}/", {"description": "x"}, format="json")
        self.assertIsNotNone(r.json()["software_version_seen_at"])
        r = self.client.patch(
            f"/api/devices/{d.id}/", {"software_version": "8.0.2"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["software_version_seen_at"])

    def test_vm_version_round_trips(self):
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=self.cluster, platform=self.ios
        )
        r = self.client.patch(
            f"/api/virtual-machines/{vm.id}/", {"software_version": "17.9.5"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["software_version"], "17.9.5")
        self.assertIsNone(r.json()["software_version_seen_at"])
        self.assertEqual(r.json()["platform"]["target_version"], "17.9.5")

    # ── filter ──────────────────────────────────────────────────────────────
    def test_device_filter(self):
        dt = DeviceType.objects.create(tenant=self.tenant, model="C9300", platform=self.ios)
        Device.objects.create(tenant=self.tenant, name="on", platform=self.ios,
                              software_version="17.9.5")
        Device.objects.create(tenant=self.tenant, name="off", platform=self.ios,
                              software_version="17.9.4a")
        # Off through the device type's platform.
        Device.objects.create(tenant=self.tenant, name="typed-off", device_type=dt,
                              software_version="17.6.1")
        Device.objects.create(tenant=self.tenant, name="blank", platform=self.ios)
        Device.objects.create(tenant=self.tenant, name="no-target", platform=self.loose,
                              software_version="6.1")
        Device.objects.create(tenant=self.tenant, name="no-platform", software_version="1.0")
        # Another tenant's on-target device never shows.
        theirs = Platform.objects.create(tenant=self.other, name="IOS-XE", slug="ios-xe",
                                         target_version="17.9.5")
        Device.objects.create(tenant=self.other, name="foreign", platform=theirs,
                              software_version="17.9.5")

        base = "/api/devices/?software_target="
        self.assertEqual(self.names(base + "on"), ["on"])
        self.assertEqual(self.names(base + "off"), ["off", "typed-off"])
        self.assertEqual(self.names(base + "unknown"), ["blank", "no-platform", "no-target"])
        self.assertEqual(self.client.get(base + "maybe").status_code, 400)

    def test_vm_filter(self):
        for name, plat, version in (("on", self.ios, "17.9.5"), ("off", self.ios, "17.9.1"),
                                    ("blank", self.ios, ""), ("loose", self.loose, "6.1")):
            VirtualMachine.objects.create(tenant=self.tenant, name=name, cluster=self.cluster,
                                          platform=plat, software_version=version)
        base = "/api/virtual-machines/?software_target="
        self.assertEqual(self.names(base + "on"), ["on"])
        self.assertEqual(self.names(base + "off"), ["off"])
        self.assertEqual(self.names(base + "unknown"), ["blank", "loose"])
