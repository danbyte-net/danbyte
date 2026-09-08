"""SNMP for a virtual chassis (#148): one observation on the stack owner,
split back onto the members it describes."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Interface, VirtualChassis
from core.models import Organization, Tenant
from monitoring.models import DeviceSnmp, SnmpProfile
from monitoring.snmp_drift import compute_device_drift, sync_device_from_snmp
from monitoring.snmp_poll import _device_target, poll_device
from monitoring.vc_stack import (
    observed_for,
    partition_observed,
    position_from_name,
    stack_owner,
    stack_state,
)


def _row(name, descr=None, **extra):
    row = {"if_index": name, "name": name, "descr": descr or name, "mac": "",
           "admin_status": "up", "type_name": "ethernet"}
    row.update(extra)
    return row


OBSERVED = [
    _row("Gi1/0/1", "GigabitEthernet1/0/1"),
    _row("Gi1/0/2", "GigabitEthernet1/0/2"),
    _row("Gi2/0/1", "GigabitEthernet2/0/1"),
    _row("Gi2/0/2", "GigabitEthernet2/0/2"),
    _row("Po1", "Port-channel1", type_name="lag"),
    _row("Vl1", "Vlan1", type_name="l3ipvlan"),
]


class _Stack(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        self.master = Device.objects.create(
            tenant=self.tenant, name="sw1", virtual_chassis=self.vc, vc_position=1
        )
        self.member = Device.objects.create(
            tenant=self.tenant, name="sw2", virtual_chassis=self.vc, vc_position=2
        )
        self.vc.master = self.master
        self.vc.save()
        Interface.objects.create(device=self.master, name="GigabitEthernet1/0/1")
        Interface.objects.create(device=self.master, name="GigabitEthernet1/0/2")
        Interface.objects.create(device=self.master, name="Po1", type="lag")
        Interface.objects.create(device=self.member, name="GigabitEthernet2/0/1")
        self.state = DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.master, reachable=True,
            polled_at=timezone.now(), data={"sys_name": "stack"}, interfaces=OBSERVED,
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _kinds(self, device, kind):
        return sorted(
            i["name"] for i in compute_device_drift(device, self.tenant) if i["kind"] == kind
        )


class PartitionTests(_Stack):
    def test_position_from_name(self):
        self.assertEqual(position_from_name("Gi2/0/1"), 2)
        self.assertEqual(position_from_name("Ten-GigabitEthernet3/0/1"), 3)
        self.assertEqual(position_from_name("ge-1/0/0"), 1)
        self.assertEqual(position_from_name("1/1/1"), 1)
        self.assertIsNone(position_from_name("Port-channel1"))
        self.assertIsNone(position_from_name("Vlan1"))

    def test_rows_land_on_their_member(self):
        members = [self.master, self.member]
        parts = partition_observed(OBSERVED, members, self.master)
        self.assertEqual(
            [r["name"] for r in parts[self.member.id]], ["Gi2/0/1", "Gi2/0/2"]
        )
        self.assertEqual(
            [r["name"] for r in parts[self.master.id]],
            ["Gi1/0/1", "Gi1/0/2", "Po1", "Vl1"],
        )

    def test_existing_name_beats_the_slot_number(self):
        # An operator moved a port to the member by hand: it stays there.
        Interface.objects.filter(device=self.master, name="GigabitEthernet1/0/2").update(
            device=self.member
        )
        got = [r["name"] for r in observed_for(self.member, OBSERVED)]
        self.assertIn("Gi1/0/2", got)
        self.assertNotIn("Gi1/0/2", [r["name"] for r in observed_for(self.master, OBSERVED)])

    def test_standalone_device_keeps_everything(self):
        solo = Device.objects.create(tenant=self.tenant, name="solo")
        self.assertEqual(len(observed_for(solo, OBSERVED)), len(OBSERVED))


class DriftTests(_Stack):
    def test_member_only_sees_its_own_slice(self):
        self.assertEqual(self._kinds(self.member, "interface_missing"), ["Gi2/0/2"])
        self.assertEqual(self._kinds(self.member, "interface_stale"), [])
        self.assertEqual(self._kinds(self.master, "interface_missing"), ["Vl1"])
        self.assertEqual(self._kinds(self.master, "interface_stale"), [])

    def test_member_reads_the_owner_state(self):
        self.assertEqual(stack_state(self.member, self.tenant).id, self.state.id)
        r = self.client.get(f"/api/monitoring/devices/{self.member.id}/snmp/")
        self.assertEqual(r.json()["polled_via"]["name"], "sw1")
        r = self.client.get(f"/api/monitoring/devices/{self.master.id}/snmp/")
        self.assertNotIn("polled_via", r.json())

    def test_sync_member_creates_only_its_ports(self):
        summary = sync_device_from_snmp(self.member, self.tenant)
        self.assertEqual(summary["interfaces_created"], 1)
        self.assertEqual(
            sorted(self.member.interfaces.values_list("name", flat=True)),
            ["Gi2/0/2", "GigabitEthernet2/0/1"],
        )
        self.assertFalse(self.master.interfaces.filter(name="Gi2/0/2").exists())

    def test_fleet_list_has_a_row_per_member(self):
        SnmpProfile.objects.create(tenant=self.tenant, name="default", is_default=True)
        r = self.client.get("/api/monitoring/snmp-drift/")
        rows = {x["device_name"]: x for x in r.json()["results"]}
        self.assertEqual(set(rows), {"sw1", "sw2"})
        self.assertEqual(rows["sw2"]["by_kind"]["interface_missing"], 1)
        self.assertEqual(rows["sw2"]["by_kind"]["interface_stale"], 0)


class StackEndpointTests(_Stack):
    def test_vc_drift_groups_by_member(self):
        r = self.client.get(f"/api/monitoring/virtual-chassis/{self.vc.id}/snmp/drift/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["owner"]["name"], "sw1")
        self.assertTrue(body["owner"]["is_master"])
        names = {
            m["device"]["name"]: [d["name"] for d in m["drift"] if d["kind"] == "interface_missing"]
            for m in body["members"]
        }
        self.assertEqual(names, {"sw1": ["Vl1"], "sw2": ["Gi2/0/2"]})

    def test_vc_sync_walks_the_members(self):
        r = self.client.post(f"/api/monitoring/virtual-chassis/{self.vc.id}/snmp/sync/")
        self.assertEqual(r.status_code, 200, r.content)
        created = {m["device"]["name"]: m["summary"]["interfaces_created"] for m in r.json()["members"]}
        self.assertEqual(created, {"sw1": 1, "sw2": 1})
        self.assertTrue(self.master.interfaces.filter(name="Vl1").exists())
        self.assertTrue(self.member.interfaces.filter(name="Gi2/0/2").exists())

    def test_vc_poll_goes_to_the_owner(self):
        with mock.patch("monitoring.views.poll_device") as poll:
            poll.return_value = (self.state, None)
            r = self.client.post(f"/api/monitoring/virtual-chassis/{self.vc.id}/snmp-poll/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(poll.call_args[0][0].id, self.master.id)


class PollTests(_Stack):
    def test_owner_and_target_fallback(self):
        self.assertEqual(stack_owner(self.member).id, self.master.id)
        Device.objects.filter(pk=self.master.pk).update(name="localhost")
        Device.objects.filter(pk=self.member.pk).update(name="sw2.invalid.")
        self.member.refresh_from_db()
        self.assertEqual(_device_target(self.member), "localhost")

    def test_polling_a_member_polls_the_owner(self):
        with mock.patch("monitoring.snmp_poll.fetch_snmp") as fetch, mock.patch(
            "monitoring.snmp_poll.resolve_device_profile"
        ) as prof:
            prof.return_value = (SnmpProfile.objects.create(tenant=self.tenant, name="p"), "x")
            fetch.return_value = {"reachable": True, "data": {}, "interfaces": []}
            Device.objects.filter(pk=self.master.pk).update(name="localhost")
            self.master.refresh_from_db()
            state, reason = poll_device(self.member, self.tenant)
        self.assertIsNone(reason)
        self.assertEqual(state.device_id, self.master.id)
        self.assertEqual(DeviceSnmp.objects.filter(device=self.member).count(), 0)


class MoveToMemberTests(_Stack):
    def test_interface_moves_only_inside_the_stack(self):
        iface = self.master.interfaces.get(name="GigabitEthernet1/0/2")
        r = self.client.patch(
            f"/api/interfaces/{iface.id}/", {"device_id": str(self.member.id)}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        iface.refresh_from_db()
        self.assertEqual(iface.device_id, self.member.id)
        solo = Device.objects.create(tenant=self.tenant, name="solo")
        r = self.client.patch(
            f"/api/interfaces/{iface.id}/", {"device_id": str(solo.id)}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("same virtual chassis", str(r.json()))
