"""Multi-window burn-rate alerts: a sharp outage pages, a slow leak tickets,
recovery resolves, a flap inside the hour stays quiet."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.core import mail
from rest_framework.test import APITestCase

from . import sla_burn
from .models import SlaAgreement
from .tests_sla import NOW
from .tests_sla_notify import A, _Alerting

M = timedelta(minutes=1)


class BurnAlertTests(_Alerting):
    # Gold's target is 99 %: a 1 % budget, so 14.4x is 14.4 % down.

    def run_at(self, when):
        self.agreement.refresh_from_db()
        return sla_burn.evaluate(self.agreement, when)

    def test_a_sharp_outage_pages_fast_not_slow(self):
        self.tr(self.ip, self.ping, NOW - 10 * M, "down")
        state = self.run_at(NOW)
        self.assertTrue(state["fast"]["firing"])
        self.assertFalse(state["slow"]["firing"])  # 10 min of 6 h is 2.8x
        self.assertEqual(self.subjects(), ["SLA budget burning fast: Gold"])
        self.assertIn("1 h at 16.67x", mail.outbox[0].body)

    def test_a_slow_leak_tickets_but_does_not_page(self):
        # Three minutes down every half hour: 10 % over 1 h and over 6 h.
        for k in range(12):
            start = NOW - 10 * M - k * 30 * M
            self.tr(self.ip, self.ping, start, "down")
            self.tr(self.ip, self.ping, start + 3 * M, "up")
        state = self.run_at(NOW)
        self.assertFalse(state["fast"]["firing"])
        self.assertTrue(state["slow"]["firing"])
        self.assertEqual(len(mail.outbox), 1)

    def test_recovery_resolves_once(self):
        self.tr(self.ip, self.ping, NOW - 10 * M, "down")
        self.run_at(NOW)
        self.tr(self.ip, self.ping, NOW, "up")
        state = self.run_at(NOW + 10 * M)  # the 5-minute window is clean
        self.assertFalse(state["fast"]["firing"])
        self.assertEqual(self.subjects()[-1], "SLA budget burn resolved: Gold")
        n = len(mail.outbox)
        self.run_at(NOW + 11 * M)
        self.assertEqual(len(mail.outbox), n)

    def test_a_flap_inside_the_hour_is_silent(self):
        self.tr(self.ip, self.ping, NOW - 10 * M, "down")
        self.run_at(NOW)
        self.tr(self.ip, self.ping, NOW, "up")
        self.run_at(NOW + 10 * M)
        n = len(mail.outbox)
        self.tr(self.ip, self.ping, NOW + 12 * M, "down")
        state = self.run_at(NOW + 20 * M)
        self.assertTrue(state["fast"]["firing"])
        self.assertFalse(state["fast"]["notified"])
        self.assertEqual(len(mail.outbox), n)
        # ...and an unannounced firing ends without a "resolved".
        self.tr(self.ip, self.ping, NOW + 20 * M, "up")
        self.run_at(NOW + 30 * M)
        self.assertEqual(len(mail.outbox), n)

    def test_still_firing_does_not_repeat(self):
        self.tr(self.ip, self.ping, NOW - 10 * M, "down")
        self.run_at(NOW)
        self.run_at(NOW + M)
        self.assertEqual(len(mail.outbox), 1)

    def test_a_rule_switched_off_is_not_computed(self):
        rules = self.agreement.burn_alerts
        for r in rules:
            r["on"] = False
        self.agreement.burn_alerts = rules
        self.agreement.save()
        self.tr(self.ip, self.ping, NOW - 10 * M, "down")
        sla_burn.run(NOW)
        self.assertEqual(SlaAgreement.objects.get(pk=self.agreement.pk).burn_state, {})
        self.assertEqual(mail.outbox, [])

    def test_state_is_kept_without_channels(self):
        self.agreement.notify_channels.clear()
        self.tr(self.ip, self.ping, NOW - 10 * M, "down")
        sla_burn.run(NOW)
        state = SlaAgreement.objects.get(pk=self.agreement.pk).burn_state
        self.assertTrue(state["fast"]["firing"])
        self.assertEqual(mail.outbox, [])


class BurnRuleValidationTests(_Alerting):
    def test_rules_are_checked(self):
        ok = sla_burn.validate_rules(
            [{"name": "fast", "long_min": 60, "short_min": 5, "burn": "14.4"}]
        )
        self.assertEqual(ok[0]["burn"], 14.4)
        self.assertTrue(ok[0]["on"])
        for bad in (
            [{"name": "x", "long_min": 5, "short_min": 60, "burn": 2}],
            [{"name": "x", "long_min": 60, "short_min": 5, "burn": 0}],
            [{"name": "x", "long_min": 60, "short_min": 5, "burn": 2}] * 2,
            [{"name": "", "long_min": 60, "short_min": 5, "burn": 2}],
            "nope",
        ):
            with self.assertRaises(ValueError):
                sla_burn.validate_rules(bad)


class BurnApiTests(_Alerting, APITestCase):
    def setUp(self):
        super().setUp()
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_rules_save_and_are_validated(self):
        url = f"{A}{self.agreement.id}/"
        r = self.client.patch(url, {"burn_alerts": [
            {"name": "fast", "long_min": 30, "short_min": 2, "burn": 20, "on": True},
        ]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["burn_alerts"][0]["long_min"], 30)
        bad = self.client.patch(url, {"burn_alerts": [
            {"name": "fast", "long_min": 5, "short_min": 30, "burn": 20},
        ]}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("burn_alerts", bad.json())

    def test_current_carries_the_burn(self):
        from . import sla

        self.tr(self.ip, self.ping, NOW - 10 * M, "down")
        sla.refresh_agreement(self.agreement, now=NOW)
        sla_burn.evaluate(self.agreement, NOW, send=False)
        row = next(x for x in self.client.get(A).json()["results"]
                   if x["id"] == str(self.agreement.id))
        self.assertTrue(row["current"]["burn"]["fast"]["firing"])
