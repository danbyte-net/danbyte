"""Bulk rename + bulk clone for device-type component templates."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Interface, InterfaceTemplate, Manufacturer
from core.models import Organization, Tenant


class ComponentRenameCloneTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Acme", slug="acme")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="SW-1"
        )
        for n in ("Gi1/0/1", "Gi1/0/2", "Gi1/0/3"):
            InterfaceTemplate.objects.create(device_type=self.dt, name=n)
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _ids(self):
        return [str(t.id) for t in InterfaceTemplate.objects.filter(device_type=self.dt)]

    def test_bulk_rename_find_replace(self):
        r = self.client.post(
            "/api/interface-templates/bulk-rename/",
            {"ids": self._ids(), "find": "Gi", "replace": "GigabitEthernet"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["renamed"], 3)
        names = set(
            InterfaceTemplate.objects.filter(device_type=self.dt).values_list("name", flat=True)
        )
        self.assertEqual(
            names, {"GigabitEthernet1/0/1", "GigabitEthernet1/0/2", "GigabitEthernet1/0/3"}
        )

    def test_bulk_rename_follows_into_markers_and_child_keys(self):
        # A photo marker + a faceplate slot reference Gi1/0/1 by name, and a
        # device of this type carries it as its frozen marker key. The bulk
        # path must rename all three like a single template save does -
        # otherwise sync-from-type keeps expecting the old name.
        self.dt.image_ports = {"front": [{"kind": "interface", "name": "Gi1/0/1", "x": 1, "y": 1}]}
        self.dt.faceplate = {
            "front": [{"slots": [{"t": "port", "kind": "interface", "name": "Gi1/0/1"}]}]
        }
        self.dt.save(update_fields=["image_ports", "faceplate"])
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        dev = Device.objects.create(
            tenant=self.tenant, name="sw", device_type=self.dt, role=role
        )
        iface = Interface.objects.create(device=dev, name="Gi1/0/1", marker_key="Gi1/0/1")
        r = self.client.post(
            "/api/interface-templates/bulk-rename/",
            {"ids": self._ids(), "find": "Gi1/", "replace": "Gi{position}/"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.image_ports["front"][0]["name"], "Gi{position}/0/1")
        self.assertEqual(
            self.dt.faceplate["front"][0]["slots"][0]["name"], "Gi{position}/0/1"
        )
        iface.refresh_from_db()
        self.assertEqual(iface.marker_key, "Gi{position}/0/1")

    def test_bulk_rename_rejects_collision(self):
        # Rename Gi1/0/2 → Gi1/0/1 (already exists, not in the rename set) → 400.
        t2 = InterfaceTemplate.objects.get(device_type=self.dt, name="Gi1/0/2")
        r = self.client.post(
            "/api/interface-templates/bulk-rename/",
            {"ids": [str(t2.id)], "find": "Gi1/0/2", "replace": "Gi1/0/1"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        t2.refresh_from_db()
        self.assertEqual(t2.name, "Gi1/0/2")  # unchanged

    def test_bulk_clone_with_rename(self):
        r = self.client.post(
            "/api/interface-templates/bulk-clone/",
            {"ids": self._ids(), "find": "1/0/", "replace": "2/0/"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["created"], 3)
        names = set(
            InterfaceTemplate.objects.filter(device_type=self.dt).values_list("name", flat=True)
        )
        self.assertIn("Gi2/0/1", names)
        self.assertIn("Gi1/0/1", names)  # originals kept
        self.assertEqual(InterfaceTemplate.objects.filter(device_type=self.dt).count(), 6)

    def test_bulk_clone_suffix_when_no_find(self):
        t1 = InterfaceTemplate.objects.get(device_type=self.dt, name="Gi1/0/1")
        r = self.client.post(
            "/api/interface-templates/bulk-clone/",
            {"ids": [str(t1.id)]},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(
            InterfaceTemplate.objects.filter(device_type=self.dt, name="Gi1/0/1 copy").exists()
        )
