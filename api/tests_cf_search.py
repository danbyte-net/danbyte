"""Custom-field values are searchable everywhere, and a hidden definition keeps
its value out of the UI without losing it."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Cable, Device
from core.models import Organization, Tenant
from customization.models import CustomField
from integrations.management.commands.import_netbox import ensure_netbox_fields


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.client.force_login(
            get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        )
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class CustomFieldSearchTests(_Base):
    def test_global_search_finds_custom_field_values(self):
        dev = Device.objects.create(
            tenant=self.tenant, name="core-a", custom_fields={"netbox_id": 57}
        )
        cab = Cable.objects.create(tenant=self.tenant, custom_fields={"netbox_id": 5701})
        Device.objects.create(tenant=self.tenant, name="other", custom_fields={"netbox_id": 9})
        groups = self.client.get("/api/search/?q=57").json()["groups"]
        self.assertEqual([d["id"] for d in groups["devices"]], [str(dev.id)])
        self.assertIn(str(cab.id), [c["id"] for c in groups["cables"]])

    def test_list_search_finds_custom_field_values(self):
        dev = Device.objects.create(
            tenant=self.tenant, name="core-a", custom_fields={"asset": "INV-4711"}
        )
        Device.objects.create(tenant=self.tenant, name="core-b")
        r = self.client.get("/api/devices/?search=4711").json()
        self.assertEqual([d["id"] for d in r["results"]], [str(dev.id)])


class HiddenCustomFieldTests(_Base):
    def test_hidden_round_trips_and_defaults_off(self):
        r = self.client.post(
            "/api/custom-fields/",
            {"key": "netbox_id", "label": "NetBox ID", "type": "integer",
             "applies_to": ["device"], "hidden": True},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["hidden"])
        listed = self.client.get("/api/custom-fields/?model=device").json()["results"]
        self.assertEqual([f["hidden"] for f in listed], [True])
        r2 = self.client.post(
            "/api/custom-fields/",
            {"key": "rack_unit_note", "label": "Note", "type": "text",
             "applies_to": ["device"]},
            format="json",
        )
        self.assertFalse(r2.json()["hidden"])

    def test_hidden_value_survives_a_form_style_save(self):
        CustomField.objects.create(
            tenant=self.tenant, key="netbox_id", label="NetBox ID", type="integer",
            applies_to=["device"], hidden=True,
        )
        dev = Device.objects.create(
            tenant=self.tenant, name="core-a", custom_fields={"netbox_id": 57}
        )
        # A form resends the object's whole custom_fields map, hidden keys included.
        r = self.client.patch(
            f"/api/devices/{dev.id}/",
            {"description": "edited", "custom_fields": {"netbox_id": 57}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        dev.refresh_from_db()
        self.assertEqual(dev.custom_fields.get("netbox_id"), 57)

    def test_importer_definitions_are_hidden_and_apply_broadly(self):
        ensure_netbox_fields(self.tenant)
        ensure_netbox_fields(self.tenant)  # idempotent
        defs = {f.key: f for f in CustomField.objects.filter(tenant=self.tenant)}
        self.assertEqual(set(defs), {"netbox_id", "netbox_tenant"})
        self.assertTrue(defs["netbox_id"].hidden)
        self.assertEqual(defs["netbox_id"].type, "integer")
        for slug in ("device", "cable", "prefix", "ipaddress", "rack"):
            self.assertIn(slug, defs["netbox_id"].applies_to)
