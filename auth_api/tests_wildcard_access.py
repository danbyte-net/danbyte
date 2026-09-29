"""All-object grants do not reach users, groups or permissions (0.17).

"*" used to expand to every registered type, the access types included, so the
built-in Operator group (view/add/change on "*") could change users, groups
and grants - reach every admin surface and edit its own way to Administrator.
Now "*" means every type except ``ACCESS_TYPES``; a grant reaches those only
by naming them. Pinned here for every built-in group, through the engine, the
admin gates and the real endpoints, plus the upgrade that keeps existing
administrators administrators.
"""
from __future__ import annotations

import contextlib
import importlib
import io

from django.apps import apps as django_apps
from django.contrib.auth.models import Group, User
from django.test import RequestFactory, SimpleTestCase, TestCase
from rest_framework.test import APITestCase

from api.models import Prefix, Site
from auth_api import rbac
from auth_api.builtin_groups import ensure_builtin_groups, grant_names
from auth_api.models import GroupProfile, ObjectPermission, UserProfile
from auth_api.object_types import ACCESS_TYPES, grant_covers
from auth_api.permissions import (
    can_grant_superuser,
    can_manage_admin,
    can_manage_deployment,
)
from core.models import Organization, Tenant

MIGRATION = importlib.import_module("auth_api.migrations.0024_wildcard_excludes_access")
NARROW = importlib.import_module("auth_api.migrations.0025_narrow_kept_access")
CRUD = ["view", "add", "change", "delete"]
BUILTIN = ("Administrator", "Operator", "Read-only")


def _member(name, tenant, group=None):
    user = User.objects.create_user(name, f"{name}@example.com", "x")
    UserProfile.objects.create(user=user).tenants.add(tenant)
    if group:
        user.groups.add(Group.objects.get(name=group))
    return user


class GrantCoversTests(SimpleTestCase):
    def test_wildcard_skips_only_the_access_types(self):
        for slug in ACCESS_TYPES:
            with self.subTest(slug=slug):
                self.assertFalse(grant_covers(["*"], slug))
                self.assertTrue(grant_covers([slug], slug))
                self.assertTrue(grant_covers(["*", slug], slug))
        self.assertTrue(grant_covers(["*"], "prefix"))
        # A plugin type is covered whatever group label it picked.
        self.assertTrue(grant_covers(["*"], "widget"))
        self.assertFalse(grant_covers(["prefix"], "user"))
        self.assertFalse(grant_covers([], "prefix"))
        self.assertFalse(grant_covers(None, "prefix"))

    def test_the_migration_froze_the_same_list(self):
        self.assertEqual(tuple(MIGRATION.ACCESS_TYPES), ACCESS_TYPES)

    def test_the_narrowing_migration_froze_the_same_names(self):
        from core.upgrade_notes import KEPT_ACCESS_GRANT

        self.assertEqual(NARROW.ACCESS_TYPES, list(ACCESS_TYPES))
        self.assertEqual(NARROW.KEPT_NAME, KEPT_ACCESS_GRANT)


class BuiltinGroupEngineTests(TestCase):
    """Every built-in group through the engine and the admin gates."""

    @classmethod
    def setUpTestData(cls):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        cls.users = {g: _member(g.lower(), cls.tenant, g) for g in BUILTIN}

    def test_access_types_need_the_administrator_grant(self):
        for group, user in self.users.items():
            acts = rbac.effective_actions(user, self.tenant)
            for slug in ACCESS_TYPES:
                with self.subTest(group=group, slug=slug):
                    want = set(CRUD) if group == "Administrator" else set()
                    self.assertEqual(acts.get(slug, set()), want)

    def test_everything_else_is_unchanged(self):
        acts = {g: rbac.effective_actions(u, self.tenant) for g, u in self.users.items()}
        self.assertEqual(acts["Administrator"]["prefix"], set(CRUD))
        self.assertEqual(acts["Operator"]["prefix"], {"view", "add", "change"})
        self.assertEqual(acts["Read-only"]["prefix"], {"view"})
        self.assertEqual(acts["Operator"]["script"], {"view", "add", "change"})

    def test_admin_gates_follow(self):
        for group, user in self.users.items():
            admin = group == "Administrator"
            with self.subTest(group=group):
                self.assertEqual(can_manage_admin(user, self.tenant), admin)
                self.assertEqual(can_manage_admin(user, None), admin)
                self.assertEqual(can_manage_deployment(user), admin)
                self.assertFalse(can_grant_superuser(user))

    def test_row_level_helpers_deny_non_admins(self):
        for group in ("Operator", "Read-only"):
            user = self.users[group]
            for action in ("view", "change"):
                with self.subTest(group=group, action=action):
                    self.assertIsNone(
                        rbac.constraints_for(user, self.tenant, "user", action)
                    )
                    self.assertFalse(
                        rbac.restrict_queryset(
                            User.objects.all(), user, self.tenant, "user", action
                        ).exists()
                    )
                    self.assertFalse(
                        rbac.can_act_on(user, self.tenant, "user", action, user)
                    )
        admin = self.users["Administrator"]
        self.assertEqual(rbac.constraints_for(admin, self.tenant, "user", "change"), [])
        self.assertEqual(
            rbac.restrict_queryset(
                User.objects.all(), admin, self.tenant, "user", "view"
            ).count(),
            User.objects.count(),
        )

    def test_change_log_types_leave_out_access_for_non_admins(self):
        from audit.api import _viewable_types

        labels = {"auth.user", "auth.group", "auth_api.objectpermission"}
        for group, user in self.users.items():
            request = RequestFactory().get("/")
            request.user = user
            request.session = {"current_tenant_id": str(self.tenant.id)}
            with self.subTest(group=group):
                seen = _viewable_types(request) & labels
                self.assertEqual(seen, labels if group == "Administrator" else set())


class BuiltinGroupApiTests(APITestCase):
    """The real endpoints, per built-in group: Administrator is never
    refused; Operator and Read-only always are."""

    @classmethod
    def setUpTestData(cls):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        cls.users = {g: _member(g.lower(), cls.tenant, g) for g in BUILTIN}
        cls.admin_group = Group.objects.get(name="Administrator")
        cls.operator_grant = ObjectPermission.objects.filter(
            name__in=grant_names("Operator")
        ).first()

    def _as(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _probe(self, user):
        self._as(user)
        c = self.client
        return {
            "list users": c.get("/api/users/"),
            "list groups": c.get("/api/groups/"),
            "list permissions": c.get("/api/object-permissions/"),
            "access summary": c.get(f"/api/users/{user.id}/access-summary/"),
            "create group": c.post("/api/groups/", {"name": "escalate"}, format="json"),
            "join Administrator": c.patch(
                f"/api/users/{user.id}/",
                {"group_ids": [self.admin_group.id]}, format="json",
            ),
            "give Operator delete": c.patch(
                f"/api/object-permissions/{self.operator_grant.id}/",
                {"actions": CRUD}, format="json",
            ),
            "deployment email": c.put("/api/deployment/email/", {}, format="json"),
            "deployment ldap": c.put("/api/deployment/ldap/", {}, format="json"),
            "monitoring settings": c.patch(
                "/api/monitoring/settings/", {}, format="json"
            ),
            "tenant settings": c.get("/api/tenant-settings/"),
            "monitoring engine": c.post("/api/monitoring/engines/", {}, format="json"),
        }

    def test_administrator_reaches_every_admin_surface(self):
        for what, r in self._probe(self.users["Administrator"]).items():
            with self.subTest(what=what):
                self.assertNotEqual(r.status_code, 403, r.content)

    def test_operator_and_read_only_are_refused_everywhere(self):
        for group in ("Operator", "Read-only"):
            user = self.users[group]
            for what, r in self._probe(user).items():
                with self.subTest(group=group, what=what):
                    self.assertEqual(r.status_code, 403, r.content)
            user.refresh_from_db()
            self.assertFalse(user.groups.filter(pk=self.admin_group.pk).exists())
        self.operator_grant.refresh_from_db()
        self.assertNotIn("delete", self.operator_grant.actions)

    def test_me_reports_no_admin_and_no_access_types(self):
        for group, user in self.users.items():
            self._as(user)
            me = self.client.get("/api/me/").json()
            admin = group == "Administrator"
            with self.subTest(group=group):
                self.assertEqual(me["can_manage_users"], admin)
                self.assertEqual(me["can_manage_deployment"], admin)
                self.assertFalse(me["can_grant_superuser"])
                has_access = {s for s in ACCESS_TYPES if s in me["permissions"]}
                self.assertEqual(has_access, set(ACCESS_TYPES) if admin else set())
                self.assertIn("prefix", me["permissions"])

    def test_operator_keeps_its_everyday_work(self):
        self._as(self.users["Operator"])
        r = self.client.post("/api/prefixes/", {"cidr": "10.9.0.0/24"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        prefix = Prefix.objects.get(pk=r.json()["id"])
        self.assertEqual(self.client.delete(f"/api/prefixes/{prefix.id}/").status_code, 403)
        self.assertEqual(
            self.client.get("/api/planning/assignable-users/").status_code, 200
        )
        self.assertEqual(self.client.get("/api/people/").status_code, 200)

    def test_rbac_registry_names_the_excluded_types(self):
        self._as(self.users["Read-only"])
        body = self.client.get("/api/rbac/object-types/").json()
        self.assertEqual(body["wildcard_excluded"], list(ACCESS_TYPES))


class AdministratorGrantGuardTests(APITestCase):
    """A stale browser tab or script writing a bare ["*"] to the built-in
    Administrator grant would demote every administrator - refused."""

    @classmethod
    def setUpTestData(cls):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        cls.root = User.objects.create_superuser("root", "r@example.com", "x")
        cls.grant = ObjectPermission.objects.filter(
            name__in=grant_names("Administrator")
        ).first()

    def setUp(self):
        self.client.force_login(self.root)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _patch(self, grant, types):
        return self.client.patch(
            f"/api/object-permissions/{grant.id}/", {"object_types": types},
            format="json",
        )

    def test_bare_wildcard_on_the_administrator_grant_is_refused(self):
        r = self._patch(self.grant, ["*"])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("object_types", r.json())
        self.grant.refresh_from_db()
        self.assertTrue(set(ACCESS_TYPES) <= set(self.grant.object_types))

    def test_saving_it_with_the_access_types_is_fine(self):
        r = self._patch(self.grant, ["*", *ACCESS_TYPES])
        self.assertEqual(r.status_code, 200, r.content)
        # Other edits that leave object_types alone are untouched by the guard.
        r = self.client.patch(
            f"/api/object-permissions/{self.grant.id}/", {"description": "x"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_other_grants_may_use_a_bare_wildcard(self):
        custom = ObjectPermission.objects.create(
            name="Administrator - all objects (copy)", object_types=["prefix"],
            actions=CRUD,
        )
        custom.groups.add(Group.objects.get(name="Administrator"))
        self.assertEqual(self._patch(custom, ["*"]).status_code, 200)


class AccessGrantLimitTests(APITestCase):
    """Users, groups and permissions have no site and nothing reads row
    constraints for them, so a grant naming them refuses either limit - it
    would look narrower than it is."""

    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        cls.site = Site.objects.create(tenant=cls.tenant, name="HQ")
        cls.root = User.objects.create_superuser("root", "r@example.com", "x")

    def setUp(self):
        self.client.force_login(self.root)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _post(self, **body):
        body = {"name": "g", "actions": ["view", "change"], **body}
        return self.client.post("/api/object-permissions/", body, format="json")

    def test_sites_or_constraints_on_access_types_are_refused(self):
        for body, field in (
            ({"object_types": ["*", "user"], "site_ids": [str(self.site.id)]}, "site_ids"),
            ({"object_types": ["group"], "constraints": {"name": "x"}}, "constraints"),
            ({"object_types": ["device", "objectpermission"],
              "constraints": [{"status__slug": "active"}]}, "constraints"),
        ):
            with self.subTest(body=body):
                r = self._post(**body)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(field, r.json())

    def test_other_limits_are_fine(self):
        for body in (
            {"object_types": ["*"], "site_ids": [str(self.site.id)],
             "constraints": {"status__slug": "active"}},
            {"object_types": ["user"], "tenant_ids": [str(self.tenant.id)]},
            {"object_types": ["user"], "constraints": {}},
        ):
            with self.subTest(body=body):
                self.assertEqual(self._post(**body).status_code, 201)

    def test_an_existing_limited_grant_can_still_be_disabled(self):
        old = ObjectPermission.objects.create(
            name="old", object_types=["*", *ACCESS_TYPES], actions=CRUD,
            constraints={"status__slug": "active"},
        )
        old.sites.add(self.site)
        url = f"/api/object-permissions/{old.id}/"
        self.assertEqual(
            self.client.patch(url, {"enabled": False}, format="json").status_code, 200
        )
        r = self.client.patch(url, {"object_types": ["*", "user"]}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(
            url, {"object_types": ["*"]}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)


class MigrationTests(TestCase):
    """0024 names the access types on the grants that were administrator
    grants, and on no others."""

    def setUp(self):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.admin_group = Group.objects.get(name="Administrator")
        self.operator_group = Group.objects.get(name="Operator")

        # The seeded Administrator grants, back to their pre-0.17 shape, under
        # both names the seeders used.
        ObjectPermission.objects.filter(name__in=grant_names("Administrator")).delete()
        self.seeded = []
        for name in grant_names("Administrator"):
            perm = ObjectPermission.objects.create(
                name=name, object_types=["*"], actions=CRUD,
            )
            perm.groups.add(self.admin_group)
            self.seeded.append(perm)

        self.boss = _member("boss", self.tenant)
        self.custom_admin = self._grant("custom admin", CRUD, users=[self.boss])
        self.tenant_admin = self._grant("tenant admin", CRUD, tenants=[self.tenant])
        self.site_admin = self._grant(
            "site admin", CRUD, sites=[self.site],
            constraints={"status__slug": "active"},
        )
        self.disabled_admin = self._grant("disabled admin", CRUD, enabled=False)
        self.ops = _member("ops", self.tenant)
        self.ops_like = self._grant("ops like", ["view", "add", "change"], users=[self.ops])
        self.view_all = self._grant("read all", ["view"])
        self.edited_down = self._grant(
            "admins without delete", ["view", "add", "change"],
            groups=[self.admin_group],
        )
        self.shared = self._grant(
            "shared", ["view", "add", "change"],
            groups=[self.admin_group, self.operator_group],
        )
        self.promoter = self._grant("promoter", ["view", "grant_superuser"])
        self.operator_grant = ObjectPermission.objects.filter(
            name__in=grant_names("Operator")
        ).first()
        self.operator_grant.actions = CRUD  # an install that gave Operator delete
        self.operator_grant.object_types = ["*"]
        self.operator_grant.save()

    def _grant(self, name, actions, *, users=(), groups=(), tenants=(), sites=(),
               constraints=None, enabled=True):
        perm = ObjectPermission.objects.create(
            name=name, object_types=["*"], actions=list(actions),
            constraints=constraints, enabled=enabled,
        )
        perm.users.set(users)
        perm.groups.set(groups)
        perm.tenants.set(tenants)
        perm.sites.set(sites)
        return perm

    def _types(self, perm):
        perm.refresh_from_db()
        return perm.object_types

    def _migrate(self):
        MIGRATION.forwards(django_apps, None)

    def test_administrator_grants_gain_the_access_types(self):
        self._migrate()
        full = ["*", *ACCESS_TYPES]
        for perm in (
            *self.seeded, self.custom_admin, self.tenant_admin, self.site_admin,
            self.disabled_admin, self.edited_down, self.promoter,
        ):
            with self.subTest(grant=perm.name):
                self.assertEqual(self._types(perm), full)

    def test_every_other_wildcard_grant_loses_them(self):
        self._migrate()
        for perm in (self.ops_like, self.view_all, self.shared, self.operator_grant):
            with self.subTest(grant=perm.name):
                self.assertEqual(self._types(perm), ["*"])
        read_only = ObjectPermission.objects.filter(name__in=grant_names("Read-only"))
        for perm in read_only:
            self.assertEqual(perm.object_types, ["*"])

    def test_running_twice_adds_nothing_more(self):
        self._migrate()
        before = {p.pk: list(p.object_types) for p in ObjectPermission.objects.all()}
        self._migrate()
        after = {p.pk: list(p.object_types) for p in ObjectPermission.objects.all()}
        self.assertEqual(before, after)
        for types in after.values():
            self.assertEqual(len(types), len(set(types)))

    def test_admins_stay_admins_and_operator_likes_do_not(self):
        self._migrate()
        self.assertTrue(can_manage_deployment(self.boss))
        self.assertFalse(can_manage_deployment(self.ops))
        self.assertFalse(can_manage_admin(self.ops, self.tenant))

    def test_seeded_descriptions_are_rewritten_only_while_untouched(self):
        GroupProfile.objects.filter(group__name="Operator").update(
            description="Create and edit, but not delete."
        )
        GroupProfile.objects.filter(group__name="Read-only").update(
            description="Our viewers."
        )
        self._migrate()
        self.assertEqual(
            GroupProfile.objects.get(group__name="Operator").description,
            "Create and edit, but not delete. No access to users, groups or "
            "permissions.",
        )
        self.assertEqual(
            GroupProfile.objects.get(group__name="Read-only").description,
            "Our viewers.",
        )


class NarrowedUpgradeTests(MigrationTests):
    """0025 runs right after 0024 in the same upgrade: a grant limited to
    sites or by row constraints does not keep users, groups and
    permissions - neither limit narrows them."""

    def _migrate(self):
        MIGRATION.forwards(django_apps, None)
        NARROW.forwards(django_apps, None)

    def test_administrator_grants_gain_the_access_types(self):
        holder = _member("site-lead", self.tenant)
        row_only = self._grant(
            "planned only", CRUD, users=[holder], constraints={"status__slug": "planned"},
        )
        site_only = self._grant("site only", CRUD, users=[holder], sites=[self.site])
        self._migrate()
        full = ["*", *ACCESS_TYPES]
        for perm in (
            *self.seeded, self.custom_admin, self.tenant_admin, self.disabled_admin,
            self.edited_down, self.promoter,
        ):
            with self.subTest(grant=perm.name):
                self.assertEqual(self._types(perm), full)
        for perm in (self.site_admin, row_only, site_only):
            with self.subTest(grant=perm.name):
                self.assertEqual(self._types(perm), ["*"])
        self.assertFalse(can_manage_deployment(holder))
        self.assertFalse(can_manage_admin(holder, self.tenant))
        # Their everyday reach is untouched.
        self.assertTrue(rbac.has_action(holder, self.tenant, "device", "delete"))
        # Somebody else could still manage users, so nothing was kept.
        from core.upgrade_notes import KEPT_ACCESS_GRANT

        self.assertFalse(ObjectPermission.objects.filter(name=KEPT_ACCESS_GRANT).exists())


class LockoutGuardTests(TestCase):
    """An install whose only way to manage users was an all-object grant
    keeps user management for the accounts that had it - in a grant of
    their own, not on the shared grant - and the upgrade note says so until
    someone cleans up."""

    def setUp(self):
        from core import upgrade_notes

        self.check = upgrade_notes._no_kept_access_grant
        self.kept_name = upgrade_notes.KEPT_ACCESS_GRANT
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        # The pre-0.17 shape: bare "*" on the built-in grants.
        ObjectPermission.objects.filter(
            name__in=[n for g in BUILTIN for n in grant_names(g)]
        ).update(object_types=["*"])
        self.operators = [_member(f"op{i}", self.tenant, "Operator") for i in (1, 2)]
        self.operator_grant = ObjectPermission.objects.get(
            name__in=grant_names("Operator")
        )
        # Nobody else can manage users: no superuser, no legacy admin, and
        # the seeded Administrator grant reaches no active account.
        self.assertFalse(User.objects.filter(is_superuser=True).exists())

    def _team_lead(self):
        lead = _member("lead", self.tenant)
        team = Group.objects.create(name="noc")
        lead.groups.add(team)
        grant = ObjectPermission.objects.create(
            name="noc all", object_types=["*"], actions=["view", "add", "change"],
        )
        grant.groups.add(team)
        return lead, grant

    def _upgrade(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            MIGRATION.forwards(django_apps, None)
            NARROW.forwards(django_apps, None)
        return out.getvalue()

    def _kept(self):
        return ObjectPermission.objects.get(name=self.kept_name)

    def test_a_custom_grant_holder_keeps_it_and_operators_do_not(self):
        lead, grant = self._team_lead()
        self.assertTrue(self.check())
        out = self._upgrade()
        self.assertIn(self.kept_name, out)
        self.assertIn("lead", out)
        kept = self._kept()
        self.assertEqual(kept.object_types, list(ACCESS_TYPES))
        self.assertEqual(kept.actions, ["view", "add", "change"])
        self.assertEqual(list(kept.users.all()), [lead])
        for perm in (grant, self.operator_grant):
            perm.refresh_from_db()
            self.assertEqual(perm.object_types, ["*"])
        self.assertTrue(can_manage_deployment(lead))
        for op in self.operators:
            self.assertFalse(can_manage_deployment(op))
        self.assertFalse(self.check())
        # Naming an administrator and deleting the grant clears the note.
        lead.groups.add(Group.objects.get(name="Administrator"))
        kept.delete()
        self.assertTrue(can_manage_deployment(lead))
        self.assertTrue(self.check())

    def test_only_operators_could_so_they_keep_it_but_not_the_group(self):
        self._upgrade()
        kept = self._kept()
        self.assertEqual(set(kept.users.all()), set(self.operators))
        self.assertEqual(kept.groups.count(), 0)
        self.operator_grant.refresh_from_db()
        self.assertEqual(self.operator_grant.object_types, ["*"])
        # Someone who joins Operator later does not inherit it.
        late = _member("late", self.tenant, "Operator")
        self.assertFalse(can_manage_deployment(late))
        self.assertFalse(self.check())

    def test_a_site_limited_admin_is_kept_only_when_nobody_else_is(self):
        lead = _member("site-lead", self.tenant)
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        grant = ObjectPermission.objects.create(
            name="site all", object_types=["*"], actions=CRUD,
        )
        grant.users.add(lead)
        grant.sites.add(site)
        # The Operator grant would reach this install too; turn it off so the
        # site grant is the only path.
        self.operator_grant.enabled = False
        self.operator_grant.save()
        self._upgrade()
        grant.refresh_from_db()
        self.assertEqual(grant.object_types, ["*"])
        self.assertEqual(list(self._kept().users.all()), [lead])
        self.assertEqual(self._kept().actions, CRUD)

    def test_not_kept_when_another_admin_exists(self):
        lead, grant = self._team_lead()
        User.objects.create_superuser("root", "r@example.com", "x")
        self._upgrade()
        grant.refresh_from_db()
        self.assertEqual(grant.object_types, ["*"])
        self.assertFalse(can_manage_deployment(lead))
        self.assertFalse(ObjectPermission.objects.filter(name=self.kept_name).exists())
        self.assertTrue(self.check())

    def test_running_the_upgrade_twice_keeps_one_grant(self):
        self._team_lead()
        self._upgrade()
        self._upgrade()
        self.assertEqual(ObjectPermission.objects.filter(name=self.kept_name).count(), 1)

    def test_a_deliberate_access_grant_does_not_raise_the_note(self):
        User.objects.create_superuser("root", "r@example.com", "x")
        self._upgrade()
        auditors = ObjectPermission.objects.create(
            name="auditors", object_types=["*", "user"], actions=["view"],
        )
        auditors.users.add(self.operators[0])
        helpdesk = ObjectPermission.objects.create(
            name="helpdesk", object_types=["*", "group"],
            actions=["view", "add", "change"],
        )
        helpdesk.users.add(self.operators[1])
        self.assertTrue(self.check())


class EnsureBuiltinGroupsTests(TestCase):
    def test_fresh_database_gets_an_administrator_grant_naming_access(self):
        ObjectPermission.objects.filter(
            name__in=[n for g in BUILTIN for n in grant_names(g)]
        ).delete()
        Group.objects.filter(name__in=BUILTIN).delete()
        ensure_builtin_groups()
        admin = ObjectPermission.objects.get(name__in=grant_names("Administrator"))
        self.assertEqual(admin.object_types, ["*", *ACCESS_TYPES])
        operator = ObjectPermission.objects.get(name__in=grant_names("Operator"))
        self.assertEqual(operator.object_types, ["*"])

    def test_existing_seeded_row_is_updated_not_duplicated(self):
        ObjectPermission.objects.filter(name__in=grant_names("Administrator")).delete()
        legacy = ObjectPermission.objects.create(
            name=grant_names("Administrator")[1], object_types=["*"], actions=CRUD,
        )
        ensure_builtin_groups()
        ensure_builtin_groups()
        rows = ObjectPermission.objects.filter(name__in=grant_names("Administrator"))
        self.assertEqual([r.pk for r in rows], [legacy.pk])
        legacy.refresh_from_db()
        self.assertEqual(legacy.object_types, ["*", *ACCESS_TYPES])
        self.assertTrue(legacy.groups.filter(name="Administrator").exists())
