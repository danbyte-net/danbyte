"""User-defined SNMP sensors → inventory-item health."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, InventoryItem
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

from .models import SnmpProfile, SnmpSensor

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        seed_builtin_statuses(self.tenant)
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="R750")
        self.device = Device.objects.create(
            tenant=self.tenant, name="srv1", device_type=self.dt
        )
        self.profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="Lab", slug="lab", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )
        # A disk-health sensor: OID walk, 3=active / 4=failed (Dell-ish codes).
        self.sensor = SnmpSensor.objects.create(
            tenant=self.tenant, name="Disk health", slug="disk-health",
            device_type=self.dt, oid="1.3.6.1.4.1.674.1.1", walk=True,
            item_kind="disk", name_template="Disk {index}",
            value_map={"3": "active", "4": "failed"},
        )


class SensorReconcileTests(_Base):
    def test_walk_creates_and_flips_status(self):
        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            return_value={"1": "3", "2": "4", "3": "3"},
        ):
            from .snmp_sensors import poll_device_sensors

            result = poll_device_sensors(self.device, self.tenant)
        self.assertEqual(result["flipped"], 0)  # all created, not flipped
        items = {i.name: i for i in self.device.inventory_items.all()}
        self.assertEqual(set(items), {"Disk 1", "Disk 2", "Disk 3"})
        self.assertEqual(items["Disk 1"].kind, "disk")
        self.assertEqual(items["Disk 1"].status.slug, "active")
        self.assertEqual(items["Disk 2"].status.slug, "failed")
        self.assertEqual(len(result["readings"]), 3)

    def test_flip_on_second_poll_journals(self):
        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            return_value={"1": "3"},
        ):
            from .snmp_sensors import poll_device_sensors

            poll_device_sensors(self.device, self.tenant)
        disk = self.device.inventory_items.get(name="Disk 1")
        self.assertEqual(disk.status.slug, "active")
        # Now it fails.
        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            return_value={"1": "4"},
        ):
            from .snmp_sensors import poll_device_sensors

            result = poll_device_sensors(self.device, self.tenant)
        self.assertEqual(result["flipped"], 1)
        disk.refresh_from_db()
        self.assertEqual(disk.status.slug, "failed")
        from audit.models import JournalEntry

        self.assertTrue(
            JournalEntry.objects.filter(
                object_type="api.device", object_id=str(self.device.id),
                comments__icontains="Disk 1",
            ).exists()
        )

    def test_unmapped_value_leaves_status_alone(self):
        InventoryItem.objects.create(
            device=self.device, name="Disk 1", kind="disk",
        )
        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            return_value={"1": "99"},  # not in value_map
        ):
            from .snmp_sensors import poll_device_sensors

            poll_device_sensors(self.device, self.tenant)
        disk = self.device.inventory_items.get(name="Disk 1")
        self.assertIsNone(disk.status_id)  # untouched

    def test_sensor_bound_to_other_type_skipped(self):
        other_type = DeviceType.objects.create(tenant=self.tenant, name="Other")
        self.sensor.device_type = other_type
        self.sensor.save(update_fields=["device_type"])
        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            return_value={"1": "3"},
        ) as m:
            from .snmp_sensors import poll_device_sensors

            poll_device_sensors(self.device, self.tenant)
        m.assert_not_called()
        self.assertEqual(self.device.inventory_items.count(), 0)


class SensorApiTests(_Base):
    def test_crud_and_type_filter(self):
        resp = self.client.get(
            f"/api/monitoring/snmp-sensors/?device_type={self.dt.id}"
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(len(resp.json()["results"]), 1)
        # Create a new global sensor.
        resp = self.client.post(
            "/api/monitoring/snmp-sensors/",
            {"name": "PSU health", "oid": "1.3.6.1.4.1.674.2",
             "walk": True, "item_kind": "psu", "name_template": "PSU {index}",
             "value_map": {"3": "active", "4": "failed"}},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["slug"], "psu-health")

    def test_value_map_must_be_object(self):
        resp = self.client.post(
            "/api/monitoring/snmp-sensors/",
            {"name": "Bad", "oid": "1.2.3", "value_map": ["nope"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_poll_view(self):
        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            return_value={"1": "3", "2": "4"},
        ):
            resp = self.client.post(
                f"/api/monitoring/devices/{self.device.id}/sensor-poll/"
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(len(resp.json()["readings"]), 2)
        self.assertEqual(self.device.inventory_items.count(), 2)

    def test_tenant_isolation(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        foreign = SnmpSensor.objects.create(
            tenant=other, name="theirs", slug="theirs", oid="1.2.3",
        )
        resp = self.client.get(f"/api/monitoring/snmp-sensors/{foreign.id}/")
        self.assertEqual(resp.status_code, 404)
