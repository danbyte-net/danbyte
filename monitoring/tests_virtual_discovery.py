"""SNMP-discovered loopbacks, SVIs, tunnels and VLAN interfaces arrive typed
"virtual" (so flagged virtual and out of port utilization), and the 0107
backfill flags the ones discovered before that."""
from __future__ import annotations

import importlib

from django.apps import apps
from django.db import connection
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Interface, VirtualChassis
from core.models import Organization, Tenant
from monitoring.models import DeviceSnmp
from monitoring.snmp_drift import (
    apply_drift_action,
    compute_device_drift,
    sync_device_from_snmp,
)


def _row(if_index, name, type_name, **extra):
    return {"if_index": str(if_index), "name": name, "type_name": type_name,
            "admin_status": "up", "mac": "", **extra}


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")

    def _state(self, interfaces, device=None, tenant=None):
        return DeviceSnmp.objects.create(
            tenant=tenant or self.tenant, device=device or self.device,
            reachable=True, polled_at=timezone.now(), data={"sys_name": "sw1"},
            interfaces=interfaces,
        )


class VirtualDiscoveryTests(_Base):
    def test_sync_creates_virtual_kinds_as_virtual(self):
        self._state([
            _row(1, "Gi1/0/1", "ethernet"),
            _row(2, "Vl10", "l3vlan"),
            _row(3, "VLAN-401", "l2vlan", descr="unrouted VLAN 401"),
            _row(4, "Lo0", "loopback"),
            _row(5, "Tu0", "tunnel"),
            _row(6, "NVI0", "virtual"),
            _row(7, "Po1", "lag"),
        ])
        sync_device_from_snmp(self.device, self.tenant)
        got = {
            i.name: (i.type, i.virtual)
            for i in Interface.objects.filter(device=self.device)
        }
        self.assertEqual(got, {
            "Gi1/0/1": ("", False),
            "Vl10": ("virtual", True),
            "VLAN-401": ("virtual", True),
            "Lo0": ("virtual", True),
            "Tu0": ("virtual", True),
            "NVI0": ("virtual", True),
            "Po1": ("lag", True),
        })

    def test_accepting_a_missing_l2vlan_creates_it_virtual(self):
        self._state([_row(3, "Vlan401", "l2vlan")])
        missing = [
            i for i in compute_device_drift(self.device, self.tenant)
            if i["kind"] == "interface_missing"
        ]
        self.assertEqual([m["name"] for m in missing], ["Vlan401"])
        self.assertTrue(apply_drift_action(self.device, self.tenant, missing[0]))
        iface = Interface.objects.get(device=self.device, name="Vlan401")
        self.assertEqual((iface.type, iface.virtual), ("virtual", True))


class ObservedVirtualBackfillTests(_Base):
    """monitoring 0107: blank-type rows SNMP reported as virtual kinds."""

    def _backfill(self):
        mig = importlib.import_module(
            "monitoring.migrations.0107_interface_virtual_from_snmp"
        )
        with connection.schema_editor() as editor:
            mig.flag_observed_virtual(apps, editor)

    def _flags(self, device=None):
        return dict(
            Interface.objects.filter(device=device or self.device)
            .values_list("name", "virtual")
        )

    def test_flags_blank_type_rows_the_poll_saw_as_virtual(self):
        self._state([
            _row(1, "Gi1/0/1", "ethernet", descr="GigabitEthernet1/0/1"),
            _row(2, "Vl10", "l3vlan", descr="Vlan10"),
            _row(3, "Vl20", "l2vlan"),
            _row(4, "Lo0", "loopback", descr="Loopback0"),
            _row(5, "Tu0", "tunnel"),
            _row(6, "Lo1", "loopback"),
            _row(7, "Po1", "lag"),
        ])
        for name in ("Gi1/0/1", "Vlan10", "VL20", "Loopback0", "Po1"):
            Interface.objects.create(device=self.device, name=name)
        # A type somebody chose is theirs, even against the poll.
        Interface.objects.create(device=self.device, name="Tu0", type="1000base-t")
        # Linked by SNMP name: the label differs from what the agent reports.
        Interface.objects.create(device=self.device, name="mgmt-loop", snmp_name="Lo1")
        # The same name on a device nobody polled stays as it is.
        other = Device.objects.create(tenant=self.tenant, name="sw2")
        Interface.objects.create(device=other, name="Vlan10")

        for _ in range(2):  # idempotent
            self._backfill()

        self.assertEqual(self._flags(), {
            "Gi1/0/1": False,
            "Vlan10": True,      # matched on ifDescr
            "VL20": True,        # case-insensitive
            "Loopback0": True,
            "Po1": True,
            "Tu0": False,
            "mgmt-loop": True,   # matched on its SNMP name
        })
        self.assertEqual(Interface.objects.get(device=self.device, name="Tu0").type,
                         "1000base-t")
        self.assertEqual(self._flags(other), {"Vlan10": False})

    def test_a_stack_poll_covers_every_member(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        member = Device.objects.create(tenant=self.tenant, name="sw1-2")
        Device.objects.filter(pk__in=[self.device.pk, member.pk]).update(
            virtual_chassis=vc
        )
        self._state([_row(2, "Vlan20", "l3vlan"), _row(3, "Gi2/0/1", "ethernet")])
        Interface.objects.create(device=member, name="Vlan20")
        Interface.objects.create(device=member, name="Gi2/0/1")
        self._backfill()
        self.assertEqual(self._flags(member), {"Vlan20": True, "Gi2/0/1": False})

    def test_another_tenants_state_never_reaches_across(self):
        org = Organization.objects.create(name="Other", slug="other")
        foreign = Tenant.objects.create(org=org, name="Other", slug="other")
        # A state row whose tenant disagrees with its device's (written
        # behind the API's back) is not trusted.
        self._state([_row(2, "Vlan10", "l3vlan")], tenant=foreign)
        Interface.objects.create(device=self.device, name="Vlan10")
        self._backfill()
        self.assertEqual(self._flags(), {"Vlan10": False})

    def test_odd_payloads_are_skipped(self):
        self._state({"not": "a list"})
        other = Device.objects.create(tenant=self.tenant, name="sw2")
        self._state(["junk", 7, {"name": "Lo0"}], device=other)
        Interface.objects.create(device=self.device, name="Lo0")
        Interface.objects.create(device=other, name="Lo0")
        self._backfill()
        self.assertEqual(self._flags(), {"Lo0": False})
        self.assertEqual(self._flags(other), {"Lo0": False})
