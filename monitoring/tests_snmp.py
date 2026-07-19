"""Phase-1 SNMP discovery tests (issue #84): profiles + on-demand device poll
into the read-only observed-facts layer."""
from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    Location,
    Manufacturer,
    Site,
)
from core.models import Organization, Tenant
from monitoring.models import (
    DeviceSnmp, SnmpProfile, SnmpProfileBinding,
)
from danbyte_checks.snmp_facts import SnmpFactsError
from monitoring.snmp_resolve import resolve_device_profile

User = get_user_model()


class SnmpPhase1Tests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.device = Device.objects.create(tenant=self.tenant, name="r1")
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

    def test_profile_api_is_write_only_for_secrets(self):
        r = self.client.post(
            "/api/monitoring/snmp-profiles/",
            {"name": "Prod v2c", "version": "v2c",
             "secret_params": {"community": "public"}},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertNotIn("secret_params", body)   # never echoed back
        self.assertTrue(body["has_secrets"])
        self.assertEqual(body["slug"], "prod-v2c")

    @patch("danbyte_checks.snmp_facts.fetch_interfaces_sync")
    @patch("danbyte_checks.snmp_facts.fetch_system_facts_sync")
    def test_poll_stores_observed_facts_and_interfaces(self, mock_facts, mock_ifaces):
        mock_facts.return_value = {"sys_name": "r1.example", "sys_descr": "VendorOS 1.0"}
        mock_ifaces.return_value = [
            {"if_index": "1", "name": "Gi0/1", "oper_status": "up",
             "admin_status": "up", "speed_mbps": "1000", "mac": "00:11:22:33:44:55"},
        ]
        self._default_profile()
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp-poll/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["reachable"])
        self.assertEqual(body["data"]["sys_name"], "r1.example")
        self.assertEqual(len(body["interfaces"]), 1)
        self.assertEqual(body["interfaces"][0]["name"], "Gi0/1")
        self.assertIsNotNone(body["polled_at"])
        self.assertTrue(DeviceSnmp.objects.filter(device=self.device).exists())

        # Observed facts + interfaces are readable on the GET endpoint.
        g = self.client.get(f"/api/monitoring/devices/{self.device.id}/snmp/")
        self.assertEqual(g.json()["data"]["sys_descr"], "VendorOS 1.0")
        self.assertEqual(g.json()["interfaces"][0]["oper_status"], "up")

    @patch("danbyte_checks.snmp_facts.fetch_system_facts_sync", side_effect=SnmpFactsError("No response"))
    def test_poll_records_unreachable(self, _mock):
        self._default_profile()
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp-poll/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["reachable"])
        self.assertIn("No response", r.json()["error"])

    def test_poll_without_a_profile_is_rejected(self):
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp-poll/", {}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_snmp_state_empty_before_first_poll(self):
        g = self.client.get(f"/api/monitoring/devices/{self.device.id}/snmp/")
        self.assertEqual(g.status_code, 200)
        self.assertEqual(g.json()["data"], {})
        self.assertIsNone(g.json()["polled_at"])


class SnmpBindingTests(APITestCase):
    """Credential hierarchy: device → device role → device type → tenant default."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        man = Manufacturer.objects.create(tenant=self.tenant, name="Acme", slug="acme")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, name="X1", manufacturer=man
        )
        self.drole = DeviceRole.objects.create(
            tenant=self.tenant, name="Core", slug="core"
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="r1", device_type=self.dtype, role=self.drole
        )
        self.p_type = self._profile("type")
        self.p_role = self._profile("role")
        self.p_dev = self._profile("dev")
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _profile(self, name):
        return SnmpProfile.objects.create(
            tenant=self.tenant, name=name, slug=name, version="v2c",
            secret_params={"community": name},
        )

    def _bind(self, scope, object_id, profile):
        SnmpProfileBinding.objects.create(
            tenant=self.tenant, scope=scope, object_id=object_id, profile=profile
        )

    def test_resolution_is_most_specific_first(self):
        self._bind("device_type", self.dtype.id, self.p_type)
        self.assertEqual(resolve_device_profile(self.device, self.tenant)[0], self.p_type)

        self._bind("device_role", self.drole.id, self.p_role)
        self.assertEqual(resolve_device_profile(self.device, self.tenant)[0], self.p_role)

        self._bind("device", self.device.id, self.p_dev)
        profile, source = resolve_device_profile(self.device, self.tenant)
        self.assertEqual(profile, self.p_dev)
        self.assertEqual(source, "device")

    def test_binding_endpoint_put_get_delete(self):
        url = f"/api/monitoring/snmp-binding/device/{self.device.id}/"
        r = self.client.put(url, {"profile_id": str(self.p_dev.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["profile_id"], str(self.p_dev.id))
        self.assertEqual(r.json()["effective"]["source"], "device")

        self.assertEqual(
            self.client.get(url).json()["profile_id"], str(self.p_dev.id)
        )
        self.assertIsNone(self.client.delete(url).json()["profile_id"])

    def test_device_effective_inherits_from_type(self):
        self._bind("device_type", self.dtype.id, self.p_type)
        g = self.client.get(f"/api/monitoring/snmp-binding/device/{self.device.id}/")
        self.assertIsNone(g.json()["profile_id"])           # no direct device binding
        self.assertEqual(g.json()["effective"]["profile_id"], str(self.p_type.id))
        self.assertEqual(g.json()["effective"]["source"], "device_type")


class SnmpUtilizationTests(APITestCase):
    """Counter samples → utilisation series (#84, Phase 2)."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.device = Device.objects.create(tenant=self.tenant, name="r1")
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_utilization_rate_from_two_samples(self):
        from datetime import timedelta
        from django.utils import timezone
        from monitoring.models import SnmpInterfaceSample
        from monitoring.snmp_util import compute_device_utilization

        t0 = timezone.now()
        SnmpInterfaceSample.objects.create(
            tenant=self.tenant, device=self.device, if_index="1",
            in_octets=0, out_octets=0, speed_mbps=1000, sampled_at=t0,
        )
        # 1.25e9 bytes in 10s = 1e9 bps = a full 1 Gbps link → 100%.
        SnmpInterfaceSample.objects.create(
            tenant=self.tenant, device=self.device, if_index="1",
            in_octets=1_250_000_000, out_octets=0, speed_mbps=1000,
            sampled_at=t0 + timedelta(seconds=10),
        )
        util = compute_device_utilization(self.device)
        self.assertEqual(util["1"][-1]["in_pct"], 100.0)
        self.assertEqual(util["1"][-1]["out_pct"], 0.0)

    def test_utilization_endpoint(self):
        r = self.client.get(
            f"/api/monitoring/devices/{self.device.id}/snmp/utilization/"
        )
        self.assertEqual(r.status_code, 200)
        self.assertIn("interfaces", r.json())


class SnmpDriftTests(APITestCase):
    """Reconciliation: observed SNMP vs intended SoT, and accepting a diff (#84)."""

    def setUp(self):
        from django.utils import timezone
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.device = Device.objects.create(tenant=self.tenant, name="r1")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.device, reachable=True,
            polled_at=timezone.now(),
            data={"sys_name": "r1-core"},
            interfaces=[
                {"if_index": "1", "name": "Gi0/1",
                 "mac": "00:11:22:33:44:55", "admin_status": "up"},
            ],
        )
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _drift(self):
        return self.client.get(
            f"/api/monitoring/devices/{self.device.id}/snmp/drift/"
        ).json()["drift"]

    def _reconcile(self, action):
        return self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": action}, format="json",
        )

    def test_name_drift_then_accept_updates_device(self):
        drift = self._drift()
        name_item = next(d for d in drift if d["kind"] == "device_field")
        self.assertEqual(name_item["observed"], "r1-core")

        r = self._reconcile(name_item)
        self.assertEqual(r.status_code, 200, r.content)
        self.device.refresh_from_db()
        self.assertEqual(self.device.name, "r1-core")  # SoT updated only on accept

    def test_missing_interface_accept_creates_it(self):
        from api.models import Interface
        drift = self._drift()
        missing = next(d for d in drift if d["kind"] == "interface_missing")
        self.assertEqual(missing["name"], "Gi0/1")

        self._reconcile(missing)
        iface = Interface.objects.get(device=self.device, name="Gi0/1")
        self.assertEqual(iface.mac_address, "00:11:22:33:44:55")
        self.assertTrue(iface.enabled)

    def test_mac_mismatch_accept_updates_interface(self):
        from api.models import Interface
        iface = Interface.objects.create(
            device=self.device, name="Gi0/1", mac_address="aa:bb:cc:dd:ee:ff"
        )
        drift = self._drift()
        mismatch = next(
            d for d in drift
            if d["kind"] == "interface_mismatch" and d["field"] == "mac_address"
        )
        self.assertEqual(mismatch["observed"], "00:11:22:33:44:55")

        self._reconcile(mismatch)
        iface.refresh_from_db()
        self.assertEqual(iface.mac_address, "00:11:22:33:44:55")


class SnmpTopologyParseTests(APITestCase):
    """Pure LLDP/ARP/nmap parsers (#84, Phase 4) — no SNMP/nmap needed."""

    def test_parse_lldp_joins_local_port_and_remote(self):
        from danbyte_checks.snmp_facts import parse_lldp
        loc = {"5": "Gi0/5"}
        # rem-table index = timeMark.localPort.remIndex
        sysn = {"0.5.1": "switch-2"}
        pdesc = {"0.5.1": "Gi0/12"}
        out = parse_lldp(loc, sysn, pdesc, {})
        self.assertEqual(out, [{
            "local_port": "Gi0/5", "remote_device": "switch-2",
            "remote_port": "Gi0/12",
        }])

    def test_parse_arp_splits_index(self):
        from danbyte_checks.snmp_facts import parse_arp
        # index = ifIndex.a.b.c.d
        out = parse_arp({"2.10.0.0.5": "0x001122334455"})
        self.assertEqual(out[0]["ip"], "10.0.0.5")
        self.assertEqual(out[0]["if_index"], "2")
        self.assertEqual(out[0]["mac"], "00:11:22:33:44:55")

    def test_parse_nmap_grepable(self):
        from monitoring.nmap_sweep import parse_nmap_grepable
        sample = (
            "# Nmap scan\n"
            "Host: 10.0.0.5 ()\tStatus: Up\n"
            "Host: 10.0.0.6 (host6)\tStatus: Up\n"
            "Host: 10.0.0.7 ()\tStatus: Down\n"
        )
        self.assertEqual(parse_nmap_grepable(sample), ["10.0.0.5", "10.0.0.6"])


class NmapSweepTests(APITestCase):
    def setUp(self):
        from api.models import Prefix
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    @patch("monitoring.nmap_sweep.nmap_ping_sweep")
    def test_sweep_seeds_discovered_ips(self, mock_sweep):
        from api.models import IPAddress
        mock_sweep.return_value = ["10.0.0.5", "10.0.0.6"]
        r = self.client.post(
            f"/api/monitoring/prefixes/{self.prefix.id}/nmap-sweep/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 2)
        self.assertTrue(
            IPAddress.objects.filter(tenant=self.tenant, ip_address="10.0.0.5").exists()
        )

    @patch("monitoring.nmap_sweep.shutil.which", return_value=None)
    def test_sweep_without_nmap_returns_400(self, _which):
        # When nmap isn't on the host → graceful 400, not a 500. Mock its absence
        # so the test is deterministic regardless of whether the host has nmap.
        r = self.client.post(
            f"/api/monitoring/prefixes/{self.prefix.id}/nmap-sweep/", {}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("nmap", r.json()["detail"].lower())


class SnmpFleetDriftTests(APITestCase):
    """Tenant-wide SNMP drift list (the config-drift page's SNMP tab)."""

    def setUp(self):
        from django.utils import timezone
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        # The profile is bound per-device, so each device below has SNMP
        # *deliberately configured* (a device-scope binding) and shows in the list.
        self.profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="P", slug="p", secret_params={"community": "x"},
        )

        def _bind(device):
            SnmpProfileBinding.objects.create(
                tenant=self.tenant, scope=SnmpProfileBinding.SCOPE_DEVICE,
                object_id=device.id, profile=self.profile,
            )

        now = timezone.now()
        # A drifted device: observed name differs from intent, AND one interface
        # drifts on both MAC and admin-status (two mismatch items, one interface).
        self.drifted = Device.objects.create(tenant=self.tenant, name="sw-intended")
        Interface.objects.create(
            device=self.drifted, name="eth0",
            mac_address="00:00:00:00:00:01", enabled=True,
        )
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.drifted, reachable=True, polled_at=now,
            data={"sys_name": "sw-observed"},
            interfaces=[{"if_index": "1", "name": "eth0",
                         "mac": "00:00:00:00:00:02", "admin_status": "down"}],
        )
        # An in-sync device: observed name matches, no interfaces either side.
        self.synced = Device.objects.create(tenant=self.tenant, name="ok")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.synced, reachable=True, polled_at=now,
            data={"sys_name": "ok"}, interfaces=[],
        )
        # An unreachable device: should be its own status, never "in sync".
        self.down = Device.objects.create(tenant=self.tenant, name="down")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.down, reachable=False, polled_at=now,
            data={}, interfaces=[], error="timeout",
        )
        # reachable unknown (None) is not a confirmed poll → bucket as unreachable,
        # never "in sync".
        self.unknown = Device.objects.create(tenant=self.tenant, name="unknown")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.unknown, reachable=None, polled_at=now,
            data={}, interfaces=[],
        )
        for d in (self.drifted, self.synced, self.down, self.unknown):
            _bind(d)
        # Polled (e.g. via a tenant fallback) but with NO SNMP binding/default —
        # not deliberately configured, so it must NOT appear in the list.
        self.unconfigured = Device.objects.create(tenant=self.tenant, name="stray")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.unconfigured, reachable=False,
            polled_at=now, data={}, interfaces=[], error="timeout",
        )
        # A never-polled device: excluded from the list entirely.
        Device.objects.create(tenant=self.tenant, name="never")
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _list(self, status=None):
        url = "/api/monitoring/snmp-drift/"
        if status:
            url += f"?status={status}"
        return self.client.get(url).json()

    def test_lists_polled_devices_with_status(self):
        data = self._list()
        self.assertEqual(data["count"], 4)  # never-polled excluded
        by_name = {r["device_name"]: r for r in data["results"]}
        d = by_name["sw-intended"]
        self.assertEqual(d["status"], "drift")
        # name + 2 interface-mismatch items, but only ONE distinct interface.
        self.assertEqual(d["drift_count"], 3)
        self.assertEqual(d["by_kind"]["device_field"], 1)
        self.assertEqual(d["by_kind"]["interface_mismatch"], 2)
        self.assertEqual(d["interfaces_drifted"], 1)
        self.assertEqual(by_name["ok"]["status"], "in_sync")
        self.assertEqual(by_name["ok"]["drift_count"], 0)
        # Unreachable (False) and unknown (None) are both their own bucket —
        # never a misleading "in sync".
        self.assertEqual(by_name["down"]["status"], "unreachable")
        self.assertEqual(by_name["unknown"]["status"], "unreachable")

    def test_status_filter(self):
        self.assertEqual(self._list(status="drift")["count"], 1)
        self.assertEqual(self._list(status="in_sync")["count"], 1)
        self.assertEqual(self._list(status="unreachable")["count"], 2)

    def test_unconfigured_device_is_hidden(self):
        # The bound devices show; the polled-but-unbound "stray" does not.
        names = {r["device_name"] for r in self._list()["results"]}
        self.assertIn("down", names)
        self.assertNotIn("stray", names)


class SnmpIpLoopTests(APITestCase):
    """Accept SNMP-discovered IPs + the "Sync from SNMP" button (the IP loop)."""

    def setUp(self):
        from django.utils import timezone
        from api.models import Prefix
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.device = Device.objects.create(tenant=self.tenant, name="sw")
        self.eth0 = Interface.objects.create(device=self.device, name="eth0")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.device, reachable=True,
            polled_at=timezone.now(), data={"sys_name": "sw"},
            interfaces=[
                {"if_index": "1", "name": "eth0", "admin_status": "up",
                 "ip_addresses": ["10.0.0.5", "10.9.9.9"]},  # 2nd has no prefix
                {"if_index": "2", "name": "eth1", "admin_status": "up",
                 "mac": "00:11:22:33:44:55", "speed_mbps": "10000",
                 "ip_addresses": ["10.0.0.7"]},
            ],
        )
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _drift(self):
        return self.client.get(
            f"/api/monitoring/devices/{self.device.id}/snmp/drift/"
        ).json()["drift"]

    def test_observed_ip_shows_as_drift(self):
        by_ip = {d["ip"]: d for d in self._drift() if d["kind"] == "ip_missing"}
        self.assertIn("10.0.0.5", by_ip)
        self.assertIn("10.9.9.9", by_ip)
        # 10.0.0.5 is inside 10.0.0.0/24; 10.9.9.9 has no prefix → "Add prefix".
        self.assertTrue(by_ip["10.0.0.5"]["has_prefix"])
        self.assertFalse(by_ip["10.9.9.9"]["has_prefix"])
        self.assertEqual(by_ip["10.9.9.9"]["suggested_prefix"], "10.9.9.0/24")

    def test_accept_discovered_ip_assigns_it(self):
        from api.models import IPAddress
        item = next(d for d in self._drift()
                    if d["kind"] == "ip_missing" and d["ip"] == "10.0.0.5")
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": item}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        ip = IPAddress.objects.get(tenant=self.tenant, ip_address="10.0.0.5")
        self.assertEqual(ip.assigned_interface_id, self.eth0.id)
        self.assertEqual(ip.assigned_device_id, self.device.id)

    def test_accept_assigns_existing_unassigned_ip(self):
        from api.models import IPAddress
        # An IP that already exists (e.g. a primary IP) but isn't assigned — accept
        # should bind it, not duplicate it.
        existing = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="10.0.0.5"
        )
        item = next(d for d in self._drift()
                    if d["kind"] == "ip_missing" and d["ip"] == "10.0.0.5")
        self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": item}, format="json",
        )
        self.assertEqual(
            IPAddress.objects.filter(tenant=self.tenant, ip_address="10.0.0.5").count(),
            1,  # not duplicated
        )
        existing.refresh_from_db()
        self.assertEqual(existing.assigned_interface_id, self.eth0.id)

    def test_accept_ip_without_prefix_fails(self):
        item = next(d for d in self._drift()
                    if d["kind"] == "ip_missing" and d["ip"] == "10.9.9.9")
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": item}, format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_sync_creates_interfaces_and_assigns_ips(self):
        from api.models import IPAddress, Interface as Iface
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/sync/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        # eth1 created; 10.0.0.5 + 10.0.0.7 assigned; 10.9.9.9 skipped (no prefix).
        self.assertEqual(body["interfaces_created"], 1)
        self.assertEqual(body["ips_assigned"], 2)
        self.assertEqual(body["ips_skipped"], 1)
        eth1 = Iface.objects.get(device=self.device, name="eth1")
        self.assertEqual(eth1.speed, "10 Gbps")  # ifHighSpeed synced
        # The synced MAC became a first-class MACAddress object on the interface.
        from api.models import MACAddress
        self.assertTrue(
            MACAddress.objects.filter(
                tenant=self.tenant, assigned_interface=eth1,
                mac_address="00:11:22:33:44:55",
            ).exists()
        )
        self.assertEqual(
            IPAddress.objects.filter(tenant=self.tenant, assigned_device=self.device).count(),
            2,
        )

    def test_sync_requires_device_change(self):
        from auth_api.models import UserProfile
        u = User.objects.create_user("limited", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/sync/", {}, format="json"
        )
        # Row-scoped write fetch: a device outside the caller's device.change
        # scope 404s (non-leaking) — same contract as restrict_for_view.
        self.assertEqual(r.status_code, 404)


class SnmpVlanTests(APITestCase):
    """Q-BRIDGE VLAN read → parse, sync (find-or-create VLAN), and drift."""

    def test_parse_vlans_joins_bridge_port_to_ifindex(self):
        from danbyte_checks.snmp_facts import parse_vlans
        # bridge port 1 → ifIndex 10; port 1's PVID is 100; VLAN 100 is "users".
        out = parse_vlans({"1": "10"}, {"1": "100"}, {"100": "users"})
        self.assertEqual(out, {"10": {"vlan_id": "100", "vlan_name": "users"}})

    def _setup_device(self):
        from django.utils import timezone
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        device = Device.objects.create(tenant=tenant, name="sw")
        Interface.objects.create(device=device, name="eth0")
        DeviceSnmp.objects.create(
            tenant=tenant, device=device, reachable=True,
            polled_at=timezone.now(), data={"sys_name": "sw"},
            interfaces=[{"if_index": "1", "name": "eth0", "admin_status": "up",
                         "vlan": "100", "vlan_name": "users"}],
        )
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        return tenant, device

    def test_sync_creates_vlan_and_assigns_it(self):
        from api.models import VLAN
        tenant, device = self._setup_device()
        r = self.client.post(
            f"/api/monitoring/devices/{device.id}/snmp/sync/", {}, format="json"
        ).json()
        self.assertEqual(r["vlans_assigned"], 1)
        vlan = VLAN.objects.get(tenant=tenant, vlan_id=100)
        self.assertEqual(vlan.name, "users")
        Interface.objects.get(device=device, name="eth0", vlan=vlan)  # assigned

    def test_vlan_mismatch_drifts_and_accepts(self):
        from api.models import VLAN
        tenant, device = self._setup_device()
        drift = self.client.get(
            f"/api/monitoring/devices/{device.id}/snmp/drift/"
        ).json()["drift"]
        item = next(d for d in drift
                    if d["kind"] == "interface_mismatch" and d["field"] == "vlan")
        self.assertEqual(item["observed"], "100")
        r = self.client.post(
            f"/api/monitoring/devices/{device.id}/snmp/reconcile/",
            {"action": item}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        iface = Interface.objects.select_related("vlan").get(device=device, name="eth0")
        self.assertEqual(iface.vlan.vlan_id, 100)


class SnmpVrfScopedIpTests(APITestCase):
    """An interface's VRF scopes which prefix a discovered IP lands in, so
    overlapping IPs across VRFs don't collide."""

    def test_ip_lands_in_the_interfaces_vrf(self):
        from api.models import VRF, Prefix, IPAddress
        from monitoring.snmp_drift import _attach_observed_ip
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        vrf_a = VRF.objects.create(tenant=tenant, name="A")
        vrf_b = VRF.objects.create(tenant=tenant, name="B")
        # Same CIDR in two VRFs (overlapping address space).
        Prefix.objects.create(tenant=tenant, cidr="10.0.0.0/24", vrf=vrf_a)
        Prefix.objects.create(tenant=tenant, cidr="10.0.0.0/24", vrf=vrf_b)
        device = Device.objects.create(tenant=tenant, name="r")
        iface = Interface.objects.create(device=device, name="eth0", vrf=vrf_a)

        self.assertEqual(_attach_observed_ip(tenant, iface, "10.0.0.5"), "created")
        ip = IPAddress.objects.get(tenant=tenant, ip_address="10.0.0.5")
        # It went into VRF A's prefix (the interface's VRF), not B's.
        self.assertEqual(ip.prefix.vrf_id, vrf_a.id)
        self.assertEqual(ip.vrf_id, vrf_a.id)


class SnmpSpecialIpTests(APITestCase):
    """Loopback / link-local / unspecified / multicast are never imported."""

    def test_real_ip_classifier(self):
        from monitoring.snmp_drift import _real_ip
        for good in ("10.0.0.5", "192.168.1.1", "2001:db8::1"):
            self.assertTrue(_real_ip(good), good)
        for bad in ("127.0.0.1", "::1", "169.254.1.1", "fe80::1",
                    "0.0.0.0", "::", "224.0.0.1", "ff02::1", "not-an-ip"):
            self.assertFalse(_real_ip(bad), bad)


class SnmpTopologyGhostTests(APITestCase):
    """LLDP ghost edges + materialising one into a real Cable."""

    def setUp(self):
        from django.utils import timezone
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.a = Device.objects.create(tenant=self.tenant, name="sw-a")
        self.b = Device.objects.create(tenant=self.tenant, name="sw-b")
        self.ia = Interface.objects.create(device=self.a, name="eth1")
        self.ib = Interface.objects.create(device=self.b, name="eth1")
        # a sees b over LLDP (by name), no cable between them yet.
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.a, reachable=True,
            polled_at=timezone.now(), data={"sys_name": "sw-a"},
            neighbors=[{"local_port": "eth1", "remote_device": "sw-b",
                        "remote_port": "eth1"}],
        )
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_ghost_edge_between_lldp_neighbours(self):
        r = self.client.get("/api/monitoring/topology/ghosts/").json()
        self.assertEqual(len(r["edges"]), 1)
        e = r["edges"][0]
        self.assertEqual(e["type"], "ghost")
        self.assertEqual({e["source"], e["target"]},
                         {f"dev:{self.a.id}", f"dev:{self.b.id}"})

    def test_device_scoped_ghost_graph_has_nodes(self):
        # The device-detail map needs nodes for the focal device + its neighbours.
        r = self.client.get(
            f"/api/monitoring/topology/ghosts/?device={self.a.id}"
        ).json()
        names = {n["data"]["name"] for n in r["nodes"]}
        self.assertEqual(names, {"sw-a", "sw-b"})
        self.assertEqual(len(r["edges"]), 1)

    def test_no_ghost_when_already_cabled(self):
        from api.models import Cable, CableTermination
        cab = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cab, end="A", interface=self.ia)
        CableTermination.objects.create(cable=cab, end="B", interface=self.ib)
        r = self.client.get("/api/monitoring/topology/ghosts/").json()
        self.assertEqual(len(r["edges"]), 0)

    def test_materialize_creates_cable(self):
        from api.models import Cable
        r = self.client.post(
            "/api/monitoring/topology/materialize-cable/",
            {"source_device": str(self.a.id), "local_port": "eth1",
             "remote_device": str(self.b.id), "remote_port": "eth1",
             "type": "cat6"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        cab = Cable.objects.get(id=r.json()["cable_id"])
        self.assertEqual(cab.type, "cat6")
        # And it now suppresses the ghost.
        self.assertEqual(
            len(self.client.get("/api/monitoring/topology/ghosts/").json()["edges"]), 0
        )

    def test_materialize_missing_interface_is_400(self):
        r = self.client.post(
            "/api/monitoring/topology/materialize-cable/",
            {"source_device": str(self.a.id), "local_port": "eth1",
             "remote_device": str(self.b.id), "remote_port": "nope",
             "type": "cat6"}, format="json",
        )
        self.assertEqual(r.status_code, 400)


class SnmpHardeningTests(APITestCase):
    """Regressions for the review fixes: reconcile RBAC, default-profile
    uniqueness, credential fallback, MAC normalisation, double-accept, and
    Counter64-safe sampling."""

    def setUp(self):
        from django.utils import timezone
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.device = Device.objects.create(tenant=self.tenant, name="r1")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.device, reachable=True,
            polled_at=timezone.now(),
            data={"sys_name": "r1-core"},
            interfaces=[
                {"if_index": "1", "name": "Gi0/1",
                 "mac": "00:11:22:33:44:55", "admin_status": "up"},
            ],
        )

    def _as_member_without_change(self):
        """A non-super user who belongs to the tenant but has no device.change."""
        from auth_api.models import UserProfile
        u = User.objects.create_user("limited", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        return u

    def _grant_change(self, user):
        from auth_api.models import ObjectPermission
        p = ObjectPermission.objects.create(
            name="dev-change", object_types=["device"], actions=["change"],
        )
        p.users.add(user)

    def _reconcile(self, action):
        return self.client.post(
            f"/api/monitoring/devices/{self.device.id}/snmp/reconcile/",
            {"action": action}, format="json",
        )

    def test_reconcile_denied_without_device_change(self):
        # Accepting drift writes the SoT, so it needs device.change — the write
        # fetch is row-scoped to device.change, so a tenant member without it
        # 404s (non-leaking) rather than mutating the device.
        self._as_member_without_change()
        r = self._reconcile(
            {"kind": "device_field", "field": "name", "observed": "r1-core"}
        )
        self.assertEqual(r.status_code, 404, r.content)
        self.device.refresh_from_db()
        self.assertEqual(self.device.name, "r1")  # unchanged

    def test_reconcile_allowed_with_device_change(self):
        u = self._as_member_without_change()
        self._grant_change(u)
        r = self._reconcile(
            {"kind": "device_field", "field": "name", "observed": "r1-core"}
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.device.refresh_from_db()
        self.assertEqual(self.device.name, "r1-core")

    def test_setting_a_new_default_demotes_the_previous(self):
        a = SnmpProfile.objects.create(
            tenant=self.tenant, name="A", slug="a",
            secret_params={"community": "a"}, is_default=True,
        )
        b = SnmpProfile.objects.create(
            tenant=self.tenant, name="B", slug="b",
            secret_params={"community": "b"}, is_default=True,
        )
        a.refresh_from_db()
        self.assertFalse(a.is_default)  # demoted
        self.assertTrue(SnmpProfile.objects.get(pk=b.pk).is_default)
        self.assertEqual(
            SnmpProfile.objects.filter(tenant=self.tenant, is_default=True).count(), 1
        )

    def test_resolve_returns_none_when_ambiguous(self):
        # Two profiles, neither default, no binding → don't guess credentials.
        for n in ("A", "B"):
            SnmpProfile.objects.create(
                tenant=self.tenant, name=n, slug=n.lower(),
                secret_params={"community": n},
            )
        profile, source = resolve_device_profile(self.device, self.tenant)
        self.assertIsNone(profile)
        self.assertIsNone(source)

    def test_mac_drift_ignores_separator_format(self):
        from api.models import Interface
        # Same physical address, Cisco dotted form — must NOT read as drift.
        Interface.objects.create(
            device=self.device, name="Gi0/1", mac_address="0011.2233.4455",
        )
        self.client.force_login(User.objects.create_superuser("a", "a@b.c", "x"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        items = self.client.get(
            f"/api/monitoring/devices/{self.device.id}/snmp/drift/"
        ).json()["drift"]
        self.assertFalse(
            any(d.get("kind") == "interface_mismatch" and d.get("field") == "mac_address"
                for d in items)
        )

    def test_interface_missing_double_accept_is_clean_400(self):
        from api.models import Interface
        Interface.objects.create(device=self.device, name="Gi0/1")
        # Item says Gi0/1 is "missing", but a row already exists → clean 400.
        u = User.objects.create_superuser("a", "a@b.c", "x")
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self._reconcile(
            {"kind": "interface_missing", "name": "Gi0/1",
             "observed": {"mac": "00:11:22:33:44:55", "admin_status": "up"}}
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_counter64_value_above_signed_bigint_persists(self):
        from django.utils import timezone
        from monitoring.snmp_util import record_samples
        from monitoring.models import SnmpInterfaceSample
        big = 10_000_000_000_000_000_000  # 1e19 > signed bigint max (9.2e18)
        n = record_samples(
            self.device, self.tenant,
            [{"if_index": "1", "in_octets": big, "out_octets": big, "speed_mbps": 1000}],
            timezone.now(),
        )
        self.assertEqual(n, 1)
        sample = SnmpInterfaceSample.objects.get(device=self.device, if_index="1")
        self.assertEqual(int(sample.in_octets), big)


class SnmpSiteLocationBindingTests(APITestCase):
    """Site/location-scoped SNMP creds — an Outpost polls a site's devices with
    site-scoped credentials. Hierarchy: device → role → type → location
    (→ parents) → site → tenant default."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="branch")
        self.parent_loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Bldg A", slug="bldg-a"
        )
        self.child_loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Rack 3", slug="rack-3",
            parent=self.parent_loc,
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="r1", site=self.site, location=self.child_loc
        )
        self.p_site = self._profile("site")
        self.p_loc = self._profile("loc")
        self.p_dev = self._profile("dev")
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _profile(self, name):
        return SnmpProfile.objects.create(
            tenant=self.tenant, name=name, slug=name, version="v2c",
            secret_params={"community": name},
        )

    def _bind(self, scope, object_id, profile):
        SnmpProfileBinding.objects.create(
            tenant=self.tenant, scope=scope, object_id=object_id, profile=profile
        )

    def test_site_binding_resolves_for_device_at_site(self):
        self._bind("site", self.site.id, self.p_site)
        profile, source = resolve_device_profile(self.device, self.tenant)
        self.assertEqual(profile, self.p_site)
        self.assertEqual(source, "site")

    def test_parent_location_binding_wins_over_site(self):
        self._bind("site", self.site.id, self.p_site)
        # Bound on the *parent* location — inherited by the device in the child.
        self._bind("location", self.parent_loc.id, self.p_loc)
        profile, source = resolve_device_profile(self.device, self.tenant)
        self.assertEqual(profile, self.p_loc)
        self.assertEqual(source, "location")

    def test_device_binding_wins_over_location_and_site(self):
        self._bind("site", self.site.id, self.p_site)
        self._bind("location", self.parent_loc.id, self.p_loc)
        self._bind("device", self.device.id, self.p_dev)
        self.assertEqual(
            resolve_device_profile(self.device, self.tenant)[0], self.p_dev
        )

    def test_binding_endpoint_accepts_site_scope(self):
        url = f"/api/monitoring/snmp-binding/site/{self.site.id}/"
        r = self.client.put(url, {"profile_id": str(self.p_site.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["profile_id"], str(self.p_site.id))
        self.assertEqual(
            self.client.get(url).json()["profile_id"], str(self.p_site.id)
        )
