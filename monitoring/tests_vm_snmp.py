"""SNMP polling for virtual machines (virtual routers / appliances) - #13.

Mirrors the device SNMP flow: poll by the VM's primary IP, store observed facts
+ interfaces on the shared DeviceSnmp store (keyed by vm), read them back.
"""
from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    IPAddress,
    Prefix,
    VirtualMachine,
)
from core.models import Organization, Tenant
from monitoring.models import DeviceSnmp, SnmpProfile


class VmSnmpTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.8.0.0/24")
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.8.0.9", prefix=pfx
        )
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vrouter", cluster=cluster,
            primary_ip=self.ip,
        )
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _default_profile(self):
        return SnmpProfile.objects.create(
            tenant=self.tenant, name="Prod", slug="prod", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )

    @patch("danbyte_checks.snmp_facts.fetch_interfaces_sync")
    @patch("danbyte_checks.snmp_facts.fetch_system_facts_sync")
    def test_poll_vm_stores_facts_and_interfaces(self, mock_facts, mock_ifaces):
        mock_facts.return_value = {
            "sys_name": "vrouter", "sys_descr": "MikroTik RouterOS 7"
        }
        mock_ifaces.return_value = [
            {"if_index": "1", "name": "ether1", "oper_status": "up",
             "admin_status": "up", "speed_mbps": "1000",
             "mac": "00:11:22:33:44:55"},
        ]
        self._default_profile()
        r = self.client.post(
            f"/api/monitoring/virtual-machines/{self.vm.id}/snmp-poll/", {},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["reachable"])
        self.assertEqual(body["vm"], str(self.vm.id))
        self.assertEqual(body["data"]["sys_descr"], "MikroTik RouterOS 7")
        self.assertEqual(body["interfaces"][0]["name"], "ether1")
        self.assertTrue(DeviceSnmp.objects.filter(vm=self.vm).exists())
        # Readable back on the GET endpoint.
        g = self.client.get(f"/api/monitoring/virtual-machines/{self.vm.id}/snmp/")
        self.assertEqual(g.json()["interfaces"][0]["oper_status"], "up")

    def test_poll_without_profile_rejected(self):
        r = self.client.post(
            f"/api/monitoring/virtual-machines/{self.vm.id}/snmp-poll/", {},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_poll_without_primary_ip_rejected(self):
        self._default_profile()
        self.vm.primary_ip = None
        self.vm.save(update_fields=["primary_ip"])
        r = self.client.post(
            f"/api/monitoring/virtual-machines/{self.vm.id}/snmp-poll/", {},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("primary IP", r.json()["detail"])

    def test_empty_state_before_first_poll(self):
        g = self.client.get(f"/api/monitoring/virtual-machines/{self.vm.id}/snmp/")
        self.assertEqual(g.status_code, 200)
        self.assertEqual(g.json()["data"], {})
        self.assertIsNone(g.json()["polled_at"])

    def test_utilization_endpoint(self):
        g = self.client.get(
            f"/api/monitoring/virtual-machines/{self.vm.id}/snmp/utilization/"
        )
        self.assertEqual(g.status_code, 200)
        self.assertIn("interfaces", g.json())
