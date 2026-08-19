"""The OID explorer: a flat walk reshaped into the table it came from.

Fixtures mirror a real Lenovo IMM power-supply table, whose values are
*strings* ("Normal"), not the integer enums a lot of MIB tooling assumes.
"""
from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site
from api.test_utils import status_for
from auth_api.models import UserProfile
from core.models import Organization, Tenant
from danbyte_checks.snmp_facts import SnmpFactsError
from monitoring.models import SnmpProfile

# Base "…11.2.1": column .2 names the PSU, .5 is its serial, .6 is health.
PSU_TABLE = {
    "1.0": "0", "2.0": "Power System", "5.0": "Unknown", "6.0": "Normal",
    "1.1": "1", "2.1": "Power Supply 1", "5.1": "K135155D0K2", "6.1": "Normal",
    "1.2": "2", "2.2": "Power Supply 2", "5.2": "K135155D0K5", "6.2": "Normal",
}


class OidWalkTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Lenovo", slug="lenovo")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="x3650")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Server", slug="server")
        self.device = Device.objects.create(
            tenant=self.tenant, name="srv1", device_type=dt, site=site,
            role=role, status=status_for(self.tenant),
        )
        self.profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="p", version="v2c",
            params={"community": "public", "port": 161},
        )
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _walk(self, payload):
        return self.client.post(
            f"/api/monitoring/devices/{self.device.id}/oid-walk/",
            payload, format="json",
        )

    def _reachable(self):
        """Give the walker something to resolve without touching DNS."""
        return patch("monitoring.oid_walk._device_target", return_value="10.0.0.9")

    def _profile(self):
        return patch(
            "monitoring.oid_walk.resolve_device_profile",
            return_value=(self.profile, None),
        )

    @staticmethod
    def _children(base, subs, depth=1):
        """Fake a one-level listing: `depth` is how far below each child its
        first value sits - 1 marks a table column, more marks a branch."""
        return patch(
            "monitoring.oid_walk.list_oid_children_sync",
            return_value=[
                {
                    "sub": s,
                    "oid": f"{base}.{s}",
                    "first_oid": f"{base}.{s}" + ".1" * depth,
                    "sample": "x",
                }
                for s in subs
            ],
        )

    def test_table_entry_is_reshaped_into_rows_and_columns(self):
        with self._reachable(), self._profile(), self._children(
            "1.3.6.1.4.1.2.3.51.3.1.11.2.1", ["1", "2", "5", "6"]
        ), patch("monitoring.oid_walk.fetch_oid_sync", return_value=PSU_TABLE):
            resp = self._walk({"oid": "1.3.6.1.4.1.2.3.51.3.1.11.2.1"})

        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["error"], "")
        self.assertTrue(body["is_table"])
        self.assertEqual([c["column"] for c in body["columns"]], ["1", "2", "5", "6"])
        self.assertEqual([r["index"] for r in body["rows"]], ["0", "1", "2"])
        # The health column: one distinct value across every row.
        health = next(c for c in body["columns"] if c["column"] == "6")
        self.assertEqual(health["oid"], "1.3.6.1.4.1.2.3.51.3.1.11.2.1.6")
        self.assertEqual(health["distinct"], ["Normal"])
        self.assertEqual(health["filled"], 3)
        # A row keeps its columns together, which is the whole point.
        row1 = next(r for r in body["rows"] if r["index"] == "1")
        self.assertEqual(row1["values"]["2"], "Power Supply 1")
        self.assertEqual(row1["values"]["6"], "Normal")

    def test_columns_sort_numerically_not_lexically(self):
        with self._reachable(), self._profile(), self._children(
            "1.2.3", ["1", "2", "10"]
        ), patch(
            "monitoring.oid_walk.fetch_oid_sync",
            return_value={"2.1": "a", "10.1": "b", "1.1": "c"},
        ):
            body = self._walk({"oid": "1.2.3"}).json()
        self.assertEqual([c["column"] for c in body["columns"]], ["1", "2", "10"])

    def test_branch_is_browsed_not_transposed(self):
        """The bug this split fixes: reading `1.3.6.1.4.1` as a table treated
        each vendor's enterprise number as a "column", collapsing every vendor
        into one nonsense column of unrelated values."""
        with self._reachable(), self._profile(), self._children(
            "1.3.6.1.4.1", ["2", "2021", "8072"], depth=7
        ), patch("monitoring.oid_walk.fetch_oid_sync") as fetch:
            body = self._walk({"oid": "1.3.6.1.4.1"}).json()

        self.assertFalse(body["is_table"])
        self.assertEqual([c["sub"] for c in body["children"]], ["2", "2021", "8072"])
        self.assertEqual(body["columns"], [])
        # No subtree walk at all - browsing a branch is one GETNEXT per child,
        # which is what makes a high base navigable instead of budget-capped.
        fetch.assert_not_called()

    def test_a_single_child_is_a_branch_not_a_one_column_table(self):
        """1.3.6.1.4.1.2.3.51 has exactly one child - descend, don't transpose."""
        with self._reachable(), self._profile(), self._children(
            "1.3.6.1.4.1.2.3.51", ["3"], depth=1
        ), patch("monitoring.oid_walk.fetch_oid_sync") as fetch:
            body = self._walk({"oid": "1.3.6.1.4.1.2.3.51"}).json()
        self.assertFalse(body["is_table"])
        fetch.assert_not_called()

    def test_empty_subtree_reports_nothing_found(self):
        with self._reachable(), self._profile(), patch(
            "monitoring.oid_walk.list_oid_children_sync", return_value=[]
        ):
            body = self._walk({"oid": "1.2.3"}).json()
        self.assertEqual(body["children"], [])
        self.assertEqual(body["rows"], [])

    def test_scalar_get_returns_one_cell(self):
        with self._reachable(), self._profile(), patch(
            "monitoring.oid_walk.fetch_oid_sync", return_value={"0": "Linux TEST"}
        ):
            body = self._walk({"oid": "1.3.6.1.2.1.1.1.0", "walk": False}).json()
        self.assertFalse(body["walk"])
        self.assertEqual(body["rows"], [{"index": "0", "values": {"": "Linux TEST"}}])

    def test_non_numeric_oid_is_refused_without_touching_the_network(self):
        with self._reachable(), self._profile(), patch(
            "monitoring.oid_walk.list_oid_children_sync"
        ) as children:
            body = self._walk({"oid": "sysDescr.0"}).json()
        children.assert_not_called()
        self.assertIn("numeric OIDs only", body["error"])

    def test_snmp_failure_comes_back_as_error_not_500(self):
        with self._reachable(), self._profile(), patch(
            "monitoring.oid_walk.list_oid_children_sync",
            side_effect=SnmpFactsError("snmp error: timed out"),
        ):
            resp = self._walk({"oid": "1.2.3"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("timed out", resp.json()["error"])

    def test_missing_profile_is_explained(self):
        with self._reachable(), patch(
            "monitoring.oid_walk.resolve_device_profile", return_value=(None, None)
        ):
            body = self._walk({"oid": "1.2.3"}).json()
        self.assertIn("no SNMP profile", body["error"])

    def test_unreachable_device_is_explained(self):
        with self._profile(), patch(
            "monitoring.oid_walk._device_target", return_value=None
        ):
            body = self._walk({"oid": "1.2.3"}).json()
        self.assertIn("no reachable address", body["error"])

    def test_requires_authentication(self):
        self.client.logout()
        self.assertIn(self._walk({"oid": "1.2.3"}).status_code, (401, 403))
