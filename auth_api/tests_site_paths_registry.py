"""Every RBAC object type that belongs to a site is narrowed by site scope.

A registered type with a foreign key to a Site, or to any row that is itself
site-scoped (device, VM, prefix, address, interface, cluster, …), must either
be in ``SITE_PATHS`` or be listed in ``SITE_PATH_EXEMPT`` with its reason.
Before #414 a site-limited grant silently applied tenant-wide to services,
NAT rules, VLAN groups and a dozen more types nobody had added to the map.
"""
import importlib
import uuid
from unittest import mock

from django.apps import apps as django_apps
from django.contrib.auth.models import User
from django.core.exceptions import FieldError
from django.test import SimpleTestCase, TestCase
from django.urls import get_resolver
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory, force_authenticate

from api.models import Site
from auth_api import rbac
from auth_api.drf import _object_type
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import _registry
from auth_api.site_paths import (
    CATALOG_SITE_PATHS,
    SITE_PATH_EXEMPT,
    SITE_PATH_EXEMPT_CATALOGS,
    SITE_PATHS,
    SITE_ROLE_EXCLUDED,
    SITE_ROLE_REFERENCE_EXCLUDED,
    alternatives,
    site_in_q,
    site_null_q,
    site_role_catalog_types,
    site_role_types,
)
from core.models import Organization, Tenant


def _site_links(model, owners):
    """Concrete forward FK / one-to-one fields of ``model`` that point at a
    Site or at a site-scoped type. Catalog locality (``owning_site``) is
    CATALOG_SITE_PATHS's concern, not this map's."""
    out = []
    for f in model._meta.concrete_fields:
        if not (f.is_relation and (f.many_to_one or f.one_to_one)):
            continue
        rel = f.related_model
        if rel is Site and f.name != "owning_site":
            out.append(f.name)
        elif rel is not Site and rel._meta.model_name in owners:
            out.append(f.name)
    return out


class SitePathsRegistryTests(SimpleTestCase):
    def test_every_site_bound_type_is_scoped_or_exempt(self):
        owners = set(SITE_PATHS)
        missing = {}
        for slug, entry in _registry().items():
            if (slug in SITE_PATHS or slug in CATALOG_SITE_PATHS or slug in SITE_PATH_EXEMPT
                    or slug in SITE_PATH_EXEMPT_CATALOGS):
                continue
            links = _site_links(entry["model"], owners)
            if links:
                missing[slug] = links
        self.assertEqual(
            missing, {},
            "These object types link to a site-bound row but site scope ignores "
            "them. Add each to auth_api.site_paths.SITE_PATHS, or to "
            "SITE_PATH_EXEMPT with the reason it is tenant-wide.",
        )

    def test_exemptions_are_real_and_explained(self):
        registry = _registry()
        for slug, reason in {**SITE_PATH_EXEMPT, **SITE_PATH_EXEMPT_CATALOGS}.items():
            with self.subTest(slug=slug):
                self.assertIn(slug, registry)
                self.assertNotIn(slug, SITE_PATHS)
                self.assertTrue(reason.strip())
                # An exemption that no longer links anywhere is stale.
                self.assertTrue(_site_links(registry[slug]["model"], set(SITE_PATHS)))

    def test_every_path_resolves_to_a_site(self):
        registry = _registry()
        for slug, path in SITE_PATHS.items():
            with self.subTest(slug=slug):
                self.assertIn(slug, registry)
                model = registry[slug]["model"]
                try:
                    model._default_manager.filter(site_in_q(path, []))
                    model._default_manager.filter(site_null_q(path))
                except FieldError as exc:  # pragma: no cover - the failure message
                    self.fail(f"{slug}: {path} does not resolve ({exc})")
                for alt in alternatives(path):
                    if alt == "id":
                        self.assertIs(model, Site)
                        continue
                    target = model
                    for part in alt.split("__"):
                        target = target._meta.get_field(part).related_model
                    self.assertIs(target, Site, f"{slug}: {alt}")

    def test_compliance_triage_is_tenant_wide(self):
        """A triage row names its object generically (object_type, object_id):
        no foreign key reaches a site, so it is in no site map and site roles
        do not grant it. The triage endpoint checks each object's own view."""
        registry = _registry()
        self.assertIn("compliancetriage", registry)
        self.assertEqual(_site_links(registry["compliancetriage"]["model"], set(SITE_PATHS)), [])
        for site_map in (SITE_PATHS, CATALOG_SITE_PATHS, SITE_PATH_EXEMPT):
            self.assertNotIn("compliancetriage", site_map)
        self.assertNotIn("compliancetriage", site_role_types())
        self.assertNotIn("compliancetriage", site_role_catalog_types())

    def test_role_exclusions_are_site_paths(self):
        self.assertLessEqual(SITE_ROLE_EXCLUDED, set(SITE_PATHS))
        types = site_role_types()
        self.assertNotIn("site", types)
        self.assertNotIn("sitesettings", types)
        self.assertNotIn("deviceconfigsnapshot", types)
        for slug in ("service", "natrule", "vlangroup", "iprange", "virtualchassis"):
            self.assertIn(slug, types)


def _references(model):
    """Registered types ``model`` points at by FK, one-to-one or M2M."""
    registry = _registry()
    out = {}
    for f in model._meta.get_fields():
        if f.auto_created or not f.is_relation or f.related_model is None:
            continue
        if f.one_to_many:
            continue
        slug = f.related_model._meta.model_name
        if slug in registry:
            out.setdefault(slug, []).append(f.name)
    return out


class SiteRoleCatalogsTests(SimpleTestCase):
    """#425: the site roles read every catalog their types point at."""

    def test_every_reference_is_read_or_excluded(self):
        catalogs = set(site_role_catalog_types())
        known = set(SITE_PATHS) | set(SITE_PATH_EXEMPT) | set(SITE_ROLE_REFERENCE_EXCLUDED)
        missing = {}
        registry = _registry()
        for slug in site_role_types():
            for target, fields in _references(registry[slug]["model"]).items():
                if target not in catalogs and target not in known:
                    missing[f"{slug}.{fields[0]}"] = target
        self.assertEqual(
            missing, {},
            "A site role type points at a type the role neither reads nor "
            "excludes. site_role_catalog_types should derive it; if it is not a "
            "catalog, add it to SITE_ROLE_REFERENCE_EXCLUDED with the reason.",
        )

    def test_catalogs_are_not_site_bound_or_administration(self):
        catalogs = set(site_role_catalog_types())
        self.assertFalse(catalogs & set(SITE_PATHS))
        self.assertFalse(catalogs & set(SITE_PATH_EXEMPT))
        self.assertFalse(catalogs & set(SITE_ROLE_REFERENCE_EXCLUDED))
        for slug in ("user", "group", "objectpermission", "tenant", "exporttemplate"):
            self.assertNotIn(slug, catalogs)

    def test_the_reported_catalogs_are_read(self):
        self.assertLessEqual({
            "devicetype", "devicerole", "platform", "status", "tag", "customfield",
            "customfieldgroup", "vrf", "iprole", "manufacturer", "rackrole",
            "racktype", "cabinettype", "cabinetrole", "zone",
        }, set(site_role_catalog_types()))

    def test_exclusions_are_real_and_explained(self):
        registry = _registry()
        referenced = set()
        for slug in site_role_types():
            referenced |= set(_references(registry[slug]["model"]))
        for slug, reason in SITE_ROLE_REFERENCE_EXCLUDED.items():
            with self.subTest(slug=slug):
                self.assertIn(slug, referenced)
                self.assertTrue(reason.strip())


MIGRATION = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")

CATALOG_MIGRATION = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")

# Types that joined the site roles after 0028, each with the migration that
# gives the roles built before it the type.
LATER = importlib.import_module("auth_api.migrations.0030_site_roles_support_coverage")
COOLING = importlib.import_module("auth_api.migrations.0032_site_roles_cooling")
APPLICATIONS = importlib.import_module("auth_api.migrations.0033_site_roles_applications")
COOLING_PARTS = importlib.import_module("auth_api.migrations.0034_site_roles_cooling_components")
FLOWS = importlib.import_module("auth_api.migrations.0035_site_roles_application_flows")
GROUPS = importlib.import_module("auth_api.migrations.0036_site_roles_application_groups")
PRTG = importlib.import_module("auth_api.migrations.0037_site_roles_prtg")
PINS = importlib.import_module("auth_api.migrations.0038_site_roles_prtg_pins")
PRTG_FACTS = importlib.import_module("auth_api.migrations.0039_site_roles_prtg_facts")
PRTG_OVERRIDES = importlib.import_module(
    "auth_api.migrations.0040_site_roles_prtg_overrides"
)
PROFILES = importlib.import_module("auth_api.migrations.0041_site_roles_device_profiles")
REQUIREMENTS = importlib.import_module(
    "auth_api.migrations.0042_site_roles_flow_requirements"
)
ROOMS = importlib.import_module("auth_api.migrations.0043_site_roles_rooms")
STACKS = importlib.import_module("auth_api.migrations.0044_site_roles_floor_plan_stacks")


class SiteRoleUpgradeTests(TestCase):
    """0028 gives the site roles built before 0.18 what a new one gets."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _old(self, name, actions, types=None):
        perm = ObjectPermission.objects.create(
            name=name, object_types=sorted(types or MIGRATION.OLD_ROLE_TYPES),
            actions=actions,
        )
        perm.tenants.set([self.tenant])
        perm.sites.set([self.site_a])
        perm.users.set([self.user])
        return perm

    def _run(self):
        MIGRATION.forwards(django_apps, None)

    def test_viewer_gains_site_and_new_types(self):
        perm = self._old("A - site view", ["view"])
        self._run()
        perm.refresh_from_db()
        self.assertIn("site", perm.object_types)
        self.assertIn("service", perm.object_types)
        self.assertNotIn("deviceconfigsnapshot", perm.object_types)
        self.assertTrue(rbac.can_act_on(self.user, self.tenant, "site", "view", self.site_a))
        self.assertFalse(rbac.can_act_on(self.user, self.tenant, "site", "view", self.site_b))

    def test_silo_editor_gains_a_site_record_grant(self):
        perm = self._old("A - site edit", ["view", "add", "change", "delete"])
        self._run()
        perm.refresh_from_db()
        self.assertNotIn("site", perm.object_types)
        self.assertIn("natrule", perm.object_types)
        record = ObjectPermission.objects.get(name="A - site record")
        self.assertEqual((record.object_types, record.actions), (["site"], ["view"]))
        self.assertEqual(list(record.sites.all()), [self.site_a])
        self.assertEqual(list(record.users.all()), [self.user])
        self.assertEqual(list(record.tenants.all()), [self.tenant])
        self.assertTrue(rbac.can_act_on(self.user, self.tenant, "site", "view", self.site_a))
        self.assertFalse(rbac.can_act_on(self.user, self.tenant, "site", "change", self.site_a))

    def test_reading_editor_gets_no_extra_grant(self):
        self._old("A - site edit", ["view", "add", "change", "delete"])
        read_all = ObjectPermission.objects.create(
            name="A - read all", object_types=["*"], actions=["view"]
        )
        read_all.users.set([self.user])
        self._run()
        self.assertFalse(ObjectPermission.objects.filter(name="A - site record").exists())

    def test_second_run_changes_nothing(self):
        view = self._old("A - site view", ["view"])
        self._old("B - site edit", ["view", "add", "change", "delete"])
        self._run()
        view.refresh_from_db()
        before = (sorted(view.object_types), ObjectPermission.objects.count())
        self._run()
        view.refresh_from_db()
        self.assertEqual((sorted(view.object_types), ObjectPermission.objects.count()), before)

    def test_hand_built_grants_are_left_alone(self):
        custom = self._old("Ops - site view", ["view"], types=["device", "prefix"])
        unscoped = self._old("X - site view", ["view"])
        unscoped.sites.clear()
        constrained = self._old("Y - site view", ["view"])
        constrained.constraints = {"name__startswith": "a"}
        constrained.save()
        trimmed = self._old("Z - site edit", ["view", "change"])
        self._run()
        for perm in (custom, unscoped, constrained, trimmed):
            before = list(perm.object_types)
            perm.refresh_from_db()
            self.assertEqual(perm.object_types, before, perm.name)
        self.assertFalse(ObjectPermission.objects.filter(name="Z - site record").exists())

    def test_types_removed_earlier_are_not_restored(self):
        perm = self._old(
            "A - site view", ["view"],
            types=sorted(MIGRATION.OLD_ROLE_TYPES - {"devicecredential"}),
        )
        self._run()
        perm.refresh_from_db()
        self.assertNotIn("devicecredential", perm.object_types)

    def test_frozen_lists_match_the_role(self):
        self.assertEqual(
            MIGRATION.OLD_ROLE_TYPES
            | set(MIGRATION.NEW_ROLE_TYPES)
            | set(LATER.NEW_TYPES)
            | set(COOLING.NEW_TYPES)
            | set(APPLICATIONS.NEW_TYPES)
            | set(COOLING_PARTS.NEW_TYPES)
            | set(FLOWS.NEW_TYPES)
            | set(GROUPS.NEW_TYPES)
            | set(PRTG.NEW_TYPES)
            | set(PINS.NEW_TYPES)
            | set(PRTG_FACTS.NEW_TYPES)
            | set(PRTG_OVERRIDES.NEW_TYPES)
            | set(PROFILES.NEW_TYPES)
            | set(ROOMS.NEW_TYPES)
            | set(STACKS.NEW_TYPES),
            set(site_role_types()),
        )
        self.assertEqual(
            MIGRATION.CATALOG_TYPES | COOLING_PARTS.CATALOG_TYPES, set(CATALOG_SITE_PATHS)
        )


class SiteRoleCatalogUpgradeTests(SiteRoleUpgradeTests):
    """0029 gives the site roles built before #425 their catalog view."""

    def _run(self):
        MIGRATION.forwards(django_apps, None)
        CATALOG_MIGRATION.forwards(django_apps, None)

    def test_silo_editor_gains_a_catalog_view_grant(self):
        self._old("A - site edit", ["view", "add", "change", "delete"])
        self._run()
        grant = ObjectPermission.objects.get(name="A - catalog view")
        self.assertEqual(grant.actions, ["view"])
        self.assertEqual(grant.object_types, CATALOG_MIGRATION.ROLE_CATALOGS)
        self.assertEqual(list(grant.sites.all()), [self.site_a])
        self.assertEqual(list(grant.users.all()), [self.user])
        self.assertEqual(list(grant.tenants.all()), [self.tenant])
        self.assertTrue(rbac.has_action(self.user, self.tenant, "devicetype", "view"))
        self.assertFalse(rbac.has_action(self.user, self.tenant, "devicetype", "add"))
        self.assertFalse(rbac.has_action(self.user, self.tenant, "devicerole", "change"))

    def test_viewer_gains_the_catalogs(self):
        perm = self._old("A - site view", ["view"])
        self._run()
        perm.refresh_from_db()
        self.assertLessEqual(set(CATALOG_MIGRATION.ROLE_CATALOGS), set(perm.object_types))
        self.assertFalse(ObjectPermission.objects.filter(name="A - catalog view").exists())

    def test_reading_editor_gets_no_catalog_grant(self):
        self._old("A - site edit", ["view", "add", "change", "delete"])
        read_all = ObjectPermission.objects.create(
            name="A - read all", object_types=["*"], actions=["view"]
        )
        read_all.users.set([self.user])
        self._run()
        self.assertFalse(ObjectPermission.objects.filter(name="A - catalog view").exists())

    def test_hand_built_editor_is_left_alone(self):
        self._old("Z - site edit", ["view", "change"])
        self._old("Ops - site edit", ["view", "add", "change", "delete"],
                  types=["device", "prefix", "ipaddress", "circuit"])
        self._run()
        self.assertFalse(ObjectPermission.objects.filter(name__endswith="catalog view").exists())

    def test_second_catalog_run_changes_nothing(self):
        self._old("A - site edit", ["view", "add", "change", "delete"])
        view = self._old("B - site view", ["view"])
        self._run()
        view.refresh_from_db()
        before = (sorted(view.object_types), ObjectPermission.objects.count())
        self._run()
        view.refresh_from_db()
        self.assertEqual((sorted(view.object_types), ObjectPermission.objects.count()), before)

    def test_frozen_catalogs_match_the_role(self):
        self.assertEqual(
            sorted(
                CATALOG_MIGRATION.ROLE_CATALOGS + LATER.NEW_CATALOGS + COOLING.NEW_CATALOGS
                + APPLICATIONS.NEW_CATALOGS + FLOWS.NEW_CATALOGS + GROUPS.NEW_CATALOGS
                + PRTG.NEW_CATALOGS + PINS.NEW_CATALOGS + PRTG_FACTS.NEW_CATALOGS
                + PRTG_OVERRIDES.NEW_CATALOGS
                + PROFILES.NEW_CATALOGS + REQUIREMENTS.NEW_CATALOGS
            ),
            sorted(site_role_catalog_types()),
        )


class SiteRolePrtgUpgradeTests(SiteRoleUpgradeTests):
    """0037 gives the site roles built before it the PRTG rows."""

    def _role(self, name, actions):
        """A role as 0036 left it: every type up to the application groups."""
        types = (
            MIGRATION.OLD_ROLE_TYPES | set(MIGRATION.NEW_ROLE_TYPES) | set(LATER.NEW_TYPES)
            | set(COOLING.NEW_TYPES) | set(APPLICATIONS.NEW_TYPES)
            | set(COOLING_PARTS.NEW_TYPES) | set(FLOWS.NEW_TYPES) | set(GROUPS.NEW_TYPES)
        )
        if actions == ["view"]:
            types = types | {"site"}
        return self._old(name, actions, types=sorted(types))

    def test_viewer_and_editor_gain_the_prtg_rows(self):
        view = self._role("A - site view", ["view"])
        edit = self._role("B - site edit", ["view", "add", "change", "delete"])
        PRTG.forwards(django_apps, None)
        for perm in (view, edit):
            perm.refresh_from_db()
            self.assertLessEqual(set(PRTG.NEW_TYPES), set(perm.object_types), perm.name)
            self.assertNotIn("prtgconnection", perm.object_types)

    def test_prtg_second_run_and_hand_built(self):
        view = self._role("A - site view", ["view"])
        custom = self._old("Ops - site view", ["view"], types=["device", "prefix"])
        PRTG.forwards(django_apps, None)
        view.refresh_from_db()
        before = sorted(view.object_types)
        PRTG.forwards(django_apps, None)
        view.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual(sorted(view.object_types), before)
        self.assertEqual(custom.object_types, ["device", "prefix"])


class SiteRolePrtgPinUpgradeTests(SiteRoleUpgradeTests):
    """0038 gives the site roles built before it the PRTG sensor pins."""

    def _role(self, name, actions):
        """A role as 0037 left it."""
        types = (
            MIGRATION.OLD_ROLE_TYPES | set(MIGRATION.NEW_ROLE_TYPES) | set(LATER.NEW_TYPES)
            | set(COOLING.NEW_TYPES) | set(APPLICATIONS.NEW_TYPES)
            | set(COOLING_PARTS.NEW_TYPES) | set(FLOWS.NEW_TYPES) | set(GROUPS.NEW_TYPES)
            | set(PRTG.NEW_TYPES)
        )
        if actions == ["view"]:
            types = types | {"site"}
        return self._old(name, actions, types=sorted(types))

    def test_viewer_and_editor_gain_the_pins(self):
        view = self._role("A - site view", ["view"])
        edit = self._role("B - site edit", ["view", "add", "change", "delete"])
        PINS.forwards(django_apps, None)
        for perm in (view, edit):
            perm.refresh_from_db()
            self.assertIn("prtgsensorpin", perm.object_types, perm.name)

    def test_pins_second_run_and_hand_built(self):
        view = self._role("A - site view", ["view"])
        custom = self._old("Ops - site view", ["view"], types=["device", "prefix"])
        PINS.forwards(django_apps, None)
        view.refresh_from_db()
        before = sorted(view.object_types)
        PINS.forwards(django_apps, None)
        view.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual(sorted(view.object_types), before)
        self.assertEqual(custom.object_types, ["device", "prefix"])

    def test_0039_adds_the_system_information_after_0038(self):
        view = self._role("A - site view", ["view"])
        edit = self._role("B - site edit", ["view", "add", "change", "delete"])
        custom = self._old("Ops - site view", ["view"], types=["device", "prefix"])
        PINS.forwards(django_apps, None)
        PRTG_FACTS.forwards(django_apps, None)
        for perm in (view, edit):
            perm.refresh_from_db()
            self.assertIn("prtghostfacts", perm.object_types, perm.name)
        before = sorted(view.object_types)
        PRTG_FACTS.forwards(django_apps, None)
        view.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual(sorted(view.object_types), before)
        self.assertEqual(custom.object_types, ["device", "prefix"])

    def test_0040_adds_the_overrides_after_0039(self):
        view = self._role("A - site view", ["view"])
        edit = self._role("B - site edit", ["view", "add", "change", "delete"])
        custom = self._old("Ops - site view", ["view"], types=["device", "prefix"])
        for step in (PINS, PRTG_FACTS, PRTG_OVERRIDES):
            step.forwards(django_apps, None)
        for perm in (view, edit):
            perm.refresh_from_db()
            self.assertIn("prtgsensoroverride", perm.object_types, perm.name)
        before = sorted(view.object_types)
        PRTG_OVERRIDES.forwards(django_apps, None)
        view.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual(sorted(view.object_types), before)
        self.assertEqual(custom.object_types, ["device", "prefix"])


class SiteRoleDeviceProfileUpgradeTests(SiteRoleUpgradeTests):
    """0040 gives the site roles built before it the device profile
    assignments, and their catalog view the profiles."""

    def _role(self, name, actions):
        """A role as 0039 left it."""
        types = (
            MIGRATION.OLD_ROLE_TYPES | set(MIGRATION.NEW_ROLE_TYPES) | set(LATER.NEW_TYPES)
            | set(COOLING.NEW_TYPES) | set(APPLICATIONS.NEW_TYPES)
            | set(COOLING_PARTS.NEW_TYPES) | set(FLOWS.NEW_TYPES) | set(GROUPS.NEW_TYPES)
            | set(PRTG.NEW_TYPES) | set(PINS.NEW_TYPES) | set(PRTG_FACTS.NEW_TYPES)
        )
        if actions == ["view"]:
            types = types | {"site"} | set(CATALOG_MIGRATION.ROLE_CATALOGS) | {
                "supportcontract", "application", "applicationgroup"}
        return self._old(name, actions, types=sorted(types))

    def test_viewer_editor_and_catalog_view_gain_the_profiles(self):
        view = self._role("A - site view", ["view"])
        edit = self._role("B - site edit", ["view", "add", "change", "delete"])
        catalog = ObjectPermission.objects.create(
            name="B - catalog view", actions=["view"],
            object_types=sorted(CATALOG_MIGRATION.ROLE_CATALOGS + ["applicationgroup"]),
        )
        catalog.sites.set([self.site_a])
        PROFILES.forwards(django_apps, None)
        view.refresh_from_db()
        edit.refresh_from_db()
        catalog.refresh_from_db()
        self.assertLessEqual({"deviceprofileassignment", "deviceprofile"},
                             set(view.object_types))
        self.assertIn("deviceprofileassignment", edit.object_types)
        self.assertNotIn("deviceprofile", edit.object_types)
        self.assertIn("deviceprofile", catalog.object_types)

    def test_profiles_second_run_and_hand_built(self):
        view = self._role("A - site view", ["view"])
        custom = self._old("Ops - site view", ["view"], types=["device", "prefix"])
        PROFILES.forwards(django_apps, None)
        view.refresh_from_db()
        before = sorted(view.object_types)
        PROFILES.forwards(django_apps, None)
        view.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual(sorted(view.object_types), before)
        self.assertEqual(custom.object_types, ["device", "prefix"])


class SiteRoleFlowRequirementUpgradeTests(SiteRoleUpgradeTests):
    """0042 gives the site viewers built before it, and the editors' catalog
    view, the application flow requirements; an editor's own grant gains no
    write on them."""

    def _role(self, name, actions):
        """A role as 0041 left it."""
        types = (
            MIGRATION.OLD_ROLE_TYPES | set(MIGRATION.NEW_ROLE_TYPES) | set(LATER.NEW_TYPES)
            | set(COOLING.NEW_TYPES) | set(APPLICATIONS.NEW_TYPES)
            | set(COOLING_PARTS.NEW_TYPES) | set(FLOWS.NEW_TYPES) | set(GROUPS.NEW_TYPES)
            | set(PRTG.NEW_TYPES) | set(PINS.NEW_TYPES) | set(PRTG_FACTS.NEW_TYPES)
            | set(PRTG_OVERRIDES.NEW_TYPES) | set(PROFILES.NEW_TYPES)
        )
        if actions == ["view"]:
            types = types | {"site"} | set(CATALOG_MIGRATION.ROLE_CATALOGS) | {
                "supportcontract", "application", "applicationgroup", "deviceprofile"}
        return self._old(name, actions, types=sorted(types))

    def test_viewer_and_catalog_view_gain_the_requirements(self):
        view = self._role("A - site view", ["view"])
        edit = self._role("B - site edit", ["view", "add", "change", "delete"])
        catalog = ObjectPermission.objects.create(
            name="B - catalog view", actions=["view"],
            object_types=sorted(CATALOG_MIGRATION.ROLE_CATALOGS + ["deviceprofile"]),
        )
        catalog.sites.set([self.site_a])
        REQUIREMENTS.forwards(django_apps, None)
        view.refresh_from_db()
        edit.refresh_from_db()
        catalog.refresh_from_db()
        self.assertIn("applicationflowrequirement", view.object_types)
        self.assertNotIn("applicationflowrequirement", edit.object_types)
        self.assertIn("applicationflowrequirement", catalog.object_types)

    def test_requirements_second_run_and_hand_built(self):
        view = self._role("A - site view", ["view"])
        custom = self._old("Ops - site view", ["view"], types=["device", "prefix"])
        REQUIREMENTS.forwards(django_apps, None)
        view.refresh_from_db()
        before = sorted(view.object_types)
        REQUIREMENTS.forwards(django_apps, None)
        view.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual(sorted(view.object_types), before)
        self.assertEqual(custom.object_types, ["device", "prefix"])


def _routed_viewsets():
    """Every DRF viewset class mounted anywhere in the URLconf."""
    out = set()

    def walk(patterns):
        for p in patterns:
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns)
            elif getattr(getattr(p, "callback", None), "cls", None) is not None:
                out.add(p.callback.cls)

    walk(get_resolver().url_patterns)
    return out


class RoutedViewsetsRestrictTests(TestCase):
    """#426: every routed viewset of a site-scoped type runs its queryset
    through the RBAC row restriction for each action. A viewset that built
    its own queryset and returned it unrestricted ignored site limits and row
    constraints - circuit, tunnel and L2VPN terminations and redistributions
    listed, read and deleted another site's rows."""

    ACTIONS = (
        ("list", "get", "view"),
        ("retrieve", "get", "view"),
        ("partial_update", "patch", "change"),
        ("destroy", "delete", "delete"),
    )

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="A", object_types=["*"], actions=["view", "add", "change", "delete"],
        )
        perm.tenants.set([self.tenant])
        perm.sites.set([self.site_a])
        perm.users.set([self.user])

    def _view(self, cls, action, method):
        raw = getattr(APIRequestFactory(), method)("/")
        force_authenticate(raw, user=self.user)
        view = cls()
        view.action = action
        view.args = ()
        view.kwargs = {} if action == "list" else {"pk": str(uuid.uuid4())}
        view.format_kwarg = None
        view.request = Request(raw)
        view.request.user = self.user
        return view

    maxDiff = None

    def test_every_site_scoped_viewset_restricts_its_queryset(self):
        scoped = set(SITE_PATHS) | set(CATALOG_SITE_PATHS)
        real = rbac.restrict_queryset
        checked, bypass = set(), []
        for cls in sorted(_routed_viewsets(), key=lambda c: (c.__module__, c.__name__)):
            if not hasattr(cls, "get_queryset"):
                continue
            slug = _object_type(cls())
            if slug not in scoped:
                continue
            for action, method, verb in self.ACTIONS:
                # A viewset's declared map is the verb both gates use.
                verb = getattr(cls, "rbac_action_map", {}).get(action, verb)
                seen = []

                def record(qs, user, tenant, s, a, _seen=seen):
                    _seen.append((s, a))
                    return real(qs, user, tenant, s, a)

                view = self._view(cls, action, method)
                with mock.patch.object(rbac, "restrict_queryset", side_effect=record):
                    view.get_queryset()
                if (slug, verb) not in seen:
                    bypass.append(f"{cls.__module__}.{cls.__name__}.{action} ({slug})")
            checked.add(slug)
        self.assertEqual(
            bypass, [],
            "These viewsets return a queryset the RBAC row restriction never saw, "
            "so site limits and constraints do not apply. End get_queryset with "
            "restrict_for_view(self, qs) or chain to super().get_queryset().",
        )
        self.assertLessEqual(
            {"circuittermination", "tunneltermination", "l2vpntermination",
             "redistribution", "device", "interface", "tag"},
            checked,
        )
