"""A ``vxlan`` interface type and the VTEP membership's optional link to
it: the netdev a VNI rides on can be an interface row, while the VNI itself
stays on the L2VPN."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import L2VPN, Device, DeviceType, Interface, Manufacturer, Site
from core.models import Organization, Tenant

from .models import VTEP, VTEPMembership
from .render import routing_context

User = get_user_model()


class VxlanInterfaceTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.leaf = Device.objects.create(tenant=self.tenant, name="leaf1", device_type=dt,
                                          site=site)
        self.other = Device.objects.create(tenant=self.tenant, name="leaf2", device_type=dt,
                                           site=site)
        self.vtep = VTEP.objects.create(tenant=self.tenant, device=self.leaf)
        self.l2 = L2VPN.objects.create(tenant=self.tenant, name="v100", slug="v100",
                                       type="vxlan-evpn", identifier=10100)
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_a_vxlan_interface_is_virtual(self):
        r = self.client.post("/api/interfaces/", {
            "device_id": str(self.leaf.id), "name": "vxlan10100", "type": "vxlan",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["virtual"])
        self.assertEqual(r.json()["type_display"], "VXLAN")

    def test_the_membership_names_its_netdev(self):
        nd = Interface.objects.create(device=self.leaf, name="vxlan10100", type="vxlan")
        r = self.client.post("/api/routing/vtep-memberships/", {
            "vtep_id": str(self.vtep.id), "l2vpn_id": str(self.l2.id),
            "interface_id": str(nd.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["interface"]["name"], "vxlan10100")
        vni = routing_context(self.leaf)["vtep"]["vnis"][0]
        self.assertEqual((vni["vni"], vni["interface"]), (10100, "vxlan10100"))

    def test_an_interface_on_another_device_is_refused(self):
        far = Interface.objects.create(device=self.other, name="vxlan10100", type="vxlan")
        r = self.client.post("/api/routing/vtep-memberships/", {
            "vtep_id": str(self.vtep.id), "l2vpn_id": str(self.l2.id),
            "interface_id": str(far.id),
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("interface", r.json())

    def test_without_a_link_the_render_is_unchanged(self):
        VTEPMembership.objects.create(vtep=self.vtep, l2vpn=self.l2)
        self.assertIsNone(routing_context(self.leaf)["vtep"]["vnis"][0]["interface"])
