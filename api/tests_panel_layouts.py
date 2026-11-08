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


class CalloutTests(_Base):
    """A layout's callout fields: at most three short attributes or custom
    fields, resolved per object as the panel is, read in bulk for a plan."""

    def callouts(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/callouts/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["tiles"]

    def test_none_without_a_layout(self):
        self.assertEqual(self.callouts(), {})

    def test_fields_in_order_with_badge_colours(self):
        from .models import Status

        st = Status.objects.filter(tenant=self.tenant).first() or Status.objects.create(
            tenant=self.tenant, name="Active", slug="active", color="#22c55e"
        )
        self.device.status = st
        self.device.serial_number = "SN1"
        self.device.save()
        row = self.layout("default", None, "status")
        row.callout = ["serial_number", "status", "role"]
        row.save()
        lines = self.callouts()[str(self.tile.id)]
        self.assertEqual([x["key"] for x in lines], ["serial_number", "status", "role"])
        self.assertEqual(lines[0]["value"], "SN1")
        self.assertNotIn("color", lines[0])
        self.assertEqual(lines[1]["value"], st.name)
        self.assertEqual(lines[1]["color"], st.color)
        self.assertEqual(lines[2]["value"], "Access")

    def test_most_specific_layout_wins_even_without_fields(self):
        row = self.layout("default", None)
        row.callout = ["role"]
        row.save()
        self.assertIn(str(self.tile.id), self.callouts())
        self.layout("device_type", self.dtype.id)
        self.assertEqual(self.callouts(), {})

    def test_hidden_custom_field_and_other_tenant_never_show(self):
        CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", applies_to=["device"]
        )
        CustomField.objects.create(
            tenant=self.tenant, key="secret", label="Secret", applies_to=["device"],
            hidden=True,
        )
        row = self.layout("default", None)
        row.callout = ["cf:owner", "cf:secret"]
        row.save()
        theirs = self.layout("default", None, tenant=self.other)
        theirs.callout = ["serial_number"]
        theirs.save()
        lines = self.callouts()[str(self.tile.id)]
        self.assertEqual(lines, [{"key": "cf:owner", "label": "Owner", "value": "netops"}])

    def test_object_the_reader_may_not_view_says_nothing(self):
        row = self.layout("default", None)
        row.callout = ["role"]
        row.save()
        user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile"], actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.callouts(), {})

    def test_save_and_validate(self):
        r = self.client.post(URL, {
            "object_kind": "device", "scope": "default", "items": [],
            "callout": ["status", "primary_ip"],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        lid = r.json()["id"]
        self.assertEqual(r.json()["callout"], ["status", "primary_ip"])
        # Items alone keep the callout; a callout alone keeps the items.
        r = self.client.patch(f"{URL}{lid}/", {"items": [{"field": "status"}]}, format="json")
        self.assertEqual(r.json()["callout"], ["status", "primary_ip"])
        r = self.client.patch(f"{URL}{lid}/", {"callout": ["role"]}, format="json")
        self.assertEqual(r.json()["callout"], ["role"])
        self.assertEqual(r.json()["items"], [{"field": "status"}])
        for bad in (["status"] * 2, ["ports"], ["tags"], ["cf:nope"],
                    ["role", "status", "platform", "tenant"], "role"):
            r = self.client.patch(f"{URL}{lid}/", {"callout": bad}, format="json")
            self.assertEqual(r.status_code, 400, (bad, r.content))
        cat = self.client.get(f"{URL}catalog/").json()
        self.assertIn("status", cat["rack"]["callout_fields"])
        self.assertNotIn("devices", cat["rack"]["callout_fields"])
        self.assertEqual(cat["device"]["callout_max"], 3)
