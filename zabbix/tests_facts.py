"""Zabbix's inventory as an observation (#162).

The value is for devices Danbyte cannot poll itself, so the tests that matter
are: it costs no extra call, it reaches the drift inbox, it never touches a
device on its own, and the switch really stops it.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase

from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
)
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.models import CheckState, CheckTemplate, MonitoringEngine
from monitoring.snmp_drift import apply_drift_action, compute_device_drift

from . import facts, provision
from .client import ZabbixClient
from .models import ZabbixConnection, ZabbixHostFacts

TOKEN = "a" * 64


def host(hostid, name, ip=None, **inventory):
    return {
        "hostid": hostid,
        "host": name,
        "name": name,
        "status": "0",
        "interfaces": [{"interfaceid": "9", "ip": ip, "type": "2"}] if ip else [],
        "inventory": inventory,
        "parentTemplates": [],
        "hostgroups": [],
    }


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"zabbix_enabled": True}
        )
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        vendor = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=vendor, name="C9300", model="C9300"
        )
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="SW", slug="sw")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.7.0.0/24")
        self.conn = ZabbixConnection.objects.create(
            tenant=self.tenant, name="zbx", url="https://z.example.com",
            credentials={"token": TOKEN}, version="7.0.30",
            provision_mode=ZabbixConnection.REVIEW, read_inventory=True,
        )
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix"
        )
        self.conn.engines.add(self.engine)
        self.check = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", kind="zabbix", interval_seconds=300
        )
        self.device = self.make_device()

    def make_device(self, name="sw1", octet=10):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.7.0.{octet}/24", prefix=self.prefix
        )
        dev = Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dtype, role=self.role,
            site=self.site,
        )
        ip.assigned_device = dev
        ip.save(update_fields=["assigned_device"])
        dev.primary_ip = ip
        dev.save(update_fields=["primary_ip"])
        # In scope: a Zabbix check is what puts it in the provisioning pass.
        CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=self.check, engine=self.engine,
            kind="zabbix", interval_seconds=300, next_run=None,
        )
        return dev

    def plan(self, hosts):
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=hosts):
            return provision.plan(self.conn)

    def drift(self):
        return [
            i for i in compute_device_drift(self.device, self.tenant)
            if i["kind"] == "device_field"
        ]


class RecordTests(_Base):
    def test_the_pass_records_what_the_host_read_already_carried(self):
        self.plan([host("50", "sw1", "10.7.0.10", serialno_a="FOC123", model="C9300")])
        row = ZabbixHostFacts.objects.get(connection=self.conn, device=self.device)
        self.assertEqual(row.data["serial"], "FOC123")
        self.assertEqual(row.data["sys_name"], "sw1")
        self.assertEqual(row.data["model"], "C9300")
        self.assertTrue(row.reachable)
        self.assertIsNotNone(row.polled_at)

    def test_it_costs_no_extra_call(self):
        """The whole claim of this phase: the inventory rides the host read the
        pass already makes."""
        with mock.patch.object(
            ZabbixClient, "all_hosts",
            return_value=[host("50", "sw1", "10.7.0.10", serialno_a="FOC123")],
        ) as all_hosts, mock.patch.object(ZabbixClient, "call") as call:
            provision.plan(self.conn)
        self.assertEqual(all_hosts.call_count, 1)
        call.assert_not_called()

    def test_the_switch_off_records_nothing(self):
        self.conn.read_inventory = False
        self.conn.save(update_fields=["read_inventory"])
        self.plan([host("50", "sw1", "10.7.0.10", serialno_a="FOC123")])
        self.assertFalse(ZabbixHostFacts.objects.exists())

    def test_an_unmatched_device_records_nothing(self):
        self.plan([host("50", "somebody-else", "192.0.2.9", serialno_a="X")])
        self.assertFalse(ZabbixHostFacts.objects.exists())

    def test_a_host_disabled_in_zabbix_is_not_an_observation_of_now(self):
        h = host("50", "sw1", "10.7.0.10", serialno_a="FOC123")
        h["status"] = "1"
        self.plan([h])
        self.assertFalse(ZabbixHostFacts.objects.get().reachable)
        self.assertEqual(self.drift(), [])

    def test_a_blank_inventory_says_nothing_rather_than_blank(self):
        self.device.serial_number = "FOC123"
        self.device.save(update_fields=["serial_number"])
        self.plan([host("50", "sw1", "10.7.0.10", serialno_a="", model="")])
        self.assertNotIn("serial", ZabbixHostFacts.objects.get().data)
        self.assertEqual(self.drift(), [])

    def test_a_second_pass_updates_one_row(self):
        self.plan([host("50", "sw1", "10.7.0.10", serialno_a="A")])
        self.plan([host("50", "sw1", "10.7.0.10", serialno_a="B")])
        self.assertEqual(ZabbixHostFacts.objects.count(), 1)
        self.assertEqual(ZabbixHostFacts.objects.get().data["serial"], "B")

    def test_the_visible_name_is_what_is_compared(self):
        h = host("50", "sw1", "10.7.0.10")
        h["host"], h["name"] = "sw1.technical", "sw1-visible"
        self.assertEqual(facts.facts_from_host(h)["sys_name"], "sw1-visible")


class DriftTests(_Base):
    def record(self, **inventory):
        facts.record(self.conn, self.device, host("50", "sw1", **inventory))

    def test_a_serial_zabbix_has_and_danbyte_does_not_is_drift(self):
        self.record(serialno_a="FOC123")
        [item] = self.drift()
        self.assertEqual(item["field"], "serial_number")
        self.assertEqual(item["observed"], "FOC123")
        self.assertEqual(item["source"], "zabbix")

    def test_recording_never_touches_the_device(self):
        self.record(serialno_a="FOC123")
        self.device.refresh_from_db()
        self.assertEqual(self.device.serial_number, "")

    def test_accepting_is_what_writes_it(self):
        self.record(serialno_a="FOC123")
        [item] = self.drift()
        self.assertTrue(apply_drift_action(self.device, self.tenant, item))
        self.device.refresh_from_db()
        self.assertEqual(self.device.serial_number, "FOC123")
        self.assertEqual(self.drift(), [])

    def test_the_model_is_recorded_but_not_offered_as_drift(self):
        """A device type is a catalog row the operator curates - accepting one
        would mint it behind their back, so it is kept and not proposed."""
        self.record(serialno_a="FOC123", model="C9500-48Y4C")
        self.assertEqual(
            ZabbixHostFacts.objects.get().data["model"], "C9500-48Y4C"
        )
        self.assertEqual([i["field"] for i in self.drift()], ["serial_number"])

    def test_turning_the_switch_off_withdraws_the_opinion(self):
        self.record(serialno_a="FOC123")
        self.assertEqual(len(self.drift()), 1)
        self.conn.read_inventory = False
        self.conn.save(update_fields=["read_inventory"])
        self.assertEqual(self.drift(), [])

    def test_a_disabled_connection_withdraws_it_too(self):
        self.record(serialno_a="FOC123")
        self.conn.enabled = False
        self.conn.save(update_fields=["enabled"])
        self.assertEqual(self.drift(), [])

    def test_another_tenants_facts_are_not_visible(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        self.record(serialno_a="FOC123")
        ZabbixHostFacts.objects.update(tenant=other)
        self.assertEqual(self.drift(), [])


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.user = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.client.force_login(self.user)

    def test_the_switch_is_on_the_connection(self):
        r = self.client.get(f"/api/zabbix/connections/{self.conn.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["read_inventory"])
        r = self.client.patch(
            f"/api/zabbix/connections/{self.conn.id}/",
            {"read_inventory": False}, content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.read_inventory)


class ForgetTests(_Base):
    """A host that leaves stops having an opinion.

    Facts outliving their link is how a device nothing watches any more keeps
    raising drift forever.
    """

    def test_pruning_a_host_forgets_what_it_said(self):
        from .models import ZabbixChange, ZabbixHostLink

        facts.record(self.conn, self.device, host("50", "sw1", serialno_a="FOC123"))
        ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.device,
            hostid="50", host_name="sw1", created_here=True,
        )
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.device,
            kind=ZabbixChange.PRUNE, detail={"hostid": "50", "host_name": "sw1"},
        )
        with mock.patch.object(ZabbixClient, "delete_hosts"):
            provision.apply_change(change)
        self.assertFalse(ZabbixHostFacts.objects.exists())
        self.assertEqual(self.drift(), [])

    def test_unlinking_through_the_api_forgets_them_too(self):
        from django.contrib.auth import get_user_model

        from .models import ZabbixHostLink

        user = get_user_model().objects.create_superuser("root2", "r2@x.io", "pw")
        self.client.force_login(user)
        facts.record(self.conn, self.device, host("50", "sw1", serialno_a="FOC123"))
        link = ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.device,
            hostid="50", host_name="sw1",
        )
        r = self.client.delete(f"/api/zabbix/links/{link.id}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertFalse(ZabbixHostFacts.objects.exists())


class RbacRegistryTests(_Base):
    """Every Zabbix model with a viewset has to be in the RBAC registry, or
    its endpoint 403s for everyone who is not a superuser."""

    def test_every_zabbix_viewset_model_is_registered(self):
        from auth_api.object_types import is_registered

        from . import viewsets as vs

        missing = []
        for name in dir(vs):
            qs = getattr(getattr(vs, name), "queryset", None)
            model = getattr(qs, "model", None)
            if model is None or model._meta.app_label != "zabbix":
                continue
            if not is_registered(model._meta.model_name):
                missing.append(model._meta.model_name)
        self.assertEqual(missing, [], "these 403 for every non-superuser")
