"""The tenant-member picker endpoints (/api/people/).

They exist so features that name people - notification subscriptions, script
sharing, a site editor's viewer invite, user/group custom fields - work for
accounts that do not administer users. Pinned here: who may list, and that the
list never leaves the active tenant or hands out addresses.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
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

    def test_superuser_list_is_also_tenant_bound(self):
        self._as(self.root)
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
