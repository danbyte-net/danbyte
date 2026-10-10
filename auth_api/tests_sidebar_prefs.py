"""Personal sidebar layout (#285) - storage, validation, tenant default.

The layout lives in the ``sidebar`` user preference (auth_api.user_prefs), so
it follows the user across browsers and cascades user → tenant → none like
every other preference. Only ids are stored (hidden, section order, entry
order), never a snapshot of the menu, so pages added later still appear.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from auth_api.sidebar_prefs import clean_layout
from auth_api.user_prefs import get as get_pref
from core.models import Organization, Tenant

LAYOUT = {
    "v": 1,
    "order": ["dcim", "ipam"],
    "hidden": ["power", "/vlans"],
    "items": {"ipam": ["/ips", "/prefixes"]},
}


class CleanLayoutTests(APITestCase):
    def test_round_trips_a_valid_layout(self):
        self.assertEqual(clean_layout(LAYOUT), LAYOUT)

    def test_missing_lists_default_to_empty(self):
        self.assertEqual(
            clean_layout({"v": 1}),
            {"v": 1, "order": [], "hidden": [], "items": {}},
        )

    def test_drops_unknown_keys_and_duplicate_ids(self):
        out = clean_layout({
            "v": 1, "hidden": ["power", "power"], "snapshot": [{"x": 1}],
        })
        self.assertEqual(out["hidden"], ["power"])
        self.assertNotIn("snapshot", out)

    def test_rejects_malformed_layouts(self):
        bad = [
            None,
            [],
            {"order": []},                         # no version
            {"v": 2},                              # unknown version
            {"v": 1, "order": "ipam"},             # not a list
            {"v": 1, "hidden": [1, 2]},            # not strings
            {"v": 1, "hidden": [""]},              # empty id
            {"v": 1, "hidden": ["x" * 201]},       # id too long
            {"v": 1, "hidden": [f"i{n}" for n in range(501)]},  # too many
            {"v": 1, "items": ["ipam"]},           # not an object
            {"v": 1, "items": {"ipam": "/ips"}},   # entry order not a list
        ]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError):
                clean_layout(value)


class SidebarPrefEndpointTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.t).id)
        s.save()

    def _member(self, name, *tenants):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="reader")
        prof.tenants.add(*(tenants or [self.t]))
        return u

    def _tenant_admin(self, name):
        u = self._member(name)
        perm = ObjectPermission.objects.create(
            name=f"tadmin-{name}", object_types=["user"], actions=["change"]
        )
        perm.users.add(u)
        perm.tenants.add(self.t)
        return u

    # ─── personal layout via /api/me/prefs/ ──────────────────────────────

    def test_no_layout_by_default(self):
        self._login(self._member("m"))
        r = self.client.get("/api/me/prefs/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["values"]["sidebar"])

    def test_saves_and_returns_the_layout(self):
        user = self._member("m")
        self._login(user)
        r = self.client.put("/api/me/prefs/", {"sidebar": LAYOUT}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["values"]["sidebar"], LAYOUT)
        self.assertIn("sidebar", r.json()["user_set"])
        user.profile.refresh_from_db()
        self.assertEqual(user.profile.prefs["sidebar"], LAYOUT)

    def test_layout_follows_the_user_across_tenants(self):
        user = self._member("m", self.t, self.other)
        self._login(user)
        self.client.put("/api/me/prefs/", {"sidebar": LAYOUT}, format="json")
        self._login(user, self.other)
        r = self.client.get("/api/me/prefs/")
        self.assertEqual(r.json()["values"]["sidebar"], LAYOUT)

    def test_stores_the_cleaned_layout(self):
        user = self._member("m")
        self._login(user)
        r = self.client.put(
            "/api/me/prefs/",
            {"sidebar": {"v": 1, "hidden": ["vpn", "vpn"], "extra": True}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        user.profile.refresh_from_db()
        self.assertEqual(
            user.profile.prefs["sidebar"],
            {"v": 1, "order": [], "hidden": ["vpn"], "items": {}},
        )

    def test_rejects_a_malformed_layout(self):
        user = self._member("m")
        self._login(user)
        r = self.client.put(
            "/api/me/prefs/", {"sidebar": {"v": 1, "hidden": "vpn"}}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        user.profile.refresh_from_db()
        self.assertNotIn("sidebar", user.profile.prefs or {})

    def test_reset_falls_back_to_the_tenant_default(self):
        from auth_api.user_prefs import set_tenant

        tenant_layout = {"v": 1, "order": [], "hidden": ["wireless"], "items": {}}
        set_tenant(self.t, "sidebar", tenant_layout)
        user = self._member("m")
        self._login(user)
        self.client.put("/api/me/prefs/", {"sidebar": LAYOUT}, format="json")
        r = self.client.put("/api/me/prefs/", {"sidebar": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["values"]["sidebar"], tenant_layout)
        self.assertNotIn("sidebar", r.json()["user_set"])

    def test_hiding_does_not_touch_permissions(self):
        # Hidden is a menu convenience: the user's grants are unchanged.
        from auth_api.rbac import effective_actions

        user = self._member("m")
        before = effective_actions(user, self.t)
        self._login(user)
        self.client.put(
            "/api/me/prefs/",
            {"sidebar": {"v": 1, "hidden": ["ipam", "/prefixes"]}},
            format="json",
        )
        self.assertEqual(effective_actions(user, self.t), before)

    # ─── tenant default (admin) ──────────────────────────────────────────

    def test_admin_publishes_and_clears_the_tenant_default(self):
        admin = self._tenant_admin("a")
        self._login(admin)
        r = self.client.put("/api/prefs/sidebar/default/", LAYOUT, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.t.refresh_from_db()
        self.assertEqual(self.t.prefs["sidebar"], LAYOUT)

        r = self.client.get("/api/prefs/sidebar/default/")
        self.assertEqual(r.json()["data"], LAYOUT)

        # A member with no layout of their own inherits it.
        member = self._member("m")
        self.assertEqual(get_pref(member, "sidebar", tenant=self.t), LAYOUT)
        self.assertIsNone(get_pref(member, "sidebar", tenant=self.other))

        r = self.client.delete("/api/prefs/sidebar/default/")
        self.assertEqual(r.status_code, 200, r.content)
        self.t.refresh_from_db()
        self.assertNotIn("sidebar", self.t.prefs or {})

    def test_own_layout_wins_over_the_tenant_default(self):
        from auth_api.user_prefs import set_tenant, set_user

        set_tenant(self.t, "sidebar", {"v": 1, "order": [], "hidden": ["vpn"], "items": {}})
        member = self._member("m")
        set_user(member, "sidebar", LAYOUT)
        self.assertEqual(get_pref(member, "sidebar", tenant=self.t), LAYOUT)

    def test_tenant_default_needs_admin(self):
        self._login(self._member("m"))
        for method in ("get", "put", "delete"):
            with self.subTest(method=method):
                r = getattr(self.client, method)(
                    "/api/prefs/sidebar/default/", LAYOUT, format="json"
                )
                self.assertEqual(r.status_code, 403)
        self.t.refresh_from_db()
        self.assertNotIn("sidebar", self.t.prefs or {})

    def test_tenant_default_needs_sign_in(self):
        r = self.client.put("/api/prefs/sidebar/default/", LAYOUT, format="json")
        self.assertIn(r.status_code, (302, 401, 403))

    def test_tenant_default_rejects_a_malformed_layout(self):
        self._login(self._tenant_admin("a"))
        r = self.client.put(
            "/api/prefs/sidebar/default/", {"v": 1, "order": [1]}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.t.refresh_from_db()
        self.assertNotIn("sidebar", self.t.prefs or {})

    def test_admin_of_one_tenant_writes_only_the_active_tenant(self):
        admin = self._tenant_admin("a")
        self._login(admin)
        self.client.put("/api/prefs/sidebar/default/", LAYOUT, format="json")
        self.other.refresh_from_db()
        self.assertNotIn("sidebar", self.other.prefs or {})
