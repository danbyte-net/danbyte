"""The built-in Administrator grant lists view_credits and view_cost (0.18).

Administrators manage the grants and could give themselves both verbs, so
withholding them protects nothing; Operator and Read-only stay without them.
Pinned for the seed, the engine and migration 0031 (upgrade, idempotence,
edited and shared grants). The API and change-log behaviour is pinned in
api.tests_support_contract_cost and monitoring.tests_sla_credits.
"""
from __future__ import annotations

import contextlib
import importlib
import io

from django.apps import apps as django_apps
from django.contrib.auth.models import Group, User
from django.test import SimpleTestCase, TestCase

from auth_api import rbac
from auth_api.builtin_groups import BUILTINS, MONEY_VERBS, ensure_builtin_groups, grant_names
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

MIGRATION = importlib.import_module("auth_api.migrations.0031_administrator_money_verbs")
CRUD = ["view", "add", "change", "delete"]
MONEY = {"view_credits", "view_cost"}


def _run():
    with contextlib.redirect_stdout(io.StringIO()) as out:
        MIGRATION.forwards(django_apps, None)
    return out.getvalue()


class SeedTests(SimpleTestCase):
    def test_the_migration_froze_the_same_verbs(self):
        self.assertEqual(tuple(MIGRATION.MONEY_VERBS), MONEY_VERBS)
        self.assertEqual(set(MONEY_VERBS), MONEY)

    def test_only_administrator_lists_them(self):
        for name, _desc, actions, _types in BUILTINS:
            with self.subTest(group=name):
                self.assertEqual(MONEY <= set(actions), name == "Administrator")
                # No other capability verb rides along on a "*" grant.
                self.assertFalse({"reveal", "view_config", "connect", "run", "trust",
                                  "grant_superuser", "subscribe", "set_default"}
                                 & set(actions))


class EngineTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        cls.users = {}
        for name in ("Administrator", "Operator", "Read-only"):
            u = User.objects.create_user(name.lower(), password="x")
            UserProfile.objects.create(user=u).tenants.add(cls.tenant)
            u.groups.add(Group.objects.get(name=name))
            cls.users[name] = u

    def test_administrator_holds_the_money_verbs(self):
        for name, user in self.users.items():
            with self.subTest(group=name):
                want = name == "Administrator"
                self.assertEqual(
                    rbac.has_action(user, self.tenant, "slaagreement", "view_credits"), want)
                self.assertEqual(
                    rbac.has_action(user, self.tenant, "supportcontract", "view_cost"), want)

    def test_administrator_still_lacks_reveal_and_view_config(self):
        admin = self.users["Administrator"]
        self.assertFalse(rbac.has_action(admin, self.tenant, "device", "view_config"))
        self.assertFalse(rbac.has_action(admin, self.tenant, "devicecredential", "reveal"))


class MigrationTests(TestCase):
    def setUp(self):
        ensure_builtin_groups()
        self.admin_group = Group.objects.get(name="Administrator")
        self.operator_group = Group.objects.get(name="Operator")
        # The seeded Administrator grants as 0.17 left them, under both names.
        ObjectPermission.objects.filter(name__in=grant_names("Administrator")).delete()
        self.seeded = []
        for name in grant_names("Administrator"):
            perm = ObjectPermission.objects.create(
                name=name, object_types=["*", "user", "group", "objectpermission"],
                actions=list(CRUD),
            )
            perm.groups.add(self.admin_group)
            self.seeded.append(perm)

    def _actions(self, perm):
        perm.refresh_from_db()
        return list(perm.actions)

    def test_upgrade_adds_the_verbs_to_the_seeded_grant(self):
        _run()
        for perm in self.seeded:
            self.assertEqual(self._actions(perm), [*CRUD, "view_credits", "view_cost"])

    def test_a_second_run_changes_nothing(self):
        _run()
        before = [self._actions(p) for p in self.seeded]
        _run()
        self.assertEqual([self._actions(p) for p in self.seeded], before)

    def test_an_edited_grant_keeps_its_verbs_and_gains_only_the_missing_one(self):
        perm = self.seeded[0]
        perm.actions = ["view", "change", "view_cost"]
        perm.save()
        _run()
        self.assertEqual(self._actions(perm), ["view", "change", "view_cost", "view_credits"])

    def test_operator_read_only_and_copies_are_untouched(self):
        copy = ObjectPermission.objects.create(
            name="Administrator copy", object_types=["*"], actions=list(CRUD))
        copy.groups.add(self.admin_group)
        others = list(ObjectPermission.objects.filter(
            name__in=[*grant_names("Operator"), *grant_names("Read-only")]))
        before = {p.pk: list(p.actions) for p in [copy, *others]}
        _run()
        for perm in [copy, *others]:
            self.assertEqual(self._actions(perm), before[perm.pk], perm.name)

    def test_a_grant_shared_with_another_group_is_left_with_a_note(self):
        perm = self.seeded[0]
        perm.groups.add(self.operator_group)
        out = _run()
        self.assertEqual(self._actions(perm), CRUD)
        self.assertIn(perm.name, out)
        self.assertEqual(self._actions(self.seeded[1]), [*CRUD, "view_credits", "view_cost"])

    def test_a_grant_not_held_by_the_administrator_group_is_untouched(self):
        perm = self.seeded[0]
        perm.groups.clear()
        _run()
        self.assertEqual(self._actions(perm), CRUD)

    def test_ensure_builtin_groups_brings_an_old_grant_up_too(self):
        ensure_builtin_groups()
        for perm in self.seeded:
            self.assertTrue(MONEY <= set(self._actions(perm)))
