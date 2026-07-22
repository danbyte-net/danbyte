"""Faceplate layout persistence + Aux ports (the eighth component kind).

The faceplate doc rides on DeviceType.faceplate (JSONB, null = automatic
layout). Shape validation lives in DeviceTypeSerializer.validate_faceplate;
these tests pin the contract the drag-and-drop builder saves against.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from .models import AuxPortTemplate, Device, DeviceType

User = get_user_model()

VALID_DOC = {
    "v": 1,
    "rear": [],
    "front": [
        {
            "id": "a",
            "label": "1–48",
            "rows": 2,
            "bank": 12,
            "slots": [
                {"t": "port", "name": "TwentyFiveGigE1/0/1"},
                {"t": "port", "name": "TwentyFiveGigE1/0/2"},
                {"t": "blank"},
                {"t": "label", "text": "MGMT"},
                {"t": "port", "kind": "aux-port", "name": "USB1"},
            ],
        }
    ],
}


class FaceplateFieldTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9500-48Y4C", u_height=1
        )

    def _patch(self, doc):
        return self.client.patch(
            f"/api/device-types/{self.dt.id}/",
            {"faceplate": doc},
            format="json",
        )

    def test_round_trip(self):
        resp = self._patch(VALID_DOC)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["faceplate"], VALID_DOC)
        # And it comes back on GET.
        got = self.client.get(f"/api/device-types/{self.dt.id}/").json()
        self.assertEqual(got["faceplate"], VALID_DOC)

    def test_null_clears(self):
        self._patch(VALID_DOC)
        resp = self._patch(None)
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["faceplate"])

    def test_rejects_wrong_version(self):
        self.assertEqual(self._patch({"v": 2, "front": [], "rear": []}).status_code, 400)

    def test_rejects_non_dict(self):
        self.assertEqual(self._patch(["not", "a", "doc"]).status_code, 400)

    def test_rejects_bad_slot_kind(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0,
                 "slots": [{"t": "port", "kind": "flux-capacitor", "name": "x"}]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_rejects_port_without_name(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0, "slots": [{"t": "port"}]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_accepts_module_bay_placeholder(self):
        # A group may carry a `bay` marker (placed in the builder) — the device
        # render composes an installed module's faceplate there.
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "b", "bay": "Network Module", "label": "Network Module",
                 "rows": 1, "bank": 0, "slots": [{"t": "blank"}]}
            ],
        }
        resp = self._patch(doc)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["faceplate"]["front"][0]["bay"],
                         "Network Module")

    def test_rejects_non_string_bay(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "b", "bay": 42, "rows": 1, "bank": 0, "slots": []}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_rejects_duplicate_kind_name(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0, "slots": [
                    {"t": "port", "name": "eth0"},
                    {"t": "port", "name": "ETH0"},  # case-insensitive dupe
                ]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_three_rows_and_full_width(self):
        doc = {
            "v": 1, "full": True, "rear": [],
            "front": [
                {"id": "a", "rows": 3, "bank": 0, "slots": [
                    {"t": "port", "name": "eth0"},
                ]}
            ],
        }
        resp = self._patch(doc)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["faceplate"]["full"])
        # 5 rows don't exist on any panel.
        doc["front"][0]["rows"] = 5
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_same_name_different_kind_is_fine(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0, "slots": [
                    {"t": "port", "name": "usb"},
                    {"t": "port", "kind": "aux-port", "name": "usb"},
                ]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 200)

    def test_tenant_isolation(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        foreign = DeviceType.objects.create(tenant=other, name="X", u_height=1)
        resp = self.client.patch(
            f"/api/device-types/{foreign.id}/",
            {"faceplate": VALID_DOC},
            format="json",
        )
        self.assertEqual(resp.status_code, 404)


class AuxPortTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="edge-router", u_height=1
        )

    def test_crud(self):
        device = Device.objects.create(tenant=self.tenant, name="r1")
        resp = self.client.post(
            "/api/aux-ports/",
            {"device_id": str(device.id), "name": "HDMI out", "type": "hdmi"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        pid = resp.json()["id"]
        got = self.client.get(f"/api/aux-ports/{pid}/").json()
        self.assertEqual(got["type"], "hdmi")
        self.assertEqual(got["type_display"], "HDMI")
        self.assertEqual(
            self.client.delete(f"/api/aux-ports/{pid}/").status_code, 204
        )

    def test_template_stamps_on_device_create(self):
        AuxPortTemplate.objects.create(
            device_type=self.dt, name="USB{position}", type="usb-a"
        )
        AuxPortTemplate.objects.create(
            device_type=self.dt, name="HDMI", type="hdmi"
        )
        resp = self.client.post(
            "/api/devices/",
            {"name": "r2", "device_type_id": str(self.dt.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        device = Device.objects.get(name="r2")
        names = set(device.aux_ports.values_list("name", flat=True))
        # Standalone device: {position} resolves to its default (1).
        self.assertEqual(names, {"USB1", "HDMI"})
