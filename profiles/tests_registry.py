"""Device profiles are wired into the shared registries: RBAC object types,
site scope, site roles, the change log, the reference registry and the
migration guard."""
from __future__ import annotations

from django.test import SimpleTestCase

from audit.apps import AUDITED_MODELS
from auth_api.object_types import _registry
from auth_api.site_paths import SITE_PATHS, site_role_catalog_types, site_role_types
from core.tests_migration_safety import problems
from customization.object_registry import reference_model, resolve_labels

from .testing import ProfileBase


class RegistryTests(SimpleTestCase):
    def test_object_types_and_site_scope(self):
        registry = _registry()
        self.assertIn("deviceprofile", registry)
        self.assertIn("deviceprofileassignment", registry)
        # Section rows and ledger rows go with the profile and the assignment.
        self.assertNotIn("deviceprofileapplicationgroup", registry)
        self.assertNotIn("deviceprofileitemlink", registry)
        self.assertEqual(SITE_PATHS["deviceprofileassignment"],
                         "device__site|virtual_machine__site")
        self.assertNotIn("deviceprofile", SITE_PATHS)
        self.assertIn("deviceprofileassignment", site_role_types())
        self.assertIn("deviceprofile", site_role_catalog_types())

    def test_audited(self):
        for label in ("profiles.DeviceProfile", "profiles.DeviceProfileApplicationGroup",
                      "profiles.DeviceProfileAssignment"):
            self.assertIn(label, AUDITED_MODELS)

    def test_migrations_are_safe(self):
        self.assertEqual(problems(only_apps={"profiles"}), [])


class ReferenceTests(ProfileBase):
    def test_profiles_resolve_as_references(self):
        ref = reference_model("deviceprofile")
        self.assertEqual(ref.endpoint, "/api/device-profiles/")
        mine = self.profile("RDS-HR")
        theirs = self.profile("Theirs", tenant=self.other)
        rows = resolve_labels("deviceprofile", [str(mine.id), str(theirs.id)],
                              tenant=self.tenant)
        self.assertEqual([r["label"] for r in rows], ["RDS-HR"])
