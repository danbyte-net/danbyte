"""Zabbix on the shared external-monitor layer.

The rest of the Zabbix suite is the regression net for the move; these pin
the seams the move introduced: the registries Zabbix is plugged into, the
``source`` that stops an acknowledgement echoing back, the abstract bases'
queue helpers on Zabbix's own tables, and the beat entry.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.utils import timezone

from monitoring.alerts import set_acknowledged
from monitoring.external import beat, hooks
from monitoring.models import Alert

from .acks import write_ack
from .checker import KIND
from .models import ZabbixChange
from .tests_two_way import _Base


class RegistrationTests(_Base):
    def test_zabbix_registers_its_writer_listener_and_beat(self):
        self.assertIn("zabbix", hooks.ack_writers(KIND))
        self.assertIn("zabbix", hooks.window_listeners())
        entry = {e.name: e for e in beat.entries()}["zabbix"]
        # Its own timer still drives it, so the shared beat must skip it.
        self.assertTrue(entry.own_timer)
        with mock.patch("django_rq.get_queue"):
            self.assertNotIn("zabbix", beat.run_beat())
            self.assertIn("zabbix", beat.run_beat(names=["zabbix"]))


class SetAcknowledgedTests(_Base):
    def setUp(self):
        super().setUp()
        self.dev = self.device(hostid="5")
        self.alert = Alert.objects.create(
            tenant=self.tenant, target_ip=self.dev.primary_ip, template=self.check,
            kind="zabbix", dedup_key="k", check_status="down",
        )

    def test_an_operator_ack_is_written_back(self):
        from django.contrib.auth import get_user_model

        user = get_user_model().objects.create_user(
            "ann", "ann@x.io", "pw", first_name="Ann", last_name="Ops"
        )
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                set_acknowledged(self.alert, True, actor=user, note="on it")
        args = gq.return_value.enqueue.call_args.args
        self.assertIs(args[0], write_ack)
        self.assertEqual(args[1:], (str(self.alert.id), True, "Ann Ops"))
        self.assertEqual(self.alert.ack_note, "on it")

    def test_an_ack_read_from_zabbix_is_not_echoed_back(self):
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                set_acknowledged(self.alert, True, note="seen", source="zabbix")
        gq.return_value.enqueue.assert_not_called()
        self.alert.refresh_from_db()
        self.assertIsNotNone(self.alert.acknowledged_at)
        self.assertIsNone(self.alert.acknowledged_by)
        self.assertEqual(self.alert.ack_note, "seen")

    def test_another_systems_source_still_reaches_zabbix(self):
        with mock.patch("django_rq.get_queue") as gq:
            with self.captureOnCommitCallbacks(execute=True):
                set_acknowledged(self.alert, True, source="prtg")
        gq.return_value.enqueue.assert_called_once()

    def test_clearing_resets_every_field(self):
        set_acknowledged(self.alert, True, note="x", source="zabbix")
        set_acknowledged(self.alert, False, source="zabbix")
        self.alert.refresh_from_db()
        self.assertIsNone(self.alert.acknowledged_at)
        self.assertEqual(self.alert.ack_note, "")


class ChangeBaseTests(_Base):
    def test_propose_and_drop_stale_on_zabbix_changes(self):
        dev = self.device()
        fresh: set = set()
        kept = ZabbixChange.propose(
            self.conn, fresh, {"n": 1}, device=dev, kind=ZabbixChange.CREATE
        )
        again = ZabbixChange.propose(
            self.conn, fresh, {"n": 2}, device=dev, kind=ZabbixChange.CREATE
        )
        self.assertEqual(kept.id, again.id)
        self.assertEqual(ZabbixChange.objects.get().detail, {"n": 2})
        stale = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=dev,
            kind=ZabbixChange.UPDATE,
        )
        dismissed = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=dev,
            kind=ZabbixChange.PRUNE, ignored=True,
        )
        ZabbixChange.drop_stale(self.conn, fresh)
        ids = set(ZabbixChange.objects.values_list("id", flat=True))
        self.assertEqual(ids, {kept.id, dismissed.id})
        self.assertNotIn(stale.id, ids)

    def test_apply_all_skips_ambiguous(self):
        dev = self.device()
        ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=dev,
            kind=ZabbixChange.AMBIGUOUS,
        )
        self.assertFalse(ZabbixChange.applicable(self.conn).exists())

    def test_link_grace(self):
        dev = self.device(hostid="9")
        link = dev.zabbix_links.get()
        now = timezone.now()
        link.mark_unwanted(now)
        link.mark_unwanted(now + timedelta(days=3))
        link.refresh_from_db()
        self.assertEqual(link.unwanted_since, now)
        self.assertFalse(link.prune_due(now + timedelta(days=6), 7))
        self.assertTrue(link.prune_due(now + timedelta(days=7), 7))
