"""Linking a discovered SNMP name to a port the operator already created.

The link is a statement about naming, not an extra alias: it says the agent
reports this port as `eth0`, which also says the agent never reports the label.
Treating it as an alias made the linked port drift as "not seen on device"
forever — the exact opposite of what linking is for.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Interface, Manufacturer, Site
from api.test_utils import status_for
from auth_api.models import UserProfile
from core.models import Organization, Tenant
from monitoring.models import DeviceSnmp
from monitoring.snmp_drift import compute_device_drift


class _SnmpDriftTestBase(APITestCase):
    """Device + tenant fixture shared by the link/speed/ignore suites."""

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
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _observe(self, *names, **rich):
        """Record what the agent reported on the last poll. Plain names come
        as bare rows; pass ``rows=[{...}]`` for observations with facts."""
        DeviceSnmp.objects.update_or_create(
            device=self.device, tenant=self.tenant,
            defaults={
                "polled_at": timezone.now(),
                "data": {"sys_name": self.device.name},
                "interfaces": rich.get("rows") or [{"name": n} for n in names],
            },
        )

    def _drift(self):
        return compute_device_drift(self.device, self.tenant)

    def _kinds(self, name):
        return {d["kind"] for d in self._drift() if d.get("name") == name}

    def _link(self, iface, snmp_name):
        return self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/link-interface/",
            {"interface_id": str(iface.id), "snmp_name": snmp_name},
            format="json",
        )

class SnmpNameLinkTests(_SnmpDriftTestBase):
    def test_unlinked_pair_drifts_as_both_new_and_missing(self):
        """The problem linking exists to solve."""
        Interface.objects.create(device=self.device, name="IMM")
        self._observe("eth0")
        kinds = {d["kind"] for d in self._drift()}
        self.assertIn("interface_missing", kinds)  # eth0 is new to Danbyte
        self.assertIn("interface_stale", kinds)  # IMM isn't reported

    def test_link_collapses_the_pair_and_invents_no_phantom(self):
        iface = Interface.objects.create(device=self.device, name="IMM")
        self._observe("eth0")

        resp = self._link(iface, "eth0")
        self.assertEqual(resp.status_code, 200, resp.content)

        # Neither side drifts: eth0 is accounted for, and IMM is NOT expected
        # under its own label — that was the phantom.
        drift = self._drift()
        self.assertEqual(
            [d for d in drift if d["kind"] in ("interface_missing", "interface_stale")],
            [],
            drift,
        )

    def test_clearing_the_link_restores_both_drift_rows(self):
        iface = Interface.objects.create(device=self.device, name="IMM")
        self._observe("eth0")
        self._link(iface, "eth0")

        resp = self._link(iface, "")

        self.assertEqual(resp.status_code, 200, resp.content)
        iface.refresh_from_db()
        self.assertEqual(iface.snmp_name, "")
        kinds = {d["kind"] for d in self._drift()}
        self.assertIn("interface_missing", kinds)
        self.assertIn("interface_stale", kinds)

    def test_linking_onto_another_ports_real_name_is_refused(self):
        """The mistake that made this surface: eth0 exists in its own right."""
        Interface.objects.create(device=self.device, name="eth0")
        imm = Interface.objects.create(device=self.device, name="IMM")

        resp = self._link(imm, "eth0")

        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertIn("already an interface", str(resp.json()))
        imm.refresh_from_db()
        self.assertEqual(imm.snmp_name, "")

    def test_a_stored_bogus_link_does_not_evict_the_real_port(self):
        """Rows that predate the check still resolve sanely."""
        real = Interface.objects.create(device=self.device, name="eth0")
        imm = Interface.objects.create(device=self.device, name="IMM")
        # Written straight to the DB — the API now refuses this.
        Interface.objects.filter(pk=imm.pk).update(snmp_name="eth0")
        self._observe("eth0")

        drift = self._drift()

        # eth0 matches the port actually called eth0, so it is not "new"...
        self.assertNotIn(
            "eth0", [d.get("name") for d in drift if d["kind"] == "interface_missing"]
        )
        # ...and the real port is not reported stale either.
        stale = [
            d["interface_id"] for d in drift if d["kind"] == "interface_stale"
        ]
        self.assertNotIn(str(real.id), stale)

    def test_one_discovered_name_belongs_to_one_port(self):
        a = Interface.objects.create(device=self.device, name="Ethernet 1")
        b = Interface.objects.create(device=self.device, name="Ethernet 2")
        self._link(a, "eth0")

        self._link(b, "eth0")

        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual(a.snmp_name, "")
        self.assertEqual(b.snmp_name, "eth0")

    def test_link_needs_device_change_permission(self):
        iface = Interface.objects.create(device=self.device, name="IMM")
        self.client.logout()
        self.assertIn(self._link(iface, "eth0").status_code, (401, 403))

    def test_sync_honours_the_link(self):
        """The reported bug: sync matched labels only, so a linked port's
        observed row didn't match — sync created a DUPLICATE interface under
        the discovered name and hung the speed/facts on it, while the linked
        port received nothing but what per-item accepts had written."""
        imm = Interface.objects.create(device=self.device, name="IMM")
        self._link(imm, "eth0")
        self._observe(rows=[{
            "name": "eth0", "mac": "08:94:ef:00:dd:cc",
            "admin_status": "up", "speed_mbps": 1000,
        }])

        resp = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/sync/"
        )

        self.assertEqual(resp.status_code, 200, resp.content)
        # No duplicate: eth0 must NOT appear as a new interface.
        self.assertEqual(
            list(
                Interface.objects.filter(device=self.device)
                .values_list("name", flat=True)
            ),
            ["IMM"],
        )
        imm.refresh_from_db()
        self.assertEqual(imm.mac_address, "08:94:ef:00:dd:cc")
        self.assertEqual(imm.speed, "1 Gbps")
        self.assertTrue(imm.enabled)


class SpeedDriftTests(_SnmpDriftTestBase):
    """Speed drifts like MAC does — compared as a number, not a string."""

    def _speed_items(self):
        return [
            d for d in self._drift()
            if d["kind"] == "interface_mismatch" and d["field"] == "speed"
        ]

    def test_differing_speed_drifts_and_accept_writes_it(self):
        iface = Interface.objects.create(
            device=self.device, name="eth1", speed="1G"
        )
        self._observe(rows=[{"name": "eth1", "speed_mbps": 10000}])

        items = self._speed_items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["observed"], "10 Gbps")

        resp = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": items[0]}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        iface.refresh_from_db()
        self.assertEqual(iface.speed, "10 Gbps")

    def test_same_speed_in_different_costumes_is_not_drift(self):
        """"1G" vs "1 Gbps" vs 1000 Mbps — one value, three spellings."""
        Interface.objects.create(device=self.device, name="eth1", speed="1G")
        self._observe(rows=[{"name": "eth1", "speed_mbps": 1000}])
        self.assertEqual(self._speed_items(), [])

    def test_unparseable_intended_speed_is_left_alone(self):
        """Deliberate free text ("dual 10/25") is the operator's, not drift."""
        Interface.objects.create(
            device=self.device, name="eth1", speed="dual 10/25"
        )
        self._observe(rows=[{"name": "eth1", "speed_mbps": 10000}])
        self.assertEqual(self._speed_items(), [])

    def test_blank_intended_speed_drifts_so_accept_can_fill_it(self):
        Interface.objects.create(device=self.device, name="eth1")
        self._observe(rows=[{"name": "eth1", "speed_mbps": 25000}])
        items = self._speed_items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["observed"], "25 Gbps")


class SnmpIgnoreTests(_SnmpDriftTestBase):
    """`snmp_ignore` excludes a port from drift in both directions — for ports
    the polled agent can never report, which otherwise flag forever."""

    def test_ignored_port_is_not_reported_stale(self):
        Interface.objects.create(
            device=self.device, name="Ethernet 1", snmp_ignore=True
        )
        self._observe("eth0")
        self.assertEqual(
            [d for d in self._drift() if d["kind"] == "interface_stale"], []
        )

    def test_ignored_port_still_matches_and_produces_no_items(self):
        """It consumes its observed row (no phantom "new interface") but emits
        neither mismatch nor IP drift."""
        Interface.objects.create(
            device=self.device, name="eth0", mac_address="aa:aa:aa:aa:aa:aa",
            snmp_ignore=True,
        )
        self._observe(rows=[{
            "name": "eth0", "mac": "bb:bb:bb:bb:bb:bb",
            "admin_status": "up", "speed_mbps": 1000,
            "ip_addresses": ["10.9.0.1"],
        }])
        self.assertEqual(self._drift(), [])

    def test_sync_leaves_an_ignored_port_alone(self):
        iface = Interface.objects.create(
            device=self.device, name="eth0", mac_address="aa:aa:aa:aa:aa:aa",
            snmp_ignore=True,
        )
        self._observe(rows=[{
            "name": "eth0", "mac": "bb:bb:bb:bb:bb:bb", "speed_mbps": 1000,
        }])

        resp = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/sync/"
        )

        self.assertEqual(resp.status_code, 200, resp.content)
        iface.refresh_from_db()
        self.assertEqual(iface.mac_address, "aa:aa:aa:aa:aa:aa")
        self.assertEqual(iface.speed, "")
        # And no duplicate row was created for the observed name.
        self.assertEqual(
            Interface.objects.filter(device=self.device).count(), 1
        )
