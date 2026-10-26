"""PRTG Mode 1: the state map, matching, the status read, the beat and the
``prtg`` check - against the fake server, on recordings from PRTG 26.3.

The lab's devices: db-dev01 (2081, host 10.0.0.41: Ping v2, HTTP v2, HTTPS
v2, SSL security, and an SSL certificate sensor in Warning), db-zabbix (2082,
10.0.0.53: Ping v2 and HTTP), sw-01 (2080, 10.0.0.2, no sensors), plus the
probe device, the core server, "Internet" and "gw 10.0.0.0".
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from api.models import (
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    Prefix,
    Site,
    VirtualMachine,
)
from core.models import DeploymentSettings, Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.engine_drivers import driver_for, engine_kinds, engine_usable
from monitoring.external.beat import entries
from monitoring.models import CheckState, CheckTemplate, MonitoringEngine
from prtg import status as st
from prtg.driver import PrtgDriver
from prtg.matching import annotate_devices, index_devices, match_device
from prtg.models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor
from prtg.reader import read_status, refresh_device, run_status_read
from prtg.sync_tasks import enqueue_due_reads

from .fake_server import FakePrtg


class StateMapTests(SimpleTestCase):
    def test_defaults(self):
        m = st.clean_map({})
        self.assertEqual(
            {k: m[k] for k in ("3", "4", "10", "5", "14", "13")},
            {"3": "up", "4": "degraded", "10": "degraded", "5": "down",
             "14": "degraded", "13": "down"},
        )
        for code in ("0", "1", "2", "6", "7", "8", "9", "11", "12"):
            with self.subTest(code=code):
                self.assertEqual(m[code], "unknown")

    def test_edits_apply_and_fixed_codes_stay_unknown(self):
        m = st.clean_map({"10": "up", "11": "down", "7": "up", "4": "purple", "99": "down"})
        self.assertEqual(m["10"], "up")
        self.assertEqual(m["11"], "unknown")   # not licensed is never a verdict
        self.assertEqual(m["7"], "unknown")    # nor is paused
        self.assertEqual(m["4"], "degraded")   # nonsense falls back to the default
        self.assertNotIn("99", m)

    def test_rollup_worst_wins(self):
        m = st.clean_map({})
        self.assertEqual(st.rollup([3, 3, 4], m), "degraded")
        self.assertEqual(st.rollup([3, 4, 5], m), "down")
        self.assertEqual(st.rollup([3, 14], m), "degraded")
        self.assertEqual(st.rollup([3, 13], m), "down")

    def test_not_licensed_is_unknown_never_down(self):
        m = st.clean_map({})
        self.assertEqual(st.rollup([st.NOT_LICENSED], m), "unknown")
        # Something answering outweighs nothing known.
        self.assertEqual(st.rollup([st.UP, st.NOT_LICENSED], m), "up")

    def test_paused_sensors_are_left_out(self):
        m = st.clean_map({})
        self.assertEqual(st.rollup([st.PAUSED_USER, st.UP], m), "up")
        self.assertEqual(st.rollup([st.PAUSED_USER, st.PAUSED_UNTIL], m), "unknown")
        self.assertEqual(st.rollup([], m), "unknown")

    def test_an_edited_map_changes_the_rollup(self):
        self.assertEqual(st.rollup([3, 10], st.clean_map({"10": "up"})), "up")


class _Lab(TestCase):
    """A tenant shaped like the lab, a connection to the fake PRTG."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.fake = FakePrtg().start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()
        super().tearDownClass()

    def setUp(self):
        self.fake.reset()
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = ["127.0.0.1/32"]
        ds.save()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"prtg_enabled": True}
        )
        self.site = Site.objects.create(tenant=self.tenant, name="Lab")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.conn = PrtgConnection.objects.create(
            tenant=self.tenant, name="lab", url=self.fake.url,
            api_v2_url=self.fake.v2_url, credentials={"api_key": self.fake.api_key},
            version="26.3.124.1727",
        )

    def device(self, name, *addresses, dns=""):
        d = Device.objects.create(tenant=self.tenant, name=name, site=self.site)
        for i, addr in enumerate(addresses):
            ip = IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"{addr}/24", prefix=self.prefix,
                assigned_device=d, dns_name=dns if i == 0 else "",
            )
            if i == 0:
                d.primary_ip = ip
                d.save(update_fields=["primary_ip"])
        return d

    def read(self, **kw):
        with mock.patch("prtg.client.PAGE_GAP_SECONDS", 0):
            return read_status(self.conn, **kw)


class MatchingTests(_Lab):
    def _index(self):
        from prtg.client import PrtgClient

        return index_devices(PrtgClient.for_connection(self.conn).devices().rows)

    def _match(self, device, link=None):
        [annotated] = annotate_devices(self.tenant, [device])
        return match_device(annotated, self._index(), link)

    def test_tag_beats_everything(self):
        d = self.device("renamed", "10.9.9.9")
        row = next(r for r in self.fake.tables["devices"] if r["objid"] == 2082)
        row["tags"] = row["tags_raw"] = f"linux danbyte-{d.id}"
        m = self._match(d)
        self.assertEqual((m.how, m.remote["objid"]), ("tag", "2082"))

    def test_address(self):
        m = self._match(self.device("anything", "10.0.0.53"))
        self.assertEqual((m.how, m.remote["objid"]), ("address", "2082"))

    def test_any_assigned_address_counts(self):
        m = self._match(self.device("anything", "10.0.0.200", "10.0.0.2"))
        self.assertEqual((m.how, m.remote["objid"]), ("address", "2080"))

    def test_dns_name(self):
        row = next(r for r in self.fake.tables["devices"] if r["objid"] == 2080)
        row["host"] = row["host_raw"] = "SW-01.danbyte.lan"
        m = self._match(self.device("other-name", "10.0.0.77", dns="sw-01.danbyte.lan"))
        self.assertEqual((m.how, m.remote["objid"]), ("dns", "2080"))

    def test_exact_name(self):
        m = self._match(self.device("DB-ZABBIX", "10.0.5.1"))
        self.assertEqual((m.how, m.remote["objid"]), ("name", "2082"))

    def test_two_prtg_devices_at_one_level_is_no_match(self):
        for objid in (2080, 2082):
            row = next(r for r in self.fake.tables["devices"] if r["objid"] == objid)
            row["host"] = row["host_raw"] = "10.0.0.99"
        m = self._match(self.device("x", "10.0.0.99"))
        self.assertEqual(m.how, "ambiguous")
        self.assertIn("sw-01", m.reason)
        self.assertIn("db-zabbix", m.reason)

    def test_the_stored_link_wins(self):
        d = self.device("db-zabbix", "10.0.0.53")
        link = PrtgDeviceLink(objid="2080")
        m = self._match(d, link)
        self.assertEqual((m.how, m.remote["objid"]), ("link", "2080"))

    def test_nothing(self):
        m = self._match(self.device("nowhere", "10.0.5.5"))
        self.assertEqual(m.how, "none")


class StatusReadTests(_Lab):
    def test_links_writes_sensors_and_rolls_up(self):
        dev01 = self.device("db-dev01", "10.0.0.41")
        zbx = self.device("db-zabbix", "10.0.0.53")
        counts = self.read()
        self.assertEqual(counts["linked"], 2)
        link = PrtgDeviceLink.objects.get(device=dev01)
        self.assertEqual((link.objid, link.matched_by, link.host), ("2081", "address", "10.0.0.41"))
        # The SSL certificate sensor is in Warning in the recording.
        self.assertEqual(link.state, "degraded")
        self.assertEqual(link.sensor_counts, {"total": 5, "paused": 0, "up": 4, "degraded": 1})
        self.assertEqual(PrtgSensor.objects.filter(device=dev01).count(), 5)
        self.assertEqual(PrtgDeviceLink.objects.get(device=zbx).state, "up")
        ping = PrtgSensor.objects.get(objid="2089")
        self.assertEqual((ping.kind_label, ping.state, ping.tags),
                         ("Ping v2", "up", ["icmp", "ping", "pingsensor"]))

    def test_a_vm_and_a_device_on_one_address_is_a_question(self):
        """The lab's case: db-dev01 is a VM at 10.0.0.41, and kbh-srv1 is a
        device recorded on the same address. PRTG's db-dev01 must not be
        linked to kbh-srv1 because they share it."""
        # As in the demo tenant: the address row is kbh-srv1's, and the VM
        # names it as its primary address.
        kbh = self.device("kbh-srv1", "10.0.0.41")
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="db-dev01", cluster=cluster,
            primary_ip=kbh.primary_ip,
        )
        counts = self.read()
        self.assertEqual(counts["linked"], 0)
        self.assertFalse(PrtgDeviceLink.objects.exists())
        row = PrtgChange.objects.get(kind=PrtgChange.AMBIGUOUS, device__isnull=False)
        self.assertEqual(row.device.name, "kbh-srv1")
        self.assertIn("10.0.0.41", row.detail["reason"])
        self.assertIn("VM db-dev01", row.detail["reason"])
        # The VM matches the same address, and is asked about too.
        vm_row = PrtgChange.objects.get(kind=PrtgChange.AMBIGUOUS, device__isnull=True)
        self.assertEqual(vm_row.virtual_machine.name, "db-dev01")

    def test_two_danbyte_devices_on_one_prtg_device_is_a_question(self):
        self.device("db-zabbix", "10.0.5.1")
        self.device("db-zabbix ", "10.0.5.2")   # same name once trimmed
        self.read()
        self.assertFalse(PrtgDeviceLink.objects.exists())
        self.assertEqual(PrtgChange.objects.filter(kind=PrtgChange.AMBIGUOUS).count(), 2)

    def test_review_mode_proposes_and_apply_links(self):
        self.conn.link_mode = PrtgConnection.LINK_REVIEW
        self.conn.save()
        d = self.device("db-zabbix", "10.0.0.53")
        counts = self.read()
        self.assertEqual(counts["proposed"], 1)
        self.assertFalse(PrtgDeviceLink.objects.exists())
        change = PrtgChange.objects.get(kind=PrtgChange.LINK)
        self.assertEqual((change.device, change.key, change.detail["matched_by"]),
                         (d, "2082", "address"))
        from prtg.reader import apply_link

        apply_link(change)
        self.assertEqual(PrtgDeviceLink.objects.get(device=d).objid, "2082")
        # The next pass finds the link and proposes nothing.
        self.read()
        self.assertFalse(PrtgChange.objects.filter(kind=PrtgChange.LINK).exists())

    def test_a_stale_proposal_is_dropped(self):
        self.conn.link_mode = PrtgConnection.LINK_REVIEW
        self.conn.save()
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.assertTrue(PrtgChange.objects.exists())
        d.name = "elsewhere"
        d.save()
        IPAddress.objects.filter(assigned_device=d).delete()
        self.read()
        self.assertFalse(PrtgChange.objects.exists())

    def test_a_sensor_gone_from_prtg_is_deleted(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.fake.tables["sensors"] = [
            r for r in self.fake.tables["sensors"] if r["objid"] != 2100
        ]
        self.read()
        self.assertEqual(
            sorted(PrtgSensor.objects.filter(device=d).values_list("objid", flat=True)),
            ["2092"],
        )

    def test_a_device_gone_from_prtg_reads_unknown(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.fake.tables["devices"] = [
            r for r in self.fake.tables["devices"] if r["objid"] != 2082
        ]
        self.read()
        link = PrtgDeviceLink.objects.get(device=d)
        self.assertEqual((link.state, link.status_raw), ("unknown", None))
        self.assertFalse(PrtgSensor.objects.filter(device=d).exists())

    def test_an_edited_map_reaches_the_stored_rows(self):
        from prtg.reader import remap

        d = self.device("db-dev01", "10.0.0.41")
        self.read()
        self.conn.state_map = {"4": "up"}
        self.conn.save()
        remap(self.conn)
        self.assertEqual(PrtgDeviceLink.objects.get(device=d).state, "up")

    def test_cross_tenant_devices_are_never_linked(self):
        other = Tenant.objects.create(org=self.tenant.org, name="U", slug="u")
        Device.objects.create(tenant=other, name="db-zabbix")
        self.read()
        self.assertFalse(PrtgDeviceLink.objects.exists())


class BeatTests(_Lab):
    def test_registered_on_the_shared_beat(self):
        entry = {e.name: e for e in entries()}["prtg"]
        self.assertFalse(entry.own_timer)

    def test_due_connections_are_queued_once(self):
        queue = mock.Mock()
        with mock.patch("django_rq.get_queue", return_value=queue):
            self.assertEqual(enqueue_due_reads()["status"], 1)
            self.conn.last_status_at = timezone.now()
            self.conn.save()
            self.assertEqual(enqueue_due_reads()["status"], 0)
            self.conn.last_status_at = timezone.now() - timedelta(seconds=121)
            self.conn.save()
            self.assertEqual(enqueue_due_reads()["status"], 1)

    def test_integration_off_is_not_queued(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        with mock.patch("django_rq.get_queue", return_value=mock.Mock()):
            self.assertEqual(enqueue_due_reads()["status"], 0)

    def test_skip_reasons_at_run_time(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.assertEqual(run_status_read(str(self.conn.id)), {"skipped": "integration off"})
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=True)
        self.tenant.is_active = False
        self.tenant.save()
        self.assertEqual(run_status_read(str(self.conn.id)), {"skipped": "tenant inactive"})
        self.assertEqual(
            run_status_read("00000000-0000-0000-0000-000000000000"), {"skipped": "gone"}
        )
        self.tenant.is_active = True
        self.tenant.save()
        self.conn.enabled = False
        self.conn.save()
        self.assertEqual(run_status_read(str(self.conn.id)), {"skipped": "connection off"})

    def test_a_run_stamps_the_connection(self):
        self.device("db-zabbix", "10.0.0.53")
        with mock.patch("prtg.client.PAGE_GAP_SECONDS", 0):
            out = run_status_read(str(self.conn.id))
        self.assertEqual(out["linked"], 1)
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_status_at)
        self.assertEqual(self.conn.last_checked_at, self.conn.last_status_at)
        self.assertEqual(self.conn.last_error, "")

    def test_a_failed_read_writes_nothing_and_stamps_the_error(self):
        self.device("db-zabbix", "10.0.0.53")
        self.fake.fail = (500, '<div class="errormsg">Internal error</div>')
        out = run_status_read(str(self.conn.id))
        self.assertIn("Internal error", out["error"])
        self.assertFalse(PrtgDeviceLink.objects.exists())
        self.conn.refresh_from_db()
        self.assertIn("Internal error", self.conn.last_error)
        self.assertIsNotNone(self.conn.last_status_at)
        self.assertFalse(self.conn.status_due(timezone.now()))


class DriverTests(_Lab):
    def setUp(self):
        super().setUp()
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="prtg", slug="prtg", kind="prtg"
        )
        self.conn.engines.add(self.engine)
        self.tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="PRTG", slug="prtg", kind="prtg",
            interval_seconds=120
        )

    def state(self, device, tmpl=None):
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=device.primary_ip, template=tmpl or self.tmpl,
            engine=self.engine, kind="prtg", interval_seconds=120,
            next_run=timezone.now() - timedelta(seconds=1),
        )

    def claim(self):
        return PrtgDriver().claim(self.engine, timezone.now())

    def stamp(self):
        self.conn.last_status_at = timezone.now()
        self.conn.last_error = ""
        self.conn.save()

    def test_registered(self):
        self.assertIn("prtg", {k.kind for k in engine_kinds()})
        self.assertIsInstance(driver_for(self.engine), PrtgDriver)
        self.assertTrue(engine_usable(self.engine))
        from monitoring.models import check_kinds

        self.assertIn(("prtg", "PRTG"), check_kinds())

    def test_unusable_when_the_integration_is_off(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.assertFalse(engine_usable(self.engine))

    def test_answers_from_the_read(self):
        dev01 = self.device("db-dev01", "10.0.0.41")
        zbx = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.stamp()
        a, b = self.state(dev01), self.state(zbx)
        self.assertEqual(self.claim(), 2)
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual(b.status, "up")
        self.assertEqual(a.last_detail["system"], "prtg")
        self.assertEqual(a.last_detail["prtg_objid"], "2081")
        self.assertEqual(a.last_detail["problem_count"], 1)
        self.assertEqual(a.last_detail["problems"][0]["name"], "SSL Certificate Sensor (Port 443)")

    def test_down_flows_through_and_not_licensed_does_not(self):
        zbx = self.device("db-zabbix", "10.0.0.53")
        self.fake.set_status(2092, st.DOWN)
        self.fake.set_status(2100, st.NOT_LICENSED)
        self.read()
        self.stamp()
        s = self.state(zbx)
        self.claim()
        s.refresh_from_db()
        self.assertEqual(s.last_detail["problem_count"], 1)
        self.assertEqual(s.last_detail["problems"][0]["severity"], "down")

        self.fake.set_status(2092, st.NOT_LICENSED)
        self.read()
        self.stamp()
        outcome = self._answer(s)
        self.assertEqual(outcome.status, "unknown")
        self.assertIn("PRTG licence limit", outcome.detail["error"])

    def _answer(self, s):
        from prtg.driver import answer

        return answer(self.conn, [CheckState.objects.select_related(
            "target_ip", "template").get(pk=s.pk)])[0][str(s.id)]

    def test_narrowed_to_a_sensor_type(self):
        dev01 = self.device("db-dev01", "10.0.0.41")
        self.read()
        self.stamp()
        ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="PRTG ping", slug="prtg-ping", kind="prtg", interval_seconds=120,
            params={"sensor_type": "Ping v2"},
        )
        self.assertEqual(self._answer(self.state(dev01, ping)).status, "up")
        tagged = CheckTemplate.objects.create(
            tenant=self.tenant, name="PRTG ssl", slug="prtg-ssl", kind="prtg", interval_seconds=120,
            params={"sensor_tag": "sslcertificate"},
        )
        self.assertEqual(self._answer(self.state(dev01, tagged)).status, "degraded")
        none = CheckTemplate.objects.create(
            tenant=self.tenant, name="PRTG snmp", slug="prtg-snmp", kind="prtg", interval_seconds=120,
            params={"sensor_type": "snmptraffic"},
        )
        out = self._answer(self.state(dev01, none))
        self.assertEqual(out.status, "unknown")
        self.assertIn("snmptraffic", out.detail["error"])

    def test_an_unlinked_address_is_unknown(self):
        lone = self.device("lone", "10.0.0.250")
        self.read()
        self.stamp()
        out = self._answer(self.state(lone))
        self.assertEqual(out.status, "unknown")
        self.assertIn("no device for this address", out.detail["error"])

    def test_a_paused_prtg_device_is_unknown(self):
        zbx = self.device("db-zabbix", "10.0.0.53")
        row = next(r for r in self.fake.tables["devices"] if r["objid"] == 2082)
        row["status_raw"], row["status"] = st.PAUSED_USER, "Paused by User"
        self.read()
        self.stamp()
        out = self._answer(self.state(zbx))
        self.assertEqual(out.status, "unknown")
        self.assertIn("Paused", out.detail["state"])

    def test_a_stale_read_answers_unknown(self):
        zbx = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.conn.last_status_at = timezone.now() - timedelta(hours=1)
        self.conn.save()
        s = self.state(zbx)
        self.assertEqual(self._answer(s).status, "unknown")
        self.conn.last_status_at = timezone.now()
        self.conn.last_error = "PRTG refused the API key"
        self.conn.save()
        out = self._answer(s)
        self.assertEqual(out.status, "unknown")
        self.assertIn("refused", out.detail["error"])

    def test_a_push_reread_hurries_the_check(self):
        zbx = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.conn.push_enabled = True
        self.conn.save()
        s = self.state(zbx)
        s.next_run = timezone.now() + timedelta(hours=1)
        s.save()
        self.fake.set_status(2092, st.DOWN)
        with mock.patch("prtg.client.PAGE_GAP_SECONDS", 0):
            refresh_device(str(self.conn.id), sensor_objid=2092)
        self.assertEqual(PrtgSensor.objects.get(objid="2092").state, "down")
        self.assertEqual(PrtgDeviceLink.objects.get(device=zbx).state, "down")
        s.refresh_from_db()
        self.assertLessEqual(s.next_run, timezone.now())
        # Only that device was read.
        self.assertEqual(self.fake.calls("/api/table.json")[-1]["params"]["filter_parentid"],
                         "2082")


class RefreshSkipTests(_Lab):
    def test_push_off_is_skipped(self):
        self.assertEqual(refresh_device(str(self.conn.id), 2092), {"skipped": "push off"})

    def test_an_unlinked_sensor_is_skipped(self):
        self.conn.push_enabled = True
        self.conn.save()
        self.assertEqual(refresh_device(str(self.conn.id), 999), {"skipped": "not linked"})

