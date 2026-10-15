"""Every RBAC object type that belongs to a site is narrowed by site scope.

A registered type with a foreign key to a Site, or to any row that is itself
site-scoped (device, VM, prefix, address, interface, cluster, …), must either
be in ``SITE_PATHS`` or be listed in ``SITE_PATH_EXEMPT`` with its reason.
Before #414 a site-limited grant silently applied tenant-wide to services,
NAT rules, VLAN groups and a dozen more types nobody had added to the map.
"""
import importlib

from django.apps import apps as django_apps
from django.contrib.auth.models import User
from django.core.exceptions import FieldError
from django.test import SimpleTestCase, TestCase

from api.models import Site
from auth_api import rbac
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import _registry
from auth_api.site_paths import (
    CATALOG_SITE_PATHS,
    SITE_PATH_EXEMPT,
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
            if slug in SITE_PATHS or slug in CATALOG_SITE_PATHS or slug in SITE_PATH_EXEMPT:
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
        for slug, reason in SITE_PATH_EXEMPT.items():
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
            MIGRATION.OLD_ROLE_TYPES | set(MIGRATION.NEW_ROLE_TYPES) | set(LATER.NEW_TYPES),
            set(site_role_types()),
        )
        self.assertEqual(MIGRATION.CATALOG_TYPES, set(CATALOG_SITE_PATHS))


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
            sorted(CATALOG_MIGRATION.ROLE_CATALOGS + LATER.NEW_CATALOGS),
            sorted(site_role_catalog_types()),
        )
