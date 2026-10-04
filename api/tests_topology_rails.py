"""The Logical view's payload carries the colors its rail diagram draws with.

``GET /api/topology/logical/`` names each rail's status and each device's and
VM's status and role as data (id, name, color), so the diagram colors its
rails, cards and pills from them and never from a name.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    VLAN,
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    Interface,
    Status,
    VirtualMachine,
    VMInterface,
)

User = get_user_model()


class LogicalColorsTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        kinds = ["device", "virtualmachine", "vlan"]
        self.active = Status.objects.create(
            tenant=self.tenant, name="Active", slug="active", color="#22c55e",
            available_to=kinds, default_for=kinds,
        )
        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned",
            color="#f59e0b", available_to=kinds,
        )
        self.core = DeviceRole.objects.create(
            tenant=self.tenant, name="Core", slug="core", color="#ff0000"
        )
        self.app = DeviceRole.objects.create(
            tenant=self.tenant, name="App", slug="app", color="#0ea5e9"
        )
        self.v10 = VLAN.objects.create(
            tenant=self.tenant, vlan_id=10, name="prod", status=self.planned
        )
        self.v20 = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="mgmt")
        sw = Device.objects.create(
            tenant=self.tenant, name="sw-1", role=self.core, status=self.active
        )
        Interface.objects.create(device=sw, name="Gi0/1", vlan=self.v10)
        bare = Device.objects.create(tenant=self.tenant, name="sw-2")
        Interface.objects.create(device=bare, name="Gi0/1", vlan=self.v20)
        ct = ClusterType.objects.create(tenant=self.tenant, name="pve")
        cl = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web-01", cluster=cl, role=self.app,
            status=self.planned,
        )
        VMInterface.objects.create(vm=vm, name="net0", vlan=self.v10)

    def _logical(self):
        r = self.client.get("/api/topology/logical/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    @staticmethod
    def _mini(s, is_default):
        return {
            "id": str(s.id), "name": s.name, "slug": s.slug,
            "color": s.color, "text_color": s.text_color,
            "is_default": is_default,
        }

    def test_rails_carry_their_status(self):
        rails = {r["vlan_id"]: r for r in self._logical()["rails"]}
        self.assertEqual(rails[10]["status"], self._mini(self.planned, False))
        self.assertIsNone(rails[20]["status"])

    def test_devices_and_vms_carry_status_and_role(self):
        nodes = {n["name"]: n for n in self._logical()["nodes"]}
        sw, vm, bare = nodes["sw-1"], nodes["web-01"], nodes["sw-2"]
        self.assertEqual(sw["status_mini"], self._mini(self.active, True))
        self.assertEqual(
            sw["role"],
            {"id": str(self.core.id), "name": "Core", "color": "#ff0000"},
        )
        self.assertEqual(vm["status_mini"], self._mini(self.planned, False))
        self.assertEqual(
            vm["role"],
            {"id": str(self.app.id), "name": "App", "color": "#0ea5e9"},
        )
        # The display name stays for older readers.
        self.assertEqual((sw["status"], vm["status"]), ("Active", "Planned"))
        self.assertIsNone(bare["status_mini"])
        self.assertIsNone(bare["role"])
        self.assertIsNone(bare["status"])

    def test_a_node_is_described_once_whatever_its_attachments(self):
        sw = Device.objects.get(name="sw-1")
        trunk = Interface.objects.create(device=sw, name="Gi0/48")
        trunk.tagged_vlans.set([self.v10, self.v20])
        nodes = [n for n in self._logical()["nodes"] if n["name"] == "sw-1"]
        self.assertEqual(len(nodes), 1)
        self.assertEqual(len(nodes[0]["attachments"]), 3)
        self.assertEqual(nodes[0]["role"]["name"], "Core")
