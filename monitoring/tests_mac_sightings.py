"""MAC tracking (#284): sightings, uplinks, Location, the API and Refresh MACs.

The collector is exercised elsewhere; these tests feed ``persist_snmp_result``
hand-made results in the shape ``danbyte_checks.snmp_facts.fetch_snmp``
returns (plan §3.7), including the legacy shape an older agent sends.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Device,
    Interface,
    IPAddress,
    Prefix,
    Site,
    VirtualChassis,
)
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from monitoring.mac_location import UplinkContext, enrich, locate
from monitoring.mac_tables import canon_mac, parse_caps, record_mac_tables
from monitoring.models import (
    ArpSighting,
    DeviceSnmp,
    MacSighting,
    MonitoringEngine,
    MonitoringSettings,
    SnmpProfile,
)
from monitoring.retention import prune_mac_sightings
from monitoring.snmp_drift import compute_device_drift
from monitoring.snmp_poll import _accepts, persist_snmp_result

User = get_user_model()

PHONE = "00:1b:44:11:3a:b7"
PC = "3c:52:82:aa:10:44"
PRINTER = "a4:5d:36:00:00:07"
SERVER = "b8:27:eb:00:00:01"
DESK = [f"02:00:00:00:09:{i:02x}" for i in range(6)]
ACC_OWN = "00:aa:00:00:01:05"


def iface_row(idx, name, descr=None, mac="", **extra):
    row = {
        "if_index": str(idx), "name": name, "descr": descr or name, "mac": mac,
        "admin_status": "up", "oper_status": "up", "type_name": "ethernet",
        "lag_if_index": "",
    }
    row.update(extra)
    return row


def fdb_row(mac, idx, vlan=10, status="learned"):
    return {"mac": mac, "if_index": str(idx), "vlan": vlan, "fdb_id": vlan,
            "bridge_port": str(idx), "status": status}


def meta(complete=True, source="qbridge", **extra):
    m = {
        "source": source, "complete": complete, "truncated": False,
        "vlan_map": "fdb-id", "port_map": "base",
        "vlans": {"read": [], "skipped": [], "failed": []},
        "dropped": {"self": 0, "port0": 0, "group": 0, "own": 0, "unmapped": 0},
        "rows": 0, "elapsed_ms": 5, "error": "",
    }
    m.update(extra)
    return m


def result(interfaces, fdb=(), arp=(), neighbors=(), fdb_meta="default", reachable=True):
    r = {
        "reachable": reachable, "data": {"sys_name": "x"}, "error": "",
        "interfaces": list(interfaces), "neighbors": list(neighbors),
        "arp": list(arp), "fdb": list(fdb),
    }
    if fdb_meta == "default":
        r["fdb_meta"] = meta()
    elif fdb_meta is not None:
        r["fdb_meta"] = fdb_meta
    return r


ACC_IFACES = [
    iface_row(10105, "Gi1/0/5", "GigabitEthernet1/0/5", mac=ACC_OWN),
    iface_row(10107, "Gi1/0/7", "GigabitEthernet1/0/7", mac="00:aa:00:00:01:07"),
    iface_row(10109, "Gi1/0/9", "GigabitEthernet1/0/9", mac="00:aa:00:00:01:09"),
    iface_row(10601, "Te1/1/1", "TenGigabitEthernet1/1/1", mac="00:aa:00:00:06:01"),
]
ACC_NEIGHBORS = [
    {"local_port": "Te1/1/1", "remote_device": "sw-core-01", "remote_port": "Te1/0/1",
     "local_if_index": "10601", "remote_caps": ["bridge", "router"]},
    # An IP phone announces bridge + telephone: it must stay an access port.
    {"local_port": "Gi1/0/5", "remote_device": "SEP001B44113AB7", "remote_port": "Port 1",
     "local_if_index": "10105", "remote_caps": ["bridge", "telephone"]},
]
CORE_IFACES = [
    iface_row(1, "Te1/0/1", mac="00:cc:00:00:00:01"),
    iface_row(2, "Te1/0/2", mac="00:cc:00:00:00:02"),
]
CORE_NEIGHBORS = [
    {"local_port": "Te1/0/1", "remote_device": "sw-acc-03", "remote_port": "Te1/1/1",
     "local_if_index": "1", "remote_caps": ["bridge"]},
]


def acc_fdb():
    return [
        fdb_row(PHONE, 10105, vlan=20), fdb_row(PHONE, 10105, vlan=10),
        fdb_row(PC, 10105), fdb_row(PRINTER, 10107),
        *[fdb_row(m, 10109) for m in DESK],
        fdb_row(SERVER, 10601),
    ]


def core_fdb():
    return [fdb_row(PC, 1), fdb_row(PHONE, 1), fdb_row(PRINTER, 1), fdb_row(SERVER, 2)]


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.10.0.0/16")
        self.acc = Device.objects.create(tenant=self.tenant, name="sw-acc-03", site=self.site_a)
        self.core = Device.objects.create(tenant=self.tenant, name="sw-core-01", site=self.site_a)
        self.gw = Device.objects.create(tenant=self.tenant, name="gw-01", site=self.site_a)
        self.gi5 = Interface.objects.create(device=self.acc, name="Gi1/0/5")
        self.gi7 = Interface.objects.create(device=self.acc, name="Gi1/0/7")
        self.gi9 = Interface.objects.create(device=self.acc, name="Gi1/0/9")
        self.te1 = Interface.objects.create(device=self.acc, name="Te1/1/1")
        self.core_te1 = Interface.objects.create(device=self.core, name="Te1/0/1")
        self.core_te2 = Interface.objects.create(device=self.core, name="Te1/0/2")
        self.admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.login(self.admin)
        self.t0 = timezone.now() - timedelta(hours=3)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def poll(self, device, res, at=None):
        with mock.patch("monitoring.snmp_poll.timezone.now", return_value=at or self.t0):
            return persist_snmp_result(self.tenant, None, res, device=device)

    def poll_network(self, at=None):
        self.poll(self.acc, result(ACC_IFACES, acc_fdb(), neighbors=ACC_NEIGHBORS), at)
        self.poll(self.core, result(CORE_IFACES, core_fdb(), neighbors=CORE_NEIGHBORS), at)

    def ip(self, addr, **kw):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address=addr, **kw
        )

    def present(self, device=None, **kw):
        qs = MacSighting.objects.filter(gone_at__isnull=True, **kw)
        if device is not None:
            qs = qs.filter(polled_device=device)
        return qs

    def user_with(self, types, actions=("view",), sites=()):
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"p{user.pk}", object_types=list(types), actions=list(actions),
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        return user


# ─── writing ────────────────────────────────────────────────────────────────


class RecordTests(_Base):
    def test_insert_bump_and_close_on_a_complete_read(self):
        t1, t2 = self.t0, self.t0 + timedelta(minutes=15)
        self.poll(self.acc, result(ACC_IFACES, [fdb_row(PC, 10105), fdb_row(PRINTER, 10107)]), t1)
        self.assertEqual(self.present(self.acc).count(), 2)
        row = MacSighting.objects.get(mac=PC)
        self.assertEqual((row.first_seen, row.last_seen), (t1, t1))
        self.assertEqual(row.interface_id, self.gi5.id)
        self.assertEqual((row.port_key, row.vlan_vid, row.status), ("gi1/0/5", 10, "learned"))

        self.poll(self.acc, result(ACC_IFACES, [fdb_row(PC, 10105)]), t2)
        row.refresh_from_db()
        self.assertEqual((row.first_seen, row.last_seen, row.gone_at), (t1, t2, None))
        gone = MacSighting.objects.get(mac=PRINTER)
        # Closed at the read that missed it; last seen stays at the one that saw it.
        self.assertEqual((gone.last_seen, gone.gone_at), (t1, t2))
        state = DeviceSnmp.objects.get(device=self.acc)
        self.assertEqual(state.fdb_polled_at, t2)
        self.assertTrue(state.fdb_meta["complete"])

    def test_an_incomplete_read_closes_nothing(self):
        t1, t2 = self.t0, self.t0 + timedelta(minutes=15)
        self.poll(self.acc, result(ACC_IFACES, [fdb_row(PC, 10105), fdb_row(PRINTER, 10107)]), t1)
        self.poll(
            self.acc,
            result(ACC_IFACES, [fdb_row(PC, 10105)],
                   fdb_meta=meta(complete=False, truncated=True, error="budget")),
            t2,
        )
        self.assertEqual(self.present(self.acc).count(), 2)
        self.assertEqual(MacSighting.objects.get(mac=PC).last_seen, t2)
        self.assertEqual(MacSighting.objects.get(mac=PRINTER).last_seen, t1)
        state = DeviceSnmp.objects.get(device=self.acc)
        self.assertEqual(state.fdb_polled_at, t1)  # the last COMPLETE read
        self.assertFalse(state.fdb_meta["complete"])
        self.assertEqual(state.fdb_meta["error"], "budget")

    def test_skipped_and_failed_vlans_are_neither_closed_nor_refreshed(self):
        t1, t2 = self.t0, self.t0 + timedelta(minutes=15)
        self.poll(self.acc, result(ACC_IFACES, [
            fdb_row(PC, 10105, vlan=10), fdb_row(PRINTER, 10107, vlan=30),
            fdb_row(PHONE, 10105, vlan=40), fdb_row(SERVER, 10601, vlan=50),
        ]), t1)
        # Complete, but VLAN 30 was over the VLAN cap and VLAN 40's context
        # failed - nobody looked there. VLAN 50 was read: the server left.
        self.poll(self.acc, result(
            ACC_IFACES, [fdb_row(PC, 10105, vlan=10)],
            fdb_meta=meta(vlan_map="context", source="bridge-vlan",
                          vlans={"read": [1, 10, 50], "skipped": [30], "failed": [40]}),
        ), t2)
        rows = {r.mac: r for r in MacSighting.objects.all()}
        self.assertEqual((rows[PC].gone_at, rows[PC].last_seen), (None, t2))
        self.assertEqual((rows[PRINTER].gone_at, rows[PRINTER].last_seen), (None, t1))
        self.assertEqual((rows[PHONE].gone_at, rows[PHONE].last_seen), (None, t1))
        self.assertEqual(rows[SERVER].gone_at, t2)
        state = DeviceSnmp.objects.get(device=self.acc)
        self.assertEqual(state.fdb_polled_at, t2)
        self.assertEqual(state.mac_ports["gi1/0/7"]["count"], 1)

    def test_arp_meta_decides_whether_arp_rows_close(self):
        gw_ifaces = [iface_row(1, "Vlan10")]
        arp = [{"ip": "10.10.3.44", "mac": PC, "if_index": "1", "type": "dynamic"},
               {"ip": "10.10.3.50", "mac": PRINTER, "if_index": "1", "type": "static"}]
        full = result(gw_ifaces, arp=arp, fdb_meta=meta(source="none"))
        full["arp_meta"] = {"complete": True, "rows": 2, "error": ""}
        self.poll(self.gw, full)
        partial = result(gw_ifaces, arp=arp[:1], fdb_meta=meta(source="none"))
        partial["arp_meta"] = {"complete": False, "rows": 1, "error": "timeout"}
        self.poll(self.gw, partial, self.t0 + timedelta(minutes=5))
        self.assertFalse(ArpSighting.objects.filter(gone_at__isnull=False).exists())
        self.assertEqual(DeviceSnmp.objects.get(device=self.gw).fdb_meta["arp"]["error"],
                         "timeout")
        self.poll(self.gw, full | {"arp": arp[:1]}, self.t0 + timedelta(minutes=10))
        self.assertEqual(ArpSighting.objects.get(ip="10.10.3.50").gone_at,
                         self.t0 + timedelta(minutes=10))

    def test_a_move_is_one_closed_row_and_one_open_row(self):
        t1, t2 = self.t0, self.t0 + timedelta(minutes=15)
        self.poll(self.acc, result(ACC_IFACES, [fdb_row(PC, 10105)]), t1)
        self.poll(self.acc, result(ACC_IFACES, [fdb_row(PC, 10109)]), t2)
        rows = list(MacSighting.objects.filter(mac=PC).order_by("first_seen"))
        self.assertEqual([r.port_key for r in rows], ["gi1/0/5", "gi1/0/9"])
        self.assertEqual(rows[0].gone_at, t2)
        self.assertIsNone(rows[1].gone_at)
        self.assertEqual(rows[1].first_seen, t2)

    def test_a_port_created_later_is_matched_on_the_next_poll(self):
        ifaces = [*ACC_IFACES, iface_row(10111, "Gi1/0/11")]
        self.poll(self.acc, result(ifaces, [fdb_row(PC, 10111)]))
        row = MacSighting.objects.get(mac=PC)
        self.assertIsNone(row.interface_id)
        gi11 = Interface.objects.create(device=self.acc, name="Gi1/0/11")
        self.poll(self.acc, result(ifaces, [fdb_row(PC, 10111)]), self.t0 + timedelta(minutes=5))
        same = MacSighting.objects.get(mac=PC)
        self.assertEqual(same.pk, row.pk)  # rewritten in place, not reopened
        self.assertEqual(same.interface_id, gi11.id)

    def test_port_key_survives_ifindex_renumbering(self):
        self.poll(self.acc, result(ACC_IFACES, [fdb_row(PC, 10105)]))
        row = MacSighting.objects.get(mac=PC)
        renumbered = [iface_row(5, "Gi1/0/5", mac=ACC_OWN)]
        self.poll(self.acc, result(renumbered, [fdb_row(PC, 5)]), self.t0 + timedelta(minutes=5))
        same = MacSighting.objects.get(mac=PC)
        self.assertEqual((same.pk, same.if_index, same.gone_at), (row.pk, "5", None))

    def test_the_core_side_filter(self):
        rows = [
            fdb_row(PC, 10105),
            fdb_row("00:1b:44:11:3a:01", 10105, status="self"),
            fdb_row("00:1b:44:11:3a:02", 10105, status="invalid"),
            fdb_row("01:00:5e:00:00:fb", 10105),  # multicast
            fdb_row("ff:ff:ff:ff:ff:ff", 10105),  # broadcast
            fdb_row("00:00:00:00:00:00", 10105),
            fdb_row(ACC_OWN, 10107),  # the switch's own port MAC
            fdb_row("00:1b:44:11:3a:03", 999),  # no such ifIndex
            fdb_row("00:1b:44:11:3a:04", 10105, status="mgmt"),  # port security
            fdb_row("00:1b:44:11:3a:05", 10105, status="other"),
        ]
        self.poll(self.acc, result(ACC_IFACES, rows))
        self.assertEqual(
            sorted(self.present(self.acc).values_list("mac", flat=True)),
            sorted([PC, "00:1b:44:11:3a:04", "00:1b:44:11:3a:05"]),
        )
        dropped = DeviceSnmp.objects.get(device=self.acc).fdb_meta["core"]["dropped"]
        self.assertEqual(dropped, {"self": 2, "group": 3, "own": 1, "unmapped": 1})

    def test_an_unreachable_poll_writes_nothing(self):
        self.poll(self.acc, result(ACC_IFACES, [fdb_row(PC, 10105)]))
        self.poll(self.acc, result([], [], reachable=False), self.t0 + timedelta(minutes=5))
        row = MacSighting.objects.get(mac=PC)
        self.assertIsNone(row.gone_at)
        self.assertEqual(row.last_seen, self.t0)

    def test_a_legacy_result_has_no_vlan_and_completes_only_with_rows(self):
        legacy = [{"mac": PC.upper(), "if_index": "10105"}, {"mac": PRINTER, "if_index": "10107"}]
        self.poll(self.acc, result(ACC_IFACES, legacy, fdb_meta=None))
        rows = self.present(self.acc)
        self.assertEqual(rows.count(), 2)
        self.assertEqual(set(rows.values_list("vlan_vid", flat=True)), {None})
        state = DeviceSnmp.objects.get(device=self.acc)
        self.assertTrue(state.fdb_meta["legacy"])
        self.assertEqual(state.fdb_polled_at, self.t0)
        # An old agent's empty table is no evidence that every MAC left.
        self.poll(self.acc, result(ACC_IFACES, [], fdb_meta=None), self.t0 + timedelta(minutes=5))
        self.assertEqual(self.present(self.acc).count(), 2)
        self.assertEqual(DeviceSnmp.objects.get(device=self.acc).fdb_polled_at, self.t0)

    def test_a_device_with_no_bridge_is_not_a_mac_table(self):
        self.poll(self.gw, result([iface_row(1, "eth0")], [], fdb_meta=meta(source="none")))
        self.assertIsNone(DeviceSnmp.objects.get(device=self.gw).fdb_polled_at)

    def test_a_stack_is_recorded_once_under_its_owner(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        m1 = Device.objects.create(tenant=self.tenant, name="st1", virtual_chassis=vc, vc_position=1)
        m2 = Device.objects.create(tenant=self.tenant, name="st2", virtual_chassis=vc, vc_position=2)
        vc.master = m1
        vc.save()
        Interface.objects.create(device=m1, name="Gi1/0/5")
        gi2 = Interface.objects.create(device=m2, name="Gi2/0/5")
        ifaces = [iface_row(1, "Gi1/0/5"), iface_row(2, "Gi2/0/5")]
        res = result(ifaces, [fdb_row(PC, 1), fdb_row(PRINTER, 2)])
        self.poll(m1, res)
        row = MacSighting.objects.get(mac=PRINTER)
        self.assertEqual((row.polled_device_id, row.device_id, row.interface_id),
                         (m1.id, m2.id, gi2.id))
        # An Outpost polls every member; the member's copy adds nothing, and
        # its own row now points readers at the owner's sightings.
        self.poll(m2, res)
        self.assertEqual(MacSighting.objects.count(), 2)
        self.assertEqual(DeviceSnmp.objects.get(device=m2).fdb_meta["owner"], str(m1.id))
        MonitoringSettings.objects.create(tenant=self.tenant, snmp_mac_from_fdb=True)
        macs = {i["name"]: i["observed"] for i in compute_device_drift(m2, self.tenant)
                if i.get("field") == "mac_address"}
        self.assertEqual(macs, {"Gi2/0/5": PRINTER})

    def test_arp_follows_the_same_life_cycle(self):
        t1, t2 = self.t0, self.t0 + timedelta(minutes=15)
        arp = [
            {"ip": "10.10.3.44", "mac": PC, "if_index": "1", "type": "dynamic"},
            {"ip": "10.10.3.50", "mac": PRINTER, "if_index": "1", "type": "dynamic"},
            {"ip": "10.10.3.60", "mac": SERVER, "if_index": "1", "type": "invalid"},
        ]
        gw_ifaces = [iface_row(1, "Vlan10")]
        self.poll(self.gw, result(gw_ifaces, arp=arp, fdb_meta=meta(source="none")), t1)
        self.assertEqual(
            sorted(ArpSighting.objects.values_list("ip", flat=True)),
            ["10.10.3.44", "10.10.3.50"],
        )
        self.poll(self.gw, result(gw_ifaces, arp=arp[:1], fdb_meta=meta(source="none")), t2)
        self.assertEqual(ArpSighting.objects.get(ip="10.10.3.50").gone_at, t2)
        self.assertEqual(ArpSighting.objects.get(ip="10.10.3.44").last_seen, t2)

    def test_mac_ports_summarise_the_read(self):
        self.poll_network()
        ports = DeviceSnmp.objects.get(device=self.acc).mac_ports
        self.assertEqual(ports["gi1/0/5"]["count"], 2)  # phone in two VLANs is one MAC
        self.assertEqual(ports["gi1/0/9"]["count"], 6)
        self.assertEqual(ports["te1/1/1"]["lldp"],
                         {"name": "sw-core-01", "caps": ["bridge", "router"], "switch": True})
        self.assertFalse(ports["gi1/0/5"]["lldp"]["switch"])

    def test_writes_scale_with_churn_not_table_size(self):
        def repoll_queries(n):
            dev = Device.objects.create(tenant=self.tenant, name=f"sw-{n}")
            ifaces = [iface_row(i, f"Gi1/0/{i}") for i in range(1, n + 1)]
            res = result(ifaces, [fdb_row(f"3c:00:00:00:{i // 256:02x}:{i % 256:02x}", i)
                                  for i in range(1, n + 1)])
            self.poll(dev, res)
            state = DeviceSnmp.objects.get(device=dev)
            with CaptureQueriesContext(connection) as ctx:
                record_mac_tables(state, res)
            return len(ctx.captured_queries)

        self.assertEqual(repoll_queries(5), repoll_queries(40))

    def test_caps_parse_in_every_shape(self):
        self.assertEqual(parse_caps(["Bridge", "Telephone"]), ["bridge", "telephone"])
        self.assertEqual(parse_caps("bridge(2) router(4)"), ["bridge", "router"])
        self.assertEqual(parse_caps("0x2400"), ["bridge", "telephone"])  # bits 2 and 5
        self.assertEqual(parse_caps(""), [])

    def test_mac_notations(self):
        for value in (PC, PC.upper(), "3c52.82aa.1044", "3C-52-82-AA-10-44", "3c5282aa1044",
                      "0x3c5282aa1044"):
            self.assertEqual(canon_mac(value), PC, value)
        self.assertEqual(canon_mac("0:1b:44:11:3a:b7"), PHONE)
        self.assertIsNone(canon_mac("3c:52:82"))


# ─── uplinks and Location ───────────────────────────────────────────────────


class UplinkTests(_Base):
    def setUp(self):
        super().setUp()
        self.poll_network()

    def classify(self, iface, key):
        ctx = UplinkContext(self.tenant).load({self.acc.id}, {iface.id})
        return ctx.classify(self.acc.id, key, iface.id)

    def codes(self, uplink):
        return [r["code"] for r in uplink.reasons]

    def test_an_lldp_switch_neighbour_marks_an_uplink(self):
        up = self.classify(self.te1, "te1/1/1")
        self.assertTrue(up.is_uplink)
        self.assertEqual(self.codes(up), ["lldp"])
        self.assertEqual(up.reasons[0]["text"], "LLDP neighbour sw-core-01")

    def test_an_ip_phone_keeps_its_port_an_access_port(self):
        up = self.classify(self.gi5, "gi1/0/5")
        self.assertFalse(up.is_uplink)
        self.assertEqual(up.reasons, [])

    def test_a_neighbour_danbyte_polls_with_a_mac_table_counts_without_caps(self):
        res = result(ACC_IFACES, acc_fdb(), neighbors=[
            {"local_port": "Gi1/0/7", "remote_device": "sw-core-01", "remote_port": "x"},
        ])
        self.poll(self.acc, res, self.t0 + timedelta(minutes=1))
        self.assertTrue(self.classify(self.gi7, "gi1/0/7").is_uplink)

    def test_the_lldp_rule_can_be_switched_off(self):
        MonitoringSettings.objects.create(tenant=self.tenant, mac_uplink_lldp=False)
        self.assertFalse(self.classify(self.te1, "te1/1/1").is_uplink)

    def test_lag_aggregates_and_members_are_uplinks(self):
        po = Interface.objects.create(device=self.acc, name="Po1", type="lag")
        self.gi7.lag = po
        self.gi7.save()
        self.assertEqual(self.codes(self.classify(self.gi7, "gi1/0/7")), ["lag"])
        res = result([*ACC_IFACES, iface_row(5001, "Po1", type_name="lag")],
                     [*acc_fdb(), fdb_row(PC, 5001)])
        self.poll(self.acc, res, self.t0 + timedelta(minutes=1))
        up = self.classify(po, "po1")
        self.assertTrue(up.is_uplink)
        self.assertEqual(up.reasons[0]["text"], "Aggregate")

    def test_the_count_rule_reads_the_current_threshold(self):
        up = self.classify(self.gi9, "gi1/0/9")
        self.assertTrue(up.is_uplink)
        self.assertEqual(up.reasons[0]["text"], "6 MACs, above 4")
        self.assertEqual(locate(self.tenant, [DESK[0]])[DESK[0]].kind, "behind_uplink")
        # A changed setting applies on the next read, without a re-poll.
        MonitoringSettings.objects.create(tenant=self.tenant, mac_uplink_threshold=8)
        self.assertFalse(self.classify(self.gi9, "gi1/0/9").is_uplink)
        self.assertEqual(locate(self.tenant, [DESK[0]])[DESK[0]].kind, "access")

    def test_always_and_never(self):
        self.gi7.is_uplink = True
        self.gi7.save()
        up = self.classify(self.gi7, "gi1/0/7")
        self.assertEqual((up.is_uplink, up.mode, self.codes(up)), (True, "always", ["always"]))
        # Never beats LLDP, LAG and the count - and keeps the reasons it overrode.
        self.te1.never_uplink = True
        self.te1.save()
        up = self.classify(self.te1, "te1/1/1")
        self.assertEqual((up.is_uplink, up.mode, self.codes(up)), (False, "never", ["lldp"]))
        self.gi9.never_uplink = True
        self.gi9.save()
        self.assertEqual(locate(self.tenant, [DESK[0]])[DESK[0]].kind, "access")


class LocationTests(_Base):
    def test_access_beats_an_uplink(self):
        self.poll_network()
        loc = locate(self.tenant, [PC])[PC]
        self.assertEqual((loc.kind, loc.at.interface_id, loc.at.vlan), ("access", self.gi5.id, 10))
        self.assertEqual([o.device_id for o in loc.others], [self.core.id])
        self.assertTrue(loc.others[0].uplink.is_uplink)
        server = locate(self.tenant, [SERVER])[SERVER]
        self.assertEqual(server.at.interface_id, self.core_te2.id)

    def test_behind_uplink_falls_back_to_the_fewest_macs(self):
        self.poll_network()
        loc = locate(self.tenant, [DESK[3]])[DESK[3]]
        self.assertEqual((loc.kind, loc.at.interface_id), ("behind_uplink", self.gi9.id))
        # Seen only through two uplinks: the one with fewer MACs is nearer.
        other = "c0:ff:ee:00:00:01"
        self.poll(self.acc, result(ACC_IFACES, [*acc_fdb(), fdb_row(other, 10601)],
                                   neighbors=ACC_NEIGHBORS), self.t0 + timedelta(minutes=1))
        self.poll(self.core, result(CORE_IFACES, [*core_fdb(), fdb_row(other, 1)],
                                    neighbors=CORE_NEIGHBORS), self.t0 + timedelta(minutes=1))
        loc = locate(self.tenant, [other])[other]
        self.assertEqual((loc.kind, loc.at.interface_id), ("behind_uplink", self.te1.id))

    def test_two_access_sightings_resolve_the_same_way_every_poll(self):
        a = Device.objects.create(tenant=self.tenant, name="sw-a")
        b = Device.objects.create(tenant=self.tenant, name="sw-b")
        pa = Interface.objects.create(device=a, name="Gi1")
        Interface.objects.create(device=b, name="Gi1")
        for minute, order in enumerate([(a, b), (b, a), (a, b), (b, a)]):
            for dev in order:
                self.poll(dev, result([iface_row(1, "Gi1")], [fdb_row(PC, 1)]),
                          self.t0 + timedelta(minutes=minute))
            self.assertEqual(locate(self.tenant, [PC])[PC].at.interface_id, pa.id)

    def test_a_move_follows_the_newer_sighting(self):
        a = Device.objects.create(tenant=self.tenant, name="sw-a")
        b = Device.objects.create(tenant=self.tenant, name="sw-b")
        Interface.objects.create(device=a, name="Gi1")
        pb = Interface.objects.create(device=b, name="Gi1")
        self.poll(a, result([iface_row(1, "Gi1")], [fdb_row(PC, 1)]), self.t0)
        # sw-a hasn't been polled since; sw-b saw the MAC arrive after that.
        self.poll(b, result([iface_row(1, "Gi1")], [fdb_row(PC, 1)]),
                  self.t0 + timedelta(minutes=30))
        self.assertEqual(locate(self.tenant, [PC])[PC].at.interface_id, pb.id)

    def test_a_switch_that_stopped_answering_loses_to_a_fresh_one(self):
        a = Device.objects.create(tenant=self.tenant, name="sw-a")
        b = Device.objects.create(tenant=self.tenant, name="sw-b")
        Interface.objects.create(device=a, name="Gi1")
        pb = Interface.objects.create(device=b, name="Gi1")
        self.poll(b, result([iface_row(1, "Gi1")], [fdb_row(PC, 1)]), self.t0 - timedelta(days=5))
        self.poll(a, result([iface_row(1, "Gi1")], [fdb_row(PC, 1)]), self.t0 - timedelta(days=3))
        self.poll(b, result([iface_row(1, "Gi1")], [fdb_row(PC, 1)]), self.t0)
        self.assertEqual(locate(self.tenant, [PC])[PC].at.interface_id, pb.id)


# ─── the moved consumers ────────────────────────────────────────────────────


class SwitchLinkTests(_Base):
    def setUp(self):
        super().setUp()
        self.poll_network()
        self.pc_ip = self.ip("10.10.3.44")
        self.poll(self.gw, result(
            [iface_row(1, "Vlan10")],
            arp=[{"ip": "10.10.3.44", "mac": PC, "if_index": "1", "type": "dynamic"}],
            fdb_meta=meta(source="none"),
        ))

    def links(self, device):
        return [i for i in compute_device_drift(device, self.tenant)
                if i["kind"] == "switch_link_suggested"]

    def test_suggested_where_the_mac_is_located_from_any_routers_arp(self):
        (item,) = self.links(self.acc)
        self.assertEqual(item, {
            "kind": "switch_link_suggested", "ip_id": str(self.pc_ip.id),
            "ip": "10.10.3.44", "interface_id": str(self.gi5.id), "name": "Gi1/0/5",
            "intended": "-", "observed": "sw-acc-03 · Gi1/0/5",
        })
        # The core learns the PC on its uplink: no claim there.
        self.assertEqual(self.links(self.core), [])

    def test_two_switches_never_both_claim_a_host(self):
        a = Device.objects.create(tenant=self.tenant, name="sw-a")
        b = Device.objects.create(tenant=self.tenant, name="sw-b")
        Interface.objects.create(device=a, name="Gi1")
        Interface.objects.create(device=b, name="Gi1")
        host = "3c:00:00:00:00:99"
        self.ip("10.10.9.9")
        self.poll(self.gw, result(
            [iface_row(1, "Vlan10")],
            arp=[{"ip": "10.10.9.9", "mac": host, "if_index": "1", "type": "dynamic"}],
            fdb_meta=meta(source="none"),
        ), self.t0 + timedelta(minutes=1))
        for minute, order in enumerate([(a, b), (b, a), (a, b)], start=2):
            for dev in order:
                self.poll(dev, result([iface_row(1, "Gi1")], [fdb_row(host, 1)]),
                          self.t0 + timedelta(minutes=minute))
            self.assertEqual(
                ([i["ip"] for i in self.links(a)], [i["ip"] for i in self.links(b)]),
                (["10.10.9.9"], []),
            )

    def test_the_arp_source_list_keeps_its_meaning(self):
        other_gw = Device.objects.create(tenant=self.tenant, name="aa-fw")
        self.poll(other_gw, result(
            [iface_row(1, "Vlan10")],
            arp=[{"ip": "10.10.3.99", "mac": PC, "if_index": "1", "type": "dynamic"}],
            fdb_meta=meta(source="none"),
        ))
        self.ip("10.10.3.99")
        MonitoringSettings.for_tenant(self.tenant).arp_source_devices.add(self.gw)
        self.assertEqual([i["ip"] for i in self.links(self.acc)], ["10.10.3.44"])

    def test_never_uplink_lets_a_busy_port_take_suggestions(self):
        self.ip("10.10.4.1")
        self.poll(self.gw, result(
            [iface_row(1, "Vlan10")],
            arp=[{"ip": "10.10.3.44", "mac": PC, "if_index": "1", "type": "dynamic"},
                 {"ip": "10.10.4.1", "mac": DESK[0], "if_index": "1", "type": "dynamic"}],
            fdb_meta=meta(source="none"),
        ), self.t0 + timedelta(minutes=1))
        self.assertEqual([i["ip"] for i in self.links(self.acc)], ["10.10.3.44"])
        self.gi9.never_uplink = True
        self.gi9.save()
        self.assertEqual(sorted(i["ip"] for i in self.links(self.acc)),
                         ["10.10.3.44", "10.10.4.1"])

    def test_mac_from_fdb_reads_the_filtered_single_learner(self):
        MonitoringSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"snmp_mac_from_fdb": True}
        )
        macs = {i["name"]: i["observed"] for i in compute_device_drift(self.acc, self.tenant)
                if i.get("field") == "mac_address"}
        # Gi1/0/7 and Te1/1/1 learned one MAC each; Gi1/0/5 two (phone + PC),
        # Gi1/0/9 six. The switch's own MACs never count as a learner.
        self.assertEqual(macs, {"Gi1/0/7": PRINTER, "Te1/1/1": SERVER})


class LegacyStateTests(_Base):
    """A device polled before 0.17 keeps answering from its JSON tables."""

    def test_never_uplink_applies_to_a_legacy_row(self):
        self.ip("10.10.4.1")
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.acc, reachable=True, polled_at=self.t0,
            interfaces=[iface_row(10109, "Gi1/0/9")],
            arp=[{"ip": "10.10.4.1", "mac": DESK[0], "if_index": "10109"}],
            fdb=[{"mac": m, "if_index": "10109"} for m in DESK],
        )
        drift = lambda: [i for i in compute_device_drift(self.acc, self.tenant)  # noqa: E731
                         if i["kind"] == "switch_link_suggested"]
        self.assertEqual(drift(), [])
        self.gi9.never_uplink = True
        self.gi9.save()
        self.assertEqual([i["ip"] for i in drift()], ["10.10.4.1"])


# ─── API ────────────────────────────────────────────────────────────────────


class DeviceMacsApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.poll_network()

    def get(self, device, **params):
        r = self.client.get(f"/api/monitoring/devices/{device.id}/macs/", params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_ports_with_their_macs_and_uplink_state(self):
        body = self.get(self.acc)
        self.assertEqual(body["limit"], 4)
        self.assertTrue(body["meta"]["complete"])
        ports = {p["port_name"]: p for p in body["ports"]}
        gi5 = ports["Gi1/0/5"]
        self.assertEqual(gi5["interface_id"], str(self.gi5.id))
        self.assertEqual((gi5["uplink"]["is"], gi5["count"], gi5["located"]), (False, 2, 2))
        phone = next(m for m in gi5["macs"] if m["mac"] == PHONE)
        self.assertEqual(phone["vlans"], [10, 20])  # one line for both VLANs
        self.assertTrue(phone["here"])
        gi9 = ports["Gi1/0/9"]
        self.assertEqual(gi9["uplink"]["reasons"][0]["code"], "count")
        self.assertEqual((gi9["count"], gi9["located"], gi9["macs"]), (6, 6, []))
        te1 = ports["Te1/1/1"]
        self.assertEqual((te1["uplink"]["is"], te1["count"], te1["located"]), (True, 1, 0))
        self.assertEqual(te1["uplink"]["reasons"][0]["text"], "LLDP neighbour sw-core-01")

    def test_limit_and_where_a_mac_really_sits(self):
        MonitoringSettings.objects.create(tenant=self.tenant, mac_uplink_threshold=8)
        body = self.get(self.acc)
        gi9 = next(p for p in body["ports"] if p["port_name"] == "Gi1/0/9")
        self.assertEqual((gi9["count"], len(gi9["macs"])), (6, 4))  # "+2 more"
        everything = self.get(self.acc, limit=0)
        gi9 = next(p for p in everything["ports"] if p["port_name"] == "Gi1/0/9")
        self.assertEqual(len(gi9["macs"]), 6)
        core = self.get(self.core, limit=0)
        te1 = next(p for p in core["ports"] if p["port_name"] == "Te1/0/1")
        self.assertTrue(te1["uplink"]["is"])
        # On the core the PC is seen through the uplink, located on the access switch.
        te2 = next(p for p in core["ports"] if p["port_name"] == "Te1/0/2")
        self.assertTrue(te2["macs"][0]["here"])

    def test_query_count_does_not_grow_with_the_port_count(self):
        def count_for(n):
            dev = Device.objects.create(tenant=self.tenant, name=f"sw-{n}")
            ifaces, rows = [], []
            for i in range(1, n + 1):
                Interface.objects.create(device=dev, name=f"Gi1/0/{i}")
                ifaces.append(iface_row(i, f"Gi1/0/{i}"))
                rows += [fdb_row(f"3c:00:00:{n:02x}:{i:02x}:01", i),
                         fdb_row(f"3c:00:00:{n:02x}:{i:02x}:02", i)]
            self.poll(dev, result(ifaces, rows))
            self.get(dev)
            with CaptureQueriesContext(connection) as ctx:
                body = self.get(dev)
            self.assertEqual(len(body["ports"]), n)
            return len(ctx.captured_queries)

        self.assertEqual(count_for(3), count_for(12))

    def test_bad_parameters(self):
        r = self.client.get(f"/api/monitoring/devices/{self.acc.id}/macs/?view=x")
        self.assertEqual(r.status_code, 400)
        r = self.client.get(f"/api/monitoring/devices/{self.acc.id}/macs/?limit=-1")
        self.assertEqual(r.status_code, 400)


class InterfaceMacsApiTests(_Base):
    def test_present_all_and_locations_through_an_uplink(self):
        self.poll_network()
        url = f"/api/monitoring/interfaces/{self.te1.id}/macs/"
        body = self.client.get(url).json()
        self.assertEqual(body["uplink"]["reasons"][0]["code"], "lldp")
        (row,) = body["results"]
        self.assertEqual(row["mac"], SERVER)
        self.assertFalse(row["here"])
        self.assertEqual(row["location"]["interface"]["id"], str(self.core_te2.id))
        # SERVER leaves the uplink: gone, kept as history.
        self.poll(self.acc, result(ACC_IFACES, acc_fdb()[:-1], neighbors=ACC_NEIGHBORS),
                  self.t0 + timedelta(minutes=5))
        self.assertEqual(self.client.get(url).json()["results"], [])
        body = self.client.get(url, {"state": "all"}).json()
        self.assertEqual(body["counts"], {"all": 1, "present": 0})
        self.assertEqual(body["results"][0]["state"], "gone")

    def test_paging(self):
        MonitoringSettings.objects.create(tenant=self.tenant, mac_uplink_threshold=8)
        self.poll_network()
        url = f"/api/monitoring/interfaces/{self.gi9.id}/macs/"
        first = self.client.get(url, {"limit": 4}).json()
        self.assertEqual((len(first["results"]), first["next_cursor"]), (4, 4))
        rest = self.client.get(url, {"limit": 4, "cursor": 4}).json()
        self.assertEqual((len(rest["results"]), rest["next_cursor"]), (2, None))
        self.assertTrue(all(r["here"] for r in first["results"] + rest["results"]))


class LearnedListApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.poll_network()

    def rows(self, **params):
        r = self.client.get("/api/monitoring/mac-sightings/", params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_one_row_per_mac_at_its_location(self):
        body = self.rows(page_size=50)
        self.assertEqual(body["count"], 10)  # 4 hosts + 6 desk MACs
        by_mac = {r["mac"]: r for r in body["results"]}
        self.assertEqual(by_mac[PC]["interface"]["id"], str(self.gi5.id))
        self.assertEqual(by_mac[PC]["kind"], "access")
        self.assertEqual(by_mac[DESK[0]]["kind"], "behind_uplink")
        self.assertEqual(by_mac[SERVER]["device"]["name"], "sw-core-01")

    def test_filters_and_paging(self):
        self.assertEqual(self.rows(kind="behind_uplink")["count"], 6)
        self.assertEqual(self.rows(kind="access")["count"], 4)
        self.assertEqual(self.rows(device=str(self.core.id))["count"], 1)
        self.assertEqual(self.rows(vlan=20)["count"], 1)
        self.assertEqual(self.rows(site=str(self.site_b.id))["count"], 0)
        page = self.rows(page_size=3, page=4)
        self.assertEqual((page["num_pages"], len(page["results"])), (4, 1))
        for q in ("3c52.82aa.1044", "3C-52-82-AA-10-44", "3c5282aa1044", PC):
            self.assertEqual([r["mac"] for r in self.rows(q=q)["results"]], [PC], q)
        self.assertEqual(self.rows(q="02:00:00")["count"], 6)

    def test_query_count_does_not_grow_with_the_page(self):
        dev = Device.objects.create(tenant=self.tenant, name="sw-many")
        ifaces = [iface_row(i, f"Gi1/0/{i}") for i in range(1, 41)]
        for i in range(1, 41):
            Interface.objects.create(device=dev, name=f"Gi1/0/{i}")
        self.poll(dev, result(ifaces, [fdb_row(f"3c:00:00:00:01:{i:02x}", i)
                                       for i in range(1, 41)]))

        def count(size):
            self.rows(page_size=size)
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(len(self.rows(page_size=size)["results"]), size)
            return len(ctx.captured_queries)

        self.assertEqual(count(5), count(40))

    def test_enrichment_costs_the_same_for_one_mac_or_many(self):
        def count(macs):
            with CaptureQueriesContext(connection) as ctx:
                enrich(self.tenant, macs, self.admin)
            return len(ctx.captured_queries)

        self.assertEqual(count([PC]), count([PC, PHONE, PRINTER, SERVER, *DESK]))

    def test_gone_macs_and_permission(self):
        self.poll(self.acc, result(ACC_IFACES, acc_fdb()[1:], neighbors=ACC_NEIGHBORS),
                  self.t0 + timedelta(minutes=5))
        self.poll(self.core, result(CORE_IFACES, core_fdb()[:-1], neighbors=CORE_NEIGHBORS),
                  self.t0 + timedelta(minutes=5))
        self.poll(self.acc, result(ACC_IFACES, acc_fdb()[:-1], neighbors=ACC_NEIGHBORS),
                  self.t0 + timedelta(minutes=6))
        gone = self.rows(state="gone")["results"]
        self.assertEqual([r["mac"] for r in gone], [SERVER])
        self.assertEqual(gone[0]["state"], "gone")
        self.login(self.user_with(["device"]))
        r = self.client.get("/api/monitoring/mac-sightings/")
        self.assertEqual(r.status_code, 403)

    def test_a_gone_mac_shows_the_access_port_it_left(self):
        def without_pc(rows):
            return [r for r in rows if r["mac"] != PC]

        later = self.t0 + timedelta(minutes=5)
        self.poll(self.acc, result(ACC_IFACES, without_pc(acc_fdb()), neighbors=ACC_NEIGHBORS),
                  later)
        self.poll(self.core, result(CORE_IFACES, core_fdb(), neighbors=CORE_NEIGHBORS), later)
        self.poll(self.core, result(CORE_IFACES, without_pc(core_fdb()), neighbors=CORE_NEIGHBORS),
                  later + timedelta(minutes=5))

        def port(**params):
            (row,) = [r for r in self.rows(state="gone", **params)["results"] if r["mac"] == PC]
            return row["interface"]["id"]

        # The core's uplink kept it five minutes longer; the port it left wins.
        self.assertEqual(port(), str(self.gi5.id))
        # A device filter shows that device's own row.
        self.assertEqual(port(device=str(self.core.id)), str(self.core_te1.id))
        self.assertEqual(port(device=str(self.acc.id)), str(self.gi5.id))


class MacDetailAndSearchTests(_Base):
    def setUp(self):
        super().setUp()
        self.poll_network()
        self.pc_ip = self.ip("10.10.3.44", dns_name="pc-044.corp.local")
        self.poll(self.gw, result(
            [iface_row(1, "Vlan10")],
            arp=[{"ip": "10.10.3.44", "mac": PC, "if_index": "1", "type": "dynamic"},
                 {"ip": "10.10.3.50", "mac": PRINTER, "if_index": "1", "type": "dynamic"}],
            fdb_meta=meta(source="none"),
        ))

    def test_the_mac_page_in_any_notation(self):
        for notation in (PC, "3c52.82aa.1044", "3C-52-82-AA-10-44", "3c5282aa1044"):
            r = self.client.get(f"/api/macs/{notation}/")
            self.assertEqual(r.status_code, 200, notation)
        body = r.json()
        self.assertEqual(body["mac"], PC)
        loc = body["location"]
        self.assertEqual((loc["kind"], loc["interface"]["name"], loc["vlan"]),
                         ("access", "Gi1/0/5", 10))
        self.assertEqual([o["role"] for o in loc["others"]], ["uplink"])
        self.assertEqual(body["ips_observed"][0]["ip"], "10.10.3.44")
        self.assertEqual(body["ips_observed"][0]["ip_id"], str(self.pc_ip.id))
        self.assertEqual(body["ips_observed"][0]["sources"][0]["device"]["name"], "gw-01")
        self.assertEqual((body["name"], body["name_source"]), ("pc-044.corp.local", "dns"))
        fdb = [s for s in body["seen"] if s["source"] == "fdb"]
        self.assertEqual({(s["device"]["name"], s["port"], s["role"], s["present"]) for s in fdb},
                         {("sw-acc-03", "Gi1/0/5", "access", True),
                          ("sw-core-01", "Te1/0/1", "uplink", True)})
        arp = [s for s in body["seen"] if s["source"] == "arp"]
        self.assertEqual([(s["device"]["name"], s["ip"]) for s in arp], [("gw-01", "10.10.3.44")])

    def test_a_known_nic_names_the_mac(self):
        srv = Device.objects.create(tenant=self.tenant, name="srv-db-01")
        Interface.objects.create(device=srv, name="eth0", mac_address=SERVER.upper())
        info = enrich(self.tenant, [SERVER])[SERVER]
        self.assertEqual((info["name"], info["name_source"]), ("srv-db-01 · eth0", "interface"))

    def test_search_finds_the_port_from_four_notations(self):
        for q in ("3c:52:82:aa:10:44", "3c52.82aa.1044", "3C-52-82-AA-10-44", "3c5282aa1044"):
            body = self.client.get("/api/search/", {"q": q}).json()
            top = body["hits"][0]
            self.assertEqual((top["type"], top["id"]), ("interface", str(self.gi5.id)), q)
            self.assertEqual(top["subtitle"], "sw-acc-03 · learned here, VLAN 10")
            self.assertEqual(body["mac"], PC)

    def test_no_port_hit_without_interface_view(self):
        self.login(self.user_with(["device", "macaddress"]))
        body = self.client.get("/api/search/", {"q": "3c52.82aa.1044"}).json()
        self.assertFalse([h for h in body["hits"] if h["type"] == "interface"])


class RbacTests(_Base):
    """Every read filters by tenant first, then the caller's row scope."""

    def setUp(self):
        super().setUp()
        Device.objects.filter(pk__in=[self.core.pk, self.gw.pk]).update(site=self.site_b)
        self.poll_network()
        self.ip("10.10.3.44", site=self.site_a)
        self.poll(self.gw, result(
            [iface_row(1, "Vlan10")],
            arp=[{"ip": "10.10.3.44", "mac": PC, "if_index": "1", "type": "dynamic"},
                 {"ip": "10.10.3.50", "mac": PRINTER, "if_index": "1", "type": "dynamic"}],
            fdb_meta=meta(source="none"),
        ))
        self.viewer = self.user_with(
            ["device", "interface", "macaddress", "ipaddress"], sites=[self.site_a]
        )
        self.login(self.viewer)

    def test_a_site_scoped_viewer_sees_only_its_devices(self):
        r = self.client.get(f"/api/monitoring/devices/{self.core.id}/macs/")
        self.assertEqual(r.status_code, 404)
        r = self.client.get(f"/api/monitoring/interfaces/{self.core_te2.id}/macs/")
        self.assertEqual(r.status_code, 404)
        rows = self.client.get("/api/monitoring/mac-sightings/").json()["results"]
        self.assertEqual({r["device"]["name"] for r in rows}, {"sw-acc-03"})

    def test_the_location_never_names_a_switch_the_viewer_cant_see(self):
        body = self.client.get(f"/api/macs/{SERVER}/").json()
        self.assertEqual(body["location"]["device"]["name"], "sw-acc-03")
        self.assertEqual(body["location"]["kind"], "behind_uplink")
        self.assertEqual({s["device"]["name"] for s in body["seen"]}, {"sw-acc-03"})

    def test_an_arp_ip_shows_only_through_a_viewable_row(self):
        pc = self.client.get(f"/api/macs/{PC}/").json()
        (ip,) = pc["ips_observed"]
        self.assertEqual(ip["ip"], "10.10.3.44")
        self.assertIsNone(ip["sources"][0]["device"])  # the router stays unnamed
        printer = self.client.get(f"/api/macs/{PRINTER}/").json()
        self.assertEqual(printer["ips_observed"], [])
        self.login(self.admin)
        printer = self.client.get(f"/api/macs/{PRINTER}/").json()
        self.assertEqual(printer["ips_observed"][0]["sources"][0]["device"]["name"], "gw-01")

    def test_another_tenants_ids_are_404(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        dev = Device.objects.create(tenant=other, name="theirs")
        port = Interface.objects.create(device=dev, name="Gi1")
        self.login(self.admin)
        for url in (f"/api/monitoring/devices/{dev.id}/macs/",
                    f"/api/monitoring/interfaces/{port.id}/macs/"):
            self.assertEqual(self.client.get(url).status_code, 404, url)
        r = self.client.post(f"/api/monitoring/devices/{dev.id}/mac-refresh/")
        self.assertEqual(r.status_code, 404)


# ─── settings, profile params, the Uplink override, audit ──────────────────


class ValidationAndAuditTests(_Base):
    def test_settings_ranges(self):
        url = "/api/monitoring/settings/"
        for field, bad in (("mac_port_display_limit", 65), ("mac_uplink_threshold", 4097),
                           ("mac_retention_days", 0), ("mac_retention_days", 366)):
            r = self.client.patch(url, {field: bad}, format="json")
            self.assertEqual(r.status_code, 400, (field, bad))
        r = self.client.patch(url, {
            "mac_port_display_limit": 0, "mac_uplink_threshold": 8,
            "mac_uplink_lldp": False, "mac_retention_days": 7,
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = self.client.get(url).json()
        self.assertEqual(
            [body[k] for k in ("mac_port_display_limit", "mac_uplink_threshold",
                               "mac_uplink_lldp", "mac_retention_days")],
            [0, 8, False, 7],
        )
        defaults = MonitoringSettings.objects.create(
            tenant=Tenant.objects.create(org=self.tenant.org, name="T2", slug="t2")
        )
        self.assertEqual((defaults.mac_port_display_limit, defaults.mac_uplink_threshold,
                          defaults.mac_uplink_lldp, defaults.mac_retention_days),
                         (4, 4, True, 30))

    def test_profile_mac_params(self):
        url = "/api/monitoring/snmp-profiles/"
        for params in ({"mac_vlan_contexts": "sometimes"}, {"mac_max_vlans": 0},
                       {"mac_max_vlans": 1025}, {"mac_budget_s": 4}, {"mac_budget_s": 601},
                       {"mac_budget_s": True}):
            r = self.client.post(url, {"name": f"p{len(str(params))}", "version": "v2c",
                                       "params": params}, format="json")
            self.assertEqual(r.status_code, 400, params)
        r = self.client.post(url, {"name": "ok", "version": "v2c", "params": {
            "mac_vlan_contexts": "always", "mac_max_vlans": "256", "mac_budget_s": 60,
        }}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["params"]["mac_max_vlans"], 256)

    def test_uplink_always_and_never_exclude_each_other(self):
        url = f"/api/interfaces/{self.gi5.id}/"
        r = self.client.patch(url, {"is_uplink": True, "never_uplink": True}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(url, {"never_uplink": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["never_uplink"])
        r = self.client.patch(url, {"is_uplink": True}, format="json")
        self.assertEqual(r.status_code, 400)  # still Never
        r = self.client.patch(url, {"is_uplink": True, "never_uplink": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_bulk_edit_sets_one_and_clears_the_other(self):
        self.gi5.is_uplink = True
        self.gi5.save()
        url = "/api/interfaces/bulk-update/"
        r = self.client.post(url, {"ids": [str(self.gi5.id)],
                                   "fields": {"is_uplink": True, "never_uplink": True}},
                             format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(url, {"ids": [str(self.gi5.id)], "fields": {"never_uplink": True}},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.gi5.refresh_from_db()
        self.assertEqual((self.gi5.is_uplink, self.gi5.never_uplink), (False, True))

    def test_the_override_is_audited_and_sightings_are_not(self):
        before = ChangeLogEntry.objects.count()
        self.poll_network()
        self.assertEqual(ChangeLogEntry.objects.count(), before)
        r = self.client.patch(f"/api/interfaces/{self.gi9.id}/", {"never_uplink": True},
                              format="json")
        self.assertEqual(r.status_code, 200)
        entry = ChangeLogEntry.objects.get(
            object_id=str(self.gi9.id), changes__has_key="never_uplink"
        )
        self.assertEqual(entry.changes["never_uplink"], {"old": False, "new": True})


# ─── Outposts ───────────────────────────────────────────────────────────────


class OutpostIngestTests(_Base):
    def setUp(self):
        super().setUp()
        from monitoring.engines import set_binding

        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch", slug="branch", kind="remote",
            transport="pull", token={"secret": "tkn-mac"},
        )
        set_binding(self.tenant, "site", self.site_a.id, self.engine)
        Device.objects.filter(pk=self.core.pk).update(site=self.site_b)

    def post(self, rows):
        return self.client.post("/api/outpost/snmp/", {"results": rows}, format="json",
                                HTTP_AUTHORIZATION="Bearer tkn-mac")

    def test_only_the_engines_own_devices_are_ingested(self):
        rows = [
            {"device_id": str(self.acc.id), **result(ACC_IFACES, acc_fdb())},
            # Same tenant, but a site this Outpost doesn't poll.
            {"device_id": str(self.core.id), **result(CORE_IFACES, core_fdb())},
        ]
        r = self.post(rows)
        self.assertEqual(r.json(), {"ingested": 1})
        self.assertFalse(MacSighting.objects.filter(polled_device=self.core).exists())
        self.assertFalse(DeviceSnmp.objects.filter(device=self.core).exists())
        self.assertTrue(MacSighting.objects.filter(polled_device=self.acc).exists())

    def test_a_legacy_payload_is_accepted(self):
        legacy = result(ACC_IFACES, [{"mac": PC, "if_index": "10105"}], fdb_meta=None)
        r = self.post([{"device_id": str(self.acc.id), **legacy}])
        self.assertEqual(r.json(), {"ingested": 1})
        row = MacSighting.objects.get(mac=PC)
        self.assertIsNone(row.vlan_vid)
        self.assertTrue(DeviceSnmp.objects.get(device=self.acc).fdb_meta["legacy"])


# ─── Refresh MACs and Poll now ──────────────────────────────────────────────


class FakeRedis:
    def __init__(self):
        self.kv, self.hashes = {}, {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.kv:
            return False
        self.kv[key] = str(value).encode()
        return True

    def get(self, key):
        return self.kv.get(key)

    def delete(self, key):
        self.kv.pop(key, None)

    def hset(self, key, mapping):
        self.hashes.setdefault(key, {}).update(
            {k.encode(): str(v).encode() for k, v in mapping.items()}
        )

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    def expire(self, key, ttl):
        return True


class FakeQueue:
    def __init__(self):
        self.jobs = []

    def enqueue(self, fn, *args, **kwargs):
        self.jobs.append((fn, args))


class RefreshTests(_Base):
    def setUp(self):
        super().setUp()
        addr = self.ip("10.10.0.3")
        Device.objects.filter(pk=self.acc.pk).update(primary_ip=addr)
        self.acc.refresh_from_db()
        SnmpProfile.objects.create(tenant=self.tenant, name="p", slug="p", is_default=True,
                                   secret_params={"community": "public"})
        self.redis, self.queue = FakeRedis(), FakeQueue()
        self.calls, self.params = [], []
        patches = [
            mock.patch("monitoring.mac_jobs._conn", return_value=self.redis),
            mock.patch("monitoring.mac_jobs._queue", return_value=self.queue),
            mock.patch("monitoring.snmp_poll.fetch_snmp", side_effect=self.fetch),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def fetch(self, target, version, params, secret_params, timeout_ms, mac_mode="full"):
        self.calls.append(mac_mode)
        self.params.append(params)
        return result(ACC_IFACES, acc_fdb(), neighbors=ACC_NEIGHBORS)

    def refresh(self, device=None):
        return self.client.post(f"/api/monitoring/devices/{(device or self.acc).id}/mac-refresh/")

    def test_a_refresh_queues_one_run_at_a_time(self):
        r = self.refresh()
        self.assertEqual(r.status_code, 202, r.content)
        run_id = r.json()["run_id"]
        self.assertFalse(r.json()["running"])
        again = self.refresh()
        self.assertEqual((again.json()["run_id"], again.json()["running"]), (run_id, True))
        self.assertEqual(len(self.queue.jobs), 1)
        status = self.client.get(f"/api/monitoring/mac-refresh/{run_id}/").json()
        self.assertEqual((status["status"], status["done"]), ("queued", False))

        fn, args = self.queue.jobs[0]
        self.assertEqual(fn(*args), "done")
        self.assertEqual(self.calls, ["full"])
        status = self.client.get(f"/api/monitoring/mac-refresh/{run_id}/").json()
        self.assertEqual((status["status"], status["done"], status["macs"], status["ports"]),
                         ("done", True, 11, 4))
        self.assertEqual(self.redis.kv, {})  # the single-flight key is released

    def test_refresh_needs_device_change_and_the_job_checks_again(self):
        viewer = self.user_with(["device"])
        self.login(viewer)
        self.assertEqual(self.refresh().status_code, 403)
        changer = self.user_with(["device"], actions=("view", "change"))
        self.login(changer)
        r = self.refresh()
        self.assertEqual(r.status_code, 202)
        ObjectPermission.objects.filter(users=changer).delete()  # revoked after the click
        fn, args = self.queue.jobs[0]
        self.assertEqual(fn(*args), "denied")
        self.assertEqual(self.calls, [])
        self.assertFalse(MacSighting.objects.exists())

    def test_the_run_status_is_for_its_owner_or_a_device_viewer(self):
        run_id = self.refresh().json()["run_id"]
        org = Organization.objects.create(name="X", slug="x")
        stranger = User.objects.create_user("stranger", password="x")
        UserProfile.objects.create(user=stranger).tenants.add(self.tenant)
        self.login(stranger)
        body = self.client.get(f"/api/monitoring/mac-refresh/{run_id}/").json()
        self.assertEqual((body["found"], body["done"]), (False, True))
        self.login(self.user_with(["device"]))
        self.assertTrue(self.client.get(f"/api/monitoring/mac-refresh/{run_id}/").json()["found"])
        other = Tenant.objects.create(org=org, name="X", slug="x")
        self.admin.refresh_from_db()
        self.login(self.admin, tenant=other)
        self.assertFalse(self.client.get(f"/api/monitoring/mac-refresh/{run_id}/").json()["found"])

    def test_without_redis_the_refresh_runs_inline_in_quick_mode(self):
        with mock.patch("monitoring.mac_jobs._conn", side_effect=ConnectionError("down")):
            r = self.refresh()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["inline"], r.json()["status"]), (True, "done"))
        self.assertEqual(self.calls, ["quick"])

    def test_an_outpost_device_is_queued_for_its_outpost(self):
        from monitoring.engines import set_binding

        engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch", slug="branch", kind="remote",
            transport="pull", token={"secret": "s"},
        )
        set_binding(self.tenant, "site", self.site_a.id, engine)
        r = self.refresh()
        self.assertEqual(r.status_code, 202)
        self.assertTrue(r.json()["queued_on_outpost"])
        engine.refresh_from_db()
        self.assertIsNotNone(engine.snmp_requested_at)
        self.assertEqual(self.queue.jobs, [])

    def test_a_stack_member_refreshes_its_owner(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.acc.pk).update(virtual_chassis=vc, vc_position=1)
        member = Device.objects.create(tenant=self.tenant, name="sw-acc-03-2",
                                       virtual_chassis=vc, vc_position=2)
        vc.master = self.acc
        vc.save()
        r = self.refresh(member)
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()["device"]["id"], str(self.acc.id))

    def test_poll_now_asks_for_the_quick_read_when_the_collector_can(self):
        r = self.client.post(f"/api/monitoring/devices/{self.acc.id}/snmp-poll/", {},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.calls, ["quick"])
        self.assertIn("fdb_meta", r.json())

    def test_always_mode_sends_the_vlans_danbyte_knows(self):
        from api.models import VLAN

        profile = SnmpProfile.objects.get(tenant=self.tenant)
        profile.params = {"mac_vlan_contexts": "always"}
        profile.save()
        users = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="Users")
        voice = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="Voice")
        self.gi5.vlan = users
        self.gi5.save()
        self.gi5.tagged_vlans.add(voice)
        self.client.post(f"/api/monitoring/devices/{self.acc.id}/snmp-poll/", {},
                         format="json")
        self.assertEqual(self.params[-1]["mac_vlan_hint"], [10, 20])
        profile.params = {"mac_vlan_contexts": "auto"}
        profile.save()
        self.client.post(f"/api/monitoring/devices/{self.acc.id}/snmp-poll/", {},
                         format="json")
        self.assertNotIn("mac_vlan_hint", self.params[-1])

    def test_an_older_collector_gets_no_new_keyword(self):
        def old(target, version, params, secret_params, timeout_ms):
            return result(ACC_IFACES, [{"mac": PC, "if_index": "10105"}], fdb_meta=None)

        self.assertFalse(_accepts(old, "mac_mode"))
        with mock.patch("monitoring.snmp_poll.fetch_snmp", new=old):
            r = self.client.post(f"/api/monitoring/devices/{self.acc.id}/snmp-poll/", {},
                                 format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(MacSighting.objects.filter(mac=PC).exists())


# ─── end to end through the real collector ──────────────────────────────────


class CollectorEndToEndTests(_Base):
    """``danbyte_checks.snmp_facts.fetch_snmp`` - keyword-only ``mac_mode`` -
    against the in-memory agent its own tests use, persisted by the core."""

    def setUp(self):
        super().setUp()
        from monitoring import tests_mac_collector as collector

        self.c = collector
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="192.0.2.0/24")
        target = IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address=collector.TARGET
        )
        self.sw = Device.objects.create(
            tenant=self.tenant, name="sw-acc-x", site=self.site_a, primary_ip=target
        )
        names = [f"Gi1/0/{i}" for i in range(1, 10)] + ["Te1/1/1", "Vl10"]
        self.ports = {n: Interface.objects.create(device=self.sw, name=n) for n in names}
        self.ports["Po1"] = Interface.objects.create(device=self.sw, name="Po1", type="lag")
        SnmpProfile.objects.create(tenant=self.tenant, name="v2c", slug="v2c",
                                   is_default=True, secret_params={"community": "public"})

    def agent_patch(self, agent):
        from danbyte_checks import snmp_facts as sf

        return mock.patch.object(sf, "_load_pysnmp", return_value=agent)

    def present_keys(self, *fields):
        return set(MacSighting.objects.filter(
            polled_device=self.sw, gone_at__isnull=True
        ).values_list(*fields))

    def test_a_qbridge_switch(self):
        from monitoring.snmp_poll import poll_device

        c = self.c
        with self.agent_patch(c.FakeAgent(c.SW_ACC_03)):
            state, reason = poll_device(self.sw, self.tenant)
        self.assertIsNone(reason)
        self.assertEqual((state.fdb_meta["source"], state.fdb_meta["complete"]),
                         ("qbridge", True))
        self.assertIsNotNone(state.fdb_polled_at)
        names = {"10105": "gi1/0/5", "10106": "gi1/0/6", "10107": "gi1/0/7",
                 "10109": "gi1/0/9", "10201": "te1/1/1", "10601": "po1"}
        self.assertEqual(
            self.present_keys("mac", "port_key", "vlan_vid", "status"),
            {(mac, names[idx], vlan, status)
             for mac, idx, vlan, _fdb, _port, status in c.SW_ACC_03_ROWS},
        )
        self.assertFalse(MacSighting.objects.filter(interface__isnull=True).exists())

        ports = {p["port_name"]: p for p in self.client.get(
            f"/api/monitoring/devices/{self.sw.id}/macs/").json()["ports"]}
        codes = {n: [r["code"] for r in p["uplink"]["reasons"]] for n, p in ports.items()}
        self.assertEqual(codes["Te1/1/1"], ["lldp"])  # sw-core-01: bridge + router
        self.assertEqual(codes["Gi1/0/5"], [])  # the phone: bridge + telephone
        self.assertEqual(codes["Gi1/0/7"], [])  # printer-07 announces a station
        self.assertEqual(codes["Gi1/0/9"], ["count"])  # six MACs behind a desk switch
        self.assertEqual(codes["Po1"], ["lag"])

        locs = locate(self.tenant, [c.PC, c.SERVER, c.STATIC])
        self.assertEqual(locs[c.PC].at.interface_id, self.ports["Gi1/0/5"].id)
        self.assertEqual(locs[c.STATIC].at.interface_id, self.ports["Gi1/0/6"].id)
        self.assertEqual(locs[c.SERVER].kind, "behind_uplink")
        self.ports["Po1"].never_uplink = True  # a server bond, not an uplink
        self.ports["Po1"].save()
        self.assertEqual(locate(self.tenant, [c.SERVER])[c.SERVER].kind, "access")

        self.assertEqual(
            set(ArpSighting.objects.filter(device=self.sw).values_list("ip", "mac")),
            {("10.10.3.1", c.GATEWAY), ("10.10.3.44", c.PC),
             ("10.10.3.90", "3c:52:5a:41:42:43")},
        )
        self.assertEqual(ArpSighting.objects.get(ip="10.10.3.44").interface_id,
                         self.ports["Vl10"].id)
        self.assertTrue(state.fdb_meta["arp"]["complete"])

    def test_poll_now_reads_quickly_and_refresh_reads_every_vlan(self):
        from monitoring.snmp_poll import poll_device

        c = self.c
        with self.agent_patch(c.sw07()):
            r = self.client.post(f"/api/monitoring/devices/{self.sw.id}/snmp-poll/", {},
                                 format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["fdb_meta"]["complete"])  # no per-VLAN tables
        self.assertEqual(self.present_keys("mac", "vlan_vid"), {(c.AP, 1), (c.CORE, 1)})
        quick_ids = set(MacSighting.objects.values_list("pk", flat=True))

        with self.agent_patch(c.sw07()):
            state, _reason = poll_device(self.sw, self.tenant)
        self.assertTrue(state.fdb_meta["complete"])
        self.assertEqual(state.fdb_meta["vlans"]["read"], [1, 10, 20])
        self.assertEqual(self.present_keys("mac", "vlan_vid"), {
            (c.AP, 1), (c.CORE, 1), (c.CORE, 10), (c.PC, 10), (c.PHONE, 10),
            (c.PHONE, 20), (c.PRINTER, 20),
        })
        # The quick read's rows are the same rows - nothing closed, nothing reopened.
        self.assertTrue(quick_ids <= set(
            MacSighting.objects.filter(gone_at__isnull=True).values_list("pk", flat=True)
        ))


# ─── ageing ─────────────────────────────────────────────────────────────────


class RetentionTests(_Base):
    def sighting(self, mac, last_seen, gone_at=None, tenant=None, device=None):
        device = device or self.acc
        return MacSighting.objects.create(
            tenant=tenant or self.tenant, polled_device=device, device=device,
            port_key="gi1/0/5", port_name="Gi1/0/5", mac=mac,
            first_seen=last_seen, last_seen=last_seen, gone_at=gone_at,
        )

    def test_gone_rows_age_out_by_the_tenant_setting(self):
        now = timezone.now()
        old = self.sighting(PC, now - timedelta(days=40), gone_at=now - timedelta(days=31))
        recent = self.sighting(PRINTER, now - timedelta(days=10), gone_at=now - timedelta(days=9))
        present = self.sighting(SERVER, now - timedelta(hours=1))
        out = prune_mac_sightings(now)
        self.assertEqual(out["mac_deleted"], 1)
        self.assertFalse(MacSighting.objects.filter(pk=old.pk).exists())
        self.assertTrue(MacSighting.objects.filter(pk__in=[recent.pk, present.pk]).count() == 2)
        MonitoringSettings.objects.create(tenant=self.tenant, mac_retention_days=7)
        prune_mac_sightings(now)
        self.assertFalse(MacSighting.objects.filter(pk=recent.pk).exists())

    def test_a_dead_switch_stops_locating_macs(self):
        now = timezone.now()
        dead = self.sighting(PC, now - timedelta(days=45))
        out = prune_mac_sightings(now)
        self.assertEqual(out["mac_closed"], 1)
        self.assertFalse(MacSighting.objects.filter(pk=dead.pk).exists())
        self.assertEqual(locate(self.tenant, [PC]), {})

    def test_the_daily_prune_includes_sightings(self):
        from monitoring.retention import prune

        self.assertIn("mac_sightings_deleted", prune())
