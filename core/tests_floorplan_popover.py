"""Floor-plan tile popover config: defaults, tenant override, key hygiene, and
endpoint gating."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from django.test import Client, TestCase

from auth_api.models import UserProfile
from core.deployment import (
    FLOORPLAN_POPOVER_FIELD_DEFAULTS,
    clean_popover_fields,
)
from core.effective_settings import effective_floorplan_popover
from core.models import DeploymentSettings, Organization, Tenant, TenantSettings


def _switch(client, tenant):
    s = client.session
    s["current_tenant_id"] = str(tenant.id)
    s.save()


class CleanFieldsTests(TestCase):
    def test_drops_unknown_keys_and_dedupes_preserving_order(self):
        self.assertEqual(
            clean_popover_fields(["size", "bogus", "name", "size"]),
            ["size", "name"],
        )

    def test_non_list_is_empty(self):
        self.assertEqual(clean_popover_fields("name"), [])
        self.assertEqual(clean_popover_fields(None), [])


class EffectiveConfigTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_unconfigured_falls_back_to_defaults(self):
        cfg = effective_floorplan_popover(self.tenant)
        self.assertEqual(cfg["fields"], list(FLOORPLAN_POPOVER_FIELD_DEFAULTS))
        self.assertEqual(cfg["tile_overrides"], {})

    def test_deployment_value_applies_when_tenant_does_not_override(self):
        dep = DeploymentSettings.load()
        dep.floorplan_popover_fields = ["name", "check"]
        dep.save()
        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_floorplan_popover = False
        ts.floorplan_popover_fields = ["size"]  # ignored while not overriding
        ts.save()
        self.assertEqual(
            effective_floorplan_popover(self.tenant)["fields"], ["name", "check"]
        )

    def test_tenant_override_wins(self):
        dep = DeploymentSettings.load()
        dep.floorplan_popover_fields = ["name", "check"]
        dep.save()
        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_floorplan_popover = True
        ts.floorplan_popover_fields = ["size", "position"]
        ts.save()
        self.assertEqual(
            effective_floorplan_popover(self.tenant)["fields"], ["size", "position"]
        )

    def test_popover_override_is_independent_of_the_ui_group(self):
        # override_ui also governs device fields + human IDs. A tenant must be
        # able to take the popover WITHOUT overriding those, and vice versa.
        dep = DeploymentSettings.load()
        dep.floorplan_popover_fields = ["name"]
        dep.save()
        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_ui = True  # UI group taken…
        ts.override_floorplan_popover = False  # …but not the popover
        ts.floorplan_popover_fields = ["size"]
        ts.save()
        self.assertEqual(effective_floorplan_popover(self.tenant)["fields"], ["name"])

        ts.override_ui = False  # UI group inherited…
        ts.override_floorplan_popover = True  # …popover taken
        ts.save()
        self.assertEqual(effective_floorplan_popover(self.tenant)["fields"], ["size"])

    def test_tenants_can_differ(self):
        org = Organization.objects.get(slug="o")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        dep = DeploymentSettings.load()
        dep.floorplan_popover_fields = ["name"]
        dep.save()
        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_floorplan_popover = True
        ts.floorplan_popover_fields = ["check", "size"]
        ts.save()
        self.assertEqual(
            effective_floorplan_popover(self.tenant)["fields"], ["check", "size"]
        )
        self.assertEqual(effective_floorplan_popover(other)["fields"], ["name"])

    def test_unknown_stored_keys_never_reach_the_client(self):
        # A field removed from the registry must not survive on read.
        dep = DeploymentSettings.load()
        dep.floorplan_popover_fields = ["name", "was_removed"]
        dep.floorplan_popover_tile_overrides = {"tt:rack": ["size", "nope"]}
        dep.save()
        cfg = effective_floorplan_popover(self.tenant)
        self.assertEqual(cfg["fields"], ["name"])
        self.assertEqual(cfg["tile_overrides"], {"tt:rack": ["size"]})

    def test_absent_scope_inherits_rather_than_copying(self):
        dep = DeploymentSettings.load()
        dep.floorplan_popover_fields = ["name", "size"]
        dep.floorplan_popover_tile_overrides = {"tt:aisle": ["name"]}
        dep.save()
        cfg = effective_floorplan_popover(self.tenant)
        # Only the type that genuinely differs is stored; everything else falls
        # back to `fields` at render time.
        self.assertEqual(cfg["tile_overrides"], {"tt:aisle": ["name"]})
        self.assertNotIn("tt:rack", cfg["tile_overrides"])

    def test_custom_fields_ride_the_generic_cf_convention(self):
        # Never enumerated server-side — the tenant defines them.
        dep = DeploymentSettings.load()
        dep.floorplan_popover_fields = ["name", "cf_owner", "cf_bad key", "cf_"]
        dep.save()
        self.assertEqual(
            effective_floorplan_popover(self.tenant)["fields"],
            ["name", "cf_owner"],
        )

    def test_role_scopes_are_supported(self):
        # A role-placed tile has no tile_type, so it needs its own namespace.
        dep = DeploymentSettings.load()
        dep.floorplan_popover_tile_overrides = {
            "role:firewall": ["name", "linked_primary_ip"],
            "bogus-scope": ["name"],
        }
        dep.save()
        cfg = effective_floorplan_popover(self.tenant)
        self.assertEqual(
            cfg["tile_overrides"], {"role:firewall": ["name", "linked_primary_ip"]}
        )

    def test_empty_override_list_is_dropped_not_stored(self):
        # An empty list would silently mean "show nothing"; absence = inherit.
        dep = DeploymentSettings.load()
        dep.floorplan_popover_tile_overrides = {"tt:rack": []}
        dep.save()
        self.assertEqual(effective_floorplan_popover(self.tenant)["tile_overrides"], {})


class EndpointTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _client(self, superuser):
        u = User.objects.create_user(
            "u" if not superuser else "su", password="x", is_superuser=superuser
        )
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        c = Client()
        c.force_login(u)
        _switch(c, self.tenant)
        return c

    def test_effective_endpoint_readable_by_any_member(self):
        r = self._client(False).get("/api/floorplan-popover/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json()["fields"], list(FLOORPLAN_POPOVER_FIELD_DEFAULTS)
        )

    def test_deployment_editor_requires_deployment_admin(self):
        self.assertEqual(
            self._client(False).get("/api/deployment/floorplan-popover/").status_code,
            403,
        )

    def test_deployment_admin_can_read_and_write(self):
        c = self._client(True)
        r = c.get("/api/deployment/floorplan-popover/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("available", r.json())  # the UI's checklist vocabulary

        r = c.put(
            "/api/deployment/floorplan-popover/",
            data=json.dumps({"popover_fields": ["name", "bogus", "size"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        # Unknown key rejected at the door.
        self.assertEqual(r.json()["popover_fields"], ["name", "size"])
        dep = DeploymentSettings.load()
        self.assertEqual(dep.floorplan_popover_fields, ["name", "size"])

    def test_write_is_reflected_in_the_effective_config(self):
        c = self._client(True)
        c.put(
            "/api/deployment/floorplan-popover/",
            data=json.dumps({"popover_fields": ["check"]}),
            content_type="application/json",
        )
        self.assertEqual(effective_floorplan_popover(self.tenant)["fields"], ["check"])
