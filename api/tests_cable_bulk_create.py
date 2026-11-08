"""Many cables in one request (#454): ``POST /api/cables/bulk-create/``.

Each item is validated like a single create, a port named twice in one batch
is refused, any error writes nothing, and ports outside the active tenant are
refused per item.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    FrontPort,
    Interface,
    RearPort,
    Site,
)

URL = "/api/cables/bulk-create/"


def pair(a, b, kind_a="interface", kind_b="interface", **extra):
    return {
        "a": [{"kind": kind_a, "id": str(a.id)}],
        "b": [{"kind": kind_b, "id": str(b.id)}],
        **extra,
    }


class _Case(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.sw = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=self.site
        )
        self.pp = Device.objects.create(
            tenant=self.tenant, name="pp1", device_type=dt, site=self.site
        )
        self.gi = [
            Interface.objects.create(device=self.sw, name=f"Gi1/0/{n}") for n in range(1, 5)
        ]
        self.fp = [
            FrontPort.objects.create(
                device=self.pp, name=f"Front {n}", type="8p8c",
                rear_port=RearPort.objects.create(device=self.pp, name=f"Rear {n}"),
            )
            for n in range(1, 5)
        ]

        other_org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        osite = Site.objects.create(tenant=self.other, name="far")
        odt = DeviceType.objects.create(tenant=self.other, name="sw")
        odev = Device.objects.create(tenant=self.other, name="osw", device_type=odt, site=osite)
        self.foreign = Interface.objects.create(device=odev, name="Gi9")

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def admin(self):
        self.login(get_user_model().objects.create_superuser("root", "r@a.c", "pw"))

    def member(self, name, actions):
        user = get_user_model().objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=name, object_types=["cable", "device", "interface", "frontport"],
            actions=list(actions),
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)

    def post(self, cables):
        return self.client.post(URL, {"cables": cables}, format="json")


class BulkCreateTests(_Case):
    def setUp(self):
        super().setUp()
        self.admin()

    def test_creates_every_pair_in_order(self):
        r = self.post([
            pair(self.gi[i], self.fp[i], kind_b="front_port", type="cat6", color="0000ff")
            for i in range(3)
        ])
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["created"], 3)
        self.assertEqual(
            [c["a_terminations"][0]["name"] for c in body["results"]],
            ["Gi1/0/1", "Gi1/0/2", "Gi1/0/3"],
        )
        self.assertEqual(
            [c["b_terminations"][0]["name"] for c in body["results"]],
            ["Front 1", "Front 2", "Front 3"],
        )
        self.assertEqual(Cable.objects.filter(tenant=self.tenant).count(), 3)
        self.assertTrue(all(c["type"] == "cat6" for c in body["results"]))

    def test_one_bad_pair_writes_nothing(self):
        Cable.objects.create(tenant=self.tenant)  # unrelated, stays
        taken = self.post([pair(self.gi[3], self.fp[3], kind_b="front_port")])
        self.assertEqual(taken.status_code, 201, taken.content)
        before = Cable.objects.count()
        r = self.post([
            pair(self.gi[0], self.fp[0], kind_b="front_port"),
            pair(self.gi[1], self.fp[3], kind_b="front_port"),  # already cabled
        ])
        self.assertEqual(r.status_code, 400, r.content)
        errors = r.json()["cables"]
        self.assertEqual(errors[0], {})
        self.assertIn("already cabled", errors[1]["b"][0])
        self.assertEqual(Cable.objects.count(), before)
        self.assertFalse(CableTermination.objects.filter(interface=self.gi[0]).exists())

    def test_same_port_twice_in_a_batch_refused(self):
        r = self.post([
            pair(self.gi[0], self.fp[0], kind_b="front_port"),
            pair(self.gi[0], self.fp[1], kind_b="front_port"),
        ])
        self.assertEqual(r.status_code, 400, r.content)
        errors = r.json()["cables"]
        self.assertEqual(errors[0], {})
        self.assertIn("already in cable 1", errors[1]["a"][0])
        self.assertEqual(Cable.objects.count(), 0)

    def test_each_pair_validated_like_single_create(self):
        r = self.post([
            pair(self.gi[0], self.gi[1]),
            {"a": [{"kind": "interface", "id": str(self.gi[2].id)}], "b": []},
        ])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["cables"][1], {"a": ["Both ends need at least one port."]})
        self.assertEqual(Cable.objects.count(), 0)

    def test_foreign_tenant_port_refused(self):
        r = self.post([
            pair(self.gi[0], self.gi[1]),
            pair(self.gi[2], self.foreign),
        ])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(
            r.json()["cables"][1], {"b": ["Pick a port in the current tenant."]}
        )
        self.assertEqual(Cable.objects.count(), 0)

    def test_empty_and_oversized_bodies_refused(self):
        self.assertEqual(self.post([]).status_code, 400)
        self.assertEqual(
            self.client.post(URL, {"cables": "x"}, format="json").status_code, 400
        )
        too_many = [pair(self.gi[0], self.gi[1])] * 257
        r = self.post(too_many)
        self.assertEqual(r.status_code, 400)
        self.assertIn("max 256", str(r.json()["cables"]))
        self.assertEqual(Cable.objects.count(), 0)


class BulkCreatePermissionTests(_Case):
    def test_change_alone_cannot_bulk_create(self):
        self.member("editor", ["view", "change"])
        r = self.post([pair(self.gi[0], self.gi[1])])
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(Cable.objects.count(), 0)

    def test_add_may_bulk_create(self):
        self.member("adder", ["view", "add"])
        r = self.post([pair(self.gi[0], self.gi[1]), pair(self.gi[2], self.gi[3])])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Cable.objects.filter(tenant=self.tenant).count(), 2)

    def test_site_scoped_adder_cannot_reach_another_site(self):
        far = Site.objects.create(tenant=self.tenant, name="dc2")
        dt = DeviceType.objects.create(tenant=self.tenant, name="far-sw")
        far_dev = Device.objects.create(tenant=self.tenant, name="sw9", device_type=dt, site=far)
        far_if = Interface.objects.create(device=far_dev, name="Gi1")
        self.member("local", ["view", "add"])
        ObjectPermission.objects.get(name="local").sites.add(self.site)
        r = self.post([pair(self.gi[0], self.gi[1]), pair(self.gi[2], far_if)])
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(Cable.objects.count(), 0)
