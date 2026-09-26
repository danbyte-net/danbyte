"""``GET /api/devices/?picker=palette`` - the light device list the topology
diagram builder's palette loads: its shape, the list filters it shares with
``/api/devices/``, tenant and site-scoped RBAC, and a query count that does
not grow with the number of devices."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    Location,
    Manufacturer,
    Rack,
    Region,
    Site,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

User = get_user_model()

PALETTE = "/api/devices/?picker=palette"


class _PaletteBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.region = Region.objects.create(
            tenant=self.tenant, name="Europe", slug="europe"
        )
        self.site_a = Site.objects.create(
            tenant=self.tenant, name="dc-a", region=self.region
        )
        self.site_b = Site.objects.create(tenant=self.tenant, name="dc-b")
        self.hall = Location.objects.create(
            tenant=self.tenant, site=self.site_a, name="Hall 1", slug="hall-1"
        )
        self.rack = Rack.objects.create(
            tenant=self.tenant, site=self.site_a, location=self.hall,
            name="r01", u_height=42,
        )
        self.vendor = Manufacturer.objects.create(
            tenant=self.tenant, name="Arista", slug="arista"
        )
        self.dt_photo = DeviceType.objects.create(
            tenant=self.tenant, name="7050SX3", model="DCS-7050SX3-48YC8",
            manufacturer=self.vendor,
            front_image="device-type-images/7050-front.png",
        )
        self.dt_plain = DeviceType.objects.create(
            tenant=self.tenant, name="Generic box"
        )
        self.spine = DeviceRole.objects.create(
            tenant=self.tenant, name="Spine", slug="spine", color="#1d4ed8",
            icon="network",
        )
        self.leaf = DeviceRole.objects.create(
            tenant=self.tenant, name="Leaf", slug="leaf", color="#16a34a",
        )
        self.panel = DeviceRole.objects.create(
            tenant=self.tenant, name="Patch panel", slug="patch-panel",
            is_patch_panel=True,
        )
        self.active = status_for(self.tenant, "active")
        self.planned = status_for(self.tenant, "planned")

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _admin(self):
        self._login(User.objects.create_superuser("admin", "a@example.com", "x"))

    def _names(self, query=""):
        r = self.client.get(PALETTE + (f"&{query}" if query else ""))
        self.assertEqual(r.status_code, 200, r.content)
        return [d["name"] for d in r.json()["results"]]


class PaletteShapeTests(_PaletteBase):
    def setUp(self):
        super().setUp()
        self.leaf1 = Device.objects.create(
            tenant=self.tenant, name="leaf1", site=self.site_a,
            location=self.hall, rack=self.rack, role=self.leaf,
            device_type=self.dt_photo, status=self.active,
        )
        self.bare = Device.objects.create(tenant=self.tenant, name="bare")
        self._admin()

    def test_full_row(self):
        r = self.client.get(PALETTE)
        self.assertEqual(r.status_code, 200, r.content)
        row = next(d for d in r.json()["results"] if d["name"] == "leaf1")
        self.assertEqual(row, {
            "id": str(self.leaf1.id),
            "numid": self.leaf1.numid,
            "name": "leaf1",
            "role": {
                "id": str(self.leaf.id), "name": "Leaf", "slug": "leaf",
                "color": "#16a34a", "icon": "", "is_patch_panel": False,
            },
            "device_type": {
                "id": str(self.dt_photo.id), "name": "7050SX3",
                "model": "DCS-7050SX3-48YC8",
                "manufacturer": {"id": str(self.vendor.id), "name": "Arista"},
            },
            "site": {"id": str(self.site_a.id), "name": "dc-a"},
            "location": {"id": str(self.hall.id), "name": "Hall 1"},
            "rack": {"id": str(self.rack.id), "name": "r01"},
            "status": {
                "id": str(self.active.id), "name": self.active.name,
                "slug": "active", "color": self.active.color,
                "text_color": self.active.text_color,
            },
            "has_photo": True,
        })

    def test_bare_device_is_all_nulls(self):
        row = next(
            d for d in self.client.get(PALETTE).json()["results"]
            if d["name"] == "bare"
        )
        for key in ("role", "device_type", "site", "location", "rack", "status"):
            self.assertIsNone(row[key], key)
        self.assertFalse(row["has_photo"])

    def test_type_without_photo_or_manufacturer(self):
        self.bare.device_type = self.dt_plain
        self.bare.save()
        row = next(
            d for d in self.client.get(PALETTE).json()["results"]
            if d["name"] == "bare"
        )
        self.assertIsNone(row["device_type"]["manufacturer"])
        self.assertEqual(row["device_type"]["model"], "")
        self.assertFalse(row["has_photo"])

    def test_paginated_count(self):
        body = self.client.get(PALETTE + "&page_size=1").json()
        self.assertEqual(body["count"], 2)
        self.assertEqual(len(body["results"]), 1)

    def test_other_pickers_unchanged(self):
        plain = self.client.get("/api/devices/?picker=1").json()["results"][0]
        self.assertEqual(set(plain), {"id", "numid", "name"})
        full = self.client.get("/api/devices/").json()["results"][0]
        self.assertIn("interface_count", full)
        self.assertNotIn("has_photo", full)


class PaletteOrderAndFilterTests(_PaletteBase):
    def setUp(self):
        super().setUp()

        def dev(name, **kw):
            return Device.objects.create(tenant=self.tenant, name=name, **kw)

        self.leaf10 = dev(
            "leaf10", role=self.leaf, site=self.site_a, location=self.hall,
            rack=self.rack, device_type=self.dt_photo, status=self.active,
        )
        self.leaf2 = dev(
            "leaf2", role=self.leaf, site=self.site_a,
            device_type=self.dt_plain, status=self.planned,
        )
        self.spine1 = dev(
            "spine1", role=self.spine, site=self.site_b,
            device_type=self.dt_photo, status=self.active,
        )
        self.pp1 = dev("pp1", role=self.panel, site=self.site_b)
        self.loose = dev("loose", site=self.site_b)
        self.leaf2.tags.add("prod")
        self.spine1.tags.add("prod")
        self.spine1.tags.add("core")
        self.spine1.serial_number = "SN-778"
        self.spine1.save()
        other_org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        Device.objects.create(tenant=other, name="foreign")
        self._admin()

    def test_role_then_natural_name_roleless_last(self):
        self.assertEqual(
            self._names(),
            ["leaf2", "leaf10", "pp1", "spine1", "loose"],
        )

    def test_filters(self):
        cases = {
            f"site={self.site_a.id}": {"leaf2", "leaf10"},
            f"role={self.spine.id}": {"spine1"},
            f"device_type={self.dt_photo.id}": {"leaf10", "spine1"},
            f"status={self.planned.id}": {"leaf2"},
            f"rack={self.rack.id}": {"leaf10"},
            f"location={self.hall.id}": {"leaf10"},
            f"region={self.region.id}": {"leaf2", "leaf10"},
            f"manufacturer={self.vendor.id}": {"leaf10", "spine1"},
            "tag=prod": {"leaf2", "spine1"},
            "tag=prod&tag=core": {"spine1"},
            "search=leaf": {"leaf2", "leaf10"},
            "search=SN-778": {"spine1"},
        }
        for query, expected in cases.items():
            with self.subTest(query=query):
                self.assertEqual(set(self._names(query)), expected)

    def test_tag_filter_keeps_order(self):
        # ``tag=`` makes the list DISTINCT; the palette order must survive it.
        self.assertEqual(self._names("tag=prod"), ["leaf2", "spine1"])

    def test_other_tenant_never_listed(self):
        self.assertNotIn("foreign", self._names())


class PaletteRBACTests(_PaletteBase):
    def setUp(self):
        super().setUp()
        Device.objects.create(tenant=self.tenant, name="a1", site=self.site_a)
        Device.objects.create(tenant=self.tenant, name="b1", site=self.site_b)
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _grant(self, *types):
        perm = ObjectPermission.objects.create(
            name="siteA", object_types=list(types), actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)

    def test_site_scoped_user_sees_only_their_site(self):
        self._grant("device")
        self._login(self.user)
        self.assertEqual(self._names(), ["a1"])

    def test_no_device_view_sees_nothing(self):
        self._grant("site")
        self._login(self.user)
        r = self.client.get(PALETTE)
        # Denied outright or an empty list - never another row.
        if r.status_code == 200:
            self.assertEqual(r.json()["results"], [])
        else:
            self.assertEqual(r.status_code, 403)

    def test_anonymous_refused(self):
        self.assertIn(self.client.get(PALETTE).status_code, (401, 403))


class PaletteQueryCountTests(_PaletteBase):
    def _seed(self, n):
        roles = (self.leaf, self.spine, self.panel)
        for i in range(n):
            dev = Device.objects.create(
                tenant=self.tenant, name=f"sw{i}", site=self.site_a,
                location=self.hall, rack=self.rack, role=roles[i % 3],
                device_type=self.dt_photo, status=self.active,
            )
            dev.tags.add("prod")

    def _count(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(PALETTE)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), len(r.json()["results"])

    def test_constant_for_5_and_50_devices(self):
        self._admin()
        self._seed(5)
        small, rows = self._count()
        self.assertEqual(rows, 5)
        Device.objects.filter(tenant=self.tenant).delete()
        self._seed(50)
        large, rows = self._count()
        self.assertEqual(rows, 50)
        self.assertEqual(small, large)

    def test_constant_for_site_scoped_user(self):
        user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="siteA", object_types=["device"], actions=["view"]
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)
        self._login(user)
        self._seed(5)
        small, _ = self._count()
        Device.objects.filter(tenant=self.tenant).delete()
        self._seed(50)
        large, rows = self._count()
        self.assertEqual(rows, 50)
        self.assertEqual(small, large)
