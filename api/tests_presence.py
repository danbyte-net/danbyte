"""Collaborative presence - heartbeat/list endpoints over the Redis store."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APIClient, APITestCase

from api.models import VLAN, Device, Site
from auth_api.models import ObjectPermission, UserProfile
from core import presence
from core.models import Organization, Tenant


class PresenceTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.alice = self._user("alice", "Alice Adams")
        self.bob = self._user("bob", "Bob Brown")
        self.ca = self._client(self.alice)
        self.cb = self._client(self.bob)
        self.device = Device.objects.create(tenant=self.tenant, name="sw-01")
        self.ot, self.oid = "device", str(self.device.id)

    def tearDown(self):
        # Real Redis is shared with dev - drop this object's key so we don't leak.
        presence.leave(self.tenant.id, self.ot, self.oid, user_id=self.alice.id)
        presence.leave(self.tenant.id, self.ot, self.oid, user_id=self.bob.id)

    def _user(self, username, full):
        first, last = full.split(" ", 1)
        u = User.objects.create_user(username, password="x", is_superuser=True,
                                     first_name=first, last_name=last)
        prof = UserProfile.objects.create(user=u)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        return u

    def _client(self, user):
        c = APIClient()
        c.force_login(user)
        c.post(f"/api/tenants/{self.tenant.id}/switch/")
        return c

    def _beat(self, client, mode="viewing"):
        return client.post(
            "/api/presence/heartbeat/",
            {"object_type": self.ot, "object_id": self.oid, "mode": mode},
            format="json",
        )

    def test_alone_sees_nobody(self):
        res = self._beat(self.ca)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["present"], [])

    def test_sees_other_user(self):
        self._beat(self.ca, mode="viewing")
        res = self._beat(self.cb, mode="editing")
        present = res.json()["present"]
        self.assertEqual(len(present), 1)
        self.assertEqual(present[0]["name"], "Alice Adams")
        self.assertEqual(present[0]["mode"], "viewing")
        # And Alice now sees Bob editing.
        a = self._beat(self.ca).json()["present"]
        self.assertEqual(a[0]["name"], "Bob Brown")
        self.assertEqual(a[0]["mode"], "editing")

    def test_editing_sorts_first(self):
        self._beat(self.ca, mode="viewing")
        self._beat(self.cb, mode="editing")
        # A third viewer sees Bob (editing) ahead of Alice (viewing).
        carol = self._user("carol", "Carol Cox")
        cc = self._client(carol)
        present = self._beat(cc).json()["present"]
        self.assertEqual([p["mode"] for p in present], ["editing", "viewing"])
        presence.leave(self.tenant.id, self.ot, self.oid, user_id=carol.id)

    def test_invalid_mode_falls_back_to_viewing(self):
        res = self._beat(self.ca, mode="bogus")
        self.assertEqual(res.status_code, 200)
        # Bob reads Alice's mode - coerced to viewing.
        self.assertEqual(self._beat(self.cb).json()["present"][0]["mode"], "viewing")

    def test_missing_args_400(self):
        res = self.ca.post("/api/presence/heartbeat/", {"mode": "viewing"},
                           format="json")
        self.assertEqual(res.status_code, 400)

    def test_leave_removes_presence(self):
        self._beat(self.ca)
        self._beat(self.cb)
        self.assertEqual(len(self._beat(self.cb).json()["present"]), 1)
        self.ca.post(
            "/api/presence/leave/",
            {"object_type": self.ot, "object_id": self.oid},
            format="json",
        )
        self.assertEqual(self._beat(self.cb).json()["present"], [])

    def test_list_does_not_announce_self(self):
        # GET /presence/ must not register the caller as present.
        self.ca.get(
            f"/api/presence/?object_type={self.ot}&object_id={self.oid}"
        )
        self.assertEqual(self._beat(self.cb).json()["present"], [])


class PresencePermissionGateTests(APITestCase):
    """Presence carries colleagues' display names + activity, so a member with
    no ``view`` on the object type must not be able to harvest it."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        # Owner is present on both a device and a vlan.
        self.owner = self._user("owner", superuser=True)
        # Member may view VLANs but NOT devices (custom role, one grant).
        self.member = self._user("member", superuser=False)
        perm = ObjectPermission.objects.create(
            name="vlan view", object_types=["vlan"], actions=["view"],
        )
        perm.users.add(self.member)
        self.co = self._client(self.owner)
        self.cm = self._client(self.member)
        self.ids = {
            "device": str(Device.objects.create(tenant=self.tenant, name="d").id),
            "vlan": str(VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="v").id),
        }

    def tearDown(self):
        for ot, oid in self.ids.items():
            presence.leave(self.tenant.id, ot, oid, user_id=self.owner.id)
            presence.leave(self.tenant.id, ot, oid, user_id=self.member.id)

    def _user(self, username, superuser):
        u = User.objects.create_user(
            username, password="x", is_superuser=superuser, first_name=username
        )
        prof = UserProfile.objects.create(
            user=u, role="admin" if superuser else "custom"
        )
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        return u

    def _client(self, user):
        c = APIClient()
        c.force_login(user)
        c.post(f"/api/tenants/{self.tenant.id}/switch/")
        return c

    def _beat(self, client, ot, oid=None):
        return client.post(
            "/api/presence/heartbeat/",
            {"object_type": ot, "object_id": oid or self.ids[ot], "mode": "viewing"},
            format="json",
        )

    def test_member_without_view_sees_empty_and_is_not_registered(self):
        self._beat(self.co, "device")  # owner present on the device
        # Member lacks device.view → gated: empty list returned...
        self.assertEqual(self._beat(self.cm, "device").json()["present"], [])
        # ...and the gated member was never registered, so the owner is alone.
        self.assertEqual(self._beat(self.co, "device").json()["present"], [])

    def test_member_without_view_gated_on_list_endpoint(self):
        self._beat(self.co, "device")
        res = self.cm.get(
            f"/api/presence/?object_type=device&object_id={self.ids['device']}"
        )
        self.assertEqual(res.json()["present"], [])

    def test_member_with_view_sees_presence(self):
        self._beat(self.co, "vlan")  # owner present on a vlan
        present = self._beat(self.cm, "vlan").json()["present"]
        self.assertEqual(len(present), 1)
        self.assertEqual(present[0]["name"], "owner")

    # ─── the object itself (#323) ───────────────────────────────────────
    def _seed(self, ot, oid):
        """Someone already present on ``oid`` (written straight to the store,
        past the gate) so a refused caller has something to leak."""
        presence.heartbeat(self.tenant.id, ot, oid, user_id=self.member.id,
                           name="Seeded", mode="editing")
        self.addCleanup(presence.leave, self.tenant.id, ot, oid, user_id=self.member.id)
        self.addCleanup(presence.leave, self.tenant.id, ot, oid, user_id=self.owner.id)

    def test_object_in_another_tenant_is_gated(self):
        """Even a superuser only sees presence on objects of the active
        tenant; a foreign id is refused and the caller is not registered."""
        other = Tenant.objects.create(org=self.tenant.org, name="T2", slug="t2")
        foreign = str(VLAN.objects.create(tenant=other, vlan_id=20, name="x").id)
        self._seed("vlan", foreign)
        self.assertEqual(self._beat(self.co, "vlan", foreign).json()["present"], [])
        res = self.co.get(f"/api/presence/?object_type=vlan&object_id={foreign}")
        self.assertEqual(res.json()["present"], [])
        names = [p["name"] for p in presence.present(self.tenant.id, "vlan", foreign)]
        self.assertEqual(names, ["Seeded"])  # the owner was never announced

    def test_unknown_or_malformed_id_is_gated(self):
        for oid in ("33333333-3333-3333-3333-333333333333", "not-a-uuid"):
            self._seed("vlan", oid)
            self.assertEqual(self._beat(self.co, "vlan", oid).json()["present"], [])
            res = self.co.get(f"/api/presence/?object_type=vlan&object_id={oid}")
            self.assertEqual(res.json()["present"], [])

    def test_site_scoped_grant_only_opens_its_own_sites(self):
        """A view grant scoped to one site opens presence there, not on a
        same-type object at another site."""
        from auth_api.models import ObjectPermission

        mine = Site.objects.create(tenant=self.tenant, name="AMS")
        theirs = Site.objects.create(tenant=self.tenant, name="CPH")
        scoped = self._user("scoped", superuser=False)
        perm = ObjectPermission.objects.create(
            name="vlan view ams", object_types=["vlan"], actions=["view"],
        )
        perm.users.add(scoped)
        perm.sites.add(mine)
        cs = self._client(scoped)
        here = str(VLAN.objects.create(tenant=self.tenant, vlan_id=30, name="a", site=mine).id)
        there = str(VLAN.objects.create(tenant=self.tenant, vlan_id=31, name="c", site=theirs).id)
        try:
            self._beat(self.co, "vlan", here)
            self._beat(self.co, "vlan", there)
            self.assertEqual(len(self._beat(cs, "vlan", here).json()["present"]), 1)
            self.assertEqual(self._beat(cs, "vlan", there).json()["present"], [])
        finally:
            for oid in (here, there):
                for u in (self.owner, scoped):
                    presence.leave(self.tenant.id, "vlan", oid, user_id=u.id)
