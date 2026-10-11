"""A cable's ends swapped, or ports moved from one end to the other, in one
PATCH (#392): the old terminations of every end being written go before the
new ones are made, so a port changing ends does not meet its own old row,
and the cable is never deleted part way as a cable left with an empty end."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
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


class CableSwapTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = get_user_model().objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        site = Site.objects.create(tenant=self.tenant, name="dc1")
        dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.sw1 = Device.objects.create(tenant=self.tenant, name="sw1", device_type=dt,
                                         site=site)
        self.sw2 = Device.objects.create(tenant=self.tenant, name="sw2", device_type=dt,
                                         site=site)
        self.i = [Interface.objects.create(device=self.sw1, name=f"Gi{n}") for n in range(1, 6)]

    def post(self, a, b):
        r = self.client.post("/api/cables/", {"type": "cat6", **self.ends(a, b)},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["id"]

    @staticmethod
    def ends(a, b):
        def pts(items):
            return [{"kind": k, "id": str(o.id)} for k, o in items]
        return {"a": pts(a), "b": pts(b)}

    def stored(self, cid):
        out = {"A": set(), "B": set()}
        for t in CableTermination.objects.filter(cable_id=cid):
            out[t.end].add(t.point.pk)
        return out

    def iface(self, *n):
        return [("interface", self.i[k]) for k in n]

    def test_swapping_both_ends(self):
        cid = self.post(self.iface(0), self.iface(1))
        r = self.client.patch(f"/api/cables/{cid}/", self.ends(self.iface(1), self.iface(0)),
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["a_terminations"][0]["id"], str(self.i[1].id))
        self.assertEqual(r.json()["b_terminations"][0]["id"], str(self.i[0].id))
        self.assertEqual(self.stored(cid), {"A": {self.i[1].pk}, "B": {self.i[0].pk}})

    def test_one_port_moves_from_b_to_a(self):
        cid = self.post(self.iface(0), self.iface(1, 2))
        r = self.client.patch(f"/api/cables/{cid}/", self.ends(self.iface(0, 2), self.iface(1)),
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.stored(cid), {"A": {self.i[0].pk, self.i[2].pk},
                                            "B": {self.i[1].pk}})

    def test_swapping_a_breakout(self):
        cid = self.post(self.iface(0), self.iface(1, 2, 3, 4))
        r = self.client.patch(f"/api/cables/{cid}/",
                              self.ends(self.iface(1, 2, 3, 4), self.iface(0)), format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["a_terminations"]), 4)
        self.assertEqual(self.stored(cid), {"A": {self.i[k].pk for k in (1, 2, 3, 4)},
                                            "B": {self.i[0].pk}})

    def test_swapping_patch_panel_ports(self):
        rp = RearPort.objects.create(device=self.sw2, name="R1", positions=1)
        fp = FrontPort.objects.create(device=self.sw2, name="F1", rear_port=rp)
        cid = self.post([("front_port", fp)], [("rear_port", rp)])
        r = self.client.patch(f"/api/cables/{cid}/",
                              self.ends([("rear_port", rp)], [("front_port", fp)]),
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.stored(cid), {"A": {rp.pk}, "B": {fp.pk}})

    def test_the_swap_never_logs_the_cable_as_deleted(self):
        cid = self.post(self.iface(0), self.iface(1))
        r = self.client.patch(f"/api/cables/{cid}/", {
            "label": "swapped", **self.ends(self.iface(1), self.iface(0)),
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(Cable.objects.filter(pk=cid).exists())
        logs = ChangeLogEntry.objects.filter(object_id=str(cid))
        self.assertFalse(logs.filter(action="delete").exists())
        self.assertEqual(logs.filter(action="update").count(), 1)

    def test_a_port_on_both_ends_still_refused(self):
        cid = self.post(self.iface(0), self.iface(1))
        r = self.client.patch(f"/api/cables/{cid}/", self.ends(self.iface(0), self.iface(0)),
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.stored(cid), {"A": {self.i[0].pk}, "B": {self.i[1].pk}})
