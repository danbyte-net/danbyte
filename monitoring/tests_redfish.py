"""Redfish collector: BMC hardware → inventory items with health statuses.

The walker is exercised against a fake Redfish tree (no network); the API
views against the regular test client.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, InventoryItem
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

from .models import RedfishEndpoint
from .redfish import poll_endpoint

User = get_user_model()


# A minimal but structurally-faithful Redfish tree.
TREE = {
    "/redfish/v1/": {
        "Systems": {"@odata.id": "/redfish/v1/Systems"},
        "Chassis": {"@odata.id": "/redfish/v1/Chassis"},
    },
    "/redfish/v1/Systems": {
        "Members": [{"@odata.id": "/redfish/v1/Systems/1"}],
    },
    "/redfish/v1/Systems/1": {
        "Manufacturer": "Dell Inc.", "Model": "R750", "SerialNumber": "SYS1",
        "Status": {"Health": "OK", "State": "Enabled"},
        "Storage": {"@odata.id": "/redfish/v1/Systems/1/Storage"},
        "Processors": {"@odata.id": "/redfish/v1/Systems/1/Processors"},
        "Memory": {"@odata.id": "/redfish/v1/Systems/1/Memory"},
    },
    "/redfish/v1/Systems/1/Storage": {
        "Members": [{"@odata.id": "/redfish/v1/Systems/1/Storage/RAID"}],
    },
    "/redfish/v1/Systems/1/Storage/RAID": {
        "Drives": [
            {"@odata.id": "/redfish/v1/Systems/1/Storage/Drives/0"},
            {"@odata.id": "/redfish/v1/Systems/1/Storage/Drives/1"},
        ],
    },
    "/redfish/v1/Systems/1/Storage/Drives/0": {
        "Name": "Disk 0", "SerialNumber": "NVME-0001", "Model": "PM9A3",
        "CapacityBytes": 1_920_000_000_000, "MediaType": "SSD",
        "Protocol": "NVMe",
        "Status": {"Health": "OK", "State": "Enabled"},
    },
    "/redfish/v1/Systems/1/Storage/Drives/1": {
        "Name": "Disk 1", "SerialNumber": "SATA-0002", "Model": "MZ7L3",
        "CapacityBytes": 960_000_000_000, "MediaType": "SSD",
        "Protocol": "SATA",
        "Status": {"Health": "Critical", "State": "Enabled"},
    },
    "/redfish/v1/Systems/1/Processors": {
        "Members": [{"@odata.id": "/redfish/v1/Systems/1/Processors/CPU1"}],
    },
    "/redfish/v1/Systems/1/Processors/CPU1": {
        "Name": "CPU 1", "Model": "Xeon Gold 6338", "MaxSpeedMHz": 3200,
        "Status": {"Health": "OK", "State": "Enabled"},
    },
    "/redfish/v1/Systems/1/Memory": {
        "Members": [{"@odata.id": "/redfish/v1/Systems/1/Memory/DIMM1"}],
    },
    "/redfish/v1/Systems/1/Memory/DIMM1": {
        "Name": "DIMM A1", "SerialNumber": "MEM-1", "PartNumber": "M393A4",
        "CapacityMiB": 32768, "OperatingSpeedMhz": 3200,
        "Status": {"Health": "OK", "State": "Enabled"},
    },
    "/redfish/v1/Chassis": {
        "Members": [{"@odata.id": "/redfish/v1/Chassis/1"}],
    },
    "/redfish/v1/Chassis/1": {
        "Power": {"@odata.id": "/redfish/v1/Chassis/1/Power"},
        "Thermal": {"@odata.id": "/redfish/v1/Chassis/1/Thermal"},
    },
    "/redfish/v1/Chassis/1/Power": {
        "PowerSupplies": [
            {"Name": "PSU 1", "SerialNumber": "PSU-1", "Model": "DPS-750",
             "Status": {"Health": "OK", "State": "Enabled"}},
        ],
    },
    "/redfish/v1/Chassis/1/Thermal": {
        "Fans": [
            {"FanName": "Fan 1", "Status": {"Health": "OK", "State": "Enabled"}},
        ],
    },
}


class _FakeClient:
    """Serves the TREE dict in place of the httpx walker."""

    def __init__(self, endpoint, tree=None):
        self.tree = tree or TREE

    def get(self, path):
        return self.tree[path]

    def members(self, collection):
        return [self.get(m["@odata.id"]) for m in collection.get("Members", [])]

    def close(self):
        pass


def _patch_client(tree=None):
    return mock.patch(
        "monitoring.redfish._Client",
        lambda endpoint: _FakeClient(endpoint, tree),
    )


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
        self.device = Device.objects.create(tenant=self.tenant, name="srv1")
        self.ep = RedfishEndpoint.objects.create(
            tenant=self.tenant, device=self.device, host="192.168.10.5",
            secret_params={"username": "root", "password": "calvin"},
        )


class RedfishReconcileTests(_Base):
    def test_collect_and_reconcile_creates_inventory(self):
        with _patch_client():
            poll_endpoint(self.ep)
        self.ep.refresh_from_db()
        self.assertTrue(self.ep.reachable)
        items = {i.name: i for i in self.device.inventory_items.all()}
        # 2 drives + cpu + dimm + psu + fan
        self.assertEqual(len(items), 6)
        d0 = items["Disk 0"]
        self.assertEqual(d0.kind, "disk")
        self.assertEqual(d0.media, "nvme")
        self.assertEqual(d0.capacity_bytes, 1_920_000_000_000)
        self.assertEqual(d0.serial_number, "NVME-0001")
        self.assertEqual(d0.status.slug, "active")
        d1 = items["Disk 1"]
        self.assertEqual(d1.media, "ssd")
        self.assertEqual(d1.status.slug, "failed")
        self.assertEqual(items["DIMM A1"].capacity_bytes, 32768 * 1024 * 1024)
        self.assertEqual(items["CPU 1"].kind, "cpu")
        self.assertEqual(items["PSU 1"].kind, "psu")
        self.assertEqual(items["Fan 1"].kind, "fan")

    def test_rename_sticks_and_flip_journals(self):
        with _patch_client():
            poll_endpoint(self.ep)
        disk = self.device.inventory_items.get(serial_number="NVME-0001")
        disk.name = "Bay 1"  # operator's chosen name
        disk.save(update_fields=["name"])

        # Same drive goes Critical on the next poll.
        import copy

        tree = copy.deepcopy(TREE)
        tree["/redfish/v1/Systems/1/Storage/Drives/0"]["Status"]["Health"] = (
            "Critical"
        )
        with _patch_client(tree):
            poll_endpoint(self.ep)

        disk.refresh_from_db()
        self.assertEqual(disk.name, "Bay 1")  # rename survived (serial match)
        self.assertEqual(disk.status.slug, "failed")
        # No duplicate item was created for the renamed drive.
        self.assertEqual(
            self.device.inventory_items.filter(serial_number="NVME-0001").count(),
            1,
        )
        from audit.models import JournalEntry

        notes = JournalEntry.objects.filter(
            object_type="api.device", object_id=str(self.device.id)
        )
        self.assertTrue(any("Bay 1" in n.comments for n in notes))

    def test_loopback_host_refused(self):
        self.ep.host = "127.0.0.1"
        self.ep.save(update_fields=["host"])
        poll_endpoint(self.ep)  # no client patch - must fail before any I/O
        self.ep.refresh_from_db()
        self.assertFalse(self.ep.reachable)
        self.assertIn("loopback", self.ep.error)


class RedfishApiTests(_Base):
    def test_config_roundtrip_never_returns_secrets(self):
        url = f"/api/monitoring/devices/{self.device.id}/redfish/"
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["host"], "192.168.10.5")
        self.assertTrue(data["has_credentials"])
        self.assertNotIn("password", str(data))
        self.assertNotIn("calvin", str(data))
        # PUT without credentials keeps the stored ones.
        resp = self.client.put(url, {"host": "192.168.10.6"}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.ep.refresh_from_db()
        self.assertEqual(self.ep.host, "192.168.10.6")
        self.assertEqual(self.ep.secret_params["password"], "calvin")

    def test_poll_endpoint_view(self):
        with _patch_client():
            resp = self.client.post(
                f"/api/monitoring/devices/{self.device.id}/redfish-poll/"
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["reachable"])
        self.assertEqual(self.device.inventory_items.count(), 6)

    def test_poll_without_endpoint_400(self):
        other = Device.objects.create(tenant=self.tenant, name="srv2")
        resp = self.client.post(
            f"/api/monitoring/devices/{other.id}/redfish-poll/"
        )
        self.assertEqual(resp.status_code, 400)

    def test_tenant_isolation(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        foreign = Device.objects.create(tenant=other, name="theirs")
        resp = self.client.get(
            f"/api/monitoring/devices/{foreign.id}/redfish/"
        )
        self.assertEqual(resp.status_code, 404)
