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
        self.assertEqual(counts, {"created": 0, "updated": 0, "deleted": 0, "failed": 0})
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
        with mock.patch("django_rq.get_queue") as gq:
            out = enqueue_due_syncs()
        self.assertEqual(out, {"queued": 0, "maintenance": 1})
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
