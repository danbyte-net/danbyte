"""The one-click site roles read the catalogs their own objects use (#425).

A silo site editor (no read-all grant) and a site viewer get view on the
catalog types the role's types point at - device types, roles, platforms,
statuses, tags, custom fields, VRFs, … - so the Add device form's pickers and
an import by name work. View only: the catalogs stay the administrators' to
change. With enhanced site separation on, a catalog that can be local to a
site shows the global entries and the role's own sites' local ones.
"""
from django.contrib.auth.models import User

from api.models import Device, DeviceRole, DeviceType, Platform
from api.test_utils import status_for
from api.tests_site_scope_gaps import _TwoSites
from auth_api import rbac
from auth_api.api import assemble_site_role
from auth_api.models import ObjectPermission, UserProfile
from auth_api.site_paths import site_role_catalog_types
from core.models import DeploymentSettings, Organization, Tag, Tenant
from customization.models import CustomField


class _Catalogs(_TwoSites):
    def setUp(self):
        super().setUp()
        t = self.tenant
        self.dt = DeviceType.objects.create(tenant=t, name="X")
        self.role = DeviceRole.objects.create(tenant=t, name="Leaf", slug="leaf")
        self.platform = Platform.objects.create(tenant=t, name="EOS", slug="eos")
        self.status = status_for(t)
        self.tag = Tag.objects.create(tenant=t, name="prod", slug="prod")
        self.cf = CustomField.objects.create(
            tenant=t, key="asset", label="Asset", type="text", applies_to=["device"]
        )
        # Another tenant's catalog, named the same: never visible.
        org2 = Organization.objects.create(name="O2", slug="o2")
        self.t2 = Tenant.objects.create(org=org2, name="T2", slug="t2")
        self.dt2 = DeviceType.objects.create(tenant=self.t2, name="X")
        self.role2 = DeviceRole.objects.create(tenant=self.t2, name="Leaf", slug="leaf")
        self.platform2 = Platform.objects.create(tenant=self.t2, name="EOS", slug="eos")
        self.status2 = status_for(self.t2)
        self.tag2 = Tag.objects.create(tenant=self.t2, name="prod", slug="prod")
        self.cf2 = CustomField.objects.create(
            tenant=self.t2, key="asset", label="Asset", type="text", applies_to=["device"]
        )

    def _ids(self, url):
        return {str(i) for i in super()._ids(url)}

    def _role(self, role, silo=False):
        assemble_site_role(
            self.tenant, role, [self.site_a], user_ids=[self.user.id], silo=silo
        )
        self._login()

    def _separation(self, on=True):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = on
        dep.save()

    def _picker_rows(self):
        return {
            "/api/device-types/?picker=1": (self.dt, self.dt2),
            "/api/statuses/?available_to=device&picker=1": (self.status, self.status2),
            "/api/device-roles/?picker=1": (self.role, self.role2),
            "/api/platforms/?picker=1": (self.platform, self.platform2),
            "/api/tags/": (self.tag, self.tag2),
            "/api/custom-fields/?model=device": (self.cf, self.cf2),
        }


class SiloEditorCatalogTests(_Catalogs):
    def setUp(self):
        super().setUp()
        self._role("editor", silo=True)

    def test_add_device_pickers_list_own_tenant_catalogs(self):
        for url, (own, other) in self._picker_rows().items():
            with self.subTest(url=url):
                ids = self._ids(url)
                self.assertIn(str(own.id), ids)
                self.assertNotIn(str(other.id), ids)

    def test_import_by_device_type_name(self):
        r = self.client.post(
            "/api/io/device/import/",
            {"format": "json",
             "content": '[{"name":"new-in-a","site":"SiteA","device_type":"X"}]'},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["errors"], [], r.content)
        dev = Device.objects.get(name="new-in-a")
        self.assertEqual((dev.site_id, dev.device_type_id), (self.site_a.id, self.dt.id))

    def test_add_device_payload(self):
        r = self.client.post("/api/devices/", {
            "name": "a-leaf1", "site_id": str(self.site_a.id),
            "device_type_id": str(self.dt.id), "role_id": str(self.role.id),
            "platform_id": str(self.platform.id), "status_id": str(self.status.id),
            "tag_ids": [str(self.tag.id)], "custom_fields": {"asset": "A-1"},
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        dev = Device.objects.get(name="a-leaf1")
        self.assertEqual(dev.role_id, self.role.id)
        self.assertEqual(list(dev.tags.all()), [self.tag])

    def test_other_tenants_catalog_is_refused(self):
        r = self.client.post("/api/devices/", {
            "name": "a-leaf2", "site_id": str(self.site_a.id),
            "device_type_id": str(self.dt2.id),
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.client.get(f"/api/device-types/{self.dt2.id}/").status_code, 404)

    def test_catalogs_stay_read_only(self):
        self.assertEqual(self.client.post(
            "/api/device-types/", {"name": "Y"}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(
            f"/api/device-roles/{self.role.id}/", {"name": "Z"}, format="json").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/platforms/{self.platform.id}/").status_code, 403)
        self.assertEqual(self.client.post(
            "/api/tags/", {"name": "new", "slug": "new"}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(
            f"/api/custom-fields/{self.cf.id}/", {"label": "Z"}, format="json").status_code, 403)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.name, "X")
        for slug in site_role_catalog_types():
            with self.subTest(slug=slug):
                for action in ("add", "change", "delete"):
                    self.assertFalse(rbac.has_action(self.user, self.tenant, slug, action))

    def test_still_sees_only_its_own_site(self):
        Device.objects.create(tenant=self.tenant, name="b-dev", site=self.site_b)
        a = Device.objects.create(tenant=self.tenant, name="a-dev", site=self.site_a)
        self.assertEqual(self._ids("/api/devices/"), {str(a.id)})
        self.assertEqual(self._ids("/api/sites/"), {str(self.site_a.id)})


class SiteViewerCatalogTests(_Catalogs):
    """A viewer sees the catalog names on its devices already; the list
    filters pick from the same catalogs, so it reads them too."""

    def setUp(self):
        super().setUp()
        self._role("viewer")

    def test_pickers_list_own_tenant_catalogs(self):
        for url, (own, other) in self._picker_rows().items():
            with self.subTest(url=url):
                ids = self._ids(url)
                self.assertIn(str(own.id), ids)
                self.assertNotIn(str(other.id), ids)

    def test_catalogs_stay_read_only(self):
        self.assertEqual(self.client.post(
            "/api/device-types/", {"name": "Y"}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(
            f"/api/tags/{self.tag.id}/", {"name": "x"}, format="json").status_code, 403)


class CatalogLocalityTests(_Catalogs):
    """Enhanced site separation on: global entries and the role's own sites'
    local ones, never another site's."""

    def setUp(self):
        super().setUp()
        self._separation(True)
        t = self.tenant
        self.dt_a = DeviceType.objects.create(tenant=t, name="A-local", owning_site=self.site_a)
        self.dt_b = DeviceType.objects.create(tenant=t, name="B-local", owning_site=self.site_b)
        self.tag_a = Tag.objects.create(tenant=t, name="a", slug="a", owning_site=self.site_a)
        self.tag_b = Tag.objects.create(tenant=t, name="b", slug="b", owning_site=self.site_b)

    def _check_locality(self):
        types = self._ids("/api/device-types/?picker=1")
        self.assertEqual(types, {str(self.dt.id), str(self.dt_a.id)})
        tags = self._ids("/api/tags/")
        self.assertEqual(tags, {str(self.tag.id), str(self.tag_a.id)})
        # Tenant-wide catalogs without locality read in full.
        self.assertIn(str(self.role.id), self._ids("/api/device-roles/?picker=1"))
        self.assertNotIn(str(self.role2.id), self._ids("/api/device-roles/?picker=1"))

    def test_silo_editor(self):
        self._role("editor", silo=True)
        self._check_locality()
        self.assertEqual(self.client.get(f"/api/device-types/{self.dt_b.id}/").status_code, 404)
        # Global entries read but are not the site's to change: the write
        # grant (separation on) covers only its own sites' local tags.
        self.assertIn(self.client.patch(
            f"/api/tags/{self.tag.id}/", {"name": "x"}, format="json").status_code, (403, 404))
        self.assertEqual(self.client.patch(
            f"/api/device-roles/{self.role.id}/", {"name": "x"}, format="json").status_code, 403)
        self.tag.refresh_from_db()
        self.assertEqual(self.tag.name, "prod")
        self.assertEqual(self.client.patch(
            f"/api/tags/{self.tag_a.id}/", {"name": "a2"}, format="json").status_code, 200)

    def test_viewer(self):
        self._role("viewer")
        self._check_locality()

    def test_role_built_before_separation_was_turned_on(self):
        self._separation(False)
        self._role("editor", silo=True)
        self._separation(True)
        self._check_locality()


class RoleShapeTests(_Catalogs):
    def test_silo_editor_gets_a_catalog_view_grant(self):
        self._role("editor", silo=True)
        grant = ObjectPermission.objects.get(name="SiteA - catalog view")
        self.assertEqual(grant.actions, ["view"])
        self.assertEqual(grant.object_types, site_role_catalog_types())
        self.assertEqual(list(grant.sites.all()), [self.site_a])
        self.assertEqual(list(grant.users.all()), [self.user])

    def test_reading_editor_gets_none(self):
        self._role("editor")
        self.assertFalse(ObjectPermission.objects.filter(name__endswith="catalog view").exists())

    def test_viewer_grant_names_the_catalogs(self):
        self._role("viewer")
        grant = ObjectPermission.objects.get(name="SiteA - site view")
        self.assertLessEqual(set(site_role_catalog_types()), set(grant.object_types))

    def test_other_user_is_unaffected(self):
        other = User.objects.create_user("o", password="x")
        UserProfile.objects.create(user=other).tenants.add(self.tenant)
        self._role("editor", silo=True)
        self.assertFalse(rbac.has_action(other, self.tenant, "devicetype", "view"))
