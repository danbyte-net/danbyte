"""SLA templates (0.18, 8.6): create an agreement from a template, see where
it differs, and re-sync it as a new revision that leaves closed and frozen
periods on the rules they ran under."""
from __future__ import annotations

from django.contrib.auth.models import User

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import sla
from .models import HolidayCalendar, SlaAgreement, SlaPeriodResult, SlaTemplate
from .tests_sla_api import A, _Base

T = "/api/monitoring/sla-templates/"


class _T(_Base):
    def template(self, **kw):
        r = self.client.post(T, {
            "name": "Gold", "target_pct": "99.95", "period": "quarter", "timezone": "UTC",
            "service_hours": {"mon": [["08:00", "17:00"]]}, "count_stale_as": "down",
            "min_outage_seconds": 60,
            "objectives": [{"kind": "icmp", "threshold_ms": 20, "target_pct": 99}],
            "credit_tiers": [{"below": 99.9, "credit_pct": 10}], **kw,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def user(self, actions, credits=False, name="ops"):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name=f"sla-{name}", object_types=["slaagreement", "slatemplate"],
            actions=actions + (["view_credits"] if credits else []))
        p.users.add(u)
        p.tenants.add(self.tenant)
        return u


class TemplateTests(_T):
    def test_none_seeded(self):
        self.assertEqual(self.client.get(T).json()["count"], 0)

    def test_validation_is_the_agreements(self):
        for bad in ({"target_pct": "101"}, {"timezone": "Mars/Olympus"},
                    {"service_hours": {"funday": []}}, {"warning_pct": "99.0"},
                    {"credit_tiers": [{"below": 120, "credit_pct": 5}]},
                    {"currency": "EURO"}):
            r = self.client.post(T, {"name": "X", "target_pct": "99.9", **bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)

    def test_foreign_calendar_refused(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        cal = HolidayCalendar.objects.create(tenant=other, name="Theirs")
        r = self.client.post(T, {"name": "X", "target_pct": "99.9",
                                 "holiday_calendar": str(cal.id)}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_create_from_template_takes_what_is_left_out(self):
        t = self.template()
        r = self.client.post(A, {"name": "Acme", "template": t["id"], "min_outage_seconds": 5},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        a = r.json()
        self.assertEqual(a["target_pct"], "99.950")
        self.assertEqual(a["period"], "quarter")
        self.assertEqual(a["count_stale_as"], "down")
        self.assertEqual(a["credit_tiers"], [{"below": 99.9, "credit_pct": 10.0}])
        self.assertEqual(a["min_outage_seconds"], 5)
        self.assertEqual(a["template_detail"]["differs"], ["min_outage_seconds"])
        self.assertEqual(a["revision"], 1)

    def test_sync_writes_a_revision_and_keeps_closed_periods(self):
        t = self.template()
        a = self.client.post(A, {"name": "Acme", "template": t["id"]}, format="json").json()
        agreement = SlaAgreement.objects.get(pk=a["id"])
        # A frozen period ran under revision 1.
        old = SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=agreement, period_key="2026-Q1",
            period_start="2026-01-01T00:00Z", period_end="2026-04-01T00:00Z",
            state="frozen", revision=1, figures={"availability": 99.97})
        r = self.client.patch(f"{T}{t['id']}/", {"target_pct": "99.99"}, format="json")
        self.assertEqual(r.status_code, 200)
        listed = self.client.get(f"{T}{t['id']}/agreements/").json()
        self.assertEqual(listed[0]["differs"], ["target_pct"])
        r = self.client.post(f"{T}{t['id']}/sync/", {}, format="json")
        self.assertEqual(r.json(), {"synced": 1, "unchanged": 0})
        agreement.refresh_from_db()
        self.assertEqual(str(agreement.target_pct), "99.990")
        self.assertEqual(agreement.revision, 2)
        revs = self.client.get(f"{A}{a['id']}/revisions/").json()
        self.assertEqual([x["number"] for x in revs], [2, 1])
        self.assertEqual(revs[1]["rules"]["target_pct"], "99.950")
        # The frozen period keeps its figure and the rules it ran under.
        old.refresh_from_db()
        self.assertEqual(old.figures, {"availability": 99.97})
        self.assertEqual(sla.rules_for(agreement, old)["target_pct"], "99.950")
        # Syncing again changes nothing.
        r = self.client.post(f"{A}{a['id']}/sync-template/")
        self.assertEqual(r.json()["synced"], False)
        self.assertEqual(SlaAgreement.objects.get(pk=a["id"]).revision, 2)

    def test_sync_needs_change_on_every_agreement_and_credits_for_money(self):
        t = self.template(credit_tiers=[])
        a = self.client.post(A, {"name": "Acme", "template": t["id"]}, format="json").json()
        self.client.patch(f"{T}{t['id']}/", {"target_pct": "99.99"}, format="json")
        self.login(self.user(["view"]))
        self.assertEqual(self.client.post(f"{T}{t['id']}/sync/").status_code, 403)
        self.assertEqual(SlaAgreement.objects.get(pk=a["id"]).revision, 1)
        # Change, but the template now prices the service: credits needed.
        self.login(self.admin)
        self.client.patch(f"{T}{t['id']}/", {"credit_tiers": [{"below": 99, "credit_pct": 5}]},
                          format="json")
        self.login(self.user(["view", "change"], name="ops2"))
        r = self.client.post(f"{A}{a['id']}/sync-template/")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(SlaAgreement.objects.get(pk=a["id"]).revision, 1)
        # Credit fields are hidden from them, on the template and in the diff.
        body = self.client.get(f"{T}{t['id']}/").json()
        self.assertNotIn("credit_tiers", body)
        self.assertEqual(self.client.get(f"{T}{t['id']}/agreements/").json()[0]["differs"],
                         ["target_pct"])

    def test_creating_from_a_priced_template_needs_credits(self):
        t = self.template()
        self.login(self.user(["view", "add", "change"]))
        r = self.client.post(A, {"name": "Acme", "template": t["id"]}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_foreign_template_refused(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = SlaTemplate.objects.create(tenant=other, name="Gold", target_pct="99.9")
        r = self.client.post(A, {"name": "Acme", "target_pct": "99", "template": str(theirs.id)},
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get(f"{T}{theirs.id}/").status_code, 404)
