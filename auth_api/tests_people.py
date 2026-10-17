"""The tenant-member picker endpoints (/api/people/).

They exist so features that name people - notification subscriptions, script
sharing, a site editor's viewer invite, user/group custom fields - work for
accounts that do not administer users. Pinned here: who may list, and that the
list never leaves the active tenant or hands out addresses.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Site
from auth_api.builtin_groups import ensure_builtin_groups
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant
from customization.models import CustomField


class PeopleApiTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        cls.other = Tenant.objects.create(org=org, name="Other", slug="other")
        cls.ams = Site.objects.create(tenant=cls.tenant, name="AMS")

        cls.operator = cls._member("op", "Operator")
        cls.reader = cls._member("ro", "Read-only")
        cls.walled = cls._member("walled")
        cls.noc = cls._member("noc", email="noc@example.com")
        cls._grant(cls.noc, ["task"], ["view", "add", "change"])
        cls.stranger = cls._member("stranger", tenant=cls.other)
        cls.gone = cls._member("gone")
        cls.gone.is_active = False
        cls.gone.save(update_fields=["is_active"])

        from auth_api.site_paths import SITE_PATHS

        cls.editor = cls._member("editor")
        edit = cls._grant(
            cls.editor, sorted(set(SITE_PATHS) - {"site"}),
            ["view", "add", "change", "delete"],
        )
        edit.sites.set([cls.ams])

        cls.root = User.objects.create_superuser("root", "root@example.com", "x")
        UserProfile.objects.create(user=cls.root).tenants.add(cls.tenant)

        cls.ours = Group.objects.create(name="noc-team")
        cls.noc.groups.add(cls.ours)
        cls.theirs = Group.objects.create(name="their-team")
        cls.stranger.groups.add(cls.theirs)

    @classmethod
    def _member(cls, name, group=None, tenant=None, email=""):
        user = User.objects.create_user(name, email, "x")
        UserProfile.objects.create(user=user).tenants.add(tenant or cls.tenant)
        if group:
            user.groups.add(Group.objects.get(name=group))
        return user

    @classmethod
    def _grant(cls, user, types, actions):
        perm = ObjectPermission.objects.create(
            name=f"{user.username}-{'-'.join(types)[:40]}",
            object_types=list(types), actions=list(actions),
        )
        perm.users.add(user)
        return perm

    def _as(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _delegation(self, on: bool):
        ds = DeploymentSettings.load()
        ds.allow_site_editor_delegation = on
        ds.save()

    def _names(self, url="/api/people/"):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return {row.get("username") or row.get("name") for row in r.json()["results"]}

    # ── who may list ────────────────────────────────────────────────────────
    def test_operator_and_task_editor_may_list(self):
        for user in (self.operator, self.noc):
            with self.subTest(user=user.username):
                self._as(user)
                self.assertEqual(self.client.get("/api/people/").status_code, 200)
                self.assertEqual(
                    self.client.get("/api/people/groups/").status_code, 200
                )

    def test_read_only_and_walled_members_may_not(self):
        self._delegation(False)
        for user in (self.reader, self.walled):
            with self.subTest(user=user.username):
                self._as(user)
                self.assertEqual(self.client.get("/api/people/").status_code, 403)
                self.assertEqual(
                    self.client.get("/api/people/groups/").status_code, 403
                )

    def test_superuser_may_list(self):
        self._as(self.root)
        self.assertEqual(self.client.get("/api/people/").status_code, 200)

    def test_site_editor_follows_the_delegation_switch(self):
        self._as(self.editor)
        self._delegation(False)
        self.assertEqual(self.client.get("/api/people/").status_code, 403)
        self._delegation(True)
        self.assertEqual(self.client.get("/api/people/").status_code, 200)
        # The invite flow never takes a group, so delegation lists no groups.
        self.assertEqual(self.client.get("/api/people/groups/").status_code, 403)

    def test_user_custom_field_on_an_editable_type_opens_its_picker(self):
        device_editor = self._member("dev-editor")
        self._grant(device_editor, ["device"], ["view", "change"])
        owner = CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", type="object",
            related_model="user", applies_to=["device"],
        )
        on_prefix = CustomField.objects.create(
            tenant=self.tenant, key="steward", label="Steward", type="object",
            related_model="user", applies_to=["prefix"],
        )
        self._as(device_editor)
        self.assertEqual(self.client.get("/api/people/").status_code, 403)
        ok = self.client.get(f"/api/people/?custom_field={owner.id}")
        self.assertEqual(ok.status_code, 200, ok.content)
        # A field on a type the caller can't edit, a user field asked for
        # groups, and a malformed id all stay closed.
        for url in (
            f"/api/people/?custom_field={on_prefix.id}",
            f"/api/people/groups/?custom_field={owner.id}",
            "/api/people/?custom_field=not-a-uuid",
        ):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 403)

    # ── what is listed ──────────────────────────────────────────────────────
    def test_lists_active_members_of_the_active_tenant_only(self):
        self._as(self.noc)
        names = self._names()
        self.assertIn("noc", names)
        self.assertIn("op", names)
        self.assertNotIn("stranger", names)
        self.assertNotIn("gone", names)

    def test_members_follow_tenant_access_not_only_the_profile(self):
        # A superuser, the legacy admin role and a grant scoped to the tenant
        # (held directly or through a group) reach it without it being on the
        # profile - user_tenants() lets them in, so the pickers offer them.
        User.objects.create_superuser("su", "", "x")
        legacy = User.objects.create_user("legacy", "", "x")
        UserProfile.objects.create(user=legacy, role="admin")
        direct = User.objects.create_user("granted", "", "x")
        UserProfile.objects.create(user=direct)
        via_group = User.objects.create_user("via-group", "", "x")
        UserProfile.objects.create(user=via_group)
        elsewhere = User.objects.create_user("elsewhere", "", "x")
        UserProfile.objects.create(user=elsewhere)
        team = Group.objects.create(name="t-team")
        via_group.groups.add(team)
        here = ObjectPermission.objects.create(
            name="here", object_types=["device"], actions=["view"],
        )
        here.tenants.add(self.tenant)
        here.users.add(direct)
        here.groups.add(team)
        there = ObjectPermission.objects.create(
            name="there", object_types=["device"], actions=["view"],
        )
        there.tenants.add(self.other)
        there.users.add(elsewhere)

        self._as(self.noc)
        names = self._names()
        for name in ("su", "legacy", "granted", "via-group"):
            with self.subTest(name=name):
                self.assertIn(name, names)
        self.assertNotIn("elsewhere", names)
        self.assertNotIn("stranger", names)
        self.assertIn("t-team", self._names("/api/people/groups/"))

    def test_superusers_and_deployment_admins_see_every_account(self):
        # As the task board's assignee picker does: they work across tenants.
        boss = self._member("boss", "Administrator")
        for user in (self.root, boss):
            with self.subTest(user=user.username):
                self._as(user)
                names = self._names()
                self.assertIn("stranger", names)
                self.assertNotIn("gone", names)
                self.assertIn("their-team", self._names("/api/people/groups/"))
        # Operators stay tenant-bound.
        self._as(self.operator)
        self.assertNotIn("stranger", self._names())

    def test_email_needs_a_grant_on_users(self):
        self._as(self.noc)
        rows = self.client.get("/api/people/").json()["results"]
        mine = next(r for r in rows if r["username"] == "noc")
        self.assertIsNone(mine["email"])
        self.assertTrue(mine["has_email"])
        # Searching on an address the caller can't read finds nothing.
        self.assertEqual(self._names("/api/people/?search=example.com"), set())
        self._as(self.root)
        rows = self.client.get("/api/people/").json()["results"]
        self.assertEqual(
            next(r for r in rows if r["username"] == "noc")["email"],
            "noc@example.com",
        )

    def test_search_and_detail(self):
        self._as(self.noc)
        self.assertEqual(self._names("/api/people/?search=edit"), {"editor"})
        self.assertEqual(
            self.client.get(f"/api/people/{self.operator.id}/").json()["username"],
            "op",
        )
        self.assertEqual(
            self.client.get(f"/api/people/{self.stranger.id}/").status_code, 404
        )
        self.assertEqual(self.client.get(f"/api/people/{self.gone.id}/").status_code, 404)

    def test_groups_are_those_with_members_here(self):
        self._as(self.noc)
        names = self._names("/api/people/groups/")
        self.assertIn("noc-team", names)
        self.assertIn("Operator", names)
        self.assertNotIn("their-team", names)
        self.assertEqual(
            self.client.get(f"/api/people/groups/{self.theirs.id}/").status_code, 404
        )
        row = self.client.get(f"/api/people/groups/{self.ours.id}/").json()
        self.assertEqual(row, {"id": self.ours.id, "name": "noc-team"})

    def test_no_active_tenant_is_refused(self):
        lonely = User.objects.create_user("lonely", "", "x")
        UserProfile.objects.create(user=lonely)
        self._grant(lonely, ["task"], ["add"])
        self.client.force_login(lonely)
        self.assertEqual(self.client.get("/api/people/").status_code, 403)


class ReferenceLabelFallbackTests(APITestCase):
    """User and group custom-field values still read as names for accounts
    with no grant on users - but only the tenant's own people."""

    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        cls.viewer = User.objects.create_user("viewer", "", "x")
        UserProfile.objects.create(user=cls.viewer).tenants.add(cls.tenant)
        perm = ObjectPermission.objects.create(
            name="devices", object_types=["device"], actions=["view"],
        )
        perm.users.add(cls.viewer)
        cls.mate = User.objects.create_user("mate", "", "x")
        UserProfile.objects.create(user=cls.mate).tenants.add(cls.tenant)
        cls.foreign = User.objects.create_user("foreign", "", "x")
        UserProfile.objects.create(user=cls.foreign).tenants.add(other)
        cls.team = Group.objects.create(name="team")
        cls.mate.groups.add(cls.team)
        cls.far = Group.objects.create(name="far")
        cls.foreign.groups.add(cls.far)

    def _labels(self, model, ids):
        self.client.force_login(self.viewer)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        r = self.client.get(
            "/api/customization/object-labels/",
            {"model": model, "ids": ",".join(str(i) for i in ids)},
        )
        self.assertEqual(r.status_code, 200, r.content)
        return {row["label"] for row in r.json()["results"]}

    def test_user_labels_cover_tenant_members_only(self):
        self.assertEqual(self._labels("user", [self.mate.id, self.foreign.id]), {"mate"})

    def test_group_labels_cover_groups_with_members_here(self):
        self.assertEqual(self._labels("group", [self.team.id, self.far.id]), {"team"})

    def test_other_models_still_need_their_grant(self):
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.assertEqual(self._labels("site", [site.id]), set())


class ImportPeopleTests(TestCase):
    """An import cell naming a person or a group resolves against the
    tenant's people for an account with no grant on users or groups, so an
    Operator can re-import its own export."""

    def test_operator_round_trips_a_task_that_names_people(self):
        from api.io import io_for
        from planning.models import Board, Task, seed_default_statuses

        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        op = User.objects.create_user("op", "", "x")
        UserProfile.objects.create(user=op).tenants.add(tenant)
        op.groups.add(Group.objects.get(name="Operator"))
        stranger = User.objects.create_user("stranger", "", "x")
        UserProfile.objects.create(user=stranger).tenants.add(other)
        team = Group.objects.create(name="noc")
        op.groups.add(team)

        board = Board.objects.create(tenant=tenant, name="Ops", slug="ops")
        seed_default_statuses(board)
        task = Task.objects.create(
            tenant=tenant, board=board, status=board.statuses.get(name="To do"),
            title="Swap PSU", created_by=op, assigned_group=team,
        )
        handler = io_for("task")
        row = handler.to_row(task)
        self.assertEqual(row["created_by"], str(op.pk))
        handler.apply(task, row, tenant, op)

        # created_by is read-only in the API, so export-only in a file (#364).
        obj, _action, changes, _tags = handler.apply(
            task, {**row, "created_by": str(stranger.pk)}, tenant, op)
        self.assertEqual((obj.created_by_id, changes), (op.pk, {}))

        # A group outside the tenant still does not resolve.
        from django.core.exceptions import ValidationError

        theirs = Group.objects.create(name="theirs")
        stranger.groups.add(theirs)
        with self.assertRaises(ValidationError):
            handler.apply(task, {**row, "assigned_group": str(theirs.pk)}, tenant, op)
