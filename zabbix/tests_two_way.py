"""Two-way operations (#162 phase 5): windows out, acknowledgements out.

No network - the client is a Mock and the request shapes are asserted. Both
directions are jobs behind their own switch, and every test that turns a
switch off is a test that nothing is written.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from api.models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.models import (
    Alert,
    CheckState,
    CheckTemplate,
    EventImpact,
    MaintenanceEvent,
    MonitoringEngine,
)
from monitoring.signals import alert_acknowledged

from . import maintenance
from .acks import write_ack
from .client import ZabbixError, ZabbixUnreachable
from .models import ZabbixConnection, ZabbixHostLink, ZabbixMaintenance
from .sync_tasks import enqueue_due_syncs

TOKEN = "a" * 64
T0 = timezone.now().replace(microsecond=0) + timedelta(days=1)


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"zabbix_enabled": True}
        )
        seed_builtin_statuses(self.tenant)
        self.conn = ZabbixConnection.objects.create(
            tenant=self.tenant, name="zbx", url="https://z.example.com",
            credentials={"token": TOKEN}, version="7.0.30",
            sync_maintenance=True, write_acknowledgements=True,
        )
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix"
        )
        self.conn.engines.add(self.engine)
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        vendor = Manufacturer.objects.create(tenant=self.tenant, name="V", slug="v")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=vendor, model="M"
        )
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        self.check = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", kind="zabbix", interval_seconds=300
        )

    def status(self, slug):
        from api.models import Status

        return Status.objects.get(tenant=self.tenant, slug=slug)

    def device(self, name="sw1", octet=10, hostid=None):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.9.0.{octet}/24", prefix=self.prefix
        )
        dev = Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dtype, role=self.role,
            site=self.site,
        )
        ip.assigned_device = dev
        ip.save(update_fields=["assigned_device"])
        dev.primary_ip = ip
        dev.save(update_fields=["primary_ip"])
        if hostid:
            ZabbixHostLink.objects.create(
                tenant=self.tenant, connection=self.conn, device=dev,
                hostid=hostid, host_name=name,
            )
        return dev

    def event(self, *devices, status="confirmed", hours=4, name="Splice"):
        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, status=self.status(status), name=name,
            starts_at=T0, ends_at=T0 + timedelta(hours=hours),
        )
        for dev in devices:
            EventImpact.objects.create(
                tenant=self.tenant, event=ev, object_type="api.device", object_id=dev.id
            )
        ev.sync_silence()
        return ev

    def fake(self, existing=()):
        c = mock.Mock()
        c.maintenances.return_value = {str(i): {"maintenanceid": str(i)} for i in existing}
        c.create_maintenance.return_value = "77"
        c.maintenances_by_name.return_value = {}
        return c


class PayloadTests(_Base):
    def test_seven_writes_host_objects(self):
        p = maintenance.maintenance_payload(
            self.conn, name="n", since=T0, till=T0 + timedelta(hours=1), hostids=["5"]
        )
        self.assertEqual(p["hosts"], [{"hostid": "5"}])
        self.assertNotIn("hostids", p)
        self.assertEqual(p["active_till"] - p["active_since"], 3600)
        self.assertEqual(p["timeperiods"][0]["period"], 3600)
        self.assertEqual(p["maintenance_type"], 0)

    def test_six_zero_writes_host_ids(self):
        self.conn.version = "6.0.30"
        p = maintenance.maintenance_payload(
            self.conn, name="n", since=T0, till=T0 + timedelta(hours=1), hostids=["5"]
        )
        self.assertEqual(p["hostids"], ["5"])
        self.assertNotIn("hosts", p)

    def test_a_window_shorter_than_zabbix_allows_is_stretched(self):
        p = maintenance.maintenance_payload(
            self.conn, name="n", since=T0, till=T0 + timedelta(seconds=30), hostids=["5"]
        )
        self.assertEqual(p["active_till"] - p["active_since"], 300)

    def test_the_name_carries_the_event_id_and_fits(self):
        ev = self.event(name="x" * 200)
        name = maintenance.period_name(ev)
        self.assertLessEqual(len(name), 128)
        self.assertTrue(name.endswith(str(ev.id)[:8]))


class ReconcileTests(_Base):
    def test_a_confirmed_window_over_a_linked_device_is_written(self):
        dev = self.device(hostid="5")
        ev = self.event(dev)
        c = self.fake()
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["created"], 1)
        payload = c.create_maintenance.call_args.args[0]
        self.assertEqual(payload["hosts"], [{"hostid": "5"}])
        self.assertEqual(payload["active_since"], int(T0.timestamp()))
        row = ZabbixMaintenance.objects.get(connection=self.conn, event=ev)
        self.assertEqual(row.maintenanceid, "77")
        self.assertEqual(row.hostids, ["5"])
        self.assertEqual(row.last_error, "")
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_maintenance_sync_at)

    def test_a_second_pass_with_nothing_changed_writes_nothing(self):
        dev = self.device(hostid="5")
        self.event(dev)
        maintenance.reconcile(self.conn, client=self.fake())
        c = self.fake(existing=["77"])
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(
            counts, {"created": 0, "updated": 0, "deleted": 0, "adopted": 0, "failed": 0}
        )
        c.create_maintenance.assert_not_called()
        c.update_maintenance.assert_not_called()

    def test_a_moved_window_updates_the_same_period(self):
        dev = self.device(hostid="5")
        ev = self.event(dev)
        maintenance.reconcile(self.conn, client=self.fake())
        ev.ends_at = T0 + timedelta(hours=8)
        ev.save(update_fields=["ends_at"])
        ev.sync_silence()
        c = self.fake(existing=["77"])
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["updated"], 1)
        mid, payload = c.update_maintenance.call_args.args
        self.assertEqual(mid, "77")
        self.assertEqual(payload["active_till"], int((T0 + timedelta(hours=8)).timestamp()))
        self.assertEqual(ZabbixMaintenance.objects.filter(connection=self.conn).count(), 1)

    def test_a_closed_window_is_taken_back_out(self):
        dev = self.device(hostid="5")
        ev = self.event(dev)
        maintenance.reconcile(self.conn, client=self.fake())
        ev.status = self.status("completed")
        ev.save(update_fields=["status"])
        ev.sync_silence()
        c = self.fake(existing=["77"])
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["deleted"], 1)
        c.delete_maintenances.assert_called_once_with(["77"])
        self.assertFalse(ZabbixMaintenance.objects.filter(connection=self.conn).exists())

    def test_a_deleted_event_leaves_an_orphan_the_next_pass_removes(self):
        dev = self.device(hostid="5")
        ev = self.event(dev)
        maintenance.reconcile(self.conn, client=self.fake())
        ev.delete()
        row = ZabbixMaintenance.objects.get(connection=self.conn)
        self.assertIsNone(row.event)
        c = self.fake(existing=["77"])
        maintenance.reconcile(self.conn, client=c)
        c.delete_maintenances.assert_called_once_with(["77"])
        self.assertFalse(ZabbixMaintenance.objects.exists())

    def test_a_period_removed_by_hand_in_zabbix_comes_back(self):
        dev = self.device(hostid="5")
        self.event(dev)
        maintenance.reconcile(self.conn, client=self.fake())
        c = self.fake(existing=[])
        c.create_maintenance.return_value = "78"
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["created"], 1)
        self.assertEqual(ZabbixMaintenance.objects.get().maintenanceid, "78")

    def test_a_device_zabbix_does_not_know_is_not_a_period(self):
        dev = self.device()
        self.event(dev)
        c = self.fake()
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["created"], 0)
        c.create_maintenance.assert_not_called()

    def test_a_tentative_window_is_not_written(self):
        dev = self.device(hostid="5")
        self.event(dev, status="tentative")
        c = self.fake()
        maintenance.reconcile(self.conn, client=c)
        c.create_maintenance.assert_not_called()

    def test_a_refused_write_is_kept_on_the_row(self):
        dev = self.device(hostid="5")
        ev = self.event(dev)
        c = self.fake()
        c.create_maintenance.side_effect = ZabbixError("Maintenance period is too short.")
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["failed"], 1)
        row = ZabbixMaintenance.objects.get(event=ev)
        self.assertEqual(row.maintenanceid, "")
        self.assertIn("too short", row.last_error)

    def test_an_unreachable_server_writes_nothing_and_says_so(self):
        dev = self.device(hostid="5")
        self.event(dev)
        maintenance.reconcile(self.conn, client=self.fake())
        c = self.fake()
        c.maintenances.side_effect = ZabbixUnreachable("connection refused")
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertIn("error", counts)
        c.create_maintenance.assert_not_called()
        c.delete_maintenances.assert_not_called()
        self.assertIn("refused", ZabbixMaintenance.objects.get().last_error)


class ScheduleTests(_Base):
    def test_settling_a_window_queues_a_reconcile_after_commit(self):
        dev = self.device(hostid="5")
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                self.event(dev)
        gq.return_value.enqueue.assert_called_once()
        args = gq.return_value.enqueue.call_args.args
        self.assertIs(args[0], maintenance.run_maintenance_sync)
        self.assertEqual(args[1], str(self.conn.id))

    def test_deleting_an_event_queues_a_reconcile(self):
        dev = self.device(hostid="5")
        ev = self.event(dev)
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                ev.delete()
        gq.return_value.enqueue.assert_called_once()

    def test_the_switch_off_queues_nothing(self):
        self.conn.sync_maintenance = False
        self.conn.save(update_fields=["sync_maintenance"])
        dev = self.device(hostid="5")
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                self.event(dev)
        gq.return_value.enqueue.assert_not_called()

    def test_the_job_rechecks_every_switch(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(zabbix_enabled=False)
        self.assertEqual(
            maintenance.run_maintenance_sync(str(self.conn.id)), {"skipped": "integration off"}
        )
        IntegrationSettings.objects.filter(tenant=self.tenant).update(zabbix_enabled=True)
        self.conn.sync_maintenance = False
        self.conn.save(update_fields=["sync_maintenance"])
        self.assertEqual(
            maintenance.run_maintenance_sync(str(self.conn.id)),
            {"skipped": "maintenance sync off"},
        )

    def test_the_beat_queues_the_reconcile_with_provisioning_off(self):
        self.assertEqual(self.conn.provision_mode, ZabbixConnection.OFF)
        self.conn.read_host_status = False
        self.conn.save(update_fields=["read_host_status"])
        with mock.patch("django_rq.get_queue") as gq:
            out = enqueue_due_syncs()
        self.assertEqual(out, {"queued": 0, "maintenance": 1, "status": 0})
        gq.return_value.enqueue.assert_called_once()
        self.conn.last_maintenance_sync_at = timezone.now()
        self.conn.save(update_fields=["last_maintenance_sync_at"])
        with mock.patch("django_rq.get_queue") as gq:
            self.assertEqual(enqueue_due_syncs()["maintenance"], 0)


class AckTests(_Base):
    def setUp(self):
        super().setUp()
        self.dev = self.device(hostid="5")
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.dev.primary_ip, template=self.check,
            engine=self.engine, kind="zabbix", interval_seconds=300,
            next_run=timezone.now(), status="down",
            last_detail={
                "zabbix_host": "sw1",
                "problems": [
                    {"name": "Unavailable by ICMP", "severity": "4", "eventid": "901"},
                    {"name": "High CPU", "severity": "2", "eventid": "902"},
                ],
            },
        )
        self.alert = Alert.objects.create(
            tenant=self.tenant, target_ip=self.dev.primary_ip, template=self.check,
            kind="zabbix", dedup_key="k", check_status="down", ack_note="on it",
        )

    def test_acknowledging_names_the_problems_and_the_person(self):
        with mock.patch("zabbix.acks.ZabbixClient") as cls:
            out = write_ack(str(self.alert.id), True, "Ann Ops")
        cls.return_value.acknowledge.assert_called_once_with(
            ["901", "902"], message="Acknowledged in Danbyte by Ann Ops: on it",
            acknowledge=True,
        )
        self.assertEqual(out["eventids"], ["901", "902"])
        self.alert.refresh_from_db()
        self.assertTrue(self.alert.detail["zabbix_ack"]["acknowledged"])
        self.assertEqual(self.alert.detail["zabbix_ack"]["error"], "")

    def test_clearing_it_clears_it_there(self):
        with mock.patch("zabbix.acks.ZabbixClient") as cls:
            write_ack(str(self.alert.id), False, "Ann Ops")
        cls.return_value.acknowledge.assert_called_once_with(
            ["901", "902"], message="Unacknowledged in Danbyte by Ann Ops",
            acknowledge=False,
        )

    def test_a_refusal_is_kept_on_the_alert(self):
        with mock.patch("zabbix.acks.ZabbixClient") as cls:
            cls.return_value.acknowledge.side_effect = ZabbixError("no such event")
            out = write_ack(str(self.alert.id), True, "Ann")
        self.assertIn("no such event", out["error"])
        self.alert.refresh_from_db()
        self.assertIn("no such event", self.alert.detail["zabbix_ack"]["error"])

    def test_the_switch_off_writes_nothing(self):
        self.conn.write_acknowledgements = False
        self.conn.save(update_fields=["write_acknowledgements"])
        with mock.patch("zabbix.acks.ZabbixClient") as cls:
            out = write_ack(str(self.alert.id), True, "Ann")
        self.assertEqual(out, {"skipped": "write-back off"})
        cls.return_value.acknowledge.assert_not_called()

    def test_an_alert_with_no_open_problems_has_nothing_to_write(self):
        self.state.last_detail = {"zabbix_host": "sw1"}
        self.state.save(update_fields=["last_detail"])
        with mock.patch("zabbix.acks.ZabbixClient") as cls:
            out = write_ack(str(self.alert.id), True, "Ann")
        self.assertEqual(out, {"skipped": "no open problems"})
        cls.return_value.acknowledge.assert_not_called()

    def test_a_danbyte_run_check_is_not_zabbixs_business(self):
        self.alert.kind = "icmp"
        self.alert.save(update_fields=["kind"])
        with mock.patch("zabbix.acks.ZabbixClient") as cls:
            out = write_ack(str(self.alert.id), True, "Ann")
        self.assertEqual(out, {"skipped": "not a Zabbix alert"})
        cls.return_value.acknowledge.assert_not_called()

    def test_the_signal_queues_the_job_for_a_zabbix_alert_only(self):
        user = mock.Mock()
        user.get_full_name.return_value = "Ann Ops"
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                alert_acknowledged.send(
                    sender=Alert, alert=self.alert, acknowledged=True, actor=user
                )
        args = gq.return_value.enqueue.call_args.args
        self.assertIs(args[0], write_ack)
        self.assertEqual(args[1:], (str(self.alert.id), True, "Ann Ops"))
        self.alert.kind = "icmp"
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                alert_acknowledged.send(
                    sender=Alert, alert=self.alert, acknowledged=True, actor=user
                )
        gq.return_value.enqueue.assert_not_called()


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        from django.contrib.auth import get_user_model

        User = get_user_model()
        self.user = User.objects.create_superuser("root", "r@x.io", "pw")
        self.client.force_login(self.user)

    def test_the_windows_table_lists_what_was_written(self):
        dev = self.device(hostid="5")
        ev = self.event(dev)
        maintenance.reconcile(self.conn, client=self.fake())
        r = self.client.get(f"/api/zabbix/maintenance/?connection={self.conn.id}")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["event"]["id"], str(ev.id))
        self.assertEqual(rows[0]["host_count"], 1)
        self.assertEqual(rows[0]["maintenanceid"], "77")

    def test_the_connection_exposes_both_switches(self):
        r = self.client.get(f"/api/zabbix/connections/{self.conn.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["sync_maintenance"])
        self.assertTrue(r.json()["write_acknowledgements"])
        r = self.client.patch(
            f"/api/zabbix/connections/{self.conn.id}/",
            {"sync_maintenance": False}, content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.sync_maintenance)


class HealTests(_Base):
    """A period Zabbix holds but Danbyte lost the id of is found by name."""

    def stuck_row(self, ev, error='Maintenance "x" already exists.'):
        return ZabbixMaintenance.objects.create(
            tenant=self.tenant, connection=self.conn, event=ev, maintenanceid="",
            name=maintenance.period_name(ev), starts_at=ev.starts_at, ends_at=ev.ends_at,
            hostids=["5"], last_error=error,
        )

    def test_already_exists_on_create_adopts_the_period(self):
        ev = self.event(self.device(hostid="5"))
        name = maintenance.period_name(ev)
        c = self.fake()
        c.create_maintenance.side_effect = ZabbixError(f'Maintenance "{name}" already exists.')
        c.maintenances_by_name.side_effect = [{}, {name: {"maintenanceid": "90", "name": name}}]
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual((counts["adopted"], counts["created"], counts["failed"]), (1, 0, 0))
        mid, payload = c.update_maintenance.call_args.args
        self.assertEqual(mid, "90")
        self.assertEqual(payload["name"], name)
        row = ZabbixMaintenance.objects.get(event=ev)
        self.assertEqual((row.maintenanceid, row.last_error), ("90", ""))

    def test_a_period_of_that_name_is_adopted_before_any_create(self):
        ev = self.event(self.device(hostid="5"))
        name = maintenance.period_name(ev)
        c = self.fake()
        c.maintenances_by_name.return_value = {name: {"maintenanceid": "90", "name": name}}
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["adopted"], 1)
        c.create_maintenance.assert_not_called()
        c.update_maintenance.assert_called_once()
        self.assertEqual(ZabbixMaintenance.objects.get(event=ev).maintenanceid, "90")

    def test_a_row_that_lost_its_id_heals_on_the_next_pass(self):
        ev = self.event(self.device(hostid="5"))
        self.stuck_row(ev)
        name = maintenance.period_name(ev)
        c = self.fake()
        c.maintenances_by_name.return_value = {name: {"maintenanceid": "91", "name": name}}
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual((counts["adopted"], counts["failed"]), (1, 0))
        self.assertIn(name, c.maintenances_by_name.call_args.args[0])
        c.create_maintenance.assert_not_called()
        self.assertEqual(c.update_maintenance.call_args.args[0], "91")
        row = ZabbixMaintenance.objects.get(event=ev)
        self.assertEqual((row.maintenanceid, row.last_error), ("91", ""))
        # Healed: the pass after writes nothing.
        c2 = self.fake(existing=["91"])
        counts = maintenance.reconcile(self.conn, client=c2)
        self.assertEqual(sum(counts.values()), 0)

    def test_a_stuck_period_of_an_ended_event_is_taken_out(self):
        ev = self.event(self.device(hostid="5"))
        self.stuck_row(ev)
        name = maintenance.period_name(ev)
        ev.status = self.status("completed")
        ev.save(update_fields=["status"])
        ev.sync_silence()
        c = self.fake()
        c.maintenances_by_name.return_value = {name: {"maintenanceid": "91", "name": name}}
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual((counts["adopted"], counts["deleted"]), (1, 1))
        c.delete_maintenances.assert_called_once_with(["91"])
        self.assertFalse(ZabbixMaintenance.objects.exists())

    def test_a_failed_create_does_not_block_the_next_pass(self):
        ev = self.event(self.device(hostid="5"))
        c = self.fake()
        c.create_maintenance.side_effect = ZabbixError("Connection reset.")
        self.assertEqual(maintenance.reconcile(self.conn, client=c)["failed"], 1)
        c = self.fake()
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["created"], 1)
        self.assertEqual(ZabbixMaintenance.objects.get(event=ev).maintenanceid, "77")

    def test_a_create_without_an_id_is_a_failure_not_a_link(self):
        self.event(self.device(hostid="5"))
        c = self.fake()
        c.create_maintenance.return_value = ""
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual((counts["created"], counts["failed"]), (0, 1))

    def test_a_dry_run_writes_nothing_and_reports_the_plan(self):
        ev = self.event(self.device(hostid="5"))
        self.stuck_row(ev)
        name = maintenance.period_name(ev)
        c = self.fake()
        c.maintenances_by_name.return_value = {name: {"maintenanceid": "91", "name": name}}
        report = []
        counts = maintenance.reconcile(self.conn, client=c, dry_run=True, report=report)
        self.assertEqual(counts["adopted"], 1)
        self.assertEqual(report, [("adopted", name, "91")])
        c.update_maintenance.assert_not_called()
        c.create_maintenance.assert_not_called()
        self.assertEqual(ZabbixMaintenance.objects.get().maintenanceid, "")
        self.conn.refresh_from_db()
        self.assertIsNone(self.conn.last_maintenance_sync_at)


class SinglePassTests(_Base):
    """One pass per connection, and one queued pass at most."""

    def hold_lock(self):
        """Take the connection's lock from another database session, the way
        a worker would; returns the release callable."""
        import threading

        from django.db import connections

        taken, release = threading.Event(), threading.Event()

        def run():
            with maintenance.connection_lock(self.conn.pk) as got:
                assert got
                taken.set()
                release.wait(10)
            connections.close_all()

        t = threading.Thread(target=run)
        t.start()
        taken.wait(10)

        def done():
            release.set()
            t.join(10)

        return done

    def test_a_pass_does_not_start_beside_a_running_one(self):
        self.event(self.device(hostid="5"))
        done = self.hold_lock()
        try:
            c = self.fake()
            self.assertIsNone(maintenance.reconcile_locked(self.conn, client=c))
            c.create_maintenance.assert_not_called()
            self.assertTrue(maintenance.is_running(self.conn.pk))
        finally:
            done()
        self.assertFalse(maintenance.is_running(self.conn.pk))
        self.assertEqual(maintenance.reconcile_locked(self.conn, client=c)["created"], 1)

    def test_the_queued_job_requeues_itself_behind_a_running_pass(self):
        done = self.hold_lock()
        try:
            with mock.patch.object(maintenance, "LOCK_WAIT", 0), \
                    mock.patch("django_rq.get_queue") as gq:
                out = maintenance.run_maintenance_sync(str(self.conn.id))
        finally:
            done()
        self.assertEqual(out, {"skipped": "already running"})
        gq.return_value.connection.delete.assert_called_once()
        gq.return_value.enqueue.assert_called_once()

    def test_a_second_enqueue_while_one_is_queued_queues_nothing(self):
        queue = mock.Mock()
        queue.connection.set.side_effect = [True, None]
        self.assertTrue(maintenance.enqueue_maintenance_sync(self.conn.id, queue=queue))
        self.assertFalse(maintenance.enqueue_maintenance_sync(self.conn.id, queue=queue))
        queue.enqueue.assert_called_once()
        key, _v = queue.connection.set.call_args.args
        self.assertEqual(key, f"zabbix:maintenance-queued:{self.conn.id}")
        self.assertTrue(queue.connection.set.call_args.kwargs["nx"])

    def test_the_beat_does_not_queue_beside_a_queued_pass(self):
        self.conn.read_host_status = False
        self.conn.save(update_fields=["read_host_status"])
        with mock.patch("django_rq.get_queue") as gq:
            gq.return_value.connection.set.return_value = None
            out = enqueue_due_syncs()
        self.assertEqual(out["maintenance"], 0)
        gq.return_value.enqueue.assert_not_called()


class RepairCommandTests(_Base):
    def run_cmd(self, client, *args):
        from io import StringIO

        from django.core.management import call_command

        out = StringIO()
        with mock.patch.object(maintenance, "_client", return_value=client):
            call_command("zabbix_maintenance_repair", *args, stdout=out)
        return out.getvalue()

    def test_dry_run_by_default_then_apply(self):
        ev = self.event(self.device(hostid="5"))
        ZabbixMaintenance.objects.create(
            tenant=self.tenant, connection=self.conn, event=ev, maintenanceid="",
            name=maintenance.period_name(ev), starts_at=ev.starts_at, ends_at=ev.ends_at,
            last_error="already exists",
        )
        name = maintenance.period_name(ev)
        c = self.fake()
        c.maintenances_by_name.return_value = {name: {"maintenanceid": "91", "name": name}}
        out = self.run_cmd(c)
        self.assertIn("dry run: zbx", out)
        self.assertIn("1 adopted", out)
        self.assertIn("Nothing written", out)
        c.update_maintenance.assert_not_called()
        self.assertEqual(ZabbixMaintenance.objects.get().maintenanceid, "")

        out = self.run_cmd(c, "--apply", "--connection", "zbx")
        self.assertIn("1 adopted", out)
        self.assertNotIn("dry run", out)
        self.assertEqual(ZabbixMaintenance.objects.get().maintenanceid, "91")

    def test_an_unknown_connection_is_an_error(self):
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            self.run_cmd(self.fake(), "--connection", "nope")


class SyncActionTests(_Base):
    def login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def url(self):
        return f"/api/zabbix/connections/{self.conn.id}/sync-maintenance/"

    def admin(self):
        from django.contrib.auth import get_user_model

        return get_user_model().objects.create_superuser("root", "r@x.io", "pw")

    def test_the_button_runs_a_pass_and_reports_adopted(self):
        self.login(self.admin())
        c = self.fake()
        with mock.patch.object(maintenance, "_client", return_value=c), \
                mock.patch.object(maintenance, "is_queued", return_value=False):
            r = self.client.post(self.url())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["adopted"], 0)

    def test_the_button_while_a_pass_is_queued_starts_nothing(self):
        self.login(self.admin())
        self.event(self.device(hostid="5"))
        c = self.fake()
        with mock.patch("django_rq.get_queue") as gq, \
                mock.patch.object(maintenance, "_client", return_value=c):
            gq.return_value.connection.exists.return_value = 1
            r = self.client.post(self.url())
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()["busy"], "queued")
        c.maintenances.assert_not_called()

    def test_the_button_while_a_pass_is_running_starts_nothing(self):
        self.login(self.admin())
        self.event(self.device(hostid="5"))
        done = SinglePassTests.hold_lock(self)
        c = self.fake()
        try:
            with mock.patch.object(maintenance, "is_queued", return_value=False), \
                    mock.patch.object(maintenance, "_client", return_value=c):
                r = self.client.post(self.url())
        finally:
            done()
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()["busy"], "running")
        c.create_maintenance.assert_not_called()

    def test_a_viewer_cannot_run_it(self):
        from django.contrib.auth import get_user_model

        from auth_api.models import ObjectPermission, UserProfile

        viewer = get_user_model().objects.create_user("v", password="x")
        UserProfile.objects.create(user=viewer, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v-zbx", object_types=["zabbixconnection"], actions=["view"]
        )
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        self.login(viewer)
        c = self.fake()
        with mock.patch.object(maintenance, "_client", return_value=c):
            self.assertEqual(self.client.get(f"/api/zabbix/connections/{self.conn.id}/")
                             .status_code, 200)
            r = self.client.post(self.url())
        self.assertEqual(r.status_code, 403, r.content)
        c.maintenances.assert_not_called()

    def test_another_tenants_connection_is_not_found(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        IntegrationSettings.objects.update_or_create(
            tenant=other, defaults={"zabbix_enabled": True}
        )
        user = self.admin()
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(other.id)
        sess.save()
        self.assertEqual(self.client.post(self.url()).status_code, 404)


class RecurringTests(_Base):
    """A repeating Danbyte window is one repeating Zabbix period."""

    def recurring(self, dev, freq="daily", weekdays=()):
        from datetime import time as dtime

        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, status=self.status("confirmed"), name="Nightly",
            starts_at=T0, ends_at=T0 + timedelta(days=7),
            recurrence=freq, recurrence_weekdays=list(weekdays),
            recurrence_start_time=dtime(21, 55), recurrence_duration=545,
            timezone="Europe/Copenhagen",
        )
        EventImpact.objects.create(
            tenant=self.tenant, event=ev, object_type="api.device", object_id=dev.id
        )
        ev.sync_silence()
        return ev

    def test_daily_is_a_type_2_period_over_the_validity(self):
        self.recurring(self.device(hostid="5"))
        c = self.fake()
        self.assertEqual(maintenance.reconcile(self.conn, client=c)["created"], 1)
        payload = c.create_maintenance.call_args.args[0]
        self.assertEqual(payload["timeperiods"], [{
            "timeperiod_type": 2, "every": 1, "start_time": 21 * 3600 + 55 * 60,
            "period": 545 * 60,
        }])
        self.assertEqual(payload["active_since"], int(T0.timestamp()))
        self.assertEqual(payload["active_till"], int((T0 + timedelta(days=7)).timestamp()))

    def test_weekly_carries_the_day_bits(self):
        self.recurring(self.device(hostid="5"), freq="weekly", weekdays=[0, 6])
        c = self.fake()
        maintenance.reconcile(self.conn, client=c)
        tp = c.create_maintenance.call_args.args[0]["timeperiods"][0]
        self.assertEqual((tp["timeperiod_type"], tp["dayofweek"]), (3, 1 | 64))

    def test_the_moving_silence_writes_nothing_more(self):
        ev = self.recurring(self.device(hostid="5"))
        maintenance.reconcile(self.conn, client=self.fake())
        # The next occurrence: the silence moves, the Zabbix period does not.
        ev.sync_silence(now=ev.silence.ends_at + timedelta(minutes=1))
        c = self.fake(existing=["77"])
        counts = maintenance.reconcile(self.conn, client=c)
        self.assertEqual(counts["updated"], 0)
        c.update_maintenance.assert_not_called()
        # A changed rule is written.
        ev.recurrence_duration = 600
        ev.save(update_fields=["recurrence_duration"])
        c = self.fake(existing=["77"])
        self.assertEqual(maintenance.reconcile(self.conn, client=c)["updated"], 1)
        self.assertEqual(c.update_maintenance.call_args.args[1]["timeperiods"][0]["period"],
                         600 * 60)

    def test_no_end_runs_to_the_last_zabbix_date(self):
        ev = self.recurring(self.device(hostid="5"))
        ev.ends_at = None
        ev.save(update_fields=["ends_at"])
        ev.sync_silence()
        c = self.fake()
        maintenance.reconcile(self.conn, client=c)
        self.assertEqual(c.create_maintenance.call_args.args[0]["active_till"],
                         int(maintenance.OPEN_END.timestamp()))
