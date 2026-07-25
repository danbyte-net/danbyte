"""Portable device-type bundles — export, import, and the rules that keep an
imported bundle from doing something the importer didn't ask for.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from monitoring.models import SnmpSensor

from .models import (
    DeviceType,
    FrontPortTemplate,
    InterfaceTemplate,
    InventoryItemTemplate,
    Manufacturer,
    PowerOutletTemplate,
    PowerPortTemplate,
    RearPortTemplate,
)

User = get_user_model()

FACEPLATE = {
    "v": 1, "rear": [],
    "front": [{"id": "a", "rows": 1, "bank": 0,
               "slots": [{"t": "port", "name": "Gi1/0/1"}]}],
}
IMAGE_PORTS = {
    "front": [{"kind": "interface", "name": "Gi1/0/1",
               "x": 0.1, "y": 0.5, "w": 0.03, "h": 0.4}],
    "rear": [],
}


class DeviceBundleTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Lenovo")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="System x3650 M5", manufacturer=self.mfr,
            u_height=2, faceplate=FACEPLATE, image_ports=IMAGE_PORTS,
            description="A test chassis",
        )
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Gi1/0/1", type="1000base-t",
            description="uplink",
        )
        inlet = PowerPortTemplate.objects.create(
            device_type=self.dt, name="Psu 1", maximum_draw=750,
        )
        PowerOutletTemplate.objects.create(
            device_type=self.dt, name="Out 1", power_port_template=inlet,
            feed_leg="A",
        )
        rear = RearPortTemplate.objects.create(
            device_type=self.dt, name="Rear 1", positions=12,
        )
        FrontPortTemplate.objects.create(
            device_type=self.dt, name="Front 1", rear_port_template=rear,
            rear_port_position=3,
        )
        InventoryItemTemplate.objects.create(
            device_type=self.dt, name="disk0", kind="disk", media="nvme",
        )
        self.sensor = SnmpSensor.objects.create(
            tenant=self.tenant, name="Drive health", slug="drive-health",
            device_type=self.dt, oid="1.3.6.1.4.1.2.3.51.3.1.12.2.1.3",
            walk=True, item_kind="disk", name_template="disk{index}",
            value_map={"Normal": "active", "Critical": "failed"},
            absent_status="empty",
            # Deliberately auto here, to prove import forces it back to drift.
            apply_mode=SnmpSensor.APPLY_AUTO,
        )

    def _export(self):
        resp = self.client.get(f"/api/device-types/{self.dt.id}/library-export/")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def _import(self, bundle, **params):
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return self.client.post(
            f"/api/device-types/import-bundle/{'?' + qs if qs else ''}",
            bundle, format="json",
        )

    # ── export ───────────────────────────────────────────────────────────────

    def test_export_carries_the_whole_model_setup(self):
        b = self._export()
        self.assertEqual(b["danbyte_device_type"], 1)
        self.assertEqual(b["name"], "System x3650 M5")
        self.assertEqual(b["manufacturer"], "Lenovo")
        self.assertEqual(b["u_height"], 2)
        self.assertEqual(b["faceplate"], FACEPLATE)
        self.assertEqual(b["image_ports"], IMAGE_PORTS)
        c = b["components"]
        self.assertEqual(c["interfaces"][0]["name"], "Gi1/0/1")
        self.assertEqual(c["power_ports"][0]["maximum_draw"], 750)
        self.assertEqual(c["inventory_items"][0]["media"], "nvme")
        self.assertEqual(len(b["sensors"]), 1)
        self.assertEqual(b["sensors"][0]["oid"], "1.3.6.1.4.1.2.3.51.3.1.12.2.1.3")

    def test_export_references_components_by_name_not_id(self):
        c = self._export()["components"]
        # Ids are per-deployment; the far side re-resolves these by name.
        self.assertEqual(c["power_outlets"][0]["power_port"], "Psu 1")
        self.assertEqual(c["front_ports"][0]["rear_port"], "Rear 1")
        for rows in c.values():
            for row in rows:
                self.assertNotIn("id", row)

    def test_export_leaks_no_credentials_or_local_ids(self):
        b = self._export()
        blob = str(b)
        for forbidden in ("secret", "community", "password", "token",
                          str(self.tenant.id), str(self.dt.id)):
            self.assertNotIn(forbidden, blob, forbidden)
        # apply_mode is a local policy decision, not part of the definition.
        self.assertNotIn("apply_mode", b["sensors"][0])

    # ── import ───────────────────────────────────────────────────────────────

    def _reimport_into_clean_tenant(self, bundle):
        """Wipe the local copy so the import is a genuine first-time create."""
        SnmpSensor.objects.all().delete()
        self.dt.delete()
        return self._import(bundle)

    def test_round_trip_rebuilds_everything(self):
        bundle = self._export()
        resp = self._reimport_into_clean_tenant(bundle)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["action"], "create")

        dt = DeviceType.objects.get(tenant=self.tenant, name="System x3650 M5")
        self.assertEqual(dt.manufacturer.name, "Lenovo")
        self.assertEqual(dt.u_height, 2)
        self.assertEqual(dt.faceplate, FACEPLATE)
        self.assertEqual(dt.image_ports, IMAGE_PORTS)
        self.assertEqual(dt.interface_templates.count(), 1)
        self.assertEqual(dt.inventory_item_templates.get().media, "nvme")
        # The by-name cross-references got re-hooked to the NEW rows.
        self.assertEqual(
            dt.power_outlet_templates.get().power_port_template.name, "Psu 1"
        )
        front = dt.front_port_templates.get()
        self.assertEqual(front.rear_port_template.name, "Rear 1")
        self.assertEqual(front.rear_port_position, 3)

    def test_imported_sensor_cannot_write_intent(self):
        """The rule that matters: a bundle from someone else must never arrive
        able to overwrite a status a human here set."""
        bundle = self._export()
        self._reimport_into_clean_tenant(bundle)
        s = SnmpSensor.objects.get(tenant=self.tenant, slug="drive-health")
        self.assertEqual(s.apply_mode, SnmpSensor.APPLY_DRIFT)
        self.assertEqual(s.value_map, {"Normal": "active", "Critical": "failed"})
        self.assertEqual(s.device_type_id, DeviceType.objects.get().id)

    def test_dry_run_writes_nothing_but_reports_the_plan(self):
        bundle = self._export()
        SnmpSensor.objects.all().delete()
        self.dt.delete()
        resp = self._import(bundle, dry_run=1)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["action"], "create")
        self.assertEqual(body["components"]["interfaces"], 1)
        self.assertTrue(body["faceplate"])
        self.assertFalse(DeviceType.objects.exists())

    def test_existing_type_is_skipped_without_replace(self):
        bundle = self._export()
        bundle["u_height"] = 9
        resp = self._import(bundle)
        self.assertEqual(resp.json()["action"], "skipped")
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.u_height, 2)  # untouched

        resp = self._import(bundle, replace=1)
        self.assertEqual(resp.json()["action"], "update")
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.u_height, 9)

    def test_missing_photo_is_reported_not_silently_broken(self):
        """Marker coordinates are meaningless without the image they were placed
        on, so the report has to say so rather than importing dead markers."""
        bundle = self._export()
        bundle["images"] = {"front": True, "rear": False}
        SnmpSensor.objects.all().delete()
        self.dt.delete()
        body = self._import(bundle).json()
        self.assertEqual(body["missing_images"], ["front"])
        self.assertTrue(any("upload it" in w for w in body["warnings"]))

    def test_front_port_naming_a_missing_rear_port_is_dropped_loudly(self):
        bundle = self._export()
        bundle["components"]["rear_ports"] = []
        SnmpSensor.objects.all().delete()
        self.dt.delete()
        body = self._import(bundle).json()
        dt = DeviceType.objects.get()
        self.assertEqual(dt.front_port_templates.count(), 0)
        self.assertTrue(any("rear port" in w for w in body["warnings"]))

    def test_rejects_anything_that_is_not_a_bundle(self):
        for bad in (
            {"sensors": []},                                  # no envelope
            {"danbyte_device_type": 99, "name": "x"},          # wrong version
            {"danbyte_device_type": 1},                       # no name
            {"danbyte_device_type": 1, "name": "x", "components": "nope"},
        ):
            self.assertEqual(self._import(bad).status_code, 400, bad)

    def test_import_lands_in_the_active_tenant_only(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        bundle = self._export()
        bundle["name"] = "Imported Chassis"
        self._import(bundle)
        self.assertTrue(
            DeviceType.objects.filter(tenant=self.tenant, name="Imported Chassis")
            .exists()
        )
        self.assertFalse(DeviceType.objects.filter(tenant=other).exists())

    def test_export_requires_view_access(self):
        self.client.logout()
        resp = self.client.get(f"/api/device-types/{self.dt.id}/library-export/")
        self.assertIn(resp.status_code, (401, 403))
