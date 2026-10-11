"""A bulk-delete preview counts the cables the delete removes (#391).

Since #378 a cable goes once one of its ends has no port left, together with
the terminations on its other end. The preview's ``impact`` has to say so:
for each case the dry run's counts must equal what the real delete removes.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.bulk_delete import plural_label
from api.models import (
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    Device,
    DeviceType,
    Interface,
    PowerFeed,
    PowerPanel,
    PowerPort,
    Provider,
    Site,
)
from core.models import Organization, Tenant

CABLES = plural_label(Cable)
TERMS = plural_label(CableTermination)


class PreviewMatchesDeleteTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.client.force_login(User.objects.create_superuser("root", "r@a.c", "pw"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site, name="MDB")
        self.f1 = PowerFeed.objects.create(tenant=self.tenant, power_panel=self.panel, name="A")
        self.f2 = PowerFeed.objects.create(tenant=self.tenant, power_panel=self.panel, name="B")
        dt = DeviceType.objects.create(tenant=self.tenant, name="pdu")
        self.pdu = Device.objects.create(tenant=self.tenant, name="pdu-1", device_type=dt,
                                         site=self.site)
        self.inlet = PowerPort.objects.create(device=self.pdu, name="PSU1")
        self.inlet2 = PowerPort.objects.create(device=self.pdu, name="PSU2")

    def cable(self, a, b, label="C"):
        cable = Cable.objects.create(tenant=self.tenant, label=label)
        for end, objs in (("A", a), ("B", b)):
            for field, obj in objs:
                CableTermination.objects.create(cable=cable, end=end, **{field: obj})
        return cable

    def run_both(self, endpoint, ids, **extra):
        """The dry run's impact, then what the real delete removed."""
        body = {"ids": [str(i) for i in ids], **extra}
        r = self.client.post(f"{endpoint}bulk-delete/", {**body, "dry_run": True},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        preview = r.json()
        impact = {i["label"]: i["count"] for i in preview["impact"]}
        before = (Cable.objects.count(), CableTermination.objects.count())
        r = self.client.post(f"{endpoint}bulk-delete/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], preview["deleted"])
        removed = {
            CABLES: before[0] - Cable.objects.count(),
            TERMS: before[1] - CableTermination.objects.count(),
        }
        return preview, {k: impact.get(k, 0) for k in removed}, removed

    def test_cabled_feed_counts_the_cable_and_its_far_end(self):
        self.cable([("power_feed", self.f1)], [("power_port", self.inlet)])
        preview, counted, removed = self.run_both("/api/power-feeds/", [self.f1.id])
        self.assertEqual(removed, {CABLES: 1, TERMS: 2})
        self.assertEqual(counted, removed)
        self.assertEqual([(n["name"], n["label"]) for n in preview["notes"]],
                         [("A", "Cable removed")])
        self.assertIn("pdu-1 PSU1", preview["notes"][0]["detail"])

    def test_breakout_leg_keeps_the_cable(self):
        self.cable([("power_feed", self.f1), ("power_feed", self.f2)],
                   [("power_port", self.inlet)])
        preview, counted, removed = self.run_both("/api/power-feeds/", [self.f1.id])
        self.assertEqual(removed, {CABLES: 0, TERMS: 1})
        self.assertEqual(counted, removed)
        self.assertEqual([(n["name"], n["label"]) for n in preview["notes"]],
                         [("A", "Cable kept")])
        self.assertTrue(Cable.objects.exists())

    def test_every_leg_of_an_end_takes_the_cable(self):
        self.cable([("power_feed", self.f1), ("power_feed", self.f2)],
                   [("power_port", self.inlet)])
        preview, counted, removed = self.run_both("/api/power-feeds/",
                                                  [self.f1.id, self.f2.id])
        self.assertEqual(removed, {CABLES: 1, TERMS: 3})
        self.assertEqual(counted, removed)
        self.assertEqual({n["label"] for n in preview["notes"]}, {"Cable removed"})

    def test_panel_with_feeds(self):
        self.cable([("power_feed", self.f1)], [("power_port", self.inlet)], "P-1")
        self.cable([("power_feed", self.f2)], [("power_port", self.inlet2)], "P-2")
        preview, counted, removed = self.run_both("/api/power-panels/", [self.panel.id],
                                                  with_feeds=True)
        self.assertEqual(removed, {CABLES: 2, TERMS: 4})
        self.assertEqual(counted, removed)
        self.assertEqual(len(preview["notes"]), 2)

    def test_circuit_with_a_cabled_termination(self):
        sw = Device.objects.create(tenant=self.tenant, name="sw1",
                                   device_type=self.pdu.device_type, site=self.site)
        port = Interface.objects.create(device=sw, name="Et1")
        prov = Provider.objects.create(tenant=self.tenant, name="Telco", slug="telco")
        circuit = Circuit.objects.create(tenant=self.tenant, cid="C-1", provider=prov)
        term = CircuitTermination.objects.create(circuit=circuit, term_side="A",
                                                 site=self.site)
        self.cable([("circuit_termination", term)], [("interface", port)])
        _, counted, removed = self.run_both("/api/circuits/", [circuit.id])
        self.assertEqual(removed, {CABLES: 1, TERMS: 2})
        self.assertEqual(counted, removed)

    def test_uncabled_feed_counts_no_cable(self):
        self.cable([("power_feed", self.f1)], [("power_port", self.inlet)])
        preview, counted, removed = self.run_both("/api/power-feeds/", [self.f2.id])
        self.assertEqual(removed, {CABLES: 0, TERMS: 0})
        self.assertEqual(counted, removed)
        self.assertEqual(preview["notes"], [])
