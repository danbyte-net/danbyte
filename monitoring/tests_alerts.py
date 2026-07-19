"""A1 tests — the alerting engine (transitions → stateful alerts)."""
from __future__ import annotations

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .alerts import process_transitions
from .models import Alert, CheckKind, CheckTemplate, StateTransition


from api.test_utils import status_for


class AlertEngineTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )

    def _tr(self, frm, to):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            from_status=frm, to_status=to, at=timezone.now(),
        )

    def test_down_opens_critical_alert(self):
        process_transitions([self._tr("up", "down")], timezone.now())
        a = Alert.objects.get(tenant=self.tenant, status="firing")
        self.assertEqual(a.severity, "critical")
        self.assertEqual(a.check_status, "down")

    def test_dedup_one_firing_alert(self):
        now = timezone.now()
        process_transitions([self._tr("up", "down")], now)
        # A second down transition (e.g. after an intermittent unknown) must not
        # open a second alert.
        process_transitions([self._tr("unknown", "down")], now)
        self.assertEqual(
            Alert.objects.filter(tenant=self.tenant, status="firing").count(), 1
        )

    def test_degraded_then_down_escalates_severity(self):
        now = timezone.now()
        process_transitions([self._tr("up", "degraded")], now)
        a = Alert.objects.get(status="firing")
        self.assertEqual(a.severity, "warning")
        process_transitions([self._tr("degraded", "down")], now)
        a.refresh_from_db()
        self.assertEqual(a.severity, "critical")
        self.assertEqual(a.check_status, "down")

    def test_recovery_resolves(self):
        now = timezone.now()
        process_transitions([self._tr("up", "down")], now)
        process_transitions([self._tr("down", "up")], now)
        self.assertEqual(
            Alert.objects.filter(status="firing").count(), 0
        )
        self.assertEqual(Alert.objects.filter(status="resolved").count(), 1)

    def test_skipped_resolves(self):
        now = timezone.now()
        process_transitions([self._tr("up", "down")], now)
        process_transitions([self._tr("down", "skipped")], now)
        self.assertFalse(Alert.objects.filter(status="firing").exists())

    def test_unknown_does_not_open(self):
        process_transitions([self._tr("up", "unknown")], timezone.now())
        self.assertFalse(Alert.objects.exists())


class AlertRuleTests(TestCase):
    def setUp(self):
        from monitoring.models import AlertRule

        self.AlertRule = AlertRule
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )

    def _tr(self, to):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            from_status="up", to_status=to, at=timezone.now(),
        )

    def test_matching_rule_sets_severity(self):
        self.AlertRule.objects.create(
            tenant=self.tenant, name="ping is info",
            match_kinds=["icmp"], match_statuses=["down"], severity="info",
        )
        process_transitions([self._tr("down")], timezone.now())
        a = Alert.objects.get(status="firing")
        self.assertEqual(a.severity, "info")
        self.assertIsNotNone(a.rule_id)

    def test_rules_present_but_none_match_opens_nothing(self):
        # A rule scoped to tcp; an icmp failure shouldn't alert.
        self.AlertRule.objects.create(
            tenant=self.tenant, name="tcp only", match_kinds=["tcp"], severity="critical"
        )
        process_transitions([self._tr("down")], timezone.now())
        self.assertFalse(Alert.objects.exists())

    def test_weight_order_first_match_wins(self):
        self.AlertRule.objects.create(
            tenant=self.tenant, name="broad", weight=200, severity="warning"
        )
        self.AlertRule.objects.create(
            tenant=self.tenant, name="specific", weight=10,
            match_kinds=["icmp"], severity="critical",
        )
        process_transitions([self._tr("down")], timezone.now())
        self.assertEqual(Alert.objects.get(status="firing").severity, "critical")


class AlertRoutingTests(TestCase):
    """A3 — alerts route to enabled channels through the severity gate."""

    def setUp(self):
        from unittest.mock import patch

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )
        self.patcher = patch("monitoring.notify._dispatch_to_channel")
        self.dispatch = self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def _tr(self, frm, to):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            from_status=frm, to_status=to, at=timezone.now(),
        )

    def _channel(self, **kw):
        from .models import NotificationChannel

        return NotificationChannel.objects.create(
            tenant=self.tenant, name=kw.pop("name", "ch"), kind="slack",
            config={"url": "https://hooks/x"}, **kw,
        )

    def test_firing_alert_routes_to_channel(self):
        self._channel(min_severity="warning")
        process_transitions([self._tr("up", "down")], timezone.now())
        self.assertEqual(self.dispatch.call_count, 1)
        _, _, event, _ = self.dispatch.call_args.args
        self.assertEqual(event, "firing")

    def test_resolve_routes_resolved_event(self):
        self._channel(min_severity="warning")
        now = timezone.now()
        process_transitions([self._tr("up", "down")], now)
        self.dispatch.reset_mock()
        process_transitions([self._tr("down", "up")], now)
        self.assertEqual(self.dispatch.call_count, 1)
        self.assertEqual(self.dispatch.call_args.args[2], "resolved")

    def test_min_severity_gate_blocks_lower(self):
        # critical-only channel; a warning (degraded) alert must not route.
        self._channel(min_severity="critical")
        process_transitions([self._tr("up", "degraded")], timezone.now())
        self.dispatch.assert_not_called()

    def test_disabled_channel_skipped(self):
        self._channel(min_severity="info", enabled=False)
        process_transitions([self._tr("up", "down")], timezone.now())
        self.dispatch.assert_not_called()


class SilenceTests(TestCase):
    """A4 — active silences suppress notification but still track the alert."""

    def setUp(self):
        from unittest.mock import patch
        from datetime import timedelta

        self.td = timedelta
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )
        from .models import NotificationChannel

        NotificationChannel.objects.create(
            tenant=self.tenant, name="ch", kind="slack",
            config={"url": "https://hooks/x"}, min_severity="info",
        )
        self.patcher = patch("monitoring.notify._dispatch_to_channel")
        self.dispatch = self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def _tr(self, frm, to):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            from_status=frm, to_status=to, at=timezone.now(),
        )

    def _silence(self, **kw):
        from .models import Silence

        now = timezone.now()
        kw.setdefault("starts_at", now - self.td(minutes=1))
        kw.setdefault("ends_at", now + self.td(hours=1))
        return Silence.objects.create(tenant=self.tenant, **kw)

    def test_active_blanket_silence_suppresses(self):
        self._silence(reason="maintenance")
        process_transitions([self._tr("up", "down")], timezone.now())
        self.dispatch.assert_not_called()
        # The alert is still opened/tracked, just not delivered.
        self.assertEqual(Alert.objects.filter(status="firing").count(), 1)

    def test_expired_silence_does_not_suppress(self):
        now = timezone.now()
        self._silence(
            starts_at=now - self.td(hours=2), ends_at=now - self.td(hours=1)
        )
        process_transitions([self._tr("up", "down")], now)
        self.assertEqual(self.dispatch.call_count, 1)

    def test_silence_matcher_scopes_to_ip(self):
        other = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.9", prefix=self.prefix
        )
        self._silence(match_ip=other)  # silences a different IP
        process_transitions([self._tr("up", "down")], timezone.now())
        self.dispatch.assert_called_once()  # our IP isn't covered

    def test_silence_kind_matcher(self):
        self._silence(match_kinds=["tcp"])  # only silences tcp checks
        process_transitions([self._tr("up", "down")], timezone.now())
        self.dispatch.assert_called_once()  # icmp alert not covered


class AlertAckApiTests(APITestCase):
    """A4 — ack / unack endpoints and the silenced annotation."""

    def setUp(self):
        from django.contrib.auth import get_user_model

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )
        self.alert = Alert.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            dedup_key=f"{self.ip.id}:{self.t.id}", severity="critical",
            check_status="down",
        )
        self.user = get_user_model().objects.create_superuser("a", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_ack_and_unack(self):
        url = f"/api/monitoring/alerts/{self.alert.id}/ack/"
        r = self.client.post(url, {"note": "on it"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["acknowledged"])
        self.assertEqual(r.json()["ack_note"], "on it")
        self.alert.refresh_from_db()
        self.assertEqual(self.alert.acknowledged_by_id, self.user.id)

        r = self.client.post(url + "?action=unack", format="json")
        self.assertFalse(r.json()["acknowledged"])
        self.alert.refresh_from_db()
        self.assertIsNone(self.alert.acknowledged_at)

    def test_list_marks_silenced(self):
        from datetime import timedelta

        from .models import Silence

        now = timezone.now()
        Silence.objects.create(
            tenant=self.tenant, reason="mw",
            starts_at=now - timedelta(minutes=1), ends_at=now + timedelta(hours=1),
        )
        r = self.client.get("/api/monitoring/alerts/?status=firing")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["results"][0]["silenced"])


class AlertMaintenanceTests(TestCase):
    """A5 — renotify / escalation / flap dampening (periodic maintenance)."""

    def setUp(self):
        from datetime import timedelta
        from unittest.mock import patch

        from .models import MonitoringSettings, NotificationChannel

        self.td = timedelta
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )
        NotificationChannel.objects.create(
            tenant=self.tenant, name="ch", kind="slack",
            config={"url": "https://hooks/x"}, min_severity="info",
        )
        self.ms = MonitoringSettings.for_tenant(self.tenant)
        self.patcher = patch("monitoring.notify._dispatch_to_channel")
        self.dispatch = self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def _alert(self, **kw):
        now = timezone.now()
        defaults = dict(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            dedup_key=f"{self.ip.id}:{self.t.id}", severity="warning",
            status="firing", check_status="down", opened_at=now,
            last_status_at=now, last_notified_at=now,
        )
        defaults.update(kw)
        return Alert.objects.create(**defaults)

    def test_renotify_after_interval(self):
        from .escalation import run_alert_maintenance

        self.ms.renotify_enabled = True
        self.ms.renotify_interval_minutes = 30
        self.ms.save()
        # last notified 40 min ago → due for a reminder.
        self._alert(last_notified_at=timezone.now() - self.td(minutes=40))
        r = run_alert_maintenance()
        self.assertEqual(r["renotified"], 1)
        self.assertEqual(self.dispatch.call_args.args[2], "reminder")

    def test_renotify_skips_acked(self):
        from .escalation import run_alert_maintenance

        self.ms.renotify_enabled = True
        self.ms.renotify_interval_minutes = 30
        self.ms.save()
        self._alert(
            last_notified_at=timezone.now() - self.td(minutes=40),
            acknowledged_at=timezone.now(),
        )
        self.assertEqual(run_alert_maintenance()["renotified"], 0)
        self.dispatch.assert_not_called()

    def test_renotify_respects_interval(self):
        from .escalation import run_alert_maintenance

        self.ms.renotify_enabled = True
        self.ms.renotify_interval_minutes = 60
        self.ms.save()
        self._alert(last_notified_at=timezone.now() - self.td(minutes=10))
        self.assertEqual(run_alert_maintenance()["renotified"], 0)

    def test_escalation_bumps_to_critical(self):
        from .escalation import run_alert_maintenance

        self.ms.escalate_enabled = True
        self.ms.escalate_after_minutes = 60
        self.ms.save()
        a = self._alert(
            severity="warning", opened_at=timezone.now() - self.td(minutes=90)
        )
        r = run_alert_maintenance()
        self.assertEqual(r["escalated"], 1)
        a.refresh_from_db()
        self.assertEqual(a.severity, "critical")
        self.assertTrue(a.escalated)
        self.assertEqual(self.dispatch.call_args.args[2], "escalated")

    def test_flap_detection_marks_and_pauses_renotify(self):
        from .escalation import run_alert_maintenance

        self.ms.renotify_enabled = True
        self.ms.renotify_interval_minutes = 1
        self.ms.flap_threshold = 3
        self.ms.flap_window_minutes = 30
        self.ms.save()
        a = self._alert(last_notified_at=timezone.now() - self.td(minutes=10))
        # 3 opens within the window → flapping.
        for _ in range(3):
            StateTransition.objects.create(
                tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
                from_status="up", to_status="down", at=timezone.now(),
            )
        r = run_alert_maintenance()
        a.refresh_from_db()
        self.assertTrue(a.flapping)
        # flapping alert is not renotified despite being overdue.
        self.assertEqual(r["renotified"], 0)


class AlertGroupingTests(TestCase):
    """A5 — a burst of new alerts coalesces into one grouped notification."""

    def setUp(self):
        from unittest.mock import patch

        from .models import MonitoringSettings, NotificationChannel

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )
        NotificationChannel.objects.create(
            tenant=self.tenant, name="ch", kind="slack",
            config={"url": "https://hooks/x"}, min_severity="info",
        )
        self.ms = MonitoringSettings.for_tenant(self.tenant)
        self.ms.group_notifications = True
        self.ms.group_threshold = 2
        self.ms.save()
        self.gpatch = patch("monitoring.notify.notify_alert_group")
        self.ipatch = patch("monitoring.notify.notify_alert")
        self.group = self.gpatch.start()
        self.single = self.ipatch.start()
        self.addCleanup(self.gpatch.stop)
        self.addCleanup(self.ipatch.stop)

    def _tr(self, addr):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=addr, prefix=self.prefix
        )
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip, template=self.t, kind="icmp",
            from_status="up", to_status="down", at=timezone.now(),
        )

    def test_burst_groups_into_one_notification(self):
        trs = [self._tr("10.0.0.1"), self._tr("10.0.0.2"), self._tr("10.0.0.3")]
        process_transitions(trs, timezone.now())
        self.group.assert_called_once()
        # 3 alerts grouped; no individual sends for the opens.
        self.assertEqual(len(self.group.call_args.args[1]), 3)
        self.single.assert_not_called()

    def test_below_threshold_stays_individual(self):
        process_transitions([self._tr("10.0.0.1")], timezone.now())
        self.group.assert_not_called()
        self.single.assert_called_once()
