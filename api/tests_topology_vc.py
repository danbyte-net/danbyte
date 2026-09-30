"""Virtual chassis on the topology map: ``vc`` on the member nodes (gated by
the chassis' own view permission), ``chassis=`` placing a chassis' members on
a hand-picked map as they are now, and ``/api/topology/chassis/`` - the
Diagram palette's list - scoped by both the chassis and the device grants."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    Interface,
    Site,
    VirtualChassis,
)

User = get_user_model()

CHASSIS = "/api/topology/chassis/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="dc-a")
        self.site_b = Site.objects.create(tenant=self.tenant, name="dc-b")
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack-01")
        self.m1 = self._dev("acc-1", self.site_a, vc=self.vc, pos=1)
        self.m2 = self._dev("acc-2", self.site_a, vc=self.vc, pos=2)
        self.m3 = self._dev("acc-3", self.site_b, vc=self.vc, pos=3)
        self.vc.master = self.m1
        self.vc.save()
        self.core = self._dev("core-1", self.site_a)
        for i, m in enumerate((self.m1, self.m2, self.m3)):
            self._cable(m, "uplink", self.core, f"eth{i}")

    def _dev(self, name, site, vc=None, pos=None, tenant=None):
        return Device.objects.create(
            tenant=tenant or self.tenant, name=name, site=site,
            virtual_chassis=vc, vc_position=pos,
        )

    def _cable(self, a, pa, b, pb):
        ia = Interface.objects.create(device=a, name=pa)
        ib = Interface.objects.create(device=b, name=pb)
        cab = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cab, end="A", interface=ia)
        CableTermination.objects.create(cable=cab, end="B", interface=ib)

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _admin(self):
        self._login(User.objects.create_superuser("admin", "a@example.com", "x"))

    def _member(self, *grants):
        """A user holding ``grants``: (object types, sites or None)."""
        user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for i, (types, sites) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"g{i}", object_types=list(types), actions=["view"]
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            for s in sites or ():
                perm.sites.add(s)
        self._login(user)
        return user

    def _nodes(self, **body):
        r = self.client.post("/api/topology/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return {n["data"]["name"]: n["data"] for n in r.json()["nodes"]}


class ChassisOnNodesTests(_Base):
    def test_members_carry_their_chassis(self):
        self._admin()
        nodes = self._nodes()
        self.assertEqual(
            nodes["acc-1"]["vc"],
            {"id": str(self.vc.id), "name": "stack-01", "position": 1,
             "master": True},
        )
        self.assertEqual(nodes["acc-2"]["vc"]["position"], 2)
        self.assertFalse(nodes["acc-2"]["vc"]["master"])
        self.assertNotIn("vc", nodes["core-1"])

    def test_no_chassis_view_strips_it(self):
        self._member((["device"], None))
        nodes = self._nodes()
        self.assertIn("acc-1", nodes)
        for data in nodes.values():
            self.assertNotIn("vc", data)

    def test_a_scoped_chassis_grant_shows_only_its_chassis(self):
        other = VirtualChassis.objects.create(tenant=self.tenant, name="stack-02")
        self._dev("acc-9", self.site_a, vc=other, pos=1)
        self._cable(Device.objects.get(name="acc-9"), "up", self.core, "eth9")
        user = self._member((["device"], None))
        perm = ObjectPermission.objects.create(
            name="vc", object_types=["virtualchassis"], actions=["view"],
            constraints={"name": "stack-01"},
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        nodes = self._nodes()
        self.assertEqual(nodes["acc-1"]["vc"]["name"], "stack-01")
        self.assertNotIn("vc", nodes["acc-9"])

    def test_the_query_count_does_not_grow_with_the_map(self):
        self._admin()

        def count():
            with CaptureQueriesContext(connection) as ctx:
                self._nodes()
            return len(ctx.captured_queries)

        small = count()
        more = VirtualChassis.objects.create(tenant=self.tenant, name="stack-03")
        for i in range(6):
            d = self._dev(f"x{i}", self.site_a, vc=more, pos=i + 1)
            self._cable(d, "up", self.core, f"p{i}")
        self.assertEqual(count(), small)


class PlacedChassisTests(_Base):
    def test_a_placed_chassis_brings_its_members(self):
        self._admin()
        nodes = self._nodes(devices=[str(self.core.id)], chassis=[str(self.vc.id)])
        self.assertEqual(set(nodes), {"core-1", "acc-1", "acc-2", "acc-3"})
        get = self.client.get(
            f"/api/topology/?devices={self.core.id}&chassis={self.vc.id}"
        )
        self.assertEqual(len(get.json()["nodes"]), 4)

    def test_membership_is_read_live(self):
        self._admin()
        body = {"devices": [], "chassis": [str(self.vc.id)]}
        self.assertEqual(set(self._nodes(**body)), {"acc-1", "acc-2", "acc-3"})
        self.m3.virtual_chassis = None
        self.m3.vc_position = None
        self.m3.save()
        new = self._dev("acc-4", self.site_a, vc=self.vc, pos=4)
        self.assertEqual(set(self._nodes(**body)), {"acc-1", "acc-2", new.name})

    def test_members_outside_the_device_scope_stay_off(self):
        self._member((["device"], [self.site_a]), (["virtualchassis"], None))
        nodes = self._nodes(devices=[], chassis=[str(self.vc.id)])
        self.assertEqual(set(nodes), {"acc-1", "acc-2"})

    def test_no_chassis_view_places_nothing(self):
        self._member((["device"], None))
        self.assertEqual(self._nodes(devices=[], chassis=[str(self.vc.id)]), {})

    def test_another_tenants_or_unknown_chassis_is_ignored(self):
        org = Organization.objects.create(name="Other", slug="other")
        t2 = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = VirtualChassis.objects.create(tenant=t2, name="theirs")
        self._dev("their-1", None, vc=theirs, pos=1, tenant=t2)
        self._admin()
        nodes = self._nodes(
            devices=[],
            chassis=[str(theirs.id), "5d93e7b1-0c4a-4f28-b6d5-9a1e3c7f2d03"],
        )
        self.assertEqual(nodes, {})

    def test_malformed_and_too_many_ids_are_a_400(self):
        self._admin()
        r = self.client.get("/api/topology/?devices=&chassis=nope")
        self.assertEqual(r.status_code, 400)
        self.assertIn("chassis", r.json()["detail"])
        many = [f"00000000-0000-4000-8000-{i:012d}" for i in range(1001)]
        r = self.client.post(
            "/api/topology/", {"devices": [], "chassis": many}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_chassis_needs_a_hand_picked_map(self):
        self._admin()
        nodes = self._nodes(chassis=[str(self.vc.id)])
        # A filtered map is every device, placed or not.
        self.assertIn("core-1", nodes)


class ChassisListTests(_Base):
    def test_lists_chassis_with_members_in_order(self):
        self.m1.vc_position = None
        self.m1.save()
        VirtualChassis.objects.create(tenant=self.tenant, name="empty")
        self._admin()
        r = self.client.get(CHASSIS)
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertEqual([c["name"] for c in rows], ["stack-01"])
        self.assertEqual(
            [m["name"] for m in rows[0]["members"]], ["acc-2", "acc-3", "acc-1"]
        )
        self.assertEqual(rows[0]["master_id"], str(self.m1.id))

    def test_searches_by_name(self):
        VirtualChassis.objects.create(tenant=self.tenant, name="core-vc")
        self._dev("c-1", self.site_a, vc=VirtualChassis.objects.get(name="core-vc"))
        self._admin()
        rows = self.client.get(CHASSIS + "?q=core").json()["results"]
        self.assertEqual([c["name"] for c in rows], ["core-vc"])

    def test_members_follow_the_device_scope(self):
        self._member((["device"], [self.site_b]), (["virtualchassis"], None))
        rows = self.client.get(CHASSIS).json()["results"]
        self.assertEqual([m["name"] for m in rows[0]["members"]], ["acc-3"])
        # The master is out of scope: its id is not given away.
        self.assertIsNone(rows[0]["master_id"])

    def test_needs_both_grants(self):
        self._member((["device"], None))
        self.assertEqual(self.client.get(CHASSIS).status_code, 403)
        self.client.logout()
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="vc-only", object_types=["virtualchassis"], actions=["view"]
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self._login(user)
        self.assertEqual(self.client.get(CHASSIS).status_code, 403)

    def test_another_tenants_chassis_never_shows(self):
        org = Organization.objects.create(name="Other", slug="other")
        t2 = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = VirtualChassis.objects.create(tenant=t2, name="theirs")
        self._dev("their-1", None, vc=theirs, pos=1, tenant=t2)
        self._admin()
        rows = self.client.get(CHASSIS).json()["results"]
        self.assertEqual([c["name"] for c in rows], ["stack-01"])

    def test_anonymous_refused(self):
        self.assertIn(self.client.get(CHASSIS).status_code, (401, 403))

    def test_query_count_is_flat(self):
        self._admin()

        def count():
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(CHASSIS)
            self.assertEqual(r.status_code, 200)
            return len(ctx.captured_queries)

        small = count()
        for n in range(5):
            vc = VirtualChassis.objects.create(tenant=self.tenant, name=f"s{n}")
            for i in range(3):
                self._dev(f"s{n}-{i}", self.site_a, vc=vc, pos=i + 1)
        self.assertEqual(count(), small)
