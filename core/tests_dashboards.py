"""Named dashboards: visibility, ownership, duplicate, home, and validation."""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Dashboard, Organization, Tenant

URL = "/api/dashboards/"


class DashboardTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.alice = self.member("alice")
        self.bob = self.member("bob")
        self.login(self.alice)

    def member(self, name):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        return u

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def create(self, **kw):
        r = self.client.post(URL, {"name": "NOC", **kw}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def names(self):
        return [d["name"] for d in self.client.get(URL).json()["results"]]

    def test_private_by_default_and_owner_only_edits(self):
        d = self.create()
        self.assertTrue(d["mine"])
        self.login(self.bob)
        self.assertEqual(self.names(), [])
        self.login(self.alice)
        self.client.patch(f"{URL}{d['id']}/", {"visibility": "tenant"}, format="json")
        self.login(self.bob)
        self.assertEqual(self.names(), ["NOC"])
        r = self.client.patch(f"{URL}{d['id']}/", {"name": "Mine now"}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.delete(f"{URL}{d['id']}/").status_code, 403)

    def test_shared_with_a_group(self):
        noc = Group.objects.create(name="noc")
        self.alice.groups.add(noc)
        self.create(visibility="groups", groups=[noc.id])
        self.login(self.bob)
        self.assertEqual(self.names(), [])
        self.bob.groups.add(noc)
        self.assertEqual(self.names(), ["NOC"])

    def test_cannot_share_with_a_group_you_are_not_in(self):
        other = Group.objects.create(name="finance")
        r = self.client.post(URL, {"name": "X", "visibility": "groups", "groups": [other.id]},
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_duplicate_gives_a_private_copy(self):
        d = self.create(visibility="tenant", scope={"tag": ["core"]})
        self.login(self.bob)
        r = self.client.post(f"{URL}{d['id']}/duplicate/")
        self.assertEqual(r.status_code, 201)
        copy = r.json()
        self.assertEqual(copy["name"], "NOC (copy)")
        self.assertTrue(copy["mine"])
        self.assertEqual(copy["visibility"], "private")
        self.assertEqual(copy["scope"], {"tag": ["core"]})

    def test_home_pick(self):
        d = self.create()
        self.assertEqual(self.client.get(f"{URL}home/").json(), {"id": None})
        self.client.put(f"{URL}home/", {"id": d["id"]}, format="json")
        self.assertEqual(self.client.get(f"{URL}home/").json(), {"id": d["id"]})
        # Someone else's private board can't be picked.
        self.login(self.bob)
        r = self.client.put(f"{URL}home/", {"id": d["id"]}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_validation(self):
        for bad in (
            {"layout": {"v": 1}},
            {"scope": {"planet": ["x"]}},
            {"scope": {"site": ["not-an-id"]}},
            {"refresh_seconds": 7},
            {"name": "  "},
        ):
            r = self.client.post(URL, {"name": "X", **bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)

    def test_other_tenants_boards_stay_out(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        Dashboard.objects.create(tenant=other, owner=self.bob, name="Theirs", visibility="tenant")
        self.assertEqual(self.names(), [])

    def test_members_see_their_own_groups(self):
        mine = Group.objects.create(name="noc")
        Group.objects.create(name="finance")
        self.alice.groups.add(mine)
        r = self.client.get(f"{URL}share-groups/")
        self.assertEqual([g["name"] for g in r.json()], ["noc"])
