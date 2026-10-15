"""Fields the API hides from a user stay hidden everywhere else.

* Export and label templates render for the person running them: a gated
  field (contract cost without ``view_cost``, SLA money without
  ``view_credits``) reads as undefined and cannot be filtered or ordered on,
  and a relation the API shows as ``null`` (an address's device at another
  site, a coverage row's hidden contract) is not reachable either.
* Coverage rows name only contracts the caller may view, in the API and the
  spreadsheet export.
* A contract's device count, its ``?device=`` filter and the dashboard's
  ``?site=`` filter count and match only devices the caller may view.
"""
from __future__ import annotations

import csv
import io
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth.models import Group, User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from jinja2 import TemplateError
from rest_framework.test import APITestCase

from api.export_templates import render_export_template
from api.label_templates import render_label
from api.models import (
    Device,
    ExportTemplate,
    IPAddress,
    LabelTemplate,
    Manufacturer,
    Prefix,
    Site,
    SupportContract,
    SupportCoverage,
)
from api.test_utils import status_for
from auth_api.builtin_groups import ensure_builtin_groups
from auth_api.models import ObjectPermission, UserProfile
from core.hidden_fields import GATED_FIELDS, GATED_HISTORY_FIELDS
from core.models import Organization, Tenant
from monitoring.models import SlaAgreement, SlaAgreementRevision, SlaTemplate

COST = "123456.78"


class _Base(APITestCase):
    def setUp(self):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.dev_a = Device.objects.create(tenant=self.tenant, name="dev-a", site=self.site_a)
        self.dev_b = Device.objects.create(tenant=self.tenant, name="dev-b", site=self.site_b)
        self.contract = SupportContract.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, contract_number="CN-HIDDEN",
            end_date=timezone.localdate() + timedelta(days=400),
            cost=Decimal(COST), currency="EUR",
        )
        SupportCoverage.objects.create(tenant=self.tenant, contract=self.contract,
                                       device=self.dev_a)
        SupportCoverage.objects.create(tenant=self.tenant, contract=self.contract,
                                       device=self.dev_b)

    def user(self, name):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        return u

    def operator(self, name="op"):
        u = self.user(name)
        u.groups.add(Group.objects.get(name="Operator"))
        return u

    def grant(self, u, types, actions, sites=()):
        p = ObjectPermission.objects.create(
            name=f"g-{u.username}-{'-'.join(types)}-{'-'.join(actions)}",
            object_types=list(types), actions=list(actions),
        )
        p.users.add(u)
        p.tenants.add(self.tenant)
        if sites:
            p.sites.set(sites)
        return p

    def login(self, u):
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def export(self, object_type, code, user):
        t = ExportTemplate(tenant=self.tenant, name="t", object_type=object_type,
                           template_code=code)
        return render_export_template(t, self.tenant, user)

    def label(self, obj, html, user):
        t = LabelTemplate(tenant=self.tenant, object_type=obj._meta.model_name,
                          template_html=html, qr_enabled=False)
        return render_label(t, obj, tenant=self.tenant, user=user)["html"]


class ContractCostInTemplatesTests(_Base):
    CODE = "{% for c in objects %}{{ c.contract_number }}={{ c.cost }} {{ c.currency }}{% endfor %}"

    def test_operator_template_prints_no_cost(self):
        out = self.export("supportcontract", self.CODE, self.operator())
        self.assertIn("CN-HIDDEN=", out)
        self.assertNotIn(COST, out)
        self.assertNotIn("EUR", out)

    def test_view_cost_prints_it(self):
        u = self.operator()
        self.grant(u, ["supportcontract"], ["view", "view_cost"])
        out = self.export("supportcontract", self.CODE, u)
        self.assertIn(f"CN-HIDDEN={COST} EUR", out)

    def test_superuser_prints_it(self):
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.assertIn(COST, self.export("supportcontract", self.CODE, admin))

    def test_reached_through_a_device(self):
        code = ("{% for d in objects %}{% for cv in d.support_coverage.all() %}"
                "{{ d.name }}:{{ cv.contract.cost }};{% endfor %}{% endfor %}")
        out = self.export("device", code, self.operator())
        self.assertIn("dev-a:", out)
        self.assertNotIn(COST, out)

    def test_filtering_or_ordering_on_cost_is_refused(self):
        # A filter would answer "is the cost above X" without printing it.
        fin = self.operator("fin")
        self.grant(fin, ["supportcontract"], ["view", "view_cost"])
        op = self.operator()
        for code, expected in (
            ("{% for c in objects %}"
             "{{ c.manufacturer.support_contracts.filter(cost__gt=1)|length }}{% endfor %}",
             "1"),
            ("{% for c in objects %}"
             "{{ c.manufacturer.support_contracts.order_by('-cost').first() }}{% endfor %}",
             "CN-HIDDEN"),
        ):
            self.assertEqual(self.export("supportcontract", code, fin), expected)
            with self.assertRaises(TemplateError):
                self.export("supportcontract", code, op)

    def test_preview_and_render_use_the_viewers_grants(self):
        # The author holds view_cost; a viewer running the saved template
        # does not and gets no cost.
        author = self.operator("author")
        self.grant(author, ["supportcontract"], ["view", "view_cost"])
        self.login(author)
        r = self.client.post("/api/export-templates/", {
            "name": "costs", "object_type": "supportcontract", "template_code": self.CODE,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        tid = r.json()["id"]
        self.assertIn(COST, self.client.get(f"/api/export-templates/{tid}/preview/")
                      .json()["output"])
        self.login(self.operator("viewer"))
        r = self.client.get(f"/api/export-templates/{tid}/preview/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn(COST, r.json()["output"])
        r = self.client.get(f"/api/export-templates/{tid}/render/")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(COST, r.content.decode())

    def test_label_prints_no_cost(self):
        html = "<div>{{ obj.contract_number }} {{ obj.cost }} {{ supportcontract.currency }}</div>"
        out = self.label(self.contract, html, self.operator())
        self.assertIn("CN-HIDDEN", out)
        self.assertNotIn(COST, out)
        self.assertNotIn("EUR", out)
        u = self.operator("fin")
        self.grant(u, ["supportcontract"], ["view", "view_cost"])
        self.assertIn(COST, self.label(self.contract, html, u))

    def test_label_api_preview(self):
        self.login(self.operator())
        r = self.client.post("/api/label-templates/preview/", {
            "object_type": "supportcontract", "object_id": str(self.contract.id),
            "template_html": "<p>{{ obj.cost }}</p>",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn(COST, r.json()["html"])


class SlaMoneyInTemplatesTests(_Base):
    def setUp(self):
        super().setUp()
        self.tpl = SlaTemplate.objects.create(
            tenant=self.tenant, name="Gold", target_pct=Decimal("99.9"),
            credit_tiers=[{"below": 99.9, "credit_pct": 17}],
            period_fee=Decimal("4321.00"), currency="DKK",
        )
        self.agreement = SlaAgreement.objects.create(
            tenant=self.tenant, name="Core", target_pct=Decimal("99.9"), template=self.tpl,
            credit_tiers=[{"below": 99.9, "credit_pct": 17}],
            period_fee=Decimal("4321.00"), currency="DKK",
        )

    CODE = ("{% for a in objects %}{{ a.name }}|{{ a.period_fee }}|{{ a.currency }}|"
            "{{ a.credit_tiers }}|{{ a.template.period_fee }}{% endfor %}")

    def test_without_view_credits_money_is_blank(self):
        u = self.user("slaview")
        self.grant(u, ["slaagreement"], ["view"])
        out = self.export("slaagreement", self.CODE, u)
        self.assertIn("Core|", out)
        for money in ("4321", "DKK", "credit_pct"):
            self.assertNotIn(money, out)

    def test_view_credits_prints_it(self):
        u = self.user("slamoney")
        self.grant(u, ["slaagreement"], ["view", "view_credits"])
        out = self.export("slaagreement", self.CODE, u)
        self.assertIn("4321", out)
        self.assertIn("DKK", out)

    def test_stored_figures_are_not_reachable(self):
        # The rule snapshots and period figures carry money and every
        # member's figure; the SLA API cuts them per viewer, a template can't.
        SlaAgreementRevision.objects.create(agreement=self.agreement, number=1,
                                            rules={"period_fee": "4321.00"})
        u = self.user("slaview")
        self.grant(u, ["slaagreement"], ["view"])
        for rel in ("revisions", "results"):
            code = f"{{% for a in objects %}}{{% for r in a.{rel} %}}{{{{ r.rules }}}}" \
                   f"{{% endfor %}}{{% endfor %}}"
            try:
                out = self.export("slaagreement", code, u)
            except TemplateError:
                continue
            self.assertNotIn("4321", out)

    def test_label_prints_no_money(self):
        u = self.user("slalabel")
        self.grant(u, ["slaagreement"], ["view"])
        out = self.label(self.agreement, "<p>{{ obj.period_fee }}{{ obj.currency }}</p>", u)
        self.assertNotIn("4321", out)
        self.assertNotIn("DKK", out)


class HiddenRelationsInTemplatesTests(_Base):
    """A site-A user: devices of site A only, every address."""

    def setUp(self):
        super().setUp()
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.9.0/24",
                                       status=status_for(self.tenant, "container"))
        self.ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.9.9.9",
                                           prefix=prefix, assigned_device=self.dev_b)
        self.u = self.user("sitea")
        self.grant(self.u, ["device"], ["view"], sites=[self.site_a])
        self.grant(self.u, ["ipaddress", "supportcoverage"], ["view"])

    def test_address_device_at_another_site_is_blank(self):
        out = self.export(
            "ipaddress",
            "{% for ip in objects %}{{ ip }}|{{ ip.assigned_device }}|"
            "{{ ip.assigned_device_id }}{% endfor %}", self.u,
        )
        self.assertIn("10.9.9.9|", out)
        self.assertNotIn("dev-b", out)
        self.assertNotIn(str(self.dev_b.id), out)

    def test_address_device_in_scope_prints(self):
        self.ip.assigned_device = self.dev_a
        self.ip.save()
        out = self.export("ipaddress",
                          "{% for ip in objects %}{{ ip.assigned_device.name }}{% endfor %}",
                          self.u)
        self.assertEqual(out, "dev-a")

    def test_filtering_on_a_hidden_relation_is_refused(self):
        # "Which address belongs to dev-b" is a question about a device the
        # user cannot see.
        code = ("{% for ip in objects %}{{ ip.prefix.ip_addresses.filter(assigned_device_id='"
                + str(self.dev_b.id) + "')|length }}{% endfor %}")
        everyone = self.user("all")
        self.grant(everyone, ["device", "ipaddress", "prefix"], ["view"])
        self.assertEqual(self.export("ipaddress", code, everyone), "1")
        self.grant(self.u, ["prefix"], ["view"])
        with self.assertRaises(TemplateError):
            self.export("ipaddress", code, self.u)

    def test_coverage_row_with_a_hidden_contract_is_not_handed_out(self):
        # The row's own text names the contract ("CN-HIDDEN → dev-a").
        for code in (
            "{% for d in objects %}{% for cv in d.support_coverage.all() %}{{ cv }}|"
            "{{ cv.contract }}{% endfor %}{% endfor %}",
            "{% for cv in objects %}{{ cv }}{% endfor %}",
        ):
            ot = "device" if "d.support_coverage" in code else "supportcoverage"
            self.assertNotIn("CN-HIDDEN", self.export(ot, code, self.u))
        cv = SupportCoverage.objects.get(device=self.dev_a)
        with self.assertRaises(TemplateError):
            self.label(cv, "<p>{{ obj }}</p>", self.u)

    def test_label_relation_lists_are_fenced(self):
        out = self.label(self.dev_a, "<p>{% for c in obj.support_coverage.all() %}{{ c }}{% endfor %}"
                                     "</p>", self.u)
        self.assertNotIn("CN-HIDDEN", out)
        self.grant(self.u, ["supportcontract"], ["view"])
        out = self.label(self.dev_a, "<p>{% for c in obj.support_coverage.all() %}{{ c }}{% endfor %}"
                                     "</p>", self.u)
        self.assertIn("CN-HIDDEN", out)


class CoverageRowsTests(_Base):
    def setUp(self):
        super().setUp()
        self.u = self.user("cov")
        self.grant(self.u, ["device", "supportcoverage"], ["view"])
        self.login(self.u)

    def test_rows_do_not_name_a_hidden_contract(self):
        card = self.client.get(f"/api/devices/{self.dev_a.id}/coverage/").json()
        self.assertEqual(card["hidden_contracts"], 1)
        r = self.client.get(f"/api/support-coverage/?device={self.dev_a.id}")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("CN-HIDDEN", r.content.decode())
        row = r.json()["results"][0]
        self.assertIsNone(row["contract"])
        self.assertEqual(row["device"]["name"], "dev-a")

    def test_rows_name_a_visible_contract(self):
        self.grant(self.u, ["supportcontract"], ["view"])
        r = self.client.get(f"/api/support-coverage/?device={self.dev_a.id}")
        self.assertEqual(r.json()["results"][0]["contract"]["contract_number"], "CN-HIDDEN")

    def test_spreadsheet_export_leaves_the_contract_blank(self):
        r = self.client.get("/api/io/supportcoverage/export/?fmt=csv")
        self.assertEqual(r.status_code, 200, getattr(r, "content", b""))
        body = b"".join(r.streaming_content).decode() if r.streaming else r.content.decode()
        self.assertNotIn("CN-HIDDEN", body)
        rows = list(csv.DictReader(io.StringIO(body)))
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(not row.get("contract") for row in rows))


class ContractDeviceScopeTests(_Base):
    def setUp(self):
        super().setUp()
        self.u = self.user("sitea")
        self.grant(self.u, ["supportcontract"], ["view"])
        self.grant(self.u, ["device"], ["view"], sites=[self.site_a])
        self.login(self.u)

    def rows(self, query=""):
        r = self.client.get(f"/api/support-contracts/{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["results"]

    def test_device_count_counts_visible_devices(self):
        self.assertEqual(self.rows()[0]["device_count"], 1)
        r = self.client.get(f"/api/support-contracts/{self.contract.id}/")
        self.assertEqual(r.json()["device_count"], 1)

    def test_device_filter_on_a_hidden_device_matches_nothing(self):
        self.assertEqual(self.client.get(f"/api/devices/{self.dev_b.id}/").status_code, 404)
        self.assertEqual(self.rows(f"?device={self.dev_b.id}"), [])
        self.assertEqual(len(self.rows(f"?device={self.dev_a.id}")), 1)

    def test_unscoped_viewer_counts_every_device(self):
        u = self.user("all")
        self.grant(u, ["supportcontract", "device"], ["view"])
        self.login(u)
        self.assertEqual(self.rows()[0]["device_count"], 2)
        self.assertEqual(len(self.rows(f"?device={self.dev_b.id}")), 1)

    def test_list_query_count_is_flat(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.rows()
            return len(ctx.captured_queries)

        base = count()
        for i in range(5):
            c = SupportContract.objects.create(tenant=self.tenant, manufacturer=self.mfr,
                                               contract_number=f"X-{i}")
            SupportCoverage.objects.create(tenant=self.tenant, contract=c, device=self.dev_b)
        self.assertEqual(count(), base)

    def test_dashboard_site_filter_and_counts(self):
        r = self.client.get(f"/api/devices/coverage-summary/?site={self.site_b.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["ending"], [])
        r = self.client.get(f"/api/devices/coverage-summary/?site={self.site_a.id}")
        ending = r.json()["ending"]
        self.assertEqual([e["contract_number"] for e in ending], ["CN-HIDDEN"])
        self.assertEqual(ending[0]["device_count"], 1)
        r = self.client.get("/api/devices/coverage-summary/")
        self.assertEqual(r.json()["ending"][0]["device_count"], 1)


class RegistryTests(_Base):
    def test_history_reads_the_shared_table(self):
        self.assertIs(GATED_HISTORY_FIELDS, GATED_FIELDS)

    def test_serializers_hide_what_the_table_names(self):
        """Each gated type's serializer hides exactly the table's fields
        from a user without the action - one list, not three."""
        from django.test import RequestFactory

        from api.support_coverage_api import SupportContractSerializer
        from monitoring.sla_api import SlaAgreementSerializer
        from monitoring.sla_template_api import SlaTemplateSerializer

        u = self.user("plain")
        req = RequestFactory().get("/")
        req.user = u
        req.session = {"current_tenant_id": str(self.tenant.id)}
        cases = {
            "api.supportcontract": (SupportContractSerializer, SupportContract),
            "monitoring.slaagreement": (SlaAgreementSerializer, SlaAgreement),
            "monitoring.slatemplate": (SlaTemplateSerializer, SlaTemplate),
        }
        self.assertEqual(set(cases), set(GATED_FIELDS))
        for label, (ser_cls, model) in cases.items():
            ser = ser_cls(context={"request": req})
            hidden = ser.hidden_fields(model(tenant=self.tenant))
            self.assertEqual(hidden, set(GATED_FIELDS[label][2]), label)
