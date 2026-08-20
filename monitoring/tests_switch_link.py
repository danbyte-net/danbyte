"""IP → switch / switch-interface link: parse, serializer, SNMP suggest+accept."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Interface, IPAddress, Prefix
from core.models import Organization, Tenant
from danbyte_checks.snmp_facts import parse_fdb
from monitoring.models import DeviceSnmp
from monitoring.snmp_drift import compute_device_drift


class ParseFdbTests(APITestCase):
    def test_joins_mac_octets_and_bridge_port_ifindex(self):
        # dot1dTpFdbPort: MAC octets → bridge port; base map: bridge port → ifIndex
        fdb_port = {"0.17.34.51.68.85": "3"}
        base = {"3": "10"}
        out = parse_fdb(fdb_port, base)
        self.assertEqual(out, [{"mac": "00:11:22:33:44:55", "if_index": "10"}])

    def test_drops_ports_without_ifindex(self):
        self.assertEqual(parse_fdb({"0.17.34.51.68.85": "9"}, {}), [])


def _status(tenant):
    from api.models import IPStatus

    return IPStatus.objects.create(tenant=tenant, name="Active", slug="active")


class SwitchLinkSerializerTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.sw = Device.objects.create(tenant=self.tenant, name="sw1")
        self.port = Interface.objects.create(device=self.sw, name="Gi0/1")
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_set_switch_interface_forces_switch(self):
        ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="10.0.0.5"
        )
        r = self.client.patch(
            f"/api/ips/{ip.id}/",
            {"switch_interface_id": str(self.port.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        ip.refresh_from_db()
        self.assertEqual(ip.switch_interface_id, self.port.id)
        self.assertEqual(ip.switch_id, self.sw.id)  # derived from the port
        # serialized read exposes the nested switch + switch_interface
        body = r.json()
        self.assertEqual(body["switch"]["name"], "sw1")
        self.assertEqual(body["switch_interface"]["name"], "Gi0/1")


class SwitchLinkDriftTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.sw = Device.objects.create(tenant=self.tenant, name="sw1")
        self.port = Interface.objects.create(device=self.sw, name="Gi0/1")
        # The host IP Danbyte already tracks, sitting behind the switch port.
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="10.0.0.5"
        )
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.sw, reachable=True,
            polled_at=timezone.now(),
            interfaces=[{"if_index": "10", "name": "Gi0/1"}],
            arp=[{"ip": "10.0.0.5", "mac": "00:11:22:33:44:55", "if_index": "10"}],
            fdb=[{"mac": "00:11:22:33:44:55", "if_index": "10"}],
        )
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_suggests_switch_link_from_arp_and_fdb(self):
        items = compute_device_drift(self.sw, self.tenant)
        sl = [i for i in items if i["kind"] == "switch_link_suggested"]
        self.assertEqual(len(sl), 1)
        self.assertEqual(sl[0]["ip"], "10.0.0.5")
        self.assertEqual(sl[0]["interface_id"], str(self.port.id))

    def test_accept_sets_the_link(self):
        items = compute_device_drift(self.sw, self.tenant)
        sl = next(i for i in items if i["kind"] == "switch_link_suggested")
        r = self.client.post(
            f"/api/monitoring/devices/{self.sw.id}/snmp/reconcile/",
            {"action": sl}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.switch_id, self.sw.id)
        self.assertEqual(self.ip.switch_interface_id, self.port.id)

    def test_no_suggestion_once_linked(self):
        self.ip.switch = self.sw
        self.ip.switch_interface = self.port
        self.ip.save()
        items = compute_device_drift(self.sw, self.tenant)
        self.assertFalse(
            [i for i in items if i["kind"] == "switch_link_suggested"]
        )

    def _suggestions(self):
        items = compute_device_drift(self.sw, self.tenant)
        return [i for i in items if i["kind"] == "switch_link_suggested"]

    def test_trunk_port_learning_many_macs_is_skipped(self):
        # Issue #22: an uplink learns every MAC behind it - a port over the
        # limit must never claim hosts that hang off another switch.
        state = DeviceSnmp.objects.get(device=self.sw)
        state.fdb = [{"mac": "00:11:22:33:44:55", "if_index": "10"}] + [
            {"mac": f"00:11:22:33:44:{i:02x}", "if_index": "10"}
            for i in range(80, 85)
        ]
        state.save(update_fields=["fdb"])
        self.assertEqual(self._suggestions(), [])

    def test_lag_member_and_aggregate_are_skipped(self):
        agg = Interface.objects.create(
            device=self.sw, name="Po1", virtual=True
        )
        self.port.lag = agg
        self.port.save(update_fields=["lag"])
        self.assertEqual(self._suggestions(), [])
        # The aggregate itself (bridge-agg ports report FDB on the LAG ifindex)
        # is skipped too.
        state = DeviceSnmp.objects.get(device=self.sw)
        state.interfaces = [{"if_index": "10", "name": "Po1"}]
        state.save(update_fields=["interfaces"])
        self.assertEqual(self._suggestions(), [])

    def test_port_facing_another_polled_switch_is_skipped(self):
        sw2 = Device.objects.create(tenant=self.tenant, name="sw2")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=sw2, reachable=True,
            polled_at=timezone.now(),
            fdb=[{"mac": "aa:bb:cc:dd:ee:ff", "if_index": "1"}],
        )
        state = DeviceSnmp.objects.get(device=self.sw)
        state.neighbors = [
            {"local_port": "Gi0/1", "remote_device": "sw2", "remote_port": "Gi0/24"}
        ]
        state.save(update_fields=["neighbors"])
        self.assertEqual(self._suggestions(), [])

    def test_manual_uplink_flag_is_skipped(self):
        self.port.is_uplink = True
        self.port.save(update_fields=["is_uplink"])
        self.assertEqual(self._suggestions(), [])

    def test_arp_source_device_feeds_suggestions(self):
        # "One ARP source" mode: the switch's own ARP is ignored; the named
        # gateway's table supplies the IP↔MAC pairs joined with this FDB.
        from monitoring.models import MonitoringSettings

        gw = Device.objects.create(tenant=self.tenant, name="gw")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=gw, reachable=True,
            polled_at=timezone.now(),
            arp=[{"ip": "10.0.0.5", "mac": "00:11:22:33:44:55", "if_index": "1"}],
        )
        settings = MonitoringSettings.for_tenant(self.tenant)
        settings.arp_source_devices.add(gw)

        # Blank the switch's own ARP - pure-L2 reality. The suggestion must
        # still appear, driven by the gateway's table.
        state = DeviceSnmp.objects.get(device=self.sw)
        state.arp = []
        state.save(update_fields=["arp"])
        sl = self._suggestions()
        self.assertEqual(len(sl), 1)
        self.assertEqual(sl[0]["ip"], "10.0.0.5")

    def test_lldp_to_non_bridging_neighbor_still_suggests(self):
        # A server or phone announcing LLDP must not mute the port - only a
        # neighbour we know bridges (has an FDB) marks it as an uplink.
        state = DeviceSnmp.objects.get(device=self.sw)
        state.neighbors = [
            {"local_port": "Gi0/1", "remote_device": "some-server", "remote_port": "eno1"}
        ]
        state.save(update_fields=["neighbors"])
        self.assertEqual(len(self._suggestions()), 1)

    def test_multiple_arp_sources_merge(self):
        """Issue #39: two firewalls each route part of the network - both
        tables feed the suggestions, unioned."""
        from monitoring.models import MonitoringSettings

        fw1 = Device.objects.create(tenant=self.tenant, name="fw-a")
        fw2 = Device.objects.create(tenant=self.tenant, name="fw-b")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=fw1, reachable=True,
            polled_at=timezone.now(),
            arp=[{"ip": "10.0.0.5", "mac": "00:11:22:33:44:55", "if_index": "1"}],
        )
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=fw2, reachable=True,
            polled_at=timezone.now(),
            arp=[{"ip": "10.0.0.6", "mac": "66:77:88:99:aa:bb", "if_index": "1"}],
        )
        ip2 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.6", prefix=self.prefix
        )
        settings = MonitoringSettings.for_tenant(self.tenant)
        settings.arp_source_devices.add(fw1, fw2)

        Interface.objects.create(device=self.sw, name="Gi0/2")
        state = DeviceSnmp.objects.get(device=self.sw)
        state.arp = []  # pure L2: the switch itself knows nothing
        state.interfaces = [
            {"if_index": "10", "name": "Gi0/1"},
            {"if_index": "11", "name": "Gi0/2"},
        ]
        state.fdb = [
            {"mac": "00:11:22:33:44:55", "if_index": "10"},
            {"mac": "66:77:88:99:aa:bb", "if_index": "11"},
        ]
        state.save(update_fields=["arp", "interfaces", "fdb"])

        got = {s_["ip"] for s_ in self._suggestions()}
        self.assertEqual(got, {"10.0.0.5", "10.0.0.6"})
        self.assertIsNotNone(ip2)

    def test_conflicting_sources_are_deterministic(self):
        """Two gateways claiming the same MAC: the device-name-ordered first
        answer wins, every poll, rather than flapping between the two."""
        from monitoring.models import MonitoringSettings

        fw_a = Device.objects.create(tenant=self.tenant, name="a-fw")
        fw_z = Device.objects.create(tenant=self.tenant, name="z-fw")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=fw_z, reachable=True,
            polled_at=timezone.now(),
            arp=[{"ip": "10.0.0.9", "mac": "00:11:22:33:44:55", "if_index": "1"}],
        )
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=fw_a, reachable=True,
            polled_at=timezone.now(),
            arp=[{"ip": "10.0.0.5", "mac": "00:11:22:33:44:55", "if_index": "1"}],
        )
        # Both candidate IPs are tracked, so whichever source won would be
        # suggested - the assertion is meaningful, not vacuous.
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.9", prefix=self.prefix
        )
        settings = MonitoringSettings.for_tenant(self.tenant)
        settings.arp_source_devices.add(fw_a, fw_z)

        state = DeviceSnmp.objects.get(device=self.sw)
        state.arp = []
        state.save(update_fields=["arp"])

        got = {s_["ip"] for s_ in self._suggestions()}
        self.assertEqual(got, {"10.0.0.5"})  # a-fw sorts first and wins

    def test_settings_api_round_trips_multiple_sources(self):
        """The PUT path for arp_source_devices - many=True on the
        tenant-scoped field is otherwise untested."""
        fw1 = Device.objects.create(tenant=self.tenant, name="api-fw1")
        fw2 = Device.objects.create(tenant=self.tenant, name="api-fw2")
        r = self.client.put(
            "/api/monitoring/settings/",
            {"arp_source_devices": [str(fw1.id), str(fw2.id)]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        got = self.client.get("/api/monitoring/settings/").json()
        self.assertEqual(
            sorted(d["name"] for d in got["arp_source_devices_detail"]),
            ["api-fw1", "api-fw2"],
        )
        # ...and clearing works.
        r = self.client.put(
            "/api/monitoring/settings/", {"arp_source_devices": []},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            self.client.get("/api/monitoring/settings/").json()[
                "arp_source_devices_detail"
            ],
            [],
        )

    def test_settings_api_rejects_cross_tenant_source(self):
        from core.models import Organization, Tenant

        org2 = Organization.objects.create(name="X", slug="x")
        t2 = Tenant.objects.create(org=org2, name="X", slug="x")
        alien = Device.objects.create(tenant=t2, name="alien-fw")
        r = self.client.put(
            "/api/monitoring/settings/",
            {"arp_source_devices": [str(alien.id)]},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
