"""User-defined SNMP sensors → inventory-item health."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, InventoryItem, IPAddress, Prefix
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
        # A real primary IP: the poller only falls back to the device NAME
        # when that name resolves, so a fixture without an IP would be skipped.
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.9.9.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.9.9", prefix=pfx
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="srv1", device_type=self.dt,
            primary_ip=ip,
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

    def _write_through(self):
        """Opt the fixture sensor into writing intent directly.

        The default is observe-and-report (Danbyte's contract); these suites
        exercise the write path, so they ask for it explicitly."""
        self.sensor.apply_mode = "auto"
        self.sensor.save(update_fields=["apply_mode"])


class SensorReconcileTests(_Base):
    """The `auto` write path. Observe-only behaviour lives in
    SensorSoTComplianceTests."""

    def setUp(self):
        super().setUp()
        self._write_through()

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


class SensorSoTComplianceTests(_Base):
    """Danbyte is a source of truth with drift visualisation. A reading is
    observed data: by default it is recorded and the difference is listed, and
    it never overwrites a status a human set unless the sensor opts in.
    """

    def setUp(self):
        super().setUp()
        from api.models import InventoryItem
        from api.status_registry import resolve_status

        self.active = resolve_status(self.tenant, "active", "inventoryitem")
        self.disk = InventoryItem.objects.create(
            device=self.device, name="Disk 1", kind="disk", status=self.active
        )

    def _poll(self, raw={"1": "4"}):
        from .snmp_sensors import poll_device_sensors

        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync", return_value=raw
        ):
            return poll_device_sensors(self.device, self.tenant)

    def _drift(self):
        from .snmp_drift import compute_device_drift

        return compute_device_drift(self.device, self.tenant)

    def test_default_mode_records_the_reading_without_writing(self):
        self.assertEqual(self.sensor.apply_mode, "drift")  # the default

        result = self._poll()

        self.disk.refresh_from_db()
        self.assertEqual(self.disk.status.slug, "active", "intent was overwritten")
        self.assertEqual(result["flipped"], 0)
        # The observation is still recorded — that's what drift reads.
        self.assertEqual(
            [(r["name"], r["status"]) for r in result["readings"]],
            [("Disk 1", "failed")],
        )

    def test_the_difference_surfaces_as_drift(self):
        self._poll()
        items = [d for d in self._drift() if d["kind"] == "part_status"]
        self.assertEqual(len(items), 1, items)
        self.assertEqual(items[0]["part_id"], str(self.disk.id))
        self.assertEqual(items[0]["intended"], "Active")
        self.assertEqual(items[0]["observed"], "failed")
        self.assertEqual(items[0]["raw"], "4")

    def test_accepting_the_drift_writes_it(self):
        self._poll()
        item = next(d for d in self._drift() if d["kind"] == "part_status")

        resp = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": item}, format="json",
        )

        self.assertEqual(resp.status_code, 200, resp.content)
        self.disk.refresh_from_db()
        self.assertEqual(self.disk.status.slug, "failed")
        # And the difference is gone.
        self.assertEqual([d for d in self._drift() if d["kind"] == "part_status"], [])

    def test_auto_mode_writes_through_and_shows_no_drift(self):
        """The opt-in: health acted on with nobody watching."""
        self.sensor.apply_mode = "auto"
        self.sensor.save(update_fields=["apply_mode"])

        result = self._poll()

        self.disk.refresh_from_db()
        self.assertEqual(self.disk.status.slug, "failed")
        self.assertEqual(result["flipped"], 1)
        # Intent now matches the reading, so nothing is left to review.
        self.assertEqual([d for d in self._drift() if d["kind"] == "part_status"], [])

    def test_a_part_danbyte_has_never_seen_is_offered_not_created(self):
        result = self._poll({"1": "4", "9": "3"})

        self.assertEqual(
            self.device.inventory_items.count(), 1, "a part was created silently"
        )
        missing = [d for d in self._drift() if d["kind"] == "part_missing"]
        self.assertEqual([d["name"] for d in missing], ["Disk 9"])
        self.assertEqual(missing[0]["part_kind"], "disk")

        resp = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": missing[0]}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        created = self.device.inventory_items.get(name="Disk 9")
        self.assertEqual(created.kind, "disk")
        self.assertEqual(created.status.slug, "active")
        self.assertEqual(result["flipped"], 0)

    def test_an_empty_bay_is_drift_too_not_a_write(self):
        """The absent case goes through the same review path."""
        from api.models import InventoryItem

        InventoryItem.objects.create(
            device=self.device, name="Disk 2", kind="disk", status=self.active
        )
        self.sensor.absent_status = "empty"
        self.sensor.save(update_fields=["absent_status"])

        self._poll({"1": "3"})  # only Disk 1 reported

        bay2 = self.device.inventory_items.get(name="Disk 2")
        self.assertEqual(bay2.status.slug, "active", "intent was overwritten")
        drifted = {
            d["name"]: d["observed"]
            for d in self._drift() if d["kind"] == "part_status"
        }
        self.assertEqual(drifted, {"Disk 2": "empty"})

    def test_unmapped_values_are_never_drift(self):
        self._poll({"1": "99"})
        self.assertEqual([d for d in self._drift() if d["kind"] == "part_status"], [])


class SensorAbsentStatusTests(_Base):
    """A chassis template stamps every bay; the agent only reports the populated
    ones. Without this, the empty bays keep claiming to hold healthy hardware.
    """

    def setUp(self):
        super().setUp()
        self._write_through()
        self.sensor.absent_status = "empty"
        self.sensor.save(update_fields=["absent_status"])
        # Four bays stamped from the type; the agent will report two.
        from api.models import InventoryItem
        from api.status_registry import resolve_status

        active = resolve_status(self.tenant, "active", "inventoryitem")
        self.bays = {
            n: InventoryItem.objects.create(
                device=self.device, name=n, kind="disk", status=active
            )
            for n in ("Disk 1", "Disk 2", "Disk 3", "Disk 4")
        }

    def _poll(self, raw):
        from .snmp_sensors import poll_device_sensors

        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync", return_value=raw
        ):
            return poll_device_sensors(self.device, self.tenant)

    def _slugs(self):
        return {
            i.name: (i.status.slug if i.status_id else None)
            for i in self.device.inventory_items.all()
        }

    def test_unreported_bays_flip_to_the_absent_status(self):
        self._poll({"1": "3", "2": "3"})
        self.assertEqual(
            self._slugs(),
            {"Disk 1": "active", "Disk 2": "active",
             "Disk 3": "empty", "Disk 4": "empty"},
        )

    def test_a_bay_that_comes_back_is_marked_healthy_again(self):
        self._poll({"1": "3"})
        self.assertEqual(self._slugs()["Disk 2"], "empty")
        self._poll({"1": "3", "2": "3"})
        self.assertEqual(self._slugs()["Disk 2"], "active")

    def test_an_empty_reading_set_marks_nothing(self):
        """The guard that matters: an agent answering with nothing looks exactly
        like "every bay is empty", and acting on it would wipe real hardware."""
        self._poll({})
        self.assertEqual(
            set(self._slugs().values()), {"active"}, "a silent agent wiped the bays"
        )

    def test_a_failed_poll_marks_nothing(self):
        from danbyte_checks.snmp_facts import SnmpFactsError
        from .snmp_sensors import poll_device_sensors

        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            side_effect=SnmpFactsError("snmp error: timed out"),
        ):
            result = poll_device_sensors(self.device, self.tenant)
        self.assertIn("timed out", result["error"])
        self.assertEqual(set(self._slugs().values()), {"active"})

    def test_only_the_sensors_own_kind_is_touched(self):
        """A disk sensor must not mark the PSUs empty."""
        from api.models import InventoryItem
        from api.status_registry import resolve_status

        psu = InventoryItem.objects.create(
            device=self.device, name="PSU 1", kind="psu",
            status=resolve_status(self.tenant, "active", "inventoryitem"),
        )
        self._poll({"1": "3"})
        psu.refresh_from_db()
        self.assertEqual(psu.status.slug, "active")

    def test_blank_absent_status_leaves_everything_alone(self):
        self.sensor.absent_status = ""
        self.sensor.save(update_fields=["absent_status"])
        self._poll({"1": "3"})
        self.assertEqual(self._slugs()["Disk 4"], "active")

    def test_the_flip_is_journaled(self):
        from audit.models import JournalEntry

        self._poll({"1": "3", "2": "3"})
        entry = JournalEntry.objects.filter(
            object_id=str(self.device.id), author_name="SNMP sensors"
        ).first()
        self.assertIsNotNone(entry)
        self.assertIn("Disk 3", entry.comments)


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
        self._write_through()  # creating parts is a write, so opt in
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

    def test_poll_view_observes_without_writing_by_default(self):
        with mock.patch(
            "monitoring.snmp_sensors.fetch_oid_sync",
            return_value={"1": "3", "2": "4"},
        ):
            resp = self.client.post(
                f"/api/monitoring/devices/{self.device.id}/sensor-poll/"
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(len(resp.json()["readings"]), 2)
        self.assertEqual(self.device.inventory_items.count(), 0)

    def test_tenant_isolation(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        foreign = SnmpSensor.objects.create(
            tenant=other, name="theirs", slug="theirs", oid="1.2.3",
        )
        resp = self.client.get(f"/api/monitoring/snmp-sensors/{foreign.id}/")
        self.assertEqual(resp.status_code, 404)


class SensorPackTests(_Base):
    """Export/import of sensor definitions as a portable JSON pack.

    A sensor is per-vendor OID archaeology worth sharing; it holds no
    credentials, which is what makes the pack safe to move between deployments.
    """

    EXPORT = "/api/monitoring/snmp-sensors/export/"
    IMPORT = "/api/monitoring/snmp-sensors/import/"

    def test_export_shape_and_device_type_by_name(self):
        resp = self.client.get(self.EXPORT)
        self.assertEqual(resp.status_code, 200, resp.content)
        pack = resp.json()
        self.assertEqual(pack["danbyte_snmp_sensor_pack"], 1)
        self.assertEqual(pack["count"], 1)
        row = pack["sensors"][0]
        self.assertEqual(row["name"], "Disk health")
        self.assertEqual(row["value_map"], {"3": "active", "4": "failed"})
        # Ids are per-deployment; the NAME is what the far side can match on.
        self.assertEqual(row["device_type_name"], "R750")
        self.assertNotIn("id", row)
        self.assertNotIn("tenant", row)

    def test_round_trip_into_a_clean_tenant(self):
        pack = self.client.get(self.EXPORT).json()
        SnmpSensor.objects.all().delete()
        resp = self.client.post(self.IMPORT, pack, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["created"], 1)
        s = SnmpSensor.objects.get(tenant=self.tenant, slug="disk-health")
        self.assertEqual(s.oid, "1.3.6.1.4.1.674.1.1")
        self.assertEqual(s.value_map, {"3": "active", "4": "failed"})
        # Rebound to the local device type of the same name.
        self.assertEqual(s.device_type_id, self.dt.id)

    def test_import_skips_existing_unless_replace(self):
        pack = self.client.get(self.EXPORT).json()
        pack["sensors"][0]["oid"] = "9.9.9"
        resp = self.client.post(self.IMPORT, pack, format="json")
        self.assertEqual(resp.json()["skipped"], 1)
        self.sensor.refresh_from_db()
        self.assertEqual(self.sensor.oid, "1.3.6.1.4.1.674.1.1")  # untouched

        resp = self.client.post(f"{self.IMPORT}?replace=1", pack, format="json")
        self.assertEqual(resp.json()["updated"], 1)
        self.sensor.refresh_from_db()
        self.assertEqual(self.sensor.oid, "9.9.9")

    def test_unknown_device_type_imports_unbound_not_dropped(self):
        pack = self.client.get(self.EXPORT).json()
        pack["sensors"][0]["slug"] = "borrowed"
        pack["sensors"][0]["device_type_name"] = "Some Chassis We Lack"
        resp = self.client.post(self.IMPORT, pack, format="json")
        body = resp.json()
        self.assertEqual(body["created"], 1)
        self.assertEqual(body["unbound_device_types"], ["Some Chassis We Lack"])
        self.assertIsNone(
            SnmpSensor.objects.get(tenant=self.tenant, slug="borrowed").device_type_id
        )

    def test_rejects_a_file_that_is_not_a_pack(self):
        for bad in ({"sensors": []}, {"danbyte_snmp_sensor_pack": 99, "sensors": []}):
            resp = self.client.post(self.IMPORT, bad, format="json")
            self.assertEqual(resp.status_code, 400, bad)

    def test_import_cannot_bind_another_tenants_device_type(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        DeviceType.objects.create(tenant=other, name="Secret Chassis")
        pack = self.client.get(self.EXPORT).json()
        pack["sensors"][0]["slug"] = "sneaky"
        pack["sensors"][0]["device_type_name"] = "Secret Chassis"
        resp = self.client.post(self.IMPORT, pack, format="json")
        self.assertEqual(resp.json()["created"], 1)
        # Name resolution is tenant-scoped, so it lands unbound rather than
        # reaching across into the other tenant's catalog.
        self.assertIsNone(
            SnmpSensor.objects.get(tenant=self.tenant, slug="sneaky").device_type_id
        )

    def test_device_type_only_filter_excludes_all_types_sensors(self):
        SnmpSensor.objects.create(
            tenant=self.tenant, name="Everywhere", slug="everywhere",
            oid="1.1", device_type=None,
        )
        both = self.client.get(
            f"/api/monitoring/snmp-sensors/?device_type={self.dt.id}"
        ).json()
        self.assertEqual(both["count"], 2)
        only = self.client.get(
            f"/api/monitoring/snmp-sensors/?device_type_only={self.dt.id}"
        ).json()
        self.assertEqual(only["count"], 1)
        self.assertEqual(only["results"][0]["name"], "Disk health")
