"""Platform groups + the DeviceType default platform.

Covers the PlatformGroup catalog (create, nest, cycle guard, assign a
platform), the optional ``platform`` FK on DeviceType, and the derived
``effective_platform`` on Device — its own platform when set, else its
type's default.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from api.models import Device, DeviceType, Platform, PlatformGroup
from core.models import Organization, Tenant


class BaseCase(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.admin = User.objects.create_superuser("pg-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()


class PlatformGroupApiTests(BaseCase):
    def test_create_group(self):
        res = self.client_api.post(
            "/api/platform-groups/",
            {"name": "Windows", "description": "Microsoft OSes"},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data["name"], "Windows")
        self.assertEqual(res.data["slug"], "windows")
        g = PlatformGroup.objects.get(pk=res.data["id"])
        self.assertEqual(g.tenant_id, self.tenant.id)

    def test_nest_child_group(self):
        parent = self.client_api.post(
            "/api/platform-groups/", {"name": "Linux"}, format="json"
        ).data
        child = self.client_api.post(
            "/api/platform-groups/",
            {"name": "Debian family", "parent_id": parent["id"]},
            format="json",
        )
        self.assertEqual(child.status_code, 201, child.content)
        self.assertEqual(child.data["parent"]["id"], parent["id"])
        detail = self.client_api.get(f"/api/platform-groups/{parent['id']}/")
        self.assertEqual(detail.data["child_count"], 1)

    def test_cycle_is_rejected(self):
        a = self.client_api.post(
            "/api/platform-groups/", {"name": "A"}, format="json"
        ).data
        b = self.client_api.post(
            "/api/platform-groups/", {"name": "B", "parent_id": a["id"]},
            format="json",
        ).data
        res = self.client_api.patch(
            f"/api/platform-groups/{a['id']}/",
            {"parent_id": b["id"]},
            format="json",
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_assign_platform_to_group(self):
        group = PlatformGroup.objects.create(
            tenant=self.tenant, name="Windows", slug="windows"
        )
        res = self.client_api.post(
            "/api/platforms/",
            {"name": "Windows 11 22H2", "group_id": str(group.id)},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data["group"]["id"], str(group.id))
        p = Platform.objects.get(pk=res.data["id"])
        self.assertEqual(p.group_id, group.id)

    def test_delete_group_in_use_conflicts(self):
        group = PlatformGroup.objects.create(
            tenant=self.tenant, name="Linux", slug="linux"
        )
        Platform.objects.create(
            tenant=self.tenant, name="Ubuntu", slug="ubuntu", group=group
        )
        res = self.client_api.delete(f"/api/platform-groups/{group.id}/")
        self.assertEqual(res.status_code, 409, res.content)
        self.assertTrue(PlatformGroup.objects.filter(pk=group.pk).exists())


class DeviceTypePlatformTests(BaseCase):
    def test_set_device_type_platform(self):
        platform = Platform.objects.create(
            tenant=self.tenant, name="Windows", slug="windows"
        )
        res = self.client_api.post(
            "/api/device-types/",
            {"name": "Generic PC", "platform_id": str(platform.id)},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data["platform"]["id"], str(platform.id))
        dt = DeviceType.objects.get(pk=res.data["id"])
        self.assertEqual(dt.platform_id, platform.id)


class EffectivePlatformTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.generic = Platform.objects.create(
            tenant=self.tenant, name="Windows", slug="windows"
        )
        self.specific = Platform.objects.create(
            tenant=self.tenant, name="Windows 11 22H2", slug="windows-11-22h2"
        )
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="Generic PC", platform=self.generic
        )

    def _device_payload(self, device):
        res = self.client_api.get(f"/api/devices/{device.id}/")
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def test_falls_back_to_type_platform(self):
        d = Device.objects.create(
            tenant=self.tenant, name="pc-1", device_type=self.dt
        )
        data = self._device_payload(d)
        self.assertIsNone(data["platform"])
        self.assertEqual(
            data["effective_platform"],
            {"id": str(self.generic.id), "name": self.generic.name},
        )

    def test_own_platform_wins(self):
        d = Device.objects.create(
            tenant=self.tenant, name="pc-2", device_type=self.dt,
            platform=self.specific,
        )
        data = self._device_payload(d)
        self.assertEqual(data["platform"]["id"], str(self.specific.id))
        self.assertEqual(
            data["effective_platform"],
            {"id": str(self.specific.id), "name": self.specific.name},
        )

    def test_no_platform_anywhere_is_null(self):
        dt = DeviceType.objects.create(tenant=self.tenant, name="Bare")
        d = Device.objects.create(
            tenant=self.tenant, name="pc-3", device_type=dt
        )
        data = self._device_payload(d)
        self.assertIsNone(data["effective_platform"])

    def test_untyped_device_uses_own_platform_only(self):
        d = Device.objects.create(
            tenant=self.tenant, name="pc-4", platform=self.specific
        )
        data = self._device_payload(d)
        self.assertEqual(
            data["effective_platform"],
            {"id": str(self.specific.id), "name": self.specific.name},
        )
