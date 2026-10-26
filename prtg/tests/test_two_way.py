"""PRTG two-way: acknowledgements both ways, maintenance as pauses, adoption
and system information into the drift inbox - against the fake PRTG, on
recordings from the lab's PRTG 26.3.

The lab, as the recordings have it: db-zabbix (2082, 10.0.0.53: Ping v2 2092
and HTTP 2100), db-dev01 (2081, 10.0.0.41), sw-01 (2080, 10.0.0.2), gw
(2095, 10.0.0.1), Internet (46, a DNS name), the probe device (40,
127.0.0.1, the only one with system information) and the core server (1028,
no host).
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Manufacturer,
    Site,
    VirtualMachine,
)
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant
from monitoring.alerts import set_acknowledged
from monitoring.models import (
    Alert,
    CheckState,
    CheckTemplate,
    DeviceSnmp,
    EventImpact,
    MaintenanceEvent,
    MonitoringEngine,
)
from monitoring.snmp_drift import compute_device_drift
from prtg import status as st
from prtg.acks import is_ours, parse_ack, write_ack
from prtg.adopt import apply_adoption
from prtg.client import PrtgClient
from prtg.facts import facts_from_sysinfo, read_inventory, run_inventory_read
from prtg.maintenance import merged, reconcile, run_maintenance_sync
from prtg.models import (
    PrtgAdoptionRule,
    PrtgChange,
    PrtgDeviceLink,
    PrtgHostFacts,
)
from prtg.reader import refresh_device
from prtg.sync_tasks import enqueue_due_reads

from .fake_server import load_fixture
from .test_status import _Lab

ZABBIX = 2082


class SysinfoTests(_Lab):
    def test_the_recorded_system_rows_are_read_by_position(self):
        rows = PrtgClient.for_connection(self.conn).sysinfo(40)
        by_key = {r["key"]: r["value"] for r in rows}
        self.assertEqual(
            by_key["Windows Version"], "Microsoft Windows Server 2022 Standard Evaluation"
        )
        self.assertEqual(by_key["Bios Serial Number"], "")
        self.assertIn("IPAddress / Red Hat VirtIO Ethernet Adapter", by_key)
        self.assertEqual(rows[0]["displayname"], "Bios Serial Number:")

    def test_a_device_with_no_system_information(self):
        self.assertEqual(PrtgClient.for_connection(self.conn).sysinfo(2081), [])


class RecordedWritesTests(_Lab):
    """What PRTG 26.3 showed after Danbyte's own writes in the lab."""

    def _rows(self, content, fixture):
        self.fake.raw_tables[content] = load_fixture(fixture, raw=True)
        return PrtgClient.for_connection(self.conn).table(content).rows

    def test_a_sensor_danbyte_acknowledged_carries_the_marker(self):
        [row] = self._rows("sensors", "table_sensors_acknowledged.json")
        self.assertEqual(row["status_raw"], st.DOWN_ACKNOWLEDGED)
        self.assertTrue(is_ours(row["message"]))
        who, note = parse_ack(row["message"])
        self.assertEqual(who, "PRTG System Administrator")
        self.assertTrue(note.startswith("[Danbyte] Lab Probe"))

    def test_a_device_danbyte_paused_carries_the_marker(self):
        [row] = self._rows("devices", "table_devices_paused.json")
        self.assertEqual(row["status_raw"], st.PAUSED_UNTIL)
        self.assertTrue(is_ours(row["message"]))

    def test_a_pause_takes_a_few_seconds_to_show(self):
        # Read three seconds after pauseobjectfor: still Up, "(paused for …)"
        # only in the display text. The reconcile compares against what it
        # wrote, so the lag changes nothing.
        [row] = self._rows("devices", "table_devices_pausing.json")
        self.assertEqual(row["status_raw"], st.UP)
        self.assertIn("paused for", row["status"])

    def test_only_known_keys_with_values_become_facts(self):
        rows = [
            {"key": "Bios Serial Number", "value": ""},
            {"key": "Windows Version", "value": "Windows Server 2022"},
            {"key": "sysName", "value": "core-1"},
            {"key": "Serial Number:", "value": "FOC123"},
            {"key": "MACAddress / eth0", "value": "BC:24:11:DF:69:1B"},
        ]
        self.assertEqual(
            facts_from_sysinfo(rows),
            {"os": "Windows Server 2022", "sys_name": "core-1", "serial": "FOC123"},
        )


class _Wired(_Lab):
    """db-zabbix linked, a PRTG engine answering its check, one firing alert."""

    def setUp(self):
        super().setUp()
        seed_builtin_statuses(self.tenant)
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="prtg", slug="prtg", kind="prtg"
        )
        self.conn.engines.add(self.engine)
        self.zbx = self.device("db-zabbix", "10.0.0.53")
        self.check = CheckTemplate.objects.create(
            tenant=self.tenant, name="PRTG", kind="prtg", interval_seconds=300
        )
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.zbx.primary_ip, template=self.check,
            engine=self.engine, kind="prtg", interval_seconds=300,
            next_run=timezone.now(), status="down",
        )
        self.alert = Alert.objects.create(
            tenant=self.tenant, target_ip=self.zbx.primary_ip, template=self.check,
            kind="prtg", dedup_key="k", check_status="down", ack_note="on it",
        )
        self.user = User.objects.create_user("ann", password="x", first_name="Ann")

    def acks(self, objid=None):
        return [q for name, q in self.fake.writes if name == "acknowledgealarm.htm"
                and (objid is None or q["id"] == str(objid))]

    def acked_in_prtg(self, objid, note="Cable cut", who="Jane"):
        self.fake.set_status(
            objid, st.DOWN_ACKNOWLEDGED,
            f"{note} (Acknowledged by {who} on 10/26/2026 at 9:51:27 AM [GMT+0100]): "
            'Device "10.0.0.53" is unreachable.',
        )


class AckOutTests(_Wired):
    def test_acknowledging_queues_the_write_back_after_commit(self):
        with mock.patch("prtg.acks.django_rq") as rq, \
                self.captureOnCommitCallbacks(execute=True):
            set_acknowledged(self.alert, True, actor=self.user, note="on it")
        enqueue = rq.get_queue.return_value.enqueue
        enqueue.assert_called_once()
        self.assertEqual(enqueue.call_args.args[0], write_ack)
        self.assertEqual(enqueue.call_args.args[1:], (str(self.alert.id), True, "Ann"))

    def test_an_acknowledgement_read_from_prtg_is_not_written_back(self):
        with mock.patch("prtg.acks.django_rq") as rq, \
                self.captureOnCommitCallbacks(execute=True):
            set_acknowledged(self.alert, True, note="x", source="prtg")
        rq.get_queue.return_value.enqueue.assert_not_called()

    def test_the_down_sensors_are_acknowledged_with_the_name_and_note(self):
        self.fake.set_status(2092, st.DOWN)
        self.read()
        result = write_ack(str(self.alert.id), True, "Ann")
        self.assertEqual(result["objids"], ["2092"])
        [q] = self.acks()
        self.assertEqual((q["id"], q["ackmsg"]), ("2092", "[Danbyte] Ann: on it"))
        self.alert.refresh_from_db()
        self.assertEqual(self.alert.detail["prtg_ack"]["objids"], ["2092"])
        self.assertEqual(self.fake.sensor(2092)["status_raw"], st.DOWN_ACKNOWLEDGED)

    def test_a_narrowed_check_acknowledges_only_its_sensors(self):
        self.check.params = {"sensor_type": "http"}
        self.check.save()
        self.fake.set_status(2092, st.DOWN)
        self.fake.set_status(2100, st.DOWN)
        self.read()
        write_ack(str(self.alert.id), True, "Ann")
        self.assertEqual([q["id"] for q in self.acks()], ["2100"])

    def test_clearing_is_recorded_and_not_sent(self):
        self.fake.set_status(2092, st.DOWN)
        self.read()
        result = write_ack(str(self.alert.id), False, "Ann")
        self.assertEqual(self.acks(), [])
        self.assertIn("cannot un-acknowledge", result["note"])

    def test_nothing_down_nothing_written(self):
        self.read()
        self.assertEqual(write_ack(str(self.alert.id), True)["skipped"], "nothing down in PRTG")
        self.assertEqual(self.acks(), [])

    def test_the_switch_off_writes_nothing(self):
        self.fake.set_status(2092, st.DOWN)
        self.read()
        self.conn.write_acknowledgements = False
        self.conn.save()
        self.assertEqual(write_ack(str(self.alert.id), True)["skipped"], "write-back off")
        self.assertEqual(self.acks(), [])

    def test_danbytes_own_acknowledgement_is_not_read_back(self):
        self.fake.set_status(2092, st.DOWN)
        self.read()
        write_ack(str(self.alert.id), True, "Ann")
        # The operator clears it in Danbyte; PRTG cannot follow, and the next
        # read must not set it again from Danbyte's own note.
        with mock.patch("prtg.acks.django_rq"):
            set_acknowledged(self.alert, False)
        self.read()
        self.alert.refresh_from_db()
        self.assertIsNone(self.alert.acknowledged_at)


class AckInTests(_Wired):
    def test_an_acknowledgement_in_prtg_acknowledges_the_alert_without_echo(self):
        self.acked_in_prtg(2092)
        with mock.patch("prtg.acks.django_rq") as rq, \
                self.captureOnCommitCallbacks(execute=True):
            counts = self.read()
        self.assertEqual(counts["acknowledged"], 1)
        self.alert.refresh_from_db()
        self.assertIsNotNone(self.alert.acknowledged_at)
        self.assertIsNone(self.alert.acknowledged_by)
        self.assertEqual(self.alert.ack_note, "Acknowledged in PRTG by Jane: Cable cut")
        rq.get_queue.return_value.enqueue.assert_not_called()
        self.assertEqual(self.acks(), [])

    def test_a_sensor_still_down_keeps_it_open(self):
        self.acked_in_prtg(2092)
        self.fake.set_status(2100, st.DOWN)
        self.read()
        self.alert.refresh_from_db()
        self.assertIsNone(self.alert.acknowledged_at)

    def test_cleared_in_danbyte_is_not_set_again_by_the_same_acknowledgement(self):
        self.acked_in_prtg(2092)
        self.read()
        with mock.patch("prtg.acks.django_rq"):
            set_acknowledged(self.alert, False)
        self.read()
        self.alert.refresh_from_db()
        self.assertIsNone(self.alert.acknowledged_at)
        # Something new in PRTG is news again.
        self.acked_in_prtg(2092, note="Vendor on site")
        self.read()
        self.alert.refresh_from_db()
        self.assertIsNotNone(self.alert.acknowledged_at)

    def test_the_switch_off_reads_nothing(self):
        self.conn.write_acknowledgements = False
        self.conn.save()
        self.acked_in_prtg(2092)
        self.read()
        self.alert.refresh_from_db()
        self.assertIsNone(self.alert.acknowledged_at)

    def test_a_push_reread_carries_it_in_seconds(self):
        self.read()
        self.conn.push_enabled = True
        self.conn.save()
        self.acked_in_prtg(2092)
        counts = refresh_device(str(self.conn.id), device_objid=ZABBIX)
        self.assertEqual(counts["acknowledged"], 1)

    def test_the_message_is_split_into_who_and_note(self):
        self.assertEqual(
            parse_ack("Cable cut (Acknowledged by Jane Doe on 10/26/2026 at 9:51 AM): x"),
            ("Jane Doe", "Cable cut"),
        )
        self.assertEqual(parse_ack("plain"), ("", "plain"))


class MergeTests(TestCase):
    def test_overlaps_chain_and_only_the_open_group_counts(self):
        now = timezone.now()
        h = timedelta(hours=1)
        a, b, c = object(), object(), object()
        spans = [(now - h, now + h, a), (now + h / 2, now + 3 * h, b),
                 (now + 5 * h, now + 6 * h, c)]
        start, end, events = merged(spans, now)
        self.assertEqual((start, end, events), (now - h, now + 3 * h, [a, b]))
        self.assertIsNone(merged([(now + h, now + 2 * h, a)], now))


class MaintenanceTests(_Wired):
    def setUp(self):
        super().setUp()
        self.conn.sync_maintenance = True
        self.conn.save()
        self.read()
        self.link = PrtgDeviceLink.objects.get(device=self.zbx)

    def event(self, *parents, start=-1, hours=3, name="Splice", status="confirmed"):
        from api.models import Status

        now = timezone.now().replace(microsecond=0)
        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, status=Status.objects.get(tenant=self.tenant, slug=status),
            name=name, starts_at=now + timedelta(hours=start),
            ends_at=now + timedelta(hours=start + hours),
        )
        for p in parents:
            kind = "api.virtualmachine" if isinstance(p, VirtualMachine) else "api.device"
            EventImpact.objects.create(
                tenant=self.tenant, event=ev, object_type=kind, object_id=p.id
            )
        ev.sync_silence()
        return ev

    def pauses(self):
        return [(name, q) for name, q in self.fake.writes
                if name in ("pause.htm", "pauseobjectfor.htm")]

    def test_an_open_window_pauses_the_device_until_its_end(self):
        ev = self.event(self.zbx)
        counts = reconcile(self.conn)
        self.assertEqual(counts["paused"], 1)
        [(name, q)] = self.pauses()
        self.assertEqual((name, q["id"]), ("pauseobjectfor.htm", "2082"))
        self.assertIn(int(q["duration"]), (120, 121))
        self.assertTrue(q["pausemsg"].startswith("[Danbyte] Maintenance: Splice"))
        self.link.refresh_from_db()
        self.assertEqual(self.link.maintenance_paused_until, ev.silence.ends_at)
        self.assertEqual(self.link.maintenance_events, [{"id": str(ev.id), "name": "Splice"}])
        self.assertEqual(self.fake.device(ZABBIX)["status_raw"], st.PAUSED_UNTIL)

    def test_overlapping_windows_pause_once_until_the_latest_end(self):
        self.event(self.zbx, start=-1, hours=2, name="A")
        b = self.event(self.zbx, start=0, hours=4, name="B")
        reconcile(self.conn)
        [(_name, q)] = self.pauses()
        self.assertIn(int(q["duration"]), (240, 241))
        self.link.refresh_from_db()
        self.assertEqual(self.link.maintenance_paused_until, b.silence.ends_at)
        self.assertEqual(len(self.link.maintenance_events), 2)

    def test_a_window_that_has_not_started_is_not_written_early(self):
        self.event(self.zbx, start=2)
        reconcile(self.conn)
        self.assertEqual(self.pauses(), [])

    def test_a_tentative_window_is_not_written(self):
        self.event(self.zbx, status="tentative")
        reconcile(self.conn)
        self.assertEqual(self.pauses(), [])

    def test_a_second_pass_writes_nothing(self):
        self.event(self.zbx)
        reconcile(self.conn)
        reconcile(self.conn)
        self.assertEqual(len(self.pauses()), 1)

    def test_a_longer_window_extends_the_pause(self):
        ev = self.event(self.zbx)
        reconcile(self.conn)
        ev.ends_at = ev.ends_at + timedelta(hours=2)
        ev.save()
        ev.sync_silence()
        counts = reconcile(self.conn)
        self.assertEqual(counts["extended"], 1)
        self.assertIn(int(self.pauses()[-1][1]["duration"]), (240, 241))

    def test_a_window_cancelled_early_resumes_the_device(self):
        ev = self.event(self.zbx)
        reconcile(self.conn)
        ev.delete()
        counts = reconcile(self.conn)
        self.assertEqual(counts["resumed"], 1)
        name, q = self.pauses()[-1]
        self.assertEqual((name, q["id"], q["action"]), ("pause.htm", "2082", "1"))
        self.link.refresh_from_db()
        self.assertIsNone(self.link.maintenance_paused_until)

    def test_a_device_an_operator_paused_is_never_touched(self):
        self.fake.set_status(ZABBIX, st.PAUSED_USER, "Rack move (Paused by Bob)")
        ev = self.event(self.zbx)
        counts = reconcile(self.conn)
        self.assertEqual((counts["paused"], counts["left"]), (0, 1))
        self.link.refresh_from_db()
        self.assertIsNone(self.link.maintenance_paused_until)
        ev.delete()
        reconcile(self.conn)
        self.assertEqual(self.pauses(), [])
        self.assertEqual(self.fake.device(ZABBIX)["status_raw"], st.PAUSED_USER)

    def test_a_pause_taken_over_by_an_operator_is_not_resumed(self):
        ev = self.event(self.zbx)
        reconcile(self.conn)
        self.fake.set_status(ZABBIX, st.PAUSED_USER, "Mine now (Paused by Bob)")
        ev.delete()
        reconcile(self.conn)
        self.assertEqual(len(self.pauses()), 1)
        self.assertEqual(self.fake.device(ZABBIX)["status_raw"], st.PAUSED_USER)
        self.link.refresh_from_db()
        self.assertIsNone(self.link.maintenance_paused_until)

    def test_a_vm_the_window_names_is_paused_too(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-dev", cluster=Cluster.objects.create(
                tenant=self.tenant, name="C", type=ct)
        )
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.41/24", prefix=self.prefix, assigned_vm=vm
        )
        self.read()
        self.event(self.zbx, vm)
        reconcile(self.conn)
        self.assertEqual(sorted(q["id"] for _n, q in self.pauses()), ["2081", "2082"])

    def test_an_unreadable_prtg_writes_nothing(self):
        self.event(self.zbx)
        self.fake.fail = (500, "boom")
        counts = reconcile(self.conn)
        self.assertIn("error", counts)
        self.assertEqual(self.pauses(), [])

    def test_the_job_rechecks_the_switch(self):
        self.conn.sync_maintenance = False
        self.conn.save()
        self.assertEqual(run_maintenance_sync(str(self.conn.id)), {"skipped": "maintenance sync off"})

    def test_a_settled_window_queues_a_reconcile_after_commit(self):
        with mock.patch("prtg.maintenance.django_rq") as rq, \
                self.captureOnCommitCallbacks(execute=True):
            self.event(self.zbx)
        calls = rq.get_queue.return_value.enqueue.call_args_list
        self.assertTrue(calls)
        self.assertEqual(calls[0].args[0], run_maintenance_sync)

    def test_the_beat_queues_it_on_the_status_cadence(self):
        queue = mock.Mock()
        with mock.patch("prtg.sync_tasks.django_rq.get_queue", return_value=queue):
            counts = enqueue_due_reads()
        self.assertEqual(counts["maintenance"], 1)
        self.conn.last_maintenance_sync_at = timezone.now()
        self.conn.save()
        with mock.patch("prtg.sync_tasks.django_rq.get_queue", return_value=queue):
            self.assertEqual(enqueue_due_reads()["maintenance"], 0)

    def test_the_link_says_until_when(self):
        self.event(self.zbx)
        reconcile(self.conn)
        _login(self.client, self.tenant)
        r = self.client.get(f"/api/prtg/links/?device={self.zbx.id}")
        row = r.json()["results"][0]
        self.assertIsNotNone(row["maintenance_paused_until"])
        self.assertEqual(row["maintenance_events"][0]["name"], "Splice")


def _login(client, tenant):
    """A superuser working in ``tenant``."""
    user = User.objects.filter(username="root").first() or User.objects.create_superuser(
        "root", "r@x.io", "pw"
    )
    client.force_login(user)
    session = client.session
    session["current_tenant_id"] = str(tenant.id)
    session.save()


class AdoptionTests(_Lab):
    def setUp(self):
        super().setUp()
        seed_builtin_statuses(self.tenant)
        vendor = Manufacturer.objects.create(tenant=self.tenant, name="V", slug="v")
        self.dtype = DeviceType.objects.create(tenant=self.tenant, manufacturer=vendor, model="M")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.conn.adopt_devices = True
        self.conn.adopt_site, self.conn.adopt_role = self.site, self.role
        self.conn.adopt_device_type = self.dtype
        self.conn.save()

    def proposals(self):
        return {c.key: c for c in PrtgChange.objects.filter(kind=PrtgChange.ADOPT)}

    def test_unknown_devices_are_proposed_and_prtgs_own_are_not(self):
        counts = self.read()
        self.assertEqual(counts["adopt"], 5)
        self.assertEqual(set(self.proposals()), {"46", "2080", "2081", "2082", "2095"})

    def test_what_danbyte_has_is_not_proposed(self):
        self.device("db-dev01", "10.0.0.41")
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="router-vm",
            cluster=Cluster.objects.create(tenant=self.tenant, name="C", type=ct),
        )
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1/24", prefix=self.prefix, assigned_vm=vm
        )
        self.read()
        self.assertNotIn("2081", self.proposals())
        self.assertNotIn("2095", self.proposals())

    def test_a_proposal_carries_its_placement(self):
        self.read()
        d = self.proposals()["2080"].detail
        self.assertEqual((d["name"], d["address"], d["site"], d["role"], d["device_type"]),
                         ("sw-01", "10.0.0.2", "Lab", "R", "M"))
        self.assertEqual(sorted(d["defaulted"]), ["device_type", "role", "site"])

    def test_the_lightest_matching_rule_wins(self):
        a = Site.objects.create(tenant=self.tenant, name="A")
        b = Site.objects.create(tenant=self.tenant, name="B")
        c = Site.objects.create(tenant=self.tenant, name="C")
        PrtgAdoptionRule.objects.create(
            tenant=self.tenant, connection=self.conn, scope="name", pattern="db-*",
            site=a, weight=10,
        )
        PrtgAdoptionRule.objects.create(
            tenant=self.tenant, connection=self.conn, scope="ip", pattern="10.0.0.0/26",
            site=b, weight=5,
        )
        PrtgAdoptionRule.objects.create(
            tenant=self.tenant, connection=self.conn, scope="probe", pattern="Local*",
            site=c, weight=1, enabled=False,
        )
        self.read()
        d = self.proposals()["2081"].detail
        self.assertEqual((d["site"], d["rule"]), ("B", "10.0.0.0/26"))
        self.assertNotIn("site", d["defaulted"])

    def test_a_group_named_like_a_site_places_it(self):
        Site.objects.create(tenant=self.tenant, name="Network Infrastructure")
        self.read()
        self.assertEqual(self.proposals()["46"].detail["site"], "Network Infrastructure")

    def test_applying_makes_the_device_its_address_and_the_link(self):
        self.read()
        msg = apply_adoption(self.proposals()["2080"])
        self.assertIn("Adopted sw-01", msg)
        dev = Device.objects.get(tenant=self.tenant, name="sw-01")
        self.assertEqual(str(dev.primary_ip.ip_address).split("/")[0], "10.0.0.2")
        link = PrtgDeviceLink.objects.get(connection=self.conn, objid="2080")
        self.assertEqual((link.device, link.matched_by, link.created_here),
                         (dev, "adopted", False))
        self.read()
        self.assertNotIn("2080", self.proposals())
        self.assertEqual(PrtgDeviceLink.objects.get(objid="2080").device, dev)

    def test_an_address_outside_every_prefix_is_not_recorded(self):
        row = self.fake.device(2080)
        row["host"] = row["host_raw"] = "192.168.77.7"
        self.read()
        msg = apply_adoption(self.proposals()["2080"])
        self.assertIn("is in no prefix of yours", msg)
        self.assertIsNone(Device.objects.get(name="sw-01").primary_ip)

    def test_a_dns_name_is_adopted_without_an_address(self):
        self.read()
        change = self.proposals()["46"]
        self.assertIn("DNS name", change.detail["note"])
        apply_adoption(change)
        self.assertIsNone(Device.objects.get(name="Internet").primary_ip)

    def test_without_defaults_it_waits_and_says_why(self):
        self.conn.adopt_site = self.conn.adopt_role = self.conn.adopt_device_type = None
        self.conn.save()
        self.read()
        change = self.proposals()["2080"]
        self.assertIn("No site, role, device type", change.detail["reason"])
        with self.assertRaises(ValueError):
            apply_adoption(change)

    def test_setting_the_defaults_refreshes_the_waiting_proposals(self):
        self.conn.adopt_site = self.conn.adopt_role = self.conn.adopt_device_type = None
        self.conn.save()
        self.read()
        _login(self.client, self.tenant)
        r = self.client.patch(
            f"/api/prtg/connections/{self.conn.id}/",
            {"adopt_site": str(self.site.id), "adopt_role": str(self.role.id),
             "adopt_device_type": str(self.dtype.id)},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["adopt_names"]["site"], "Lab")
        r = self.client.get(f"/api/prtg/changes/?connection={self.conn.id}")
        adopt = [c for c in r.json()["results"] if c["kind"] == "adopt"]
        self.assertTrue(adopt and all(c["applicable"] for c in adopt))
        r = self.client.post(f"/api/prtg/changes/{adopt[0]['id']}/apply/")
        self.assertEqual(r.status_code, 200, r.content)

    def test_turning_adoption_off_clears_the_proposals(self):
        self.read()
        self.conn.adopt_devices = False
        self.conn.save()
        self.read()
        self.assertEqual(self.proposals(), {})

    def test_one_proposal_per_prtg_device(self):
        self.read()
        self.read()
        self.assertEqual(PrtgChange.objects.filter(kind="adopt", key="2080").count(), 1)
        with self.assertRaises(IntegrityError), transaction.atomic():
            PrtgChange.objects.create(
                tenant=self.tenant, connection=self.conn, kind="adopt", key="2080"
            )

    def test_another_tenants_rows_are_refused(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        foreign = Site.objects.create(tenant=other, name="Foreign")
        self.read()
        change = self.proposals()["2080"]
        change.detail = {**change.detail, "site_id": str(foreign.id)}
        change.save()
        with self.assertRaises(ValueError):
            apply_adoption(change)
        self.assertFalse(Device.objects.filter(name="sw-01").exists())
        _login(self.client, self.tenant)
        r = self.client.patch(
            f"/api/prtg/connections/{self.conn.id}/", {"adopt_site": str(foreign.id)},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/prtg/adoption-rules/", {
            "connection": str(self.conn.id), "scope": "name", "pattern": "x*",
            "site": str(foreign.id),
        }, content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_another_tenants_proposals_are_not_reachable(self):
        self.read()
        change = self.proposals()["2080"]
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        from integrations.models import IntegrationSettings

        IntegrationSettings.objects.update_or_create(
            tenant=other, defaults={"prtg_enabled": True}
        )
        _login(self.client, other)
        r = self.client.post(f"/api/prtg/changes/{change.id}/apply/")
        self.assertEqual(r.status_code, 404)
        self.assertFalse(Device.objects.filter(name="sw-01").exists())

    def test_apply_all_skips_what_is_not_placed(self):
        self.read()
        PrtgChange.objects.filter(key="2080").update(detail={"objid": "2080", "name": "sw-01"})
        _login(self.client, self.tenant)
        r = self.client.post("/api/prtg/changes/apply-all/", {"connection": str(self.conn.id)},
                             content_type="application/json")
        self.assertEqual(r.json()["applied"], 4)
        self.assertFalse(Device.objects.filter(name="sw-01").exists())


class InventoryTests(_Lab):
    def setUp(self):
        super().setUp()
        self.conn.read_inventory = True
        self.conn.save()
        # The probe device is the only one with system information; give it a
        # serial the recording (a VM) does not have.
        self.fake.sysinfo[40] = self.fake.sysinfo[40].replace(
            '"_raw":"Bios Serial Number","":"","_raw":""',
            '"_raw":"Bios Serial Number","":"VMW-123","_raw":"VMW-123"', 1,
        )
        self.probe = self.device("Probe Device", "10.0.0.250")
        self.dev01 = self.device("db-dev01", "10.0.0.41")
        self.read()

    def drift(self, device=None):
        return [i for i in compute_device_drift(device or self.probe, self.tenant)
                if i["kind"] == "device_field"]

    def test_the_pass_records_what_prtg_has(self):
        counts = read_inventory(self.conn)
        self.assertEqual((counts["read"], counts["empty"]), (1, 1))
        facts = PrtgHostFacts.objects.get(device=self.probe)
        self.assertEqual(facts.data["serial"], "VMW-123")
        self.assertIn("Windows Server 2022", facts.data["os"])
        self.assertTrue(facts.reachable)
        self.assertEqual(PrtgHostFacts.objects.get(device=self.dev01).data, {})

    def test_the_serial_is_drift_from_prtg(self):
        read_inventory(self.conn)
        [item] = self.drift()
        self.assertEqual((item["field"], item["observed"], item["source"]),
                         ("serial_number", "VMW-123", "prtg"))
        self.probe.refresh_from_db()
        self.assertEqual(self.probe.serial_number, "")

    def test_a_direct_poll_outranks_it(self):
        read_inventory(self.conn)
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.probe, reachable=True, polled_at=timezone.now(),
            data={"sys_name": "Probe Device", "serial": "SNMP-9"},
        )
        [item] = self.drift()
        self.assertEqual(item["observed"], "SNMP-9")
        self.assertNotIn("source", item)

    def test_the_switch_off_withdraws_the_opinion(self):
        read_inventory(self.conn)
        self.conn.read_inventory = False
        self.conn.save()
        self.assertEqual(self.drift(), [])
        self.assertEqual(run_inventory_read(str(self.conn.id)), {"skipped": "inventory off"})

    def test_a_paused_device_is_not_an_observation_of_now(self):
        link = PrtgDeviceLink.objects.get(device=self.probe)
        link.status_raw = st.PAUSED_USER
        link.save()
        read_inventory(self.conn)
        self.assertFalse(PrtgHostFacts.objects.get(device=self.probe).reachable)
        self.assertEqual(self.drift(), [])

    def test_the_oldest_are_read_first_and_fresh_ones_wait(self):
        read_inventory(self.conn, limit=1)
        self.assertEqual(PrtgHostFacts.objects.count(), 1)
        read_inventory(self.conn, limit=1)
        self.assertEqual(PrtgHostFacts.objects.count(), 2)
        before = len(self.fake.calls("/api/table.json"))
        self.assertEqual(read_inventory(self.conn), {"read": 0, "empty": 0, "failed": 0})
        self.assertEqual(len(self.fake.calls("/api/table.json")), before)

    def test_unlinking_forgets_what_it_said(self):
        read_inventory(self.conn)
        PrtgDeviceLink.objects.filter(device=self.probe).delete()
        self.assertFalse(PrtgHostFacts.objects.filter(device=self.probe).exists())

    def test_another_tenants_facts_are_not_read(self):
        read_inventory(self.conn)
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        self.assertEqual(compute_device_drift(self.probe, other), [])

    def test_the_beat_queues_it_hourly(self):
        queue = mock.Mock()
        with mock.patch("prtg.sync_tasks.django_rq.get_queue", return_value=queue):
            self.assertEqual(enqueue_due_reads()["inventory"], 1)
        run_inventory_read(str(self.conn.id))
        with mock.patch("prtg.sync_tasks.django_rq.get_queue", return_value=queue):
            self.assertEqual(enqueue_due_reads()["inventory"], 0)


class ConnectionApiTests(_Lab):
    def setUp(self):
        super().setUp()
        _login(self.client, self.tenant)

    def test_the_switches_and_their_defaults(self):
        r = self.client.get(f"/api/prtg/connections/{self.conn.id}/").json()
        self.assertEqual(
            {k: r[k] for k in ("write_acknowledgements", "sync_maintenance",
                               "read_inventory", "adopt_devices")},
            {"write_acknowledgements": True, "sync_maintenance": False,
             "read_inventory": False, "adopt_devices": False},
        )
        self.assertEqual(r["adopt_names"], {"site": None, "role": None, "device_type": None})

    def test_maintenance_now_needs_the_switch(self):
        url = f"/api/prtg/connections/{self.conn.id}/maintenance-now/"
        self.assertEqual(self.client.post(url).status_code, 400)
        self.conn.sync_maintenance = True
        self.conn.save()
        r = self.client.post(url)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["paused"], 0)
