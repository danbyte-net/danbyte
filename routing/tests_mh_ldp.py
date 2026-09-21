"""EVPN multihoming (Ethernet segments, the uplink flag) and MPLS LDP: the
models, their API, and what the render context says about them."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import ASN, VRF, Device, DeviceType, Interface, Manufacturer, Site
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

from .models import BGPInstance, EthernetSegment, LDPInstance
from .render import routing_context

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other_tenant = Tenant.objects.create(org=org, name="Other", slug="other")
        seed_builtin_statuses(self.tenant)
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.leaf1 = Device.objects.create(tenant=self.tenant, name="leaf1", device_type=dt, site=site)
        self.leaf2 = Device.objects.create(tenant=self.tenant, name="leaf2", device_type=dt, site=site)
        self.pe = Device.objects.create(tenant=self.tenant, name="pe1", device_type=dt, site=site)
        self.bond1 = Interface.objects.create(device=self.leaf1, name="bond1")
        self.bond1b = Interface.objects.create(device=self.leaf2, name="bond1")
        self.swp1 = Interface.objects.create(device=self.leaf1, name="swp1", evpn_mh_uplink=True)
        self.swp2 = Interface.objects.create(device=self.leaf1, name="swp2")
        self.gi1 = Interface.objects.create(device=self.pe, name="gi1")
        self.gi2 = Interface.objects.create(device=self.pe, name="gi2")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, url, body):
        return self.client.post(url, body, format="json")


class EthernetSegmentTests(_Base):
    def test_a_segment_spans_two_leaves_and_reaches_both_contexts(self):
        r = self._post("/api/routing/ethernet-segments/", {
            "name": "srv-w01", "es_id": 1, "sys_mac": "44-38-39-FF-00-01",
            "df_preference": 50000,
            "interface_ids": [str(self.bond1.id), str(self.bond1b.id)],
        })
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["sys_mac"], "44:38:39:ff:00:01")  # normalised
        self.assertEqual(body["device_count"], 2)

        for leaf in (self.leaf1, self.leaf2):
            ctx = routing_context(leaf)
            self.assertEqual(ctx["es_count"], 1)
            es = ctx["by_interface"]["bond1"]["es"]
            self.assertEqual(es["es_id"], 1)
            self.assertEqual(es["sys_mac"], "44:38:39:ff:00:01")
            self.assertEqual(es["df_preference"], 50000)
            # The other leaf is named, so a template can say who the peer is.
            self.assertEqual(
                [m["device"] for m in es["members"]], ["leaf1", "leaf2"]
            )
        ctx = routing_context(self.leaf1)
        self.assertIsNone(ctx["by_interface"]["swp1"]["es"])
        self.assertTrue(ctx["by_interface"]["swp1"]["evpn_mh_uplink"])
        self.assertFalse(ctx["by_interface"]["swp2"]["evpn_mh_uplink"])
        self.assertEqual([s["name"] for s in ctx["ethernet_segments"]], ["srv-w01"])

    def test_a_device_with_no_segment_has_none(self):
        ctx = routing_context(self.pe)
        self.assertEqual(ctx["es_count"], 0)
        self.assertEqual(ctx["ethernet_segments"], [])

    def test_identity_is_one_form_or_the_other(self):
        r = self._post("/api/routing/ethernet-segments/", {"name": "x"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("es_id", r.json())
        r = self._post("/api/routing/ethernet-segments/", {
            "name": "x", "esi": "00:11:22:33:44:55:66:77:88:99",
            "es_id": 1, "sys_mac": "44:38:39:ff:00:01",
        })
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("esi", r.json())
        r = self._post("/api/routing/ethernet-segments/", {
            "name": "typed0", "esi": "00:11:22:33:44:55:66:77:88:99",
        })
        self.assertEqual(r.status_code, 201, r.content)
        r = self._post("/api/routing/ethernet-segments/", {
            "name": "bad", "esi": "not-an-esi",
        })
        self.assertEqual(r.status_code, 400)

    def test_another_tenants_interface_cannot_join(self):
        foreign_site = Site.objects.create(tenant=self.other_tenant, name="X")
        foreign = Device.objects.create(
            tenant=self.other_tenant, name="f", site=foreign_site,
            device_type=self.leaf1.device_type,
        )
        fi = Interface.objects.create(device=foreign, name="bond1")
        r = self._post("/api/routing/ethernet-segments/", {
            "name": "x", "es_id": 2, "sys_mac": "44:38:39:ff:00:02",
            "interface_ids": [str(fi.id)],
        })
        self.assertEqual(r.status_code, 400, r.content)

    def test_filters_by_device_and_interface(self):
        seg = EthernetSegment.objects.create(
            tenant=self.tenant, name="s", es_id=3, sys_mac="44:38:39:ff:00:03"
        )
        seg.interfaces.set([self.bond1])
        r = self.client.get(f"/api/routing/ethernet-segments/?device={self.leaf1.id}")
        self.assertEqual([x["name"] for x in r.json()["results"]], ["s"])
        r = self.client.get(f"/api/routing/ethernet-segments/?device={self.leaf2.id}")
        self.assertEqual(r.json()["results"], [])
        r = self.client.get(f"/api/routing/ethernet-segments/?interface={self.bond1.id}")
        self.assertEqual(len(r.json()["results"]), 1)


class LDPTests(_Base):
    def test_ldp_reaches_the_context_with_its_interfaces(self):
        r = self._post("/api/routing/ldp-instances/", {
            "device_id": str(self.pe.id), "router_id": "10.51.255.1",
            "interface_ids": [str(self.gi1.id), str(self.gi2.id)],
        })
        self.assertEqual(r.status_code, 201, r.content)

        ldp = routing_context(self.pe)["ldp"]

        self.assertEqual(ldp["router_id"], "10.51.255.1")
        # Blank transport address falls back to the router id.
        self.assertEqual(ldp["transport_address"], "10.51.255.1")
        self.assertEqual(ldp["label_allocation"], "host-routes")
        self.assertEqual(ldp["interfaces"], ["gi1", "gi2"])
        self.assertIsNone(routing_context(self.leaf1)["ldp"])

    def test_one_per_device_and_ports_must_be_its_own(self):
        LDPInstance.objects.create(tenant=self.tenant, device=self.pe)
        r = self._post("/api/routing/ldp-instances/", {"device_id": str(self.pe.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("already runs LDP", str(r.json()["device_id"]))
        r = self._post("/api/routing/ldp-instances/", {
            "device_id": str(self.leaf1.id), "interface_ids": [str(self.gi1.id)],
        })
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("interface_ids", r.json())

    def test_vpn_flags_on_a_vrf_bgp_instance_reach_the_context(self):
        vrf = VRF.objects.create(tenant=self.tenant, name="CUST-A", rd="65000:100")
        asn = ASN.objects.create(tenant=self.tenant, asn=65000)
        BGPInstance.objects.create(
            tenant=self.tenant, device=self.pe, vrf=vrf, asn=asn,
            vpn_export=True, vpn_import=True, vpn_label_export="auto",
            vpn_nexthop_export="10.51.255.1",
        )
        BGPInstance.objects.create(tenant=self.tenant, device=self.pe, asn=asn)

        by_vrf = {b["vrf"]: b for b in routing_context(self.pe)["bgp"]}

        self.assertEqual(
            by_vrf["CUST-A"]["vpn"],
            {"export": True, "import": True, "label_export": "auto",
             "nexthop_export": "10.51.255.1"},
        )
        self.assertIsNone(by_vrf[None]["vpn"])

    def test_a_label_is_auto_or_a_number(self):
        asn = ASN.objects.create(tenant=self.tenant, asn=65000)
        r = self._post("/api/routing/bgp-instances/", {
            "device_id": str(self.pe.id), "asn_id": str(asn.id),
            "vpn_label_export": "sometimes",
        })
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("vpn_label_export", r.json())
