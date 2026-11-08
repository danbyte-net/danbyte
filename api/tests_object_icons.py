"""Icons on device types and devices: the fields, how a floor tile resolves
its icon (device, type, the tile's own type, role, then the client's default
by kind), the 3D scene's copy of it, and the round-trip spreadsheet."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Device,
    DeviceRole,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    Location,
    Rack,
    Site,
)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="B", slug="b"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=loc, name="G", grid_width=20, grid_height=10,
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Access", slug="access", color="#0ea5e9",
            icon="network",
        )
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="EX2300")
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site, role=self.role,
            device_type=self.dt,
        )
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _tile(self, **kw):
        return FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.dev, link_kind="device", **kw
        )

    def _linked(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/contents/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["tiles"][0]["linked"]

    def _scene_icon(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["tiles"][0]["icon"]


class FieldTests(_Base):
    def test_type_and_device_icons_round_trip(self):
        r = self.client.patch(
            f"/api/device-types/{self.dt.id}/", {"icon": "router"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["icon"], "router")
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/", {"icon": "cctv"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["icon"], "cctv")
        # The mini forms carry them: a device list's type, its role chip.
        body = self.client.get(f"/api/devices/{self.dev.id}/").json()
        self.assertEqual(body["device_type"]["icon"], "router")
        self.assertEqual(body["role"]["icon"], "network")

    def test_blank_by_default(self):
        self.assertEqual(self.client.get(f"/api/device-types/{self.dt.id}/").json()["icon"], "")
        self.assertEqual(self.client.get(f"/api/devices/{self.dev.id}/").json()["icon"], "")

    def test_changes_are_audited(self):
        from audit.models import ChangeLogEntry

        self.client.patch(f"/api/device-types/{self.dt.id}/", {"icon": "router"},
                          format="json")
        entry = ChangeLogEntry.objects.filter(
            object_type="api.devicetype", object_id=str(self.dt.id), action="update",
        ).latest("timestamp")
        self.assertIn("icon", str(entry.changes))


class ResolutionTests(_Base):
    def test_role_when_nothing_else(self):
        self._tile()
        linked = self._linked()
        self.assertEqual(linked["icon"], "")
        self.assertEqual(linked["role"]["icon"], "network")
        self.assertEqual(self._scene_icon(), "network")

    def test_type_wins_over_role(self):
        self.dt.icon = "router"
        self.dt.save()
        self._tile()
        self.assertEqual(self._linked()["icon"], "router")
        self.assertEqual(self._scene_icon(), "router")

    def test_device_wins_over_type(self):
        self.dt.icon = "router"
        self.dt.save()
        self.dev.icon = "shield"
        self.dev.save()
        self._tile()
        self.assertEqual(self._linked()["icon"], "shield")
        self.assertEqual(self._scene_icon(), "shield")
        self.assertEqual(Device.objects.get(pk=self.dev.pk).display_icon, "shield")

    def test_the_tiles_own_type_wins_over_the_role(self):
        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Cam", slug="cam", icon="cctv"
        )
        self._tile(tile_type=tt)
        self.assertEqual(self._scene_icon(), "cctv")
        self.dt.icon = "router"
        self.dt.save()
        self.assertEqual(self._scene_icon(), "router")

    def test_a_rack_has_no_object_icon(self):
        rack = Rack.objects.create(tenant=self.tenant, name="R1", site=self.site)
        FloorPlanTile.objects.create(floor_plan=self.plan, x=0, y=0, rack=rack,
                                     link_kind="rack")
        self.assertEqual(self._linked()["icon"], "")
        # The client draws its default by kind.
        self.assertEqual(self._scene_icon(), "")

    def test_hidden_device_names_no_icon(self):
        self.dev.icon = "shield"
        self.dev.save()
        self._tile()
        u = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile"], actions=["view"],
        )
        perm.tenants.add(self.tenant)
        perm.users.add(u)
        self._login(u)
        linked = self._linked()
        self.assertTrue(linked.get("hidden"))
        self.assertNotIn("icon", linked)
        self.assertEqual(self._scene_icon(), "")


class SpreadsheetTests(_Base):
    def test_icon_is_a_column_and_imports(self):
        import csv
        import io

        self.dt.icon = "router"
        self.dt.save()
        r = self.client.get("/api/io/devicetype/export/?fmt=csv")
        self.assertEqual(r.status_code, 200)
        rows = list(csv.DictReader(io.StringIO(b"".join(r.streaming_content).decode())))
        self.assertEqual(rows[0]["icon"], "router")
        r = self.client.get("/api/io/device/export/?fmt=csv")
        rows = list(csv.DictReader(io.StringIO(b"".join(r.streaming_content).decode())))
        self.assertIn("icon", rows[0])
