"""What a port marker can print (#port labels): the port's label, the cable's
label or the far end - carried by the interface list and by face-ports - and
the per-device / per-port switches that turn it off."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Cable, CableTermination, Device, DeviceType, Interface, Manufacturer, Site

User = get_user_model()


class PortLabelDataTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Acme", slug="acme")
        dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="SW-1",
            image_ports={"front": [{"kind": "interface", "name": "Gi1", "x": 0.1, "y": 0.5, "w": 0.05, "h": 0.3}], "rear": []},
        )
        self.sw = Device.objects.create(tenant=self.tenant, name="sw1", site=site, device_type=dt, port_labels="on")
        self.srv = Device.objects.create(tenant=self.tenant, name="srv1", site=site)
        self.a = Interface.objects.create(
            device=self.sw, name="Gi1", marker_key="Gi1", label="A01", label_color="#22c55e"
        )
        self.b = Interface.objects.create(
            device=self.srv, name="eth0", marker_key="eth0", label="S-07", hide_label=True
        )
        cable = Cable.objects.create(tenant=self.tenant, label="C-206")
        CableTermination.objects.create(cable=cable, end="A", interface=self.a)
        CableTermination.objects.create(cable=cable, end="B", interface=self.b)

    def test_interface_list_carries_the_far_end_and_switches(self):
        r = self.client.get(f"/api/interfaces/?device={self.sw.id}")
        self.assertEqual(r.status_code, 200, r.content)
        row = next(i for i in r.json()["results"] if i["name"] == "Gi1")
        self.assertEqual(row["label"], "A01")
        self.assertEqual(row["link_peer"], {"device": "srv1", "port": "eth0", "port_label": "S-07"})
        self.assertEqual(row["cable"]["label"], "C-206")
        self.assertFalse(row["hide_label"])
        self.assertEqual(row["label_color"], "#22c55e")
        r = self.client.get(f"/api/interfaces/?device={self.srv.id}")
        row = next(i for i in r.json()["results"] if i["name"] == "eth0")
        self.assertTrue(row["hide_label"])
        self.assertEqual(row["link_peer"], {"device": "sw1", "port": "Gi1", "port_label": "A01"})

    def test_face_ports_carry_the_same(self):
        r = self.client.get(f"/api/devices/{self.sw.id}/face-ports/")
        self.assertEqual(r.status_code, 200, r.content)
        fp = r.json()["front"][0]
        self.assertEqual(fp["label"], "A01")
        self.assertEqual(fp["cable_label"], "C-206")
        self.assertEqual(fp["peer"], {"device": "srv1", "port": "eth0", "port_label": "S-07"})
        self.assertFalse(fp["label_hidden"])
        self.assertEqual(fp["label_color"], "#22c55e")

    def test_device_override_round_trips(self):
        r = self.client.get(f"/api/devices/{self.sw.id}/")
        self.assertEqual(r.json()["port_labels"], "on")
        r = self.client.patch(f"/api/devices/{self.sw.id}/", {"port_labels": "off"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["port_labels"], "off")
        r = self.client.patch(f"/api/devices/{self.sw.id}/", {"port_labels": "maybe"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/interfaces/{self.a.id}/", {"hide_label": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["hide_label"])


class FacePortsBulkTests(PortLabelDataTests):
    """One request for many devices, scoped like the list - the 3D room's
    rack-load path."""

    def test_bulk_returns_each_visible_device_once(self):
        other = Tenant.objects.create(org=self.tenant.org, name="Other", slug="other")
        foreign = Device.objects.create(tenant=other, name="x", site=Site.objects.create(tenant=other, name="X"))
        r = self.client.get(
            f"/api/devices/face-ports/?ids={self.sw.id},{self.srv.id},{foreign.id},not-a-uuid"
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(set(body), {str(self.sw.id), str(self.srv.id)})
        self.assertEqual(body[str(self.sw.id)]["front"][0]["label"], "A01")
        self.assertEqual(self.client.get("/api/devices/face-ports/").json(), {})
