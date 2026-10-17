"""SLA incident follow-up (0.18, 8.1): the cause catalog, cause / ticket /
note / disputed per incident, down time by cause in the figures, analysis and
reports, and who may write it."""
from __future__ import annotations

from django.contrib.auth.models import User

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import SlaAgreement, SlaIncidentCause, SlaIncidentFollowUp, SlaPeriodResult
from .sla_report import report_csv, report_html
from .tests_sla_api import A, _WithFigures

C = "/api/monitoring/sla-incident-causes/"
F = "/api/monitoring/sla-incident-follow-ups/"


class _Base(_WithFigures):
    def incident(self):
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertEqual(len(body["incidents"]), 1)
        return body["incidents"][0]

    def cause(self, name="Carrier", color="#ef4444"):
        r = self.client.post(C, {"name": name, "color": color}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def follow_up(self, inc, **kw):
        return self.client.post(F, {"agreement": self.agreement_id, "unit": inc["unit"],
                                    "started_at": inc["start"], **kw}, format="json")

    def scoped_user(self, actions):
        """Device view at site Alpha only (sees a1, not b1), and ``actions``
        on agreements."""
        u = User.objects.create_user("scoped", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        sla_perm = ObjectPermission.objects.create(
            name="sla", object_types=["slaagreement"], actions=actions)
        sla_perm.users.add(u)
        sla_perm.tenants.add(self.tenant)
        dev = ObjectPermission.objects.create(name="dev", object_types=["device"],
                                              actions=["view"])
        dev.users.add(u)
        dev.tenants.add(self.tenant)
        dev.sites.add(self.site_a)
        return u


class CauseCatalogTests(_Base):
    def test_catalog_starts_empty(self):
        self.assertEqual(self.client.get(C).json()["count"], 0)
        self.assertFalse(SlaIncidentCause.objects.exists())

    def test_names_unique_per_tenant_and_colours_checked(self):
        self.cause("Carrier")
        r = self.client.post(C, {"name": "carrier"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(C, {"name": "Power", "color": "red"}, format="json")
        self.assertEqual(r.status_code, 400)
        # Another tenant has its own catalog.
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        SlaIncidentCause.objects.create(tenant=other, name="Carrier")
        self.assertEqual([c["name"] for c in self.client.get(C).json()["results"]],
                         ["Carrier"])


class FollowUpTests(_Base):
    def test_follow_up_shows_on_the_incident_and_by_cause(self):
        inc = self.incident()
        before = self.client.get(f"{A}{self.agreement_id}/figures/").json()["figures"]
        cause = self.cause()
        r = self.follow_up(inc, cause=cause["id"], ticket_url="https://tickets.example/42",
                           note="Fibre cut", disputed=True)
        self.assertEqual(r.status_code, 201, r.content)
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        fu = body["incidents"][0]["follow_up"]
        self.assertEqual(fu["cause_detail"]["name"], "Carrier")
        self.assertTrue(fu["disputed"])
        self.assertEqual(fu["note"], "Fibre cut")
        self.assertEqual(body["by_cause"], [{
            "cause": cause["id"], "name": "Carrier", "color": "#ef4444",
            "down_s": inc["seconds"], "incidents": 1, "disputed_s": inc["seconds"],
        }])
        # Disputed is shown, never excluded: the figure is unchanged.
        self.assertEqual(body["figures"]["availability"], before["availability"])
        self.assertEqual(body["figures"]["down_s"], before["down_s"])

    def test_without_a_cause_the_incident_counts_under_no_cause(self):
        inc = self.incident()
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertIsNone(body["incidents"][0]["follow_up"])
        self.assertEqual(body["by_cause"][0]["name"], "No cause")
        self.assertEqual(body["by_cause"][0]["down_s"], inc["seconds"])

    def test_analysis_has_down_time_by_cause(self):
        inc = self.incident()
        cause = self.cause()
        self.follow_up(inc, cause=cause["id"])
        body = self.client.get(f"{A}{self.agreement_id}/analysis/").json()
        self.assertEqual(body["by_cause"][0]["name"], "Carrier")
        self.assertEqual(body["incidents"][0]["follow_up"]["cause"], cause["id"])

    def test_one_follow_up_per_incident_and_its_identity_is_fixed(self):
        inc = self.incident()
        r = self.follow_up(inc, note="first")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.follow_up(inc, note="again").status_code, 400)
        fid = r.json()["id"]
        r = self.client.patch(f"{F}{fid}/", {"note": "edited", "disputed": True},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"{F}{fid}/", {"unit": "something:else"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_unknown_incident_and_bad_links_are_refused(self):
        inc = self.incident()
        r = self.client.post(F, {"agreement": self.agreement_id, "unit": inc["unit"],
                                 "started_at": "2020-01-01T00:00:00+00:00"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.follow_up(inc, ticket_url="javascript:alert(1)")
        self.assertEqual(r.status_code, 400)

    def test_a_cause_from_another_tenant_is_refused(self):
        inc = self.incident()
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        foreign = SlaIncidentCause.objects.create(tenant=other, name="Theirs")
        r = self.follow_up(inc, cause=str(foreign.id))
        self.assertEqual(r.status_code, 400)

    def test_frozen_periods_still_take_follow_up(self):
        inc = self.incident()
        SlaPeriodResult.objects.filter(agreement_id=self.agreement_id).update(state="frozen")
        self.assertEqual(self.follow_up(inc, note="after the fact").status_code, 201)

    def test_follow_up_is_in_the_change_log(self):
        inc = self.incident()
        r = self.follow_up(inc, note="Fibre cut")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="monitoring.slaincidentfollowup", object_id=r.json()["id"],
        ).exists())

    def test_reports_list_causes(self):
        inc = self.incident()
        cause = self.cause()
        self.follow_up(inc, cause=cause["id"], ticket_url="https://t.example/1",
                       note="internal only", disputed=True)
        a = SlaAgreement.objects.get(pk=self.agreement_id)
        res = SlaPeriodResult.objects.filter(agreement=a).order_by("-period_start").first()
        text = report_csv(a, res)
        self.assertIn("cause,ticket,disputed", text)
        self.assertIn("Carrier,https://t.example/1,yes", text)
        self.assertIn("cause,down_s,incidents,disputed_s", text)
        html = report_html(a, res)
        self.assertIn("Down time by cause", html)
        self.assertIn("Carrier", html)
        self.assertIn("Disputed", html)
        # The note is for the team, not the customer's report.
        self.assertNotIn("internal only", html)
        self.assertNotIn("internal only", text)


class FollowUpAccessTests(_Base):
    def test_view_only_cannot_write(self):
        inc = self.incident()
        self.login(self.scoped_user(["view"]))
        self.assertEqual(self.follow_up(inc).status_code, 403)

    def test_a_limited_viewer_cannot_touch_hidden_incidents(self):
        inc = self.incident()  # b1's, at site Bravo
        r = self.follow_up(inc, note="by admin")
        fid = r.json()["id"]
        self.login(self.scoped_user(["view", "change"]))
        self.assertEqual(self.follow_up(inc, note="x").status_code, 400)
        self.assertEqual(self.client.get(f"{F}?agreement={self.agreement_id}").json()["count"],
                         0)
        self.assertEqual(self.client.get(f"{F}{fid}/").status_code, 404)
        self.assertEqual(self.client.patch(f"{F}{fid}/", {"note": "y"},
                                           format="json").status_code, 404)
        self.assertEqual(SlaIncidentFollowUp.objects.get(pk=fid).note, "by admin")
