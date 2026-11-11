"""Layout presets - shared table layouts as defaults (/api/prefs/presets/).

Covers the order a table's layout is chosen in (own > preset for the user >
preset for a group, by weight > preset for everyone > the tenant default from
before presets > built-in), the old tenant defaults still applying, presets
captured from the creator's own layouts, the reset of personal layouts, the
deployment-admin gate and tenant isolation, and that the per-table read stays
a fixed number of queries however many presets exist.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import LayoutPreset, UserPreference, UserProfile
from core.models import Organization, Tenant

COLS = "/api/prefs/columns/devices/"
PRESETS = "/api/prefs/presets/"


def lay(*order, hidden=(), pinned=()):
    out = {"order": list(order), "hidden": list(hidden)}
    if pinned:
        out["pinned"] = list(pinned)
    return out


class Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("admin", password="x")
        self.noc = Group.objects.create(name="noc")
        self.ops = Group.objects.create(name="ops")
        self.u1 = self._member("u1")
        self.u1.groups.add(self.noc, self.ops)
        self.u2 = self._member("u2")
        self.outsider = self._member("outsider", self.other)

    def _member(self, name, tenant=None):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="reader")
        prof.tenants.add(tenant or self.t)
        return u

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.t).id)
        s.save()

    def _preset(self, name, layouts, *, tenant=None, everyone=False, weight=100,
                users=(), groups=()):
        p = LayoutPreset.objects.create(
            tenant=tenant or self.t, name=name, layouts=layouts,
            everyone=everyone, weight=weight,
        )
        p.users.set(users)
        p.groups.set(groups)
        return p

    def _get(self, user):
        self._login(user)
        r = self.client.get(COLS)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class ResolutionTests(Base):
    def test_built_in_when_nothing_applies(self):
        body = self._get(self.u1)
        self.assertEqual(body["source"], "none")
        self.assertIsNone(body["preset"])

    def test_a_tenant_default_from_before_presets_still_applies(self):
        UserPreference.objects.create(
            user=None, tenant=self.t, table_id="devices", data=lay("name")
        )
        body = self._get(self.u1)
        self.assertEqual((body["source"], body["data"]), ("default", lay("name")))

    def test_order_of_precedence(self):
        UserPreference.objects.create(
            user=None, tenant=self.t, table_id="devices", data=lay("old")
        )
        self._preset("All", {"devices": lay("all")}, everyone=True)
        self.assertEqual(self._get(self.u1)["data"], lay("all"))

        self._preset("Ops", {"devices": lay("ops")}, groups=[self.ops], weight=50)
        self._preset("Noc", {"devices": lay("noc")}, groups=[self.noc], weight=10)
        body = self._get(self.u1)
        self.assertEqual(body["data"], lay("noc"))  # lowest weight
        self.assertEqual(body["preset"]["name"], "Noc")
        # u2 is in neither group: still everyone's.
        self.assertEqual(self._get(self.u2)["data"], lay("all"))

        self._preset("Mine", {"devices": lay("mine")}, users=[self.u1], weight=900)
        self.assertEqual(self._get(self.u1)["data"], lay("mine"))

        UserPreference.objects.create(
            user=self.u1, tenant=self.t, table_id="devices", data=lay("own")
        )
        body = self._get(self.u1)
        self.assertEqual((body["source"], body["data"]), ("user", lay("own")))
        # The menu can still say which preset Reset returns to.
        self.assertEqual(body["preset"]["name"], "Mine")

    def test_ties_break_by_name(self):
        self._preset("Beta", {"devices": lay("b")}, groups=[self.noc])
        self._preset("Alpha", {"devices": lay("a")}, groups=[self.ops])
        self.assertEqual(self._get(self.u1)["preset"]["name"], "Alpha")

    def test_a_forced_tenant_default_still_locks(self):
        self._preset("Mine", {"devices": lay("mine")}, users=[self.u1])
        UserPreference.objects.create(
            user=None, tenant=self.t, table_id="devices", data=lay("locked"),
            forced=True,
        )
        body = self._get(self.u1)
        self.assertEqual((body["source"], body["is_forced"]), ("tenant_forced", True))

    def test_pins_are_carried(self):
        self._preset("P", {"devices": lay("name", pinned=["name"])}, everyone=True)
        self.assertEqual(self._get(self.u1)["data"]["pinned"], ["name"])

    def test_other_tables_and_broken_layouts_are_ignored(self):
        self._preset("Other table", {"prefixes": lay("x")}, everyone=True)
        self.assertEqual(self._get(self.u1)["source"], "none")
        self._preset("Broken", {"devices": "junk"}, users=[self.u1])
        self.assertEqual(self._get(self.u1)["source"], "none")
        self._preset("Odd", {"devices": {"order": ["a", 3], "x": 1}}, users=[self.u2])
        self.assertEqual(self._get(self.u2)["data"], {"order": ["a"], "hidden": []})

    def test_a_preset_never_reaches_another_tenant(self):
        self._preset("Theirs", {"devices": lay("x")}, tenant=self.other,
                     everyone=True)
        self.assertEqual(self._get(self.u1)["source"], "none")
        self._preset("Ours", {"devices": lay("y")}, everyone=True)
        self._login(self.outsider, self.other)
        body = self.client.get(COLS).json()
        self.assertEqual(body["data"], lay("x"))

    def test_the_read_is_a_fixed_number_of_queries(self):
        def count():
            self._login(self.u1)
            with CaptureQueriesContext(connection) as ctx:
                self.client.get(COLS)
            return len(ctx.captured_queries), [
                q["sql"] for q in ctx.captured_queries
                if "auth_api_userpreference" in q["sql"]
                or "auth_api_layoutpreset" in q["sql"]
            ]

        self._preset("A", {"devices": lay("a")}, groups=[self.noc])
        few, layout_sql = count()
        self.assertLessEqual(len(layout_sql), 2)
        for i in range(8):
            g = Group.objects.create(name=f"g{i}")
            self.u1.groups.add(g)
            self._preset(f"P{i}", {"devices": lay(str(i))}, groups=[g])
        many, _ = count()
        self.assertEqual(few, many)


class PresetApiTests(Base):
    def setUp(self):
        super().setUp()
        for tid, data in (
            ("devices", lay("name", "site", pinned=["name"])),
            ("prefixes", lay("prefix", hidden=["vrf"])),
            ("dashboard", {"v": 2, "items": []}),
        ):
            UserPreference.objects.create(
                user=self.admin, tenant=self.t, table_id=tid, data=data
            )

    def test_creates_from_my_layouts(self):
        self._login(self.admin)
        r = self.client.post(PRESETS, {"name": "NOC view"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        p = LayoutPreset.objects.get(pk=r.json()["id"])
        # The dashboard row is not a column layout and stays out.
        self.assertEqual(sorted(p.layouts), ["devices", "prefixes"])
        self.assertEqual(p.layouts["devices"]["pinned"], ["name"])
        self.assertEqual(
            r.json()["tables"]["devices"], {"shown": 2, "hidden": 0, "pinned": 1}
        )
        self.assertEqual(p.tenant, self.t)

    def test_creates_from_chosen_tables_and_edits(self):
        self._login(self.admin)
        r = self.client.post(
            PRESETS,
            {"name": "Just devices", "capture": ["devices"], "everyone": True,
             "group_ids": [self.noc.pk], "user_ids": [self.u2.pk], "weight": 5},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(list(body["tables"]), ["devices"])
        self.assertEqual([g["name"] for g in body["groups"]], ["noc"])
        url = f"{PRESETS}{body['id']}/"
        r = self.client.patch(
            url, {"capture": ["prefixes"], "remove_tables": ["devices"],
                  "name": "Prefixes", "group_ids": []},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(list(r.json()["tables"]), ["prefixes"])
        self.assertEqual(r.json()["groups"], [])
        self.assertTrue(
            ChangeLogEntry.objects.filter(object_id=body["id"]).exists()
        )

    def test_validates(self):
        self._login(self.admin)
        r = self.client.post(PRESETS, {"name": ""}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())
        self.client.post(PRESETS, {"name": "Dup"}, format="json")
        r = self.client.post(PRESETS, {"name": "Dup"}, format="json")
        self.assertEqual(r.status_code, 400)
        for bad in ({"name": "W", "weight": -1}, {"name": "G", "group_ids": [999999]},
                    {"name": "U", "user_ids": ["x"]}):
            with self.subTest(bad=bad):
                self.assertEqual(
                    self.client.post(PRESETS, bad, format="json").status_code, 400
                )

    def test_refuses_users_of_another_tenant(self):
        self._login(self.admin)
        r = self.client.post(
            PRESETS, {"name": "X", "user_ids": [self.outsider.pk]}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("user_ids", r.json())

    def test_another_tenants_preset_is_not_found(self):
        theirs = self._preset("Theirs", {}, tenant=self.other)
        self._login(self.admin)
        for method in ("get", "patch", "delete"):
            r = getattr(self.client, method)(
                f"{PRESETS}{theirs.pk}/", {}, format="json"
            )
            self.assertEqual(r.status_code, 404, method)
        r = self.client.post(f"{PRESETS}{theirs.pk}/reset/", {}, format="json")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.get(PRESETS).json()["results"], [])

    def test_only_deployment_admins(self):
        p = self._preset("P", {"devices": lay("a")})
        self._login(self.u1)
        calls = [
            ("get", PRESETS), ("post", PRESETS),
            ("get", f"{PRESETS}{p.pk}/"), ("patch", f"{PRESETS}{p.pk}/"),
            ("delete", f"{PRESETS}{p.pk}/"), ("post", f"{PRESETS}{p.pk}/reset/"),
        ]
        for method, url in calls:
            with self.subTest(method=method, url=url):
                r = getattr(self.client, method)(url, {"name": "x"}, format="json")
                self.assertEqual(r.status_code, 403)
        self.assertTrue(LayoutPreset.objects.filter(pk=p.pk).exists())
        self.client.logout()
        self.assertNotEqual(self.client.get(PRESETS).status_code, 200)


class ResetTests(Base):
    def setUp(self):
        super().setUp()
        self.p = self._preset(
            "P", {"devices": lay("a"), "prefixes": lay("b")}, groups=[self.noc]
        )
        stranger = self._member("u3")
        for u in (self.u1, self.u2, stranger):
            for tid in ("devices", "prefixes", "vlans"):
                UserPreference.objects.create(
                    user=u, tenant=self.t, table_id=tid, data=lay("own")
                )
        # Same user, other tenant: never touched.
        UserPreference.objects.create(
            user=self.u1, tenant=self.other, table_id="devices", data=lay("own")
        )
        self.url = f"{PRESETS}{self.p.pk}/reset/"

    def test_dry_run_counts_and_changes_nothing(self):
        self._login(self.admin)
        r = self.client.post(self.url, {"dry_run": True}, format="json")
        self.assertEqual(r.json(), {"dry_run": True, "users": 1, "tables": 2,
                                    "layouts": 2})
        self.assertEqual(UserPreference.objects.count(), 10)

    def test_resets_only_assignees_and_the_presets_tables(self):
        self._login(self.admin)
        r = self.client.post(self.url, {}, format="json")
        self.assertEqual(r.json()["layouts"], 2)
        left = set(UserPreference.objects.filter(user=self.u1)
                   .values_list("tenant__slug", "table_id"))
        self.assertEqual(left, {("acme", "vlans"), ("other", "devices")})
        self.assertEqual(UserPreference.objects.filter(user=self.u2).count(), 3)
        entry = ChangeLogEntry.objects.filter(
            object_id=str(self.p.pk), changes__has_key="personal_layouts_reset"
        ).get()
        self.assertEqual(entry.changes["personal_layouts_reset"]["new"]["users"], 1)
        # u1 now gets the preset.
        self.assertEqual(self._get(self.u1)["source"], "preset")

    def test_everyone_resets_every_member(self):
        self.p.everyone = True
        self.p.save()
        self._login(self.admin)
        r = self.client.post(self.url, {"dry_run": True}, format="json")
        self.assertEqual((r.json()["users"], r.json()["layouts"]), (3, 6))
