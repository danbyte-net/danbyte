"""Root-cause alerting (#450): explained, held, released, incidents, the
switch-off path and what the operator sees."""
from __future__ import annotations

import time
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.dependencies import _version_key
from api.models import Device, DeviceDependency, IPAddress, Prefix, Site
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import root_cause
from .alerts import process_transitions
from .escalation import run_alert_maintenance
from .models import (
    Alert,
    CheckKind,
    CheckState,
    CheckTemplate,
    MonitoringSettings,
    NotificationChannel,
    RootCauseIncident,
    Silence,
    StateTransition,
)

User = get_user_model()


class _Fixtures:
    def setUp(self):
        super().setUp()
        self.now = timezone.now()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container"))
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind=CheckKind.ICMP)
        self.ms = MonitoringSettings.for_tenant(self.tenant)
        self.channel = NotificationChannel.objects.create(
            tenant=self.tenant, name="hook", kind="webhook",
            config={"url": "https://hooks.example.test/x"})
        self.n = 0
        self.core = self.device("core-1")
        self.dist = self.device("dist-2")
        self.acc = self.device("acc-7")
        # Every device starts verified up.
        for d in (self.core, self.dist, self.acc):
            self.state(d, "up")

    # ── fixtures ────────────────────────────────────────────────────────
    def device(self, name, site=None):
        self.n += 1
        dev = Device.objects.create(tenant=self.tenant, name=name, site=site or self.site)
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.0.{self.n // 250}.{self.n % 250 + 1}",
            prefix=self.prefix, assigned_device=dev)
        dev.primary_ip = ip
        dev.save(update_fields=["primary_ip"])
        return dev

    def dep(self, up, down, **kw):
        DeviceDependency.objects.create(tenant=self.tenant, upstream=up, downstream=down, **kw)
        # The version bump waits for a commit a TestCase never makes.
        cache.delete(_version_key(self.tenant.id))

    def state(self, dev, status, fails=None, checked=None):
        fails = (3 if status in ("down", "stale") else 0) if fails is None else fails
        st, _ = CheckState.objects.update_or_create(
            target_ip=dev.primary_ip, template=self.t,
            defaults=dict(tenant=self.tenant, kind="icmp", status=status,
                          consecutive_fail=fails,
                          last_checked=self.now if checked is None else checked,
                          next_run=self.now + timedelta(minutes=5)),
        )
        return st

    def tr(self, dev, frm, to):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=dev.primary_ip, template=self.t, kind="icmp",
            from_status=frm, to_status=to, at=self.now)

    def alert(self, dev):
        return Alert.objects.get(tenant=self.tenant, target_ip=dev.primary_ip, status="firing")

    def batch(self, trs, now=None):
        """process_transitions with deliveries captured."""
        with self.capture() as sent:
            process_transitions(trs, now or self.now)
        return sent

    def release(self, seconds, **kw):
        with self.capture() as sent:
            root_cause.release_due([self.tenant.id], self.now + timedelta(seconds=seconds), **kw)
        return sent

    def capture(self):
        test = self

        class _Cap:
            def __enter__(self):
                self.calls = {"alert": [], "group": [], "root": []}
                self.p = [
                    patch("monitoring.notify._dispatch_to_channel",
                          side_effect=lambda ch, a, ev, ip: self.calls["alert"].append(
                              (ch.name, a.dedup_key, ev, ip))),
                    patch("monitoring.notify._dispatch_group_to_channel",
                          side_effect=lambda ch, alerts, ev, dep: self.calls["group"].append(
                              (ch.name, sorted(a.dedup_key for a in alerts), ev))),
                    patch("monitoring.notify._dispatch_root_cause",
                          side_effect=lambda ch, inc, ev, text, *a: self.calls["root"].append(
                              (ch.name, ev, text))),
                ]
                for p in self.p:
                    p.start()
                return self.calls

            def __exit__(self, *exc):
                for p in self.p:
                    p.stop()
                test._last = self.calls

        return _Cap()

    def key(self, dev):
        return f"{dev.primary_ip_id}:{self.t.id}"

    def chain(self):
        self.dep(self.core, self.dist)
        self.dep(self.dist, self.acc)


class _Base(_Fixtures, TestCase):
    pass


class SwitchOffTests(_Base):
    """With the switch off, or without dependency rows, the pipeline is
    today's: the same deliveries, the same alert fields."""

    def scenario(self):
        for d in (self.core, self.dist, self.acc):
            self.state(d, "down")
        sent = self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist, self.acc)])
        later = self.now + timedelta(minutes=1)
        for d in (self.core, self.dist, self.acc):
            self.state(d, "up")
        with self.capture() as cleared:
            process_transitions([self.tr(self.dist, "down", "up")], later)
        rows = sorted(
            (a.dedup_key, a.status, a.notify_state, a.notify_count,
             a.last_notified_at is not None, a.root_cause_id)
            for a in Alert.objects.filter(tenant=self.tenant)
        )
        return sent, cleared, rows

    def baseline(self):
        """The same scenario through the pipeline as it was: no plan."""
        with patch("monitoring.root_cause.prepare",
                   side_effect=lambda *a, **k: root_cause.Plan()):
            return self.scenario()

    def test_switch_off_is_byte_for_byte_today(self):
        self.chain()
        expected = self.baseline()
        Alert.objects.all().delete()
        self.ms.root_cause_enabled = False
        self.ms.save()
        self.assertEqual(self.scenario(), expected)
        sent, cleared, rows = expected
        self.assertEqual(sorted(c[2] for c in sent["group"]), ["firing"])
        self.assertEqual([c[2] for c in cleared["alert"]], ["resolved"])
        self.assertFalse(RootCauseIncident.objects.exists())

    def test_no_dependency_rows_is_byte_for_byte_today(self):
        expected = self.baseline()
        Alert.objects.all().delete()
        self.assertEqual(self.scenario(), expected)

    def test_no_dependency_rows_adds_no_query(self):
        trs = [self.tr(self.dist, "up", "down")]
        self.state(self.dist, "down")
        root_cause.prepare([], trs, {}, self.now)  # warm the graph cache
        with CaptureQueriesContext(connection) as plain:
            with patch("monitoring.root_cause.prepare",
                       side_effect=lambda *a, **k: root_cause.Plan()):
                self.batch(trs)
        Alert.objects.all().delete()
        with CaptureQueriesContext(connection) as live:
            self.batch(trs)
        self.assertEqual(len(live), len(plain))

    def test_raw_insert_defaults_to_sent(self):
        with connection.cursor() as cur:
            cur.execute(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_name = 'monitoring_alert' AND column_name = 'notify_state'")
            self.assertIn("sent", cur.fetchone()[0])
            cur.execute(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_name = 'monitoring_monitoringsettings' "
                "AND column_name = 'root_cause_hold_seconds'")
            self.assertEqual(cur.fetchone()[0], "60")


class ClassificationTests(_Base):
    def setUp(self):
        super().setUp()
        self.chain()

    def test_behind_a_down_root_is_explained(self):
        self.state(self.core, "down")
        self.batch([self.tr(self.core, "up", "down")])
        self.assertEqual(self._last["alert"][0][1], self.key(self.core))
        for d in (self.dist, self.acc):
            self.state(d, "down")
        sent = self.batch([self.tr(d, "up", "down") for d in (self.dist, self.acc)])
        self.assertEqual(sent, {"alert": [], "group": [], "root": []})
        inc = RootCauseIncident.objects.get(device=self.core)
        for d in (self.dist, self.acc):
            a = self.alert(d)
            self.assertEqual(a.notify_state, "explained")
            self.assertEqual(a.root_cause, inc)
            self.assertIsNone(a.last_notified_at)
            self.assertEqual(a.notify_count, 0)

    def test_root_alerts_go_out_at_once_in_the_same_batch(self):
        for d in (self.core, self.dist, self.acc):
            self.state(d, "down")
        sent = self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist, self.acc)])
        self.assertEqual([c[1] for c in sent["alert"]], [self.key(self.core)])
        self.assertEqual(self.alert(self.core).notify_state, "sent")
        self.assertEqual(self.alert(self.acc).root_cause.device, self.core)

    def test_one_message_after_the_hold_counts_the_burst(self):
        for d in (self.core, self.dist, self.acc):
            self.state(d, "down")
        self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist, self.acc)])
        self.assertEqual(self.release(30)["root"], [])
        sent = self.release(61)
        self.assertEqual(len(sent["root"]), 1)
        self.assertEqual(sent["root"][0][1], "opened")
        self.assertIn("core-1 down - explains 2 devices", sent["root"][0][2])
        self.assertEqual(self.release(120)["root"], [])
        inc = RootCauseIncident.objects.get()
        self.assertEqual(inc.explained_count, 2)
        self.assertIsNotNone(inc.announced_at)

    def test_unverified_upstream_holds_and_is_poked(self):
        st = self.state(self.core, "up", checked=self.now - timedelta(minutes=5))
        self.state(self.dist, "down")
        sent = self.batch([self.tr(self.dist, "up", "down")])
        self.assertEqual(sent["alert"], [])
        a = self.alert(self.dist)
        self.assertEqual(a.notify_state, "held")
        self.assertEqual(a.notify_after, self.now + timedelta(seconds=60))
        st.refresh_from_db()
        self.assertEqual(st.next_run, self.now)

    def test_hold_then_sent_when_the_upstream_is_fine(self):
        self.state(self.core, "up", fails=1)
        self.state(self.dist, "down")
        self.batch([self.tr(self.dist, "up", "down")])
        self.assertEqual(self.release(30)["alert"], [])
        self.state(self.core, "up")
        sent = self.release(61)
        self.assertEqual([(c[1], c[2]) for c in sent["alert"]], [(self.key(self.dist), "firing")])
        a = self.alert(self.dist)
        self.assertEqual(a.notify_state, "sent")
        self.assertEqual(a.notify_count, 1)

    def test_hold_then_explained_when_the_upstream_goes_down(self):
        self.state(self.core, "up", fails=1)
        self.state(self.dist, "down")
        self.batch([self.tr(self.dist, "up", "down")])
        self.state(self.core, "down")
        sent = self.release(61)
        self.assertEqual(sent["alert"], [])
        self.assertEqual(self.alert(self.dist).notify_state, "explained")
        self.assertEqual(self.alert(self.dist).root_cause.device, self.core)

    def test_verified_upstream_sends_at_once(self):
        self.state(self.dist, "down")
        sent = self.batch([self.tr(self.dist, "up", "down")])
        self.assertEqual([c[1] for c in sent["alert"]], [self.key(self.dist)])

    def test_always_mode_holds_even_a_verified_upstream(self):
        self.ms.root_cause_hold_mode = "always"
        self.ms.save()
        self.state(self.dist, "down")
        self.assertEqual(self.batch([self.tr(self.dist, "up", "down")])["alert"], [])
        self.assertEqual(self.alert(self.dist).notify_state, "held")

    def test_hold_zero_never_holds(self):
        self.ms.root_cause_hold_seconds = 0
        self.ms.save()
        self.state(self.core, "up", fails=1)
        self.state(self.dist, "down")
        self.assertEqual(len(self.batch([self.tr(self.dist, "up", "down")])["alert"]), 1)

    def test_cleared_while_held_is_withheld(self):
        self.state(self.core, "up", fails=1)
        self.state(self.dist, "down")
        self.batch([self.tr(self.dist, "up", "down")])
        self.state(self.dist, "up")
        sent = self.batch([self.tr(self.dist, "down", "up")])
        self.assertEqual(sent["alert"], [])
        a = Alert.objects.get(target_ip=self.dist.primary_ip)
        self.assertEqual((a.status, a.notify_state), ("resolved", "withheld"))
        self.assertEqual(self.release(61)["alert"], [])

    def test_explained_resolves_silently(self):
        self.state(self.core, "down")
        self.state(self.dist, "down")
        self.batch([self.tr(self.dist, "up", "down")])
        self.state(self.dist, "up")
        sent = self.batch([self.tr(self.dist, "down", "up")])
        self.assertEqual(sent["alert"], [])
        self.assertEqual(Alert.objects.get(target_ip=self.dist.primary_ip).status, "resolved")

    def test_unknown_upstream_is_never_down(self):
        self.state(self.core, "unknown", fails=0)
        self.state(self.dist, "down")
        sent = self.batch([self.tr(self.dist, "up", "down")])
        # Not monitored: nothing to wait for and nothing to explain it.
        self.assertEqual(len(sent["alert"]), 1)
        self.assertEqual(self.alert(self.dist).notify_state, "sent")

    def test_any_check_kind_counts_towards_down(self):
        http = CheckTemplate.objects.create(
            tenant=self.tenant, name="web", slug="web", kind=CheckKind.HTTP)
        CheckState.objects.filter(target_ip=self.core.primary_ip).delete()
        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.core.primary_ip, template=http, kind="http",
            status="down", consecutive_fail=2, last_checked=self.now)
        self.state(self.dist, "down")
        self.batch([self.tr(self.dist, "up", "down")])
        self.assertEqual(self.alert(self.dist).notify_state, "explained")

    def test_an_up_check_on_the_deciding_ip_keeps_it_up(self):
        http = CheckTemplate.objects.create(
            tenant=self.tenant, name="web", slug="web", kind=CheckKind.HTTP)
        self.state(self.core, "down")
        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.core.primary_ip, template=http, kind="http",
            status="up", last_checked=self.now)
        self.state(self.dist, "down")
        self.batch([self.tr(self.dist, "up", "down")])
        # Not down, so nothing is explained; failing, so it is waited for.
        self.assertEqual(self.alert(self.dist).notify_state, "held")

    def test_partial_redundancy_alerts_normally(self):
        remote = self.device("remote-1")
        self.state(remote, "up")
        DeviceDependency.objects.filter(tenant=self.tenant, downstream=self.acc).update(
            redundancy_group="up")
        self.dep(remote, self.acc, redundancy_group="up")
        self.state(self.dist, "down")
        self.state(self.acc, "down")
        sent = self.batch([self.tr(self.acc, "up", "down")])
        self.assertEqual([c[1] for c in sent["alert"]], [self.key(self.acc)])
        self.state(remote, "down")
        acc2 = self.device("acc-8")
        self.dep(self.dist, acc2, redundancy_group="g")
        self.dep(remote, acc2, redundancy_group="g")
        self.state(acc2, "down")
        self.batch([self.tr(acc2, "up", "down")])
        self.assertEqual(self.alert(acc2).notify_state, "explained")

    def test_prepare_raising_sends_everything(self):
        self.state(self.core, "down")
        self.state(self.dist, "down")
        with patch.object(root_cause.Classifier, "run", side_effect=RuntimeError("boom")):
            sent = self.batch([self.tr(self.dist, "up", "down")])
        self.assertEqual(len(sent["alert"]), 1)
        self.assertEqual(self.alert(self.dist).notify_state, "sent")

    def test_flapping_check_is_never_held(self):
        self.state(self.core, "up", fails=1)
        st = self.state(self.dist, "down")
        st.flapping_since = self.now
        st.save()
        self.batch([self.tr(self.dist, "up", "down")])
        a = self.alert(self.dist)
        self.assertEqual(a.notify_state, "sent")
        self.assertTrue(a.flapping)


class LifecycleTests(_Base):
    def setUp(self):
        super().setUp()
        self.chain()
        for d in (self.core, self.dist, self.acc):
            self.state(d, "down")
        self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist, self.acc)])
        self.release(61)
        self.inc = RootCauseIncident.objects.get()

    def test_recovery_once_with_counts_and_still_down_released(self):
        self.state(self.core, "up")
        self.state(self.dist, "up")
        self.release(70)
        self.inc.refresh_from_db()
        self.assertEqual(self.inc.status, "recovering")
        self.assertEqual(self.release(100)["root"], [])
        # dist recovered on its own; acc is still down one hold later.
        Alert.objects.filter(target_ip=self.dist.primary_ip).update(status="resolved")
        sent = self.release(131)
        self.assertEqual([c[1] for c in sent["root"]], ["resolved"])
        self.assertIn("1 of 2 recovered, 1 still down", sent["root"][0][2])
        self.assertEqual([(c[1], c[2]) for c in sent["alert"]], [(self.key(self.acc), "firing")])
        a = self.alert(self.acc)
        self.assertEqual(a.notify_state, "sent")
        self.assertEqual(a.detail["still_down_after"], "core-1")
        self.inc.refresh_from_db()
        self.assertEqual(self.inc.status, "resolved")
        self.assertIsNotNone(self.inc.recovery_announced_at)
        self.assertEqual(self.release(300), {"alert": [], "group": [], "root": []})

    def test_still_down_summary_names_the_recovered_root(self):
        from .notify import _alert_summary

        a = self.alert(self.acc)
        a.detail = {"still_down_after": "core-1"}
        self.assertIn("still down after core-1 recovered",
                      _alert_summary(a, "firing", "10.0.0.3"))

    def test_flap_while_recovering_reopens_silently(self):
        self.state(self.core, "up")
        self.release(70)
        self.state(self.core, "down")
        sent = self.release(90)
        self.assertEqual(sent["root"], [])
        self.inc.refresh_from_db()
        self.assertEqual((self.inc.status, self.inc.recovering_since), ("open", None))
        self.assertEqual(RootCauseIncident.objects.count(), 1)

    def test_root_becoming_explained_merges(self):
        top = self.device("wan-0")
        self.state(top, "down")
        self.dep(top, self.core)
        sent = self.release(80)
        self.assertEqual(sent["root"], [])
        self.inc.refresh_from_db()
        self.assertEqual(self.inc.status, "resolved")
        new = RootCauseIncident.objects.get(device=top)
        self.assertEqual(self.inc.merged_into, new)
        self.assertEqual(self.alert(self.acc).root_cause, new)

    def test_orphan_still_explained_is_reparented(self):
        Alert.objects.filter(target_ip=self.acc.primary_ip).update(root_cause=None)
        sent = self.release(80)
        self.assertEqual(sent["alert"], [])
        self.assertEqual(self.alert(self.acc).root_cause, self.inc)

    def test_orphan_no_longer_explained_is_released(self):
        Alert.objects.filter(target_ip=self.acc.primary_ip).update(root_cause=None)
        self.state(self.core, "up")
        self.state(self.dist, "up")
        sent = self.release(80)
        self.assertEqual([c[1] for c in sent["alert"]], [self.key(self.acc)])

    def test_root_device_deleted_releases_or_reparents(self):
        self.core.delete()
        sent = self.release(80)
        # dist is a root now; acc stays explained, by dist.
        self.assertEqual([c[1] for c in sent["alert"]], [self.key(self.dist)])
        self.assertEqual(self.alert(self.acc).root_cause.device, self.dist)

    def test_renotify_and_escalation_skip_explained(self):
        self.ms.renotify_enabled = True
        self.ms.renotify_interval_minutes = 1
        self.ms.escalate_enabled = True
        self.ms.escalate_after_minutes = 1
        self.ms.save()
        Alert.objects.update(severity="warning")
        with self.capture() as sent:
            run_alert_maintenance(self.now + timedelta(minutes=10))
        self.assertEqual(sorted(c[1] for c in sent["alert"]), [self.key(self.core)])


class LateAndSilenceTests(_Base):
    def setUp(self):
        super().setUp()
        self.chain()

    def test_late_upstream_annotates_without_a_message(self):
        self.state(self.dist, "down")
        self.batch([self.tr(self.dist, "up", "down")])
        self.assertEqual(self.alert(self.dist).notify_state, "sent")
        self.state(self.acc, "down")
        self.batch([self.tr(self.acc, "up", "down")], self.now)  # explained by dist
        self.state(self.core, "down")
        self.batch([self.tr(self.core, "up", "down")], self.now + timedelta(seconds=10))
        sent = self.release(20)
        self.assertEqual(sent["alert"], [])
        a = self.alert(self.dist)
        self.assertEqual(a.notify_state, "sent")
        self.assertEqual(a.root_cause.device, self.core)
        sent = self.release(100)
        self.assertEqual(len(sent["root"]), 1)
        self.assertIn("1 already alerted", sent["root"][0][2])

    def test_silence_on_the_root_mutes_the_incident(self):
        s = Silence.objects.create(tenant=self.tenant, reason="mw",
                                   starts_at=self.now - timedelta(hours=1),
                                   ends_at=self.now + timedelta(hours=1))
        s.match_devices.add(self.core)
        for d in (self.core, self.dist):
            self.state(d, "down")
        sent = self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist)])
        self.assertEqual(sent["alert"], [])  # the root's own alert is silenced
        with patch("monitoring.root_cause.timezone.now", return_value=self.now):
            sent = self.release(61)
        self.assertEqual(sent["root"], [])
        inc = RootCauseIncident.objects.get()
        self.assertTrue(inc.detail.get("silenced"))
        self.state(self.core, "up")
        self.release(70)
        self.assertEqual(self.release(140)["root"], [])

    def test_maintenance_window_on_root_without_alert_mutes(self):
        s = Silence.objects.create(tenant=self.tenant, reason="mw",
                                   starts_at=self.now - timedelta(hours=1),
                                   ends_at=self.now + timedelta(hours=1))
        s.match_devices.add(self.core)
        inc = RootCauseIncident.objects.create(tenant=self.tenant, device=self.core)
        from .notify import root_silenced

        self.assertTrue(root_silenced(inc, self.now))
        s.match_kinds = ["http"]
        s.save()
        self.assertFalse(root_silenced(inc, self.now))


class DeliveryTests(_Base):
    def setUp(self):
        super().setUp()
        self.chain()

    def burst(self):
        for d in (self.core, self.dist, self.acc):
            self.state(d, "down")
        self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist, self.acc)])
        return RootCauseIncident.objects.get()

    def recover_all(self):
        for d in (self.core, self.dist, self.acc):
            self.state(d, "up")
        Alert.objects.filter(tenant=self.tenant).update(status="resolved")

    def posts(self, seconds):
        with patch("monitoring.notify._post") as post:
            root_cause.release_due([self.tenant.id], self.now + timedelta(seconds=seconds))
        return [c.kwargs.get("json") or c.args[1] for c in post.call_args_list]

    def test_pagerduty_folds_into_the_root_alert(self):
        self.channel.delete()
        NotificationChannel.objects.create(tenant=self.tenant, name="pd", kind="pagerduty",
                                           config={"routing_key": "k" * 32})
        with patch("monitoring.notify._post"):
            self.burst()
        body = self.posts(61)
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["dedup_key"], self.key(self.core))
        self.assertEqual(body[0]["event_action"], "trigger")
        self.recover_all()
        self.posts(70)
        # The folded page resolves with the root's own alert, not here.
        self.assertEqual(self.posts(140), [])

    def test_pagerduty_own_key_without_a_root_alert(self):
        self.channel.delete()
        NotificationChannel.objects.create(tenant=self.tenant, name="pd", kind="pagerduty",
                                           config={"routing_key": "k" * 32})
        inc = self.burst()
        Alert.objects.filter(target_ip=self.core.primary_ip).delete()
        body = self.posts(61)
        self.assertEqual(body[0]["dedup_key"], f"rootcause:{inc.pk}")
        self.recover_all()
        self.posts(70)
        body = self.posts(140)
        self.assertEqual([b["event_action"] for b in body], ["resolve"])

    def test_webhook_payload(self):
        inc = self.burst()
        body = self.posts(61)
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["event"], "root_cause_opened")
        self.assertEqual(body[0]["incident"]["id"], str(inc.pk))
        self.assertEqual(body[0]["root"], {"id": str(self.core.pk), "name": "core-1"})
        self.assertEqual(sorted(body[0]["explained"]),
                         sorted([str(self.dist.pk), str(self.acc.pk)]))
        self.assertEqual(body[0]["count"], 2)

    def test_alert_payload_carries_state_and_root(self):
        from .notify import _alert_payload

        self.burst()
        a = self.alert(self.acc)
        p = _alert_payload(a, "firing", "10.0.0.3")
        self.assertEqual(p["notify_state"], "explained")
        self.assertEqual(p["root_cause"], str(a.root_cause_id))

    def test_scoped_channel_hears_through_its_dependents(self):
        self.channel.match_device = self.acc
        self.channel.save()
        self.burst()
        with self.capture() as sent:
            root_cause.release_due([self.tenant.id], self.now + timedelta(seconds=61))
        self.assertEqual(len(sent["root"]), 1)
        self.assertIn("1 in this channel's scope", sent["root"][0][2])
        other = self.device("elsewhere")
        self.channel.match_device = other
        self.channel.save()
        inc = RootCauseIncident.objects.get()
        from .notify import notify_root_cause

        with self.capture() as sent:
            notify_root_cause(inc, "opened")
        self.assertEqual(sent["root"], [])

    def test_forty_dependents_one_message(self):
        for i in range(40):
            d = self.device(f"leaf-{i}")
            self.dep(self.dist, d)
        devs = list(Device.objects.filter(tenant=self.tenant).exclude(pk=self.core.pk))
        for d in devs:
            self.state(d, "up")
        self.state(self.dist, "down")
        sent = self.batch([self.tr(self.dist, "up", "down")])
        self.assertEqual(len(sent["alert"]), 1)
        leaves = [d for d in devs if d.name.startswith("leaf-")]
        for d in leaves:
            self.state(d, "down")
        sent = self.batch([self.tr(d, "up", "down") for d in leaves],
                        self.now + timedelta(seconds=5))
        self.assertEqual(sent, {"alert": [], "group": [], "root": []})
        sent = self.release(70)
        self.assertEqual(len(sent["root"]), 1)
        self.assertIn("dist-2 down - explains 40 devices", sent["root"][0][2])


class IncidentConcurrencyTests(_Base):
    def test_one_live_incident_per_device(self):
        a = root_cause.incident_for(self.tenant.id, self.core.pk, self.now, 60)
        b = root_cause.incident_for(self.tenant.id, self.core.pk, self.now, 60)
        self.assertEqual(a.pk, b.pk)
        with self.assertRaises(IntegrityError), transaction.atomic():
            RootCauseIncident.objects.create(tenant=self.tenant, device=self.core)

    def test_reopens_a_recovering_one(self):
        a = root_cause.incident_for(self.tenant.id, self.core.pk, self.now, 60)
        RootCauseIncident.objects.filter(pk=a.pk).update(status="recovering",
                                                        recovering_since=self.now)
        b = root_cause.incident_for(self.tenant.id, self.core.pk, self.now, 60)
        self.assertEqual((b.pk, b.status), (a.pk, "open"))

    def test_parallel_create_reads_the_winner(self):
        winner = RootCauseIncident.objects.create(tenant=self.tenant, device=self.core)
        real = RootCauseIncident.objects.filter
        calls = {"n": 0}

        def first_misses(*a, **k):
            calls["n"] += 1
            qs = real(*a, **k)
            return qs.none() if calls["n"] == 1 else qs

        with patch.object(RootCauseIncident.objects, "filter", side_effect=first_misses):
            got = root_cause.incident_for(self.tenant.id, self.core.pk, self.now, 60)
        self.assertEqual(got.pk, winner.pk)


class BudgetTests(_Base):
    def test_query_budget_for_500_transitions(self):
        devs = []
        for i in range(500):
            d = Device(tenant=self.tenant, name=f"leaf-{i}", site=self.site)
            devs.append(d)
        Device.objects.bulk_create(devs)
        ips = [IPAddress(tenant=self.tenant, ip_address=f"10.1.{i // 250}.{i % 250 + 1}",
                         prefix=self.prefix, assigned_device=d) for i, d in enumerate(devs)]
        IPAddress.objects.bulk_create(ips)
        for d, ip in zip(devs, ips, strict=True):
            d.primary_ip = ip
        Device.objects.bulk_update(devs, ["primary_ip"])
        DeviceDependency.objects.bulk_create([
            DeviceDependency(tenant=self.tenant, upstream=self.core, downstream=d) for d in devs])
        cache.delete(_version_key(self.tenant.id))
        CheckState.objects.bulk_create([
            CheckState(tenant=self.tenant, target_ip=ip, template=self.t, kind="icmp",
                       status="down", consecutive_fail=3, last_checked=self.now)
            for ip in ips])
        self.state(self.core, "down")
        trs = [StateTransition(tenant=self.tenant, target_ip=ip, template=self.t, kind="icmp",
                               from_status="up", to_status="down", at=self.now) for ip in ips]
        ip_map = {ip.id: ip for ip in ips}
        root_cause.prepare([], trs[:1], {}, self.now)  # warm the graph cache
        with CaptureQueriesContext(connection) as q:
            plan = root_cause.prepare(trs, [], ip_map, self.now)
        self.assertEqual(len(plan.decisions), 500)
        self.assertLessEqual(len(q), 8, [x["sql"][:80] for x in q])

    def test_classifier_is_fast_at_5k_devices(self):
        from api.dependencies import build_graph

        edges = []
        ids = [f"d{i}" for i in range(5000)]
        for i in range(1, 5000):
            edges.append((ids[(i - 1) // 3], ids[i], ""))
            if i > 10 and i % 2:
                edges.append((ids[(i - 1) // 3 - 1 if (i - 1) // 3 else 1], ids[i], ""))
        graph = build_graph(edges[:8000])
        health = {d: root_cause.Health(monitored=True, down=(d == "d0")) for d in ids}
        clf = root_cause.Classifier(self.tenant.id, graph, self.ms, self.now)
        with patch("monitoring.root_cause.device_health", return_value=health):
            t0 = time.perf_counter()
            clf.run(ids[1:501])
            took = time.perf_counter() - t0
        self.assertLess(took, 0.2)


class ApiTests(_Fixtures, APITestCase):
    def setUp(self):
        super().setUp()
        self.chain()
        for d in (self.core, self.dist, self.acc):
            self.state(d, "down")
        self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist, self.acc)])
        self.admin = User.objects.create_superuser("rc-root", password="x")
        self.b = self
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.b.tenant.id)
        s.save()

    def test_alert_list_explained_filter_and_counts(self):
        r = self.client.get("/api/monitoring/alerts/").json()
        self.assertEqual(r["counts"]["firing"], 3)
        self.assertEqual(r["counts"]["explained"], 2)
        self.assertEqual(r["counts"]["held"], 0)
        self.assertEqual(len(r["results"]), 3)
        r = self.client.get("/api/monitoring/alerts/?explained=exclude").json()
        self.assertEqual([a["target_ip"]["id"] for a in r["results"]],
                         [str(self.b.core.primary_ip_id)])
        r = self.client.get("/api/monitoring/alerts/?explained=only").json()
        self.assertEqual(len(r["results"]), 2)
        rc = r["results"][0]["root_cause"]
        self.assertEqual(rc["device"], {"id": str(self.b.core.id), "name": "core-1"})
        self.assertEqual(r["results"][0]["notify_state"], "explained")

    def test_root_causes_list_detail_and_ack(self):
        r = self.client.get("/api/monitoring/root-causes/").json()
        self.assertEqual(r["counts"], {"open": 1, "resolved": 0})
        inc = r["results"][0]
        self.assertEqual(inc["device"]["name"], "core-1")
        d = self.client.get(f"/api/monitoring/root-causes/{inc['id']}/").json()
        self.assertEqual(len(d["alerts"]), 2)
        self.assertEqual(len(d["root_alerts"]), 1)
        r = self.client.post(f"/api/monitoring/root-causes/{inc['id']}/ack/", {}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["acknowledged"])
        self.assertIsNotNone(self.b.alert(self.b.core).acknowledged_at)
        self.client.post(f"/api/monitoring/root-causes/{inc['id']}/ack/?action=unack", {},
                         format="json")
        self.assertIsNone(self.b.alert(self.b.core).acknowledged_at)
        r = self.client.get("/api/monitoring/root-causes/?status=resolved").json()
        self.assertEqual(r["results"], [])

    def test_site_scoped_viewer_does_not_see_other_sites_incidents(self):
        from auth_api.models import ObjectPermission, UserProfile

        other = Site.objects.create(tenant=self.tenant, name="B")
        user = User.objects.create_user("site-b", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="b", object_types=["device", "ipaddress"], actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(other)
        self.login(user)
        r = self.client.get("/api/monitoring/root-causes/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["results"], [])
        inc = RootCauseIncident.objects.get()
        self.assertEqual(
            self.client.get(f"/api/monitoring/root-causes/{inc.id}/").status_code, 404)
        self.assertEqual(
            self.client.post(f"/api/monitoring/root-causes/{inc.id}/ack/").status_code, 404)

    def test_settings_round_trip(self):
        r = self.client.get("/api/monitoring/settings/").json()
        self.assertEqual((r["root_cause_enabled"], r["root_cause_hold_seconds"],
                          r["root_cause_hold_mode"]), (True, 60, "smart"))
        r = self.client.patch("/api/monitoring/settings/",
                              {"root_cause_hold_seconds": 120,
                               "root_cause_hold_mode": "always"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch("/api/monitoring/settings/",
                              {"root_cause_hold_seconds": 5000}, format="json")
        self.assertEqual(r.status_code, 400)


class CountsTests(_Base):
    def test_dashboard_and_digest_count_explained_apart(self):
        from api.dashboard_views import _monitoring_block

        from .digest import build_digest, render_text

        self.chain()
        for d in (self.core, self.dist, self.acc):
            self.state(d, "down")
        self.batch([self.tr(d, "up", "down") for d in (self.core, self.dist, self.acc)])
        block = _monitoring_block(self.tenant)
        self.assertEqual(sum(r["count"] for r in block["alerts_by_severity"]), 1)
        self.assertEqual(block["alerts_explained"], 2)
        d = build_digest(self.tenant, self.now - timedelta(days=1))
        self.assertEqual((d["firing_total"], d["explained_total"]), (1, 2))
        self.assertIn("Firing alerts: 1 (+2 explained)", render_text(d))
