"""An export template render is bounded: a row cap with a named refusal, a
preview over the first rows, and one query for the relations a template
prints rather than one per row (#224)."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from . import export_templates
from .export_templates import render_export_template
from .models import Device, ExportTemplate, Site

User = get_user_model()


class TemplateCapTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        for i in range(12):
            Device.objects.create(tenant=self.tenant, name=f"sw{i:02d}", site=site)
        self.tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="devs", object_type="device",
            template_code="{{ count }}|{% for d in objects %}{{ d.name }}@{{ d.site.name }};{% endfor %}",
        )

    def test_past_the_cap_the_render_is_refused_by_name(self):
        with mock.patch.object(export_templates, "MAX_TEMPLATE_ROWS", 10):
            r = self.client.get(f"/api/export-templates/{self.tmpl.id}/render/")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("12", r.json()["detail"])
        self.assertIn("10", r.json()["detail"])

    def test_a_preview_renders_the_first_rows_but_counts_them_all(self):
        with mock.patch.object(export_templates, "PREVIEW_ROWS", 3):
            r = self.client.get(f"/api/export-templates/{self.tmpl.id}/preview/")
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()["output"]
        self.assertTrue(out.startswith("12|"), out)
        self.assertEqual(out.count("@HQ"), 3)

    def test_a_relation_the_template_prints_costs_no_query_per_row(self):
        def cost(n_devices):
            site = Site.objects.get(name="HQ")
            while Device.objects.count() < n_devices:
                Device.objects.create(
                    tenant=self.tenant, name=f"x{Device.objects.count()}", site=site
                )
            with CaptureQueriesContext(connection) as ctx:
                render_export_template(self.tmpl, self.tenant, self.admin)
            return len(ctx.captured_queries)

        self.assertEqual(cost(12), cost(40))
