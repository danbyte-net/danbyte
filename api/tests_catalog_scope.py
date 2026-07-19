"""Local vs global catalog entries under enhanced site separation.

Catalog types (tags, device types, manufacturers, zones, …) carry
``owning_site`` — NULL = global to the tenant. With the separation flag ON, a
site-scoped user sees global + own-site local entries, creates land local to
their site, and global entries are read-only for them. Flag OFF = catalogs
behave tenant-wide exactly as before. Tags additionally became tenant-scoped
(flag-independent).
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, Manufacturer, Site, VLAN, Zone
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tag, Tenant


class _CatalogBase(APITestCase):
    flag_on = True

    def setUp(self):
        org = Organization.objects.create(name="OC", slug="oc")
        self.tenant = Tenant.objects.create(org=org, name="TC", slug="tc")
        self.a = Site.objects.create(tenant=self.tenant, name="A")
        self.b = Site.objects.create(tenant=self.tenant, name="B")
        self.mfr_global = Manufacturer.objects.create(
            tenant=self.tenant, name="GlobalCo", slug="globalco"
        )
        self.dt_global = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr_global, name="GT", model="GT"
        )
        self.dt_b = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr_global,
            name="B-only", model="B-only", owning_site=self.b,
        )
        self.site_user = User.objects.create_user("sa", password="x")
        UserProfile.objects.create(user=self.site_user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="site-a-cat",
            object_types=[
                "device", "devicetype", "manufacturer", "tag", "zone", "vlan",
            ],
            actions=["view", "add", "change", "delete"],
        )
        grant.users.add(self.site_user)
        grant.sites.set([self.a])
        self.hq = User.objects.create_user("hq", password="x")
        UserProfile.objects.create(user=self.hq).tenants.add(self.tenant)
        hq_grant = ObjectPermission.objects.create(
            name="hq-cat", object_types=["*"],
            actions=["view", "add", "change", "delete"],
        )
        hq_grant.users.add(self.hq)
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = self.flag_on
        dep.save()

    def _login(self, user):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")


class CatalogSeparationOnTests(_CatalogBase):
    def test_site_user_create_lands_local(self):
        self._login(self.site_user)
        res = self.client.post(
            "/api/device-types/",
            {"name": "LT", "model": "LT",
             "manufacturer_id": str(self.mfr_global.id)},
            format="json",
        )
        self.assertIn(res.status_code, (200, 201), res.content)
        dt = DeviceType.objects.get(name="LT")
        self.assertEqual(dt.owning_site_id, self.a.id)

    def test_foreign_local_invisible_global_visible(self):
        self._login(self.site_user)
        res = self.client.get("/api/device-types/?page_size=100")
        names = {r["name"] for r in res.json()["results"]}
        self.assertIn("GT", names)          # global
        self.assertNotIn("B-only", names)   # site B local

    def test_global_entry_read_only_for_site_user(self):
        self._login(self.site_user)
        res = self.client.patch(
            f"/api/device-types/{self.dt_global.id}/",
            {"description": "hax"}, format="json",
        )
        self.assertIn(res.status_code, (403, 404))
        # Per-object flags agree with enforcement.
        row = self.client.get(f"/api/device-types/{self.dt_global.id}/").json()
        self.assertFalse(row["permissions"]["change"])

    def test_own_local_editable(self):
        self._login(self.site_user)
        dt_a = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr_global,
            name="A-own", model="A-own", owning_site=self.a,
        )
        res = self.client.patch(
            f"/api/device-types/{dt_a.id}/", {"description": "ok"}, format="json"
        )
        self.assertEqual(res.status_code, 200, res.content)

    def test_promote_gated_to_unscoped_editors(self):
        dt_a = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr_global,
            name="A-loc", model="A-loc", owning_site=self.a,
        )
        self._login(self.site_user)
        res = self.client.post(f"/api/device-types/{dt_a.id}/promote/")
        self.assertEqual(res.status_code, 403)
        self._login(self.hq)
        res = self.client.post(f"/api/device-types/{dt_a.id}/promote/")
        self.assertEqual(res.status_code, 200, res.content)
        dt_a.refresh_from_db()
        self.assertIsNone(dt_a.owning_site_id)

    def test_assign_site_rehomes(self):
        self._login(self.hq)
        res = self.client.post(
            f"/api/device-types/{self.dt_global.id}/assign-site/",
            {"site_id": str(self.a.id)}, format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.dt_global.refresh_from_db()
        self.assertEqual(self.dt_global.owning_site_id, self.a.id)

    def test_device_cannot_use_foreign_local_type(self):
        self._login(self.site_user)
        res = self.client.post(
            "/api/devices/",
            {"name": "d1", "device_type_id": str(self.dt_b.id),
             "site_id": str(self.a.id)},
            format="json",
        )
        self.assertEqual(res.status_code, 400)  # picker never offered it

    def test_zone_create_local_and_vlan_link(self):
        self._login(self.site_user)
        res = self.client.post(
            "/api/zones/", {"name": "dmz", "color": "#ff0000"}, format="json"
        )
        self.assertIn(res.status_code, (200, 201), res.content)
        zone = Zone.objects.get(slug="dmz")
        self.assertEqual(zone.owning_site_id, self.a.id)
        res = self.client.post(
            "/api/vlans/",
            {"vlan_id": 100, "name": "v100", "zone_id": str(zone.id)},
            format="json",
        )
        self.assertIn(res.status_code, (200, 201), res.content)
        v = VLAN.objects.get(name="v100")
        self.assertEqual(v.zone_id, zone.id)
        self.assertEqual(v.site_id, self.a.id)  # create defaulting

    def test_tag_create_local(self):
        self._login(self.site_user)
        res = self.client.post("/api/tags/", {"name": "edge"}, format="json")
        self.assertIn(res.status_code, (200, 201), res.content)
        tag = Tag.objects.get(name="edge")
        self.assertEqual(tag.tenant_id, self.tenant.id)
        self.assertEqual(tag.owning_site_id, self.a.id)


class CatalogSeparationOffTests(_CatalogBase):
    flag_on = False

    def test_flag_off_site_user_sees_and_edits_everything(self):
        self._login(self.site_user)
        res = self.client.get("/api/device-types/?page_size=100")
        names = {r["name"] for r in res.json()["results"]}
        self.assertIn("B-only", names)  # locality inert
        res = self.client.patch(
            f"/api/device-types/{self.dt_global.id}/",
            {"description": "fine"}, format="json",
        )
        self.assertEqual(res.status_code, 200)

    def test_flag_off_create_lands_global(self):
        self._login(self.site_user)
        res = self.client.post(
            "/api/device-types/",
            {"name": "GT2", "model": "GT2",
             "manufacturer_id": str(self.mfr_global.id)},
            format="json",
        )
        self.assertIn(res.status_code, (200, 201))
        self.assertIsNone(DeviceType.objects.get(name="GT2").owning_site_id)


class TagTenancyTests(APITestCase):
    """Tags are tenant-scoped (flag-independent): no cross-tenant visibility;
    legacy NULL-tenant tags are readable everywhere, superuser-writable."""

    def setUp(self):
        org = Organization.objects.create(name="OT2", slug="ot2")
        self.t1 = Tenant.objects.create(org=org, name="T1", slug="t1")
        self.t2 = Tenant.objects.create(org=org, name="T2", slug="t2")
        self.tag1 = Tag.objects.create(name="one", slug="one", tenant=self.t1)
        self.legacy = Tag.objects.create(name="old", slug="old")  # NULL tenant
        self.u1 = User.objects.create_user("u1", password="x")
        prof = UserProfile.objects.create(user=self.u1)
        prof.tenants.add(self.t1)
        p = ObjectPermission.objects.create(
            name="tags1", object_types=["tag"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.u1)
        self.u2 = User.objects.create_user("u2", password="x")
        UserProfile.objects.create(user=self.u2).tenants.add(self.t2)
        p2 = ObjectPermission.objects.create(
            name="tags2", object_types=["tag"], actions=["view"]
        )
        p2.users.add(self.u2)

    def _login(self, user, tenant):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{tenant.id}/switch/")

    def test_no_cross_tenant_visibility(self):
        self._login(self.u2, self.t2)
        names = {r["name"] for r in self.client.get("/api/tags/").json()["results"]}
        self.assertNotIn("one", names)   # tenant 1's tag
        self.assertIn("old", names)      # legacy global stays visible

    def test_legacy_tag_read_only_for_tenant_users(self):
        self._login(self.u1, self.t1)
        res = self.client.patch(
            f"/api/tags/{self.legacy.id}/", {"name": "renamed"}, format="json"
        )
        self.assertEqual(res.status_code, 403)
        res = self.client.delete(f"/api/tags/{self.legacy.id}/")
        self.assertEqual(res.status_code, 403)

    def test_new_tag_stamped_with_tenant(self):
        self._login(self.u1, self.t1)
        res = self.client.post("/api/tags/", {"name": "fresh"}, format="json")
        self.assertIn(res.status_code, (200, 201), res.content)
        self.assertEqual(Tag.objects.get(name="fresh").tenant_id, self.t1.id)

    def test_same_name_allowed_in_two_tenants(self):
        Tag.objects.create(name="one", slug="one", tenant=self.t2)  # no clash
        self.assertEqual(Tag.objects.filter(slug="one").count(), 2)
