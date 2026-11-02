"""The floor plan detail panels' layouts (``api.panel_layouts``): the most
specific layout wins - device type, then role, then profile, then the
tenant's default, then the built-in one; layouts are the tenant's own and
only tenant admins change them; a panel names only the custom fields the
reader may see whose scope matches the object; changes are audited."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from customization.models import CustomField
from profiles.models import DeviceProfile, DeviceProfileAssignment

from . import panel_layouts
from .models import (
    Device,
    DeviceRole,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    PanelLayout,
    Site,
)

User = get_user_model()
URL = "/api/panel-layouts/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="T2", slug="t2")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.dtype = DeviceType.objects.create(tenant=self.tenant, name="C9300", u_height=1)
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Access", slug="access")
        self.profile = DeviceProfile.objects.create(tenant=self.tenant, name="Edge", slug="edge")
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site, device_type=self.dtype,
            role=self.role, custom_fields={"owner": "netops", "secret": "x", "scoped": "y"},
        )
        DeviceProfileAssignment.objects.create(
            tenant=self.tenant, profile=self.profile, device=self.device
        )
        self.plan = FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="F1")
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Dev", slug="dev")
        self.tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=tt, x=1, y=1, device=self.device,
            link_kind="device",
        )
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def layout(self, scope, scope_id, *keys, tenant=None):
        return PanelLayout.objects.create(
            tenant=tenant or self.tenant, object_kind="device", scope=scope,
            scope_id=scope_id, items=[{"section": scope}] + [{"field": k} for k in keys],
        )

    def panel(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/tile-panel/{self.tile.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class ResolutionTests(_Base):
    def test_builtin_default(self):
        body = self.panel()
        self.assertIsNone(body["layout"]["id"])
        self.assertEqual(body["layout"]["items"], panel_layouts.DEFAULTS["device"])
        self.assertIn("monitoring", body)
        self.assertIn("ports", body)
        # The photo-or-model preview leads a device's built-in layout.
        self.assertEqual(body["layout"]["items"][0], {"field": "preview"})
        self.assertIsNone(body["preview"]["model"])

    def test_preview_is_a_device_block(self):
        self.assertIn("preview", panel_layouts.FIELDS["device"])
        self.assertIn("preview", panel_layouts.COMPUTED)
        self.assertNotIn("preview", panel_layouts.FIELDS["rack"])
        cat = self.client.get(f"{URL}catalog/").json()
        fields = {f["key"]: f for f in cat["device"]["fields"]}
        self.assertTrue(fields["preview"]["computed"])

    def test_most_specific_wins(self):
        self.layout("default", None, "status")
        self.assertEqual(self.panel()["layout"]["scope"], "default")
        self.layout("profile", self.profile.id, "status")
        self.assertEqual(self.panel()["layout"]["scope"], "profile")
        self.layout("device_role", self.role.id, "status")
        self.assertEqual(self.panel()["layout"]["scope"], "device_role")
        row = self.layout("device_type", self.dtype.id, "status")
        body = self.panel()
        self.assertEqual(body["layout"]["id"], str(row.id))
        self.assertEqual(body["layout"]["scope_name"], str(self.dtype))

    def test_computed_blocks_only_when_asked(self):
        self.layout("default", None, "status")
        body = self.panel()
        self.assertNotIn("monitoring", body)
        self.assertNotIn("ports", body)
        self.assertNotIn("ips", body)
        self.assertNotIn("preview", body)

    def test_another_tenants_layout_never_applies(self):
        self.layout("default", None, "status", tenant=self.other)
        self.assertIsNone(self.panel()["layout"]["id"])


class CustomFieldTests(_Base):
    def setUp(self):
        super().setUp()
        CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", applies_to=["device"]
        )
        CustomField.objects.create(
            tenant=self.tenant, key="secret", label="Secret", applies_to=["device"],
            hidden=True,
        )
        CustomField.objects.create(
            tenant=self.tenant, key="scoped", label="Scoped", applies_to=["device"],
            scope_rules={"name_patterns": {"include": ["rtr"]}},
        )

    def test_visible_matching_fields_only(self):
        self.layout("default", None, "cf:owner", "cf:secret", "cf:scoped")
        cfs = self.panel()["custom_fields"]
        self.assertEqual([c["key"] for c in cfs], ["owner"])
        self.assertEqual(cfs[0]["value"], "netops")
        self.assertEqual(cfs[0]["label"], "Owner")

    def test_unknown_custom_field_is_refused(self):
        r = self.client.post(URL, {
            "object_kind": "device", "scope": "default",
            "items": [{"field": "cf:nope"}],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)


class ApiTests(_Base):
    def test_create_update_delete_and_audit(self):
        r = self.client.post(URL, {
            "object_kind": "device", "scope": "device_role", "scope_id": str(self.role.id),
            "items": [{"section": "Facts"}, {"field": "serial_number"}],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        lid = r.json()["id"]
        self.assertEqual(r.json()["scope_name"], "Access")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=lid, action="create").exists())
        r = self.client.patch(f"{URL}{lid}/", {"items": [{"field": "status"}]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.panel()["layout"]["items"], [{"field": "status"}])
        # The same scope twice is refused.
        r = self.client.post(URL, {
            "object_kind": "device", "scope": "device_role", "scope_id": str(self.role.id),
            "items": [],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.client.delete(f"{URL}{lid}/").status_code, 204)
        self.assertIsNone(self.panel()["layout"]["id"])

    def test_scope_must_be_the_tenants(self):
        theirs = DeviceRole.objects.create(tenant=self.other, name="X", slug="x")
        r = self.client.post(URL, {
            "object_kind": "device", "scope": "device_role", "scope_id": str(theirs.id),
            "items": [],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_scope_fits_the_kind(self):
        r = self.client.post(URL, {
            "object_kind": "rack", "scope": "profile", "scope_id": str(self.profile.id),
            "items": [],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_bad_items(self):
        for items in ([{"field": "status"}, {"field": "status"}], [{"field": "nope"}],
                      [{"section": ""}], "x"):
            r = self.client.post(URL, {
                "object_kind": "device", "scope": "default", "items": items,
            }, format="json")
            self.assertEqual(r.status_code, 400, (items, r.content))

    def test_other_tenants_layouts_are_not_listed(self):
        self.layout("default", None, "status", tenant=self.other)
        self.assertEqual(self.client.get(URL).json()["results"], [])
        row = PanelLayout.objects.get(tenant=self.other)
        self.assertEqual(self.client.delete(f"{URL}{row.id}/").status_code, 404)

    def test_catalog_and_preview(self):
        cat = self.client.get(f"{URL}catalog/").json()
        self.assertEqual(cat["device"]["scopes"],
                         ["device_type", "device_role", "profile", "default"])
        r = self.client.post(f"{URL}preview/", {
            "object_kind": "device", "scope": "profile", "scope_id": str(self.profile.id),
            "items": [{"field": "serial_number"}],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["device"]["name"], "sw1")
        self.assertEqual(r.json()["layout"]["items"], [{"field": "serial_number"}])

    def test_members_may_not_change_layouts(self):
        user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["device", "floorplan", "floorplantile"],
            actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get(URL).status_code, 403)
        r = self.client.post(URL, {"object_kind": "device", "scope": "default",
                                   "items": []}, format="json")
        self.assertEqual(r.status_code, 403)
        # The panel itself still reads.
        self.assertEqual(self.panel()["device"]["name"], "sw1")
