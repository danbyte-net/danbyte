"""The EVPN/VXLAN overlay on top of L2VPN: a VRF makes an EVPN overlay an
L3VNI, a VNI is claimed once, a VTEP per device carries the VNIs it serves,
and the leaf's render resolves each VNI to its VLAN.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    L2VPN,
    VLAN,
    VRF,
    Device,
    DeviceType,
    Interface,
    IPAddress,
    L2VPNTermination,
    Manufacturer,
    Prefix,
    Site,
)
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

from .models import VTEP
from .render import routing_context

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        seed_builtin_statuses(self.tenant)
        self.dc1 = Site.objects.create(tenant=self.tenant, name="DC1")
        self.dc2 = Site.objects.create(tenant=self.tenant, name="DC2")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.leaf = Device.objects.create(tenant=self.tenant, name="leaf1", device_type=dt, site=self.dc1)
        self.other = Device.objects.create(tenant=self.tenant, name="leaf9", device_type=dt, site=self.dc2)
        self.lo = Interface.objects.create(device=self.leaf, name="lo0")
        net = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.lo_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.11", prefix=net,
            assigned_device=self.leaf, assigned_interface=self.lo,
        )
        self.vrf = VRF.objects.create(tenant=self.tenant, name="TENANT-A", rd="65001:5000")
        self.vlan_dc1 = VLAN.objects.create(tenant=self.tenant, site=self.dc1, vlan_id=100, name="servers")
        self.vlan_dc2 = VLAN.objects.create(tenant=self.tenant, site=self.dc2, vlan_id=100, name="servers")
        self.l2 = L2VPN.objects.create(tenant=self.tenant, name="SERVERS", slug="servers",
                                       type="vxlan-evpn", identifier=10100)
        L2VPNTermination.objects.create(l2vpn=self.l2, vlan=self.vlan_dc1)
        L2VPNTermination.objects.create(l2vpn=self.l2, vlan=self.vlan_dc2)
        self.l3 = L2VPN.objects.create(tenant=self.tenant, name="TENANT-A-L3", slug="tenant-a-l3",
                                       type="vxlan-evpn", identifier=5000, vrf=self.vrf)
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, url, body):
        return self.client.post(url, body, format="json")


class L2VPNTests(_Base):
    def test_a_vrf_only_on_an_evpn_overlay_and_vnis_are_unique(self):
        r = self._post("/api/l2vpns/", {
            "name": "x", "slug": "x", "type": "vpls", "vrf_id": str(self.vrf.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("vrf_id", r.json())
        r = self._post("/api/l2vpns/", {
            "name": "dup", "slug": "dup", "type": "vxlan", "identifier": 10100,
        })
        self.assertEqual(r.status_code, 409)
        r = self._post("/api/l2vpns/", {
            "name": "vc", "slug": "vc", "type": "vpws", "identifier": 10100,
        })
        self.assertEqual(r.status_code, 201, r.content)
        body = self.client.get(f"/api/l2vpns/{self.l3.id}/").json()
        self.assertEqual(body["vrf"]["name"], "TENANT-A")
        self.assertEqual(body["vtep_count"], 0)
        names = [
            s["name"] for s in self.client.get(
                "/api/statuses/?available_to=l2vpn&picker=1"
            ).json()["results"]
        ]
        self.assertEqual(sorted(names), ["Active", "Disabled", "Planned"])


class VTEPTests(_Base):
    def test_one_per_device_with_its_vnis(self):
        r = self._post("/api/routing/vteps/", {
            "device_id": str(self.leaf.id), "source_interface_id": str(self.lo.id),
            "source_ip_id": str(self.lo_ip.id), "anycast_gateway_mac": "00:00:5E:00:01:01",
        })
        self.assertEqual(r.status_code, 201, r.content)
        vtep = r.json()
        self.assertEqual(vtep["anycast_gateway_mac"], "00:00:5e:00:01:01")
        r = self._post("/api/routing/vteps/", {"device_id": str(self.leaf.id)})
        self.assertEqual(r.status_code, 409)
        r = self._post("/api/routing/vtep-memberships/", {
            "vtep_id": vtep["id"], "l2vpn_id": str(self.l2.id),
        })
        self.assertEqual(r.status_code, 201, r.content)
        # Resolved to the site's VLAN without a device-side choice.
        self.assertEqual(r.json()["resolved_vlan"]["vlan_id"], 100)
        self.assertEqual(r.json()["resolved_vlan"]["id"], str(self.vlan_dc1.id))
        r = self._post("/api/routing/vtep-memberships/", {
            "vtep_id": vtep["id"], "l2vpn_id": str(self.l3.id), "mcast_group": "239.1.1.1",
            "ingress_replication": False,
        })
        self.assertEqual(r.status_code, 201, r.content)
        r = self._post("/api/routing/vtep-memberships/", {
            "vtep_id": vtep["id"], "l2vpn_id": str(self.l2.id),
        })
        self.assertEqual(r.status_code, 409)
        vpls = L2VPN.objects.create(tenant=self.tenant, name="v", slug="v", type="vpls")
        r = self._post("/api/routing/vtep-memberships/", {
            "vtep_id": vtep["id"], "l2vpn_id": str(vpls.id),
        })
        self.assertEqual(r.status_code, 400)
        body = self.client.get(f"/api/routing/vteps/{vtep['id']}/").json()
        self.assertEqual([m["l2vpn"]["identifier"] for m in body["memberships"]], [5000, 10100])
        l2 = self.client.get(f"/api/l2vpns/{self.l2.id}/").json()
        self.assertEqual(l2["vtep_count"], 1)
        self.assertEqual(
            self.client.get(f"/api/routing/vteps/?l2vpn={self.l2.id}").json()["count"], 1
        )
        self.assertEqual(
            self.client.get("/api/l2vpns/?vxlan=1").json()["count"], 2
        )

    def test_source_interface_must_be_on_the_device(self):
        far = Interface.objects.create(device=self.other, name="lo0")
        r = self._post("/api/routing/vteps/", {
            "device_id": str(self.leaf.id), "source_interface_id": str(far.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("source_interface", r.json())


class RenderTests(_Base):
    def test_vtep_block_and_l3vni_on_the_vrf(self):
        vtep = VTEP.objects.create(
            tenant=self.tenant, device=self.leaf, source_interface=self.lo, source_ip=self.lo_ip,
            anycast_gateway_mac="00:00:5e:00:01:01",
        )
        vtep.memberships.create(l2vpn=self.l2)
        vtep.memberships.create(l2vpn=self.l3, rd="10.0.0.11:5000")
        ctx = routing_context(self.leaf)
        v = ctx["vtep"]
        self.assertEqual(v["source_interface"], "lo0")
        self.assertEqual(v["source_ip"], "10.0.0.11")
        self.assertEqual([(x["vni"], x["kind"]) for x in v["vnis"]], [(10100, "l2"), (5000, "l3")])
        self.assertEqual(v["vnis"][0]["vlan"], 100)
        self.assertEqual(v["vnis"][1]["vrf"], "TENANT-A")
        self.assertEqual(v["vnis"][1]["rd"], "10.0.0.11:5000")
        self.assertEqual([(r["name"], r["l3vni"]) for r in ctx["vrfs"]], [("TENANT-A", 5000)])
        # A leaf with no VTEP has none.
        self.assertIsNone(routing_context(self.other)["vtep"])

    def test_anycast_gateway_reaches_the_interface_loop(self):
        from api.models import FHRPGroup, FHRPGroupAssignment

        svi = Interface.objects.create(device=self.leaf, name="Vlan100", type="virtual", vrf=self.vrf)
        net = Prefix.objects.create(tenant=self.tenant, cidr="10.100.0.0/24", vrf=self.vrf)
        vip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.100.0.1", prefix=net, vrf=self.vrf)
        group = FHRPGroup.objects.create(
            tenant=self.tenant, name="anycast-100", protocol="anycast", group_id=100, virtual_ip=vip,
        )
        FHRPGroupAssignment.objects.create(fhrp_group=group, interface=svi, priority=100)
        row = routing_context(self.leaf)["by_interface"]["Vlan100"]
        self.assertEqual(row["gateway"], "10.100.0.1/24")
        self.assertEqual(row["vrf"], "TENANT-A")
        self.assertEqual(row["fhrp"][0]["protocol"], "anycast")
        self.assertEqual(row["fhrp"][0]["group_id"], 100)
        self.assertIsNone(routing_context(self.leaf)["by_interface"]["lo0"]["gateway"])
