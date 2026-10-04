"""Topology card lines: the cleaners (and the floor-plan ones they were
generalised from), deployment/tenant/effective endpoints, resolution order,
and the per-device override on the device API."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework import serializers
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.deployment import (
    TOPOLOGY_CARD_FIELD_DEFAULTS,
    TOPOLOGY_CARD_MAX_FIELDS,
    TOPOLOGY_CARD_MAX_SCOPES,
    clean_popover_fields,
    clean_popover_overrides,
    clean_topology_card_fields,
    clean_topology_card_overrides,
    topology_card_list,
    validate_topology_card_list,
    validate_topology_card_overrides,
)
from core.effective_settings import effective_topology_card, resolve_card_fields
from core.models import DeploymentSettings, Organization, Tenant, TenantSettings

NINE = [
    "primary_ip", "secondary_ip", "oob_ip", "loopback", "serial",
    "asset_tag", "device_type", "platform", "site",
]


class FloorplanCleanerRegressionTests(APITestCase):
    """The floor-plan cleaners now delegate to the generalised helpers; their
    behaviour must not move."""

    def test_fields_drop_unknown_dedupe_and_have_no_cap(self):
        many = ["name", "type", "status", "linked", "utilization", "position",
                "size", "faceplate", "check", "plan", "color"]
        self.assertEqual(clean_popover_fields(many + ["bogus", "name"]), many)
        self.assertEqual(clean_popover_fields(["cf_owner", "cf_bad key"]), ["cf_owner"])
        self.assertEqual(clean_popover_fields({"name": 1}), [])

    def test_overrides_drop_empty_lists_and_keep_the_old_scope_shape(self):
        cleaned = clean_popover_overrides({
            "tt:rack": ["size", "nope"],
            "tt:aisle": [],             # empty = dropped (inherit)
            "role:fw": ["bogus"],       # cleans to nothing = dropped
            "role:core_sw": ["name"],   # "_" is outside SCOPE_KEY_RE
            "role:Core": ["name"],      # so are capitals
            "role:edge": "name",        # not a list
            "bogus": ["name"],
        })
        self.assertEqual(cleaned, {"tt:rack": ["size"]})
        self.assertEqual(clean_popover_overrides(["tt:rack"]), {})


class TopologyCardCleanerTests(APITestCase):
    def test_fields_keep_known_and_custom_fields_capped(self):
        self.assertEqual(
            clean_topology_card_fields(["serial", "name", "cf_rack_unit", "serial"]),
            ["serial", "cf_rack_unit"],
        )
        self.assertEqual(
            clean_topology_card_fields(NINE), NINE[:TOPOLOGY_CARD_MAX_FIELDS]
        )

    def test_overrides_keep_name_only_and_wide_role_slugs(self):
        cleaned = clean_topology_card_overrides({
            "role:core_sw": ["loopback"],
            "role:Edge-FW": [],          # name only survives
            "role:leaf": ["was_removed"],  # every key unknown → inherits
            "tt:rack": ["serial"],       # tile types aren't a card scope
            "role:x" + "y" * 128: ["serial"],  # longer than a SlugField(128)
        })
        self.assertEqual(cleaned, {"role:core_sw": ["loopback"], "role:Edge-FW": []})

    def test_overrides_cap_the_scope_count(self):
        many = {f"role:r{i}": ["serial"] for i in range(TOPOLOGY_CARD_MAX_SCOPES + 5)}
        self.assertEqual(
            len(clean_topology_card_overrides(many)), TOPOLOGY_CARD_MAX_SCOPES
        )

    def test_stored_list_semantics(self):
        self.assertIsNone(topology_card_list(None))
        self.assertIsNone(topology_card_list("serial"))
        self.assertEqual(topology_card_list([]), [])
        self.assertIsNone(topology_card_list(["was_removed"]))
        self.assertEqual(topology_card_list(["serial", "bogus"]), ["serial"])

    def test_write_validation_refuses_rather_than_drops(self):
        self.assertEqual(
            validate_topology_card_list(["serial", "serial", "cf_x"]),
            ["serial", "cf_x"],
        )
        self.assertEqual(validate_topology_card_list([]), [])
        for bad in (["serial", "bogus"], NINE, "serial", [1], None):
            with self.assertRaises(serializers.ValidationError):
                validate_topology_card_list(bad)
        with self.assertRaises(serializers.ValidationError) as ctx:
            validate_topology_card_overrides({"tt:rack": ["serial"]})
        self.assertIn("tt:rack", ctx.exception.detail)
        self.assertEqual(
            validate_topology_card_overrides({"role:core_sw": []}),
            {"role:core_sw": []},
        )


class _Fixture(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="dc-1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Acme", slug="acme")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, name="X1", model="X1"
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Core switch", slug="core_sw"
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw-1", device_type=self.dtype,
            role=self.role, site=self.site, status=status_for(self.tenant),
        )

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _reader(self, name="reader"):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="reader").tenants.add(self.tenant)
        return u

    def _tenant_admin(self, name="tadmin"):
        """A users.manage-equivalent grant narrowed to the tenant: passes
        can_manage_admin there, never can_manage_deployment."""
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=["user"], actions=["change"]
        )
        perm.users.add(u)
        perm.tenants.add(self.tenant)
        return u

    def _superuser(self):
        u = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        return u


class EffectiveConfigTests(_Fixture):
    def test_unconfigured_is_the_built_in_default(self):
        eff = effective_topology_card(self.tenant)
        self.assertEqual(eff["fields"], TOPOLOGY_CARD_FIELD_DEFAULTS)
        self.assertEqual(eff["fields"], ["monitor", "primary_ip", "loopback", "serial"])
        self.assertEqual(eff["role_overrides"], {})
        self.assertEqual(eff["source"], "default")
        self.assertEqual(effective_topology_card(None)["source"], "default")

    def test_deployment_list_and_name_only(self):
        dep = DeploymentSettings.load()
        dep.topology_card_fields = ["serial"]
        dep.save()
        eff = effective_topology_card(self.tenant)
        self.assertEqual((eff["fields"], eff["source"]), (["serial"], "deployment"))
        dep.topology_card_fields = []
        dep.save()
        eff = effective_topology_card(self.tenant)
        self.assertEqual((eff["fields"], eff["source"]), ([], "deployment"))

    def test_tenant_override_replaces_global_and_roles_wholesale(self):
        dep = DeploymentSettings.load()
        dep.topology_card_fields = ["serial"]
        dep.topology_card_role_overrides = {"role:core_sw": ["loopback"]}
        dep.save()
        ts = TenantSettings.for_tenant(self.tenant)
        ts.topology_card_fields = ["platform"]
        ts.save()
        # Switch off: the tenant row is ignored.
        self.assertEqual(effective_topology_card(self.tenant)["fields"], ["serial"])

        ts.override_topology_card = True
        ts.save()
        eff = effective_topology_card(self.tenant)
        self.assertEqual((eff["fields"], eff["source"]), (["platform"], "tenant"))
        self.assertEqual(eff["role_overrides"], {})

    def test_tenant_override_without_a_list_uses_the_default(self):
        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_topology_card = True
        ts.topology_card_role_overrides = {"role:core_sw": []}
        ts.save()
        eff = effective_topology_card(self.tenant)
        self.assertEqual(eff["source"], "default")
        self.assertEqual(eff["role_overrides"], {"role:core_sw": []})


class ResolutionOrderTests(_Fixture):
    def _eff(self, fields=None, roles=None):
        dep = DeploymentSettings.load()
        dep.topology_card_fields = fields
        dep.topology_card_role_overrides = roles or {}
        dep.save()
        return effective_topology_card(self.tenant)

    def test_built_in_default_when_nothing_is_set(self):
        self.assertEqual(
            resolve_card_fields(self.device, self._eff()),
            (TOPOLOGY_CARD_FIELD_DEFAULTS, "default"),
        )

    def test_global_then_role_then_view_then_device(self):
        eff = self._eff(["serial"], {"role:core_sw": ["loopback", "platform"]})
        # The role slug carries "_" - the floor-plan scope regex would drop it.
        self.assertEqual(
            resolve_card_fields(self.device, eff), (["loopback", "platform"], "role")
        )
        self.assertEqual(
            resolve_card_fields(self.device, eff, ["site"]), (["site"], "view")
        )
        self.device.topology_card = ["asset_tag"]
        self.assertEqual(
            resolve_card_fields(self.device, eff, ["site"]), (["asset_tag"], "device")
        )

    def test_a_device_without_a_role_uses_the_global_list(self):
        eff = self._eff(["serial"], {"role:core_sw": ["loopback"]})
        self.device.role = None
        self.assertEqual(resolve_card_fields(self.device, eff), (["serial"], "deployment"))

    def test_empty_list_is_name_only_at_every_level(self):
        eff = self._eff(["serial"], {"role:core_sw": []})
        self.assertEqual(resolve_card_fields(self.device, eff), ([], "role"))
        eff = self._eff(["serial"], {"role:core_sw": ["loopback"]})
        self.assertEqual(resolve_card_fields(self.device, eff, []), ([], "view"))
        self.device.topology_card = []
        self.assertEqual(resolve_card_fields(self.device, eff, ["site"]), ([], "device"))

    def test_view_null_inherits(self):
        eff = self._eff(["serial"])
        self.assertEqual(
            resolve_card_fields(self.device, eff, None), (["serial"], "deployment")
        )


class DeploymentEndpointTests(_Fixture):
    URL = "/api/deployment/topology-card/"

    def test_member_and_tenant_admin_are_refused(self):
        self._login(self._reader())
        self.assertEqual(self.client.get(self.URL).status_code, 403)
        self._login(self._tenant_admin())
        self.assertEqual(self.client.get(self.URL).status_code, 403)
        self.assertEqual(
            self.client.put(self.URL, {"card_fields": []}, format="json").status_code,
            403,
        )

    def test_anonymous_is_refused(self):
        self.assertIn(self.client.get(self.URL).status_code, (401, 403))

    def test_deployment_admin_reads_and_writes(self):
        self._login(self._superuser())
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["card_fields"], TOPOLOGY_CARD_FIELD_DEFAULTS)
        self.assertTrue(body["is_default"])
        self.assertEqual(body["pills"], ["status", "monitor"])
        self.assertEqual(body["max_fields"], TOPOLOGY_CARD_MAX_FIELDS)
        self.assertIn("loopback", body["available"])

        r = self.client.put(
            self.URL,
            {"card_fields": ["serial", "serial", "cf_owner"],
             "role_overrides": {"role:core_sw": [], "role:Edge_FW": ["loopback"]}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["card_fields"], ["serial", "cf_owner"])
        self.assertFalse(r.json()["is_default"])
        dep = DeploymentSettings.load()
        self.assertEqual(dep.topology_card_fields, ["serial", "cf_owner"])
        self.assertEqual(
            dep.topology_card_role_overrides,
            {"role:core_sw": [], "role:Edge_FW": ["loopback"]},
        )

        # [] is name only; null resets to the built-in default.
        r = self.client.put(self.URL, {"card_fields": []}, format="json")
        self.assertEqual((r.json()["card_fields"], r.json()["is_default"]), ([], False))
        r = self.client.put(self.URL, {"card_fields": None}, format="json")
        self.assertEqual(r.json()["card_fields"], TOPOLOGY_CARD_FIELD_DEFAULTS)
        self.assertTrue(r.json()["is_default"])
        # The role lists were untouched by the partial writes.
        self.assertIn("role:core_sw", r.json()["role_overrides"])

    def test_bad_input_is_a_field_error(self):
        self._login(self._superuser())
        for body, field in (
            ({"card_fields": ["serial", "bogus"]}, "card_fields"),
            ({"card_fields": NINE}, "card_fields"),
            ({"role_overrides": {"tt:rack": ["serial"]}}, "role_overrides"),
            ({"role_overrides": {"role:x": ["nope"]}}, "role_overrides"),
        ):
            r = self.client.put(self.URL, body, format="json")
            self.assertEqual(r.status_code, 400, body)
            self.assertIn(field, r.json())
        self.assertIsNone(DeploymentSettings.load().topology_card_fields)


class TenantEndpointTests(_Fixture):
    URL = "/api/tenant-settings/topology-card/"

    def test_member_is_refused(self):
        self._login(self._reader())
        self.assertEqual(self.client.get(self.URL).status_code, 403)
        self.assertEqual(
            self.client.put(self.URL, {"override": True}, format="json").status_code,
            403,
        )

    def test_tenant_admin_sees_deployment_defaults(self):
        dep = DeploymentSettings.load()
        dep.topology_card_fields = ["serial"]
        dep.topology_card_role_overrides = {"role:core_sw": []}
        dep.save()
        self._login(self._tenant_admin())
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["override"])
        self.assertEqual(body["card_fields"], TOPOLOGY_CARD_FIELD_DEFAULTS)
        self.assertEqual(
            body["deployment_defaults"],
            {"card_fields": ["serial"], "is_default": False,
             "role_overrides": {"role:core_sw": []}},
        )

    def test_override_switch_takes_effect(self):
        DeploymentSettings.load()
        self._login(self._tenant_admin())
        r = self.client.put(
            self.URL,
            {"override": True, "card_fields": ["platform"],
             "role_overrides": {"role:core_sw": ["loopback"]}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["override"])
        eff = effective_topology_card(self.tenant)
        self.assertEqual((eff["fields"], eff["source"]), (["platform"], "tenant"))
        self.assertEqual(
            resolve_card_fields(self.device, eff), (["loopback"], "role")
        )

        r = self.client.put(self.URL, {"override": False}, format="json")
        self.assertFalse(r.json()["override"])
        self.assertEqual(effective_topology_card(self.tenant)["source"], "default")
        # The tenant's own lists stay stored for the next time it overrides.
        self.assertEqual(r.json()["card_fields"], ["platform"])

    def test_invalid_write_changes_nothing(self):
        self._login(self._tenant_admin())
        r = self.client.put(
            self.URL, {"override": True, "card_fields": ["bogus"]}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        r = self.client.put(self.URL, {"override": "maybe"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("override", r.json())
        self.assertFalse(TenantSettings.for_tenant(self.tenant).override_topology_card)

    def test_generic_tenant_settings_endpoint_validates_too(self):
        self._login(self._tenant_admin())
        r = self.client.put(
            "/api/tenant-settings/",
            {"topology_card_fields": ["bogus"]},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("topology_card_fields", r.json())
        r = self.client.put(
            "/api/tenant-settings/",
            {"override_topology_card": True,
             "topology_card_role_overrides": {"role:core_sw": []}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            effective_topology_card(self.tenant)["role_overrides"], {"role:core_sw": []}
        )

    def test_generic_endpoint_reads_cleaned_lists_that_write_back(self):
        """A key that left the vocabulary is dropped on read, so a client
        that PUTs back what it GETs is not refused by the strict write."""
        ts = TenantSettings.for_tenant(self.tenant)
        ts.topology_card_fields = ["serial", "was_removed"]
        ts.topology_card_role_overrides = {
            "role:core_sw": ["gone"], "role:edge": [], "role:leaf": ["platform", "gone"],
        }
        ts.save()
        self._login(self._tenant_admin())
        body = self.client.get("/api/tenant-settings/").json()
        self.assertEqual(body["topology_card_fields"], ["serial"])
        self.assertEqual(
            body["topology_card_role_overrides"],
            {"role:edge": [], "role:leaf": ["platform"]},
        )
        r = self.client.put("/api/tenant-settings/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        # Nothing stored inherits (null), and a list whose every key left
        # the vocabulary inherits too rather than reading as name only.
        ts.topology_card_fields = None
        ts.save()
        self.assertIsNone(self.client.get("/api/tenant-settings/").json()[
            "topology_card_fields"
        ])
        ts.topology_card_fields = ["was_removed"]
        ts.save()
        self.assertIsNone(self.client.get("/api/tenant-settings/").json()[
            "topology_card_fields"
        ])


class EffectiveEndpointTests(_Fixture):
    URL = "/api/topology-card/"

    def test_readable_by_any_member(self):
        dep = DeploymentSettings.load()
        dep.topology_card_fields = ["serial", "was_removed"]
        dep.save()
        self._login(self._reader())
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["fields"], ["serial"])
        self.assertEqual(body["source"], "deployment")
        self.assertEqual(body["role_overrides"], {})
        self.assertEqual(body["defaults"], TOPOLOGY_CARD_FIELD_DEFAULTS)
        self.assertEqual(body["pills"], ["status", "monitor"])

    def test_anonymous_is_refused(self):
        self.assertIn(self.client.get(self.URL).status_code, (401, 403))


class DeviceOverrideTests(_Fixture):
    def _url(self):
        return f"/api/devices/{self.device.id}/"

    def test_patch_sets_clears_and_reads_back(self):
        self._login(self._superuser())
        r = self.client.get(self._url())
        self.assertIsNone(r.json()["topology_card"])

        r = self.client.patch(
            self._url(), {"topology_card": ["serial", "cf_owner"]}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["topology_card"], ["serial", "cf_owner"])
        self.device.refresh_from_db()
        self.assertEqual(self.device.topology_card, ["serial", "cf_owner"])

        r = self.client.patch(self._url(), {"topology_card": []}, format="json")
        self.assertEqual(r.json()["topology_card"], [])
        r = self.client.patch(self._url(), {"topology_card": None}, format="json")
        self.assertIsNone(r.json()["topology_card"])
        self.device.refresh_from_db()
        self.assertIsNone(self.device.topology_card)

    def test_bad_values_are_field_errors(self):
        self._login(self._superuser())
        for bad in (["serial", "bogus"], NINE, "serial", {"serial": 1}, [3]):
            r = self.client.patch(self._url(), {"topology_card": bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("topology_card", r.json())

    def test_read_drops_keys_the_vocabulary_lost(self):
        Device.objects.filter(pk=self.device.pk).update(
            topology_card=["serial", "was_removed"]
        )
        self._login(self._superuser())
        self.assertEqual(self.client.get(self._url()).json()["topology_card"], ["serial"])

    def test_viewer_cannot_change_it(self):
        u = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="view-devices", object_types=["device"], actions=["view"]
        )
        perm.users.add(u)
        self._login(u)
        r = self.client.patch(self._url(), {"topology_card": []}, format="json")
        self.assertEqual(r.status_code, 403)
        self.device.refresh_from_db()
        self.assertIsNone(self.device.topology_card)

    def test_clone_carries_the_override(self):
        self.device.topology_card = ["loopback"]
        self.device.save()
        self._login(self._superuser())
        init = self.client.get(f"{self._url()}clone/").json()["initial"]
        self.assertEqual(init["topology_card"], ["loopback"])
