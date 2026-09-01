"""SNMP-discovered link aggregation: aggregates arrive typed "lag", and each
port's bundle membership drifts against the `lag` it has in Danbyte."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Interface, VirtualChassis
from core.models import Organization, Tenant
from danbyte_checks.snmp_facts import parse_lag_membership
from monitoring.models import DeviceSnmp, MonitoringSettings
from monitoring.snmp_drift import (
    apply_drift_action,
    compute_device_drift,
    sync_device_from_snmp,
)


class ParseLagMembershipTests(APITestCase):
    def test_lag_mib_only(self):
        self.assertEqual(
            parse_lag_membership({"1": "10", "2": "10", "3": "0", "10": "10"}, {}, {}),
            {"1": "10", "2": "10"},
        )

    def test_ifstack_fallback_needs_a_lag_higher_layer(self):
        stack = {"10.1": "1", "10.2": "active", "20.3": "1", "0.4": "1", "10.5": "2"}
        types = {"10": "161", "20": "135"}
        self.assertEqual(parse_lag_membership({}, stack, types), {"1": "10", "2": "10"})

    def test_lag_mib_wins_over_ifstack(self):
        out = parse_lag_membership({"1": "11"}, {"10.1": "1"}, {"10": "161", "11": "161"})
        self.assertEqual(out, {"1": "11"})


def _observed(**overrides):
    row = {"if_index": "1", "name": "Gi0/1", "mac": "", "admin_status": "up",
           "type_name": "ethernet"}
    row.update(overrides)
    return row


PO = {"if_index": "10", "name": "Po1", "descr": "Port-channel1", "type_name": "lag",
      "admin_status": "up"}


class LagDriftTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        self.port = Interface.objects.create(device=self.device, name="Gi0/1")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _state(self, interfaces, device=None):
        return DeviceSnmp.objects.create(
            tenant=self.tenant, device=device or self.device, reachable=True,
            polled_at=timezone.now(), data={"sys_name": "sw1"},
            interfaces=interfaces,
        )

    def _items(self, kind, state=None):
        return [
            i for i in compute_device_drift(self.device, self.tenant, state=state)
            if i["kind"] == kind
        ]

    def test_accepting_an_aggregate_creates_it_typed_lag(self):
        self._state([PO, _observed(lag_if_index="10")])
        missing = self._items("interface_missing")
        self.assertEqual([m["name"] for m in missing], ["Po1"])
        self.assertEqual(missing[0]["observed"]["type_name"], "lag")
        self.assertTrue(apply_drift_action(self.device, self.tenant, missing[0]))
        po = Interface.objects.get(device=self.device, name="Po1")
        self.assertEqual(po.type, "lag")
        self.assertTrue(po.virtual)

    def test_membership_item_and_accept_links_the_port(self):
        po = Interface.objects.create(device=self.device, name="Po1", type="lag")
        self._state([PO, _observed(lag_if_index="10")])
        items = self._items("lag_membership")
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual((item["name"], item["intended"], item["observed"]),
                         ("Gi0/1", "-", "Po1"))
        self.assertEqual(item["lag_interface_id"], str(po.id))
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": item}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.port.refresh_from_db()
        self.assertEqual(self.port.lag_id, po.id)
        # In sync now - nothing more to report.
        self.assertEqual(self._items("lag_membership"), [])

    def test_missing_aggregate_cannot_be_applied(self):
        self._state([PO, _observed(lag_if_index="10")])
        item = self._items("lag_membership")[0]
        self.assertIsNone(item["lag_interface_id"])
        self.assertFalse(apply_drift_action(self.device, self.tenant, item))
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": item}, format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_removal_clears_membership(self):
        po = Interface.objects.create(device=self.device, name="Po1", type="lag")
        self.port.lag = po
        self.port.save()
        self._state([PO, _observed(lag_if_index="")])
        item = self._items("lag_membership")[0]
        self.assertEqual((item["intended"], item["observed"]), ("Po1", "-"))
        self.assertTrue(apply_drift_action(self.device, self.tenant, item))
        self.port.refresh_from_db()
        self.assertIsNone(self.port.lag_id)

    def test_rows_without_the_key_say_nothing(self):
        po = Interface.objects.create(device=self.device, name="Po1", type="lag")
        self.port.lag = po
        self.port.save()
        self._state([PO, _observed()])  # an older agent: no lag_if_index at all
        self.assertEqual(self._items("lag_membership"), [])

    def test_update_only_still_reports_membership(self):
        settings = MonitoringSettings.for_tenant(self.tenant)
        settings.snmp_update_only = True
        settings.save()
        Interface.objects.create(device=self.device, name="Po1", type="lag")
        self._state([PO, _observed(lag_if_index="10")])
        self.assertEqual(self._items("interface_missing"), [])
        self.assertEqual(len(self._items("lag_membership")), 1)

    def test_sync_creates_the_aggregate_and_links_members(self):
        self._state([PO, _observed(lag_if_index="10")])
        summary = sync_device_from_snmp(self.device, self.tenant)
        self.assertEqual(summary["lag_memberships"], 1)
        po = Interface.objects.get(device=self.device, name="Po1")
        self.assertEqual(po.type, "lag")
        self.port.refresh_from_db()
        self.assertEqual(self.port.lag_id, po.id)

    def test_stack_matches_the_master_aggregate_by_name(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        master = Device.objects.create(tenant=self.tenant, name="sw0", virtual_chassis=vc)
        Device.objects.filter(pk=self.device.pk).update(virtual_chassis=vc)
        self.device.refresh_from_db()
        po = Interface.objects.create(device=master, name="Po1", type="lag")
        self.port.lag = po
        self.port.save()
        # The member device reports Po1 too (a stack shows it everywhere).
        self._state([PO, _observed(lag_if_index="10")])
        self.assertEqual(self._items("lag_membership"), [])
        # Unlinked: the item resolves the master's aggregate across the stack.
        self.port.lag = None
        self.port.save()
        item = self._items("lag_membership")[0]
        self.assertEqual(item["lag_interface_id"], str(po.id))
        self.assertTrue(apply_drift_action(self.device, self.tenant, item))
        self.port.refresh_from_db()
        self.assertEqual(self.port.lag_id, po.id)

    def test_accept_promotes_an_untyped_aggregate(self):
        po = Interface.objects.create(device=self.device, name="Po1", type="")
        self._state([PO, _observed(lag_if_index="10")])
        item = self._items("lag_membership")[0]
        self.assertTrue(apply_drift_action(self.device, self.tenant, item))
        po.refresh_from_db()
        self.assertEqual((po.type, po.virtual), ("lag", True))

    def test_physically_typed_aggregate_is_refused(self):
        Interface.objects.create(device=self.device, name="Po1", type="1000base-t")
        self._state([PO, _observed(lag_if_index="10")])
        item = self._items("lag_membership")[0]
        self.assertFalse(apply_drift_action(self.device, self.tenant, item))
