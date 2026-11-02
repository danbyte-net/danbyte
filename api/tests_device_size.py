"""A device's own body size over its type's: the model fallback, the API,
the migration, and what floor plans and the 3D room size it by."""
from __future__ import annotations

from decimal import Decimal

from django.contrib.auth.models import User
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .models import Device, DeviceType, FloorPlan, FloorPlanTile, Site

BEFORE = ("api", "0251_interface_type_vxlan")
AFTER = ("api", "0252_device_size_mm")


def _columns() -> set[str]:
    with connection.cursor() as c:
        return {
            col.name for col in connection.introspection.get_table_description(c, "api_device")
        }


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="AP", width_mm=200, height_mm=40, depth_mm=180,
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="ap1", device_type=self.dt, site=self.site
        )
        self.admin = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=self.admin, role="admin").tenants.add(self.tenant)
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class EffectiveSizeTests(_Base):
    def test_inherits_the_type(self):
        d = self.device
        self.assertEqual(d.effective_width_mm, Decimal("200"))
        self.assertEqual(d.size_mm, {"width_mm": 200.0, "height_mm": 40.0, "depth_mm": 180.0})

    def test_own_value_wins_per_axis(self):
        self.device.depth_mm = Decimal("250.5")
        self.assertEqual(
            self.device.size_mm, {"width_mm": 200.0, "height_mm": 40.0, "depth_mm": 250.5}
        )

    def test_none_without_a_size(self):
        d = Device.objects.create(tenant=self.tenant, name="bare", site=self.site)
        self.assertIsNone(d.size_mm)
        self.assertIsNone(d.effective_width_mm)
        d.width_mm = Decimal("100")
        self.assertEqual(d.size_mm, {"width_mm": 100.0, "height_mm": None, "depth_mm": None})


class SerializerTests(_Base):
    def _patch(self, **body):
        return self.client.patch(f"/api/devices/{self.device.id}/", body, format="json")

    def test_read_own_and_effective(self):
        body = self.client.get(f"/api/devices/{self.device.id}/").json()
        self.assertIsNone(body["width_mm"])
        self.assertEqual(body["effective_width_mm"], 200.0)
        self.assertEqual(body["effective_depth_mm"], 180.0)
        self.assertEqual(body["device_type"]["depth_mm"], 180.0)

    def test_write_override_and_clear(self):
        r = self._patch(width_mm=310.5, depth_mm=90)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["width_mm"], r.json()["effective_width_mm"]), (310.5, 310.5))
        self.assertEqual(r.json()["effective_height_mm"], 40.0)
        r = self._patch(width_mm=None)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["effective_width_mm"], 200.0)

    def test_out_of_range_is_a_field_error(self):
        for bad in (0, 5000.1):
            r = self._patch(height_mm=bad)
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("height_mm", r.json())

    def test_change_is_audited(self):
        self._patch(depth_mm=120)
        entry = ChangeLogEntry.objects.filter(object_id=str(self.device.id)).latest("timestamp")
        self.assertIn("depth_mm", entry.post_change)


class FloorPlanSizeTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, name="Hall", layout_mode="free", cell_mm=500,
        )

    def test_placeable_row_carries_the_size(self):
        self.device.width_mm = 250
        self.device.save()
        rows = self.client.get(
            f"/api/floor-plans/{self.plan.id}/placeable/?kind=device"
        ).json()["results"]
        self.assertEqual(
            rows[0]["size_mm"], {"width_mm": 250.0, "height_mm": 40.0, "depth_mm": 180.0}
        )

    def test_tile_link_carries_the_size(self):
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=1, y=1, device=self.device, link_kind="device"
        )
        tile = self.client.get(f"/api/floor-plans/{self.plan.id}/contents/").json()["tiles"][0]
        self.assertEqual(tile["linked"]["size_mm"]["depth_mm"], 180.0)

    def test_scene_uses_the_own_size(self):
        self.device.depth_mm = 600
        self.device.save()
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=1, y=1, device=self.device, link_kind="device"
        )
        dev = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()["tiles"][0][
            "device"
        ]
        self.assertEqual((dev["width_mm"], dev["height_mm"], dev["depth_mm"]),
                         (200.0, 40.0, 600.0))

    def test_placeable_queries_do_not_grow_per_device(self):
        url = f"/api/floor-plans/{self.plan.id}/placeable/?kind=device"
        self.client.get(url)
        one = _count(self, url)
        for i in range(5):
            dt = DeviceType.objects.create(tenant=self.tenant, name=f"T{i}", depth_mm=100 + i)
            Device.objects.create(
                tenant=self.tenant, name=f"ap-{i}", device_type=dt, site=self.site,
                width_mm=50 + i,
            )
        self.assertEqual(_count(self, url), one)


def _count(test, url) -> int:
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as ctx:
        test.client.get(url)
    return len(ctx.captured_queries)


class MigrationTests(TestCase):
    def test_reverses_and_applies_on_existing_rows(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        dev = Device.objects.create(tenant=tenant, name="d1")
        with connection.cursor() as c:
            c.execute("SET CONSTRAINTS ALL IMMEDIATE")
        MigrationExecutor(connection).migrate([BEFORE])
        self.assertNotIn("width_mm", _columns())
        MigrationExecutor(connection).migrate([AFTER])
        self.assertTrue({"width_mm", "height_mm", "depth_mm"} <= _columns())
        dev.refresh_from_db()
        self.assertIsNone(dev.width_mm)
