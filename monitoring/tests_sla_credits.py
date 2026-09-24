"""Service credits: tiers, the stored credit, a frozen period keeping it,
who may see money, and the reports."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile

from . import sla
from .models import SlaAgreementRevision, SlaPeriodResult
from .sla_report import overview_csv, report_csv, report_html
from .tests_sla import SEP, _Base

A = "/api/monitoring/sla-agreements/"
TIERS = [{"below": 99.9, "credit_pct": 10}, {"below": 99.5, "credit_pct": 25}]


class CreditMathTests(_Base):
    def test_the_lowest_tier_met_wins(self):
        rules = {"credit_tiers": TIERS, "period_fee": "1000.00", "currency": "DKK"}
        self.assertEqual(sla.credit(rules, 99.95)["pct"], 0)
        self.assertEqual(sla.credit(rules, 99.7), {"pct": 10, "amount": 100.0, "currency": "DKK"})
        self.assertEqual(sla.credit(rules, 99.0)["amount"], 250.0)
        self.assertIsNone(sla.credit({"credit_tiers": []}, 99.0))
        self.assertIsNone(sla.credit(rules, None))
        self.assertIsNone(sla.credit({"credit_tiers": TIERS}, 99.0)["amount"])


class _Priced(_Base, APITestCase):
    def setUp(self):
        super().setUp()
        self.agreement.credit_tiers = TIERS
        self.agreement.period_fee = Decimal("1000")
        self.agreement.currency = "DKK"
        self.agreement.save()
        dev, self.ip = self.device("leaf1", 1)
        self.member(dev)
        # A day down in September: 29/30 at the month's end, ~96.7 %.
        self.tr(self.ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(self.ip, self.ping, SEP + timedelta(days=3), "up")

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class StoredCreditTests(_Priced):
    def test_a_frozen_period_keeps_the_credit_it_ran_under(self):
        SlaAgreementRevision.objects.create(
            agreement=self.agreement, number=1, rules=self.agreement.rules())
        sla.refresh_agreement(self.agreement, now=datetime(2026, 10, 3, tzinfo=UTC))
        sep = SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09")
        self.assertEqual(sep.figures["credit"]["amount"], 250.0)
        # The contract changes in October; September was priced under the old one.
        self.login(User.objects.create_superuser("admin", "a@b.c", "pw"))
        r = self.client.patch(f"{A}{self.agreement.id}/", {"credit_tiers": [
            {"below": 99.5, "credit_pct": 50}]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.agreement.refresh_from_db()
        self.assertEqual(self.agreement.revision, 2)
        sla.refresh_agreement(self.agreement, now=datetime(2026, 10, 9, tzinfo=UTC))
        sep.refresh_from_db()
        self.assertEqual(sep.state, "frozen")
        self.assertEqual(sep.figures["credit"]["amount"], 250.0)

    def test_the_running_period_follows_a_rule_change(self):
        now = SEP + timedelta(days=10)
        sla.refresh_agreement(self.agreement, now=now)
        self.login(User.objects.create_superuser("admin", "a@b.c", "pw"))
        self.client.patch(f"{A}{self.agreement.id}/", {"target_pct": "90.000"}, format="json")
        self.agreement.refresh_from_db()
        sla.refresh_agreement(self.agreement, now=now + timedelta(hours=1))
        sep = SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09")
        self.assertEqual(sep.revision, 2)
        self.assertEqual(sep.figures["target"], 90.0)

    def test_tiers_are_validated(self):
        self.login(User.objects.create_superuser("admin", "a@b.c", "pw"))
        url = f"{A}{self.agreement.id}/"
        for body in ({"credit_tiers": [{"below": 120, "credit_pct": 10}]},
                     {"credit_tiers": [{"below": 99, "credit_pct": 5}] * 2},
                     {"currency": "kroner"}):
            self.assertEqual(self.client.patch(url, body, format="json").status_code, 400)
        r = self.client.patch(url, {"currency": "eur"}, format="json")
        self.assertEqual(r.json()["currency"], "EUR")


class CreditVisibilityTests(_Priced):
    def viewer(self, *actions):
        user = User.objects.create_user("v" + "".join(actions), password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="sla" + "".join(actions), object_types=["slaagreement"], actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        dev = ObjectPermission.objects.create(
            name="d" + "".join(actions), object_types=["device"], actions=["view"])
        dev.users.add(user)
        dev.tenants.add(self.tenant)
        return user

    def current(self):
        sla.refresh_agreement(self.agreement)
        return self.client.get(A).json()["results"][0]["current"]["figures"]

    def test_money_needs_its_own_grant(self):
        self.login(self.viewer("view"))
        self.assertIsNone(self.current()["credit"])
        body = self.client.get(f"{A}{self.agreement.id}/report/?period=current&file=csv")
        self.assertNotIn(b"service_credit", body.content)

    def test_the_contract_terms_are_money_too(self):
        SlaAgreementRevision.objects.create(
            agreement=self.agreement, number=1, rules=self.agreement.rules())
        self.login(self.viewer("view", "change"))
        url = f"{A}{self.agreement.id}/"
        body = self.client.get(url).json()
        self.assertNotIn("credit_tiers", body)
        self.assertNotIn("period_fee", body)
        rules = self.client.get(f"{url}revisions/").json()[0]["rules"]
        self.assertNotIn("credit_tiers", rules)
        r = self.client.patch(url, {"credit_tiers": []}, format="json")
        self.assertEqual(r.status_code, 403)
        # Everything else stays editable.
        r = self.client.patch(url, {"description": "Core"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_credit_viewer_sees_it(self):
        self.login(self.viewer("view", "view_credits"))
        self.assertEqual(self.current()["credit"]["currency"], "DKK")

    def test_a_slice_of_the_analysis_is_not_priced(self):
        self.login(User.objects.create_superuser("admin", "a@b.c", "pw"))
        base = f"{A}{self.agreement.id}/analysis/?period=current"
        sla.refresh_agreement(self.agreement)
        self.assertIsNotNone(self.client.get(base).json()["figures"]["credit"])
        sliced = self.client.get(f"{base}&kind=icmp").json()
        self.assertIsNone(sliced["figures"]["credit"])


class CreditReportTests(_Priced):
    def test_reports_carry_the_credit(self):
        sla.refresh_agreement(self.agreement, now=datetime(2026, 10, 3, tzinfo=UTC))
        res = SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09")
        self.assertIn("Service credit: 25% of the period fee, 250.00 DKK",
                      report_html(self.agreement, res))
        self.assertIn("service_credit_amount,250.0", report_csv(self.agreement, res))
        self.assertIn("25.0,250.0,DKK", overview_csv([(self.agreement, res, res.figures)]))
