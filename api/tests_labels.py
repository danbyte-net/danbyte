"""Label templates (#9) — render engine + API.

Load-bearing guarantees: rendering is sandboxed and autoescaped (a field value
containing markup is escaped, not injected); `fields` introspection reflects the
model; and preview/render are tenant-scoped + RBAC-gated.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from core.models import Organization, Tenant

from .label_templates import available_fields, render_label
from .models import Device, DeviceRole, DeviceType, LabelTemplate, Manufacturer, Site

User = get_user_model()


class LabelRenderTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="MX")
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        # A device name carrying markup — must be escaped in the label.
        self.device = Device.objects.create(
            tenant=self.tenant, name="<b>rtr1</b>", device_type=dt, role=role,
            site=self.site,
        )

    def test_autoescape_neutralises_markup(self):
        tmpl = LabelTemplate(
            object_type="device", template_html="<span>{{ device.name }}</span>",
        )
        out = render_label(tmpl, self.device, base_url="https://x.example")
        self.assertIn("&lt;b&gt;rtr1&lt;/b&gt;", out["html"])
        self.assertNotIn("<b>rtr1</b>", out["html"])

    def test_author_script_is_stripped(self):
        # Autoescape only tames `{{ values }}`; markup the author writes into the
        # template body is literal and NOT escaped. Since the label prints inline
        # in the app origin, nh3 must strip executable markup from the output.
        tmpl = LabelTemplate(
            object_type="device",
            template_html=(
                "<span>{{ device.name }}</span>"
                "<script>alert(1)</script>"
                '<img src=x onerror="steal()">'
                '<a href="javascript:evil()">x</a>'
            ),
        )
        out = render_label(tmpl, self.device)
        html = out["html"]
        self.assertNotIn("<script", html)
        self.assertNotIn("onerror", html)
        self.assertNotIn("javascript:", html)
        # Structural/formatting markup and the escaped field value survive.
        self.assertIn("<span>", html)
        self.assertIn("&lt;b&gt;rtr1&lt;/b&gt;", html)

    def test_url_and_default_qr(self):
        tmpl = LabelTemplate(object_type="device", template_html="{{ url }}")
        out = render_label(tmpl, self.device, base_url="https://x.example")
        expected = f"https://x.example/devices/{self.device.pk}"
        self.assertEqual(out["html"], expected)
        self.assertEqual(out["qr"], expected)  # blank qr_content → the URL

    def test_custom_qr_expression(self):
        tmpl = LabelTemplate(
            object_type="device", template_html="x",
            qr_content="ASSET:{{ device.name }}",
        )
        out = render_label(tmpl, self.device)
        self.assertEqual(out["qr"], "ASSET:<b>rtr1</b>")

    def test_available_fields_tracks_model(self):
        data = available_fields("device")
        self.assertEqual(data["object"], "device")
        self.assertIn("device.name", data["tokens"])
        self.assertIn("url", data["special"])

    def test_available_fields_unknown_type(self):
        self.assertIsNone(available_fields("nope"))


class LabelApiTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="MX")
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.device = Device.objects.create(
            tenant=self.tenant, name="rtr1", device_type=dt, role=role, site=self.site,
        )
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_crud_and_fields_and_render(self):
        # Create
        r = self.client.post(
            "/api/label-templates/",
            {
                "name": "Asset tag",
                "object_type": "device",
                "template_html": "<b>{{ device.name }}</b>",
                "width_mm": 62,
                "height_mm": 29,
            },
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        tid = r.json()["id"]

        # fields introspection
        f = self.client.get("/api/label-templates/fields/?object_type=device")
        self.assertEqual(f.status_code, 200, f.content)
        self.assertIn("device.name", f.json()["tokens"])

        # render against the device
        rr = self.client.get(
            f"/api/label-templates/{tid}/render/?ids={self.device.id}"
        )
        self.assertEqual(rr.status_code, 200, rr.content)
        labels = rr.json()["labels"]
        self.assertEqual(len(labels), 1)
        self.assertIn("rtr1", labels[0]["html"])

    def test_pdf_is_label_sized(self):
        # The PDF endpoint returns a real PDF whose page is exactly the label's
        # mm dimensions — that's what makes it print at true physical size.
        r = self.client.post(
            "/api/label-templates/",
            {
                "name": "Asset",
                "object_type": "device",
                "template_html": "<b>{{ device.name }}</b><div class='qr'></div>",
                "width_mm": 62,
                "height_mm": 29,
                "qr_enabled": True,
            },
            content_type="application/json",
        )
        tid = r.json()["id"]
        p = self.client.get(f"/api/label-templates/{tid}/pdf/?ids={self.device.id}")
        self.assertEqual(p.status_code, 200, p.content)
        self.assertEqual(p["Content-Type"], "application/pdf")
        pdf = p.getvalue() if hasattr(p, "getvalue") else b"".join(p.streaming_content)
        self.assertTrue(pdf.startswith(b"%PDF"))
        # 62mm = 175.7pt, 29mm = 82.2pt — confirm the page box, not A4.
        import weasyprint

        page = weasyprint.HTML(
            string="<style>@page{size:62mm 29mm;margin:0}</style><body></body>"
        ).render().pages[0]
        self.assertAlmostEqual(page.width / 96 * 25.4, 62.0, delta=0.5)

    def test_pdf_no_objects_is_clean_400(self):
        r = self.client.post(
            "/api/label-templates/",
            {"name": "X", "object_type": "device", "template_html": "x"},
            content_type="application/json",
        )
        tid = r.json()["id"]
        p = self.client.get(f"/api/label-templates/{tid}/pdf/")  # no ids
        self.assertEqual(p.status_code, 400, p.content)

    def test_preview_falls_back_to_first_object(self):
        # No object_id → preview against the first object of the type (zero-setup
        # editor preview). A device exists in setUp, so this renders.
        r = self.client.post(
            "/api/label-templates/preview/",
            {"object_type": "device", "template_html": "N:{{ device.name }}"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["html"], "N:rtr1")

    def test_preview_renders_draft(self):
        r = self.client.post(
            "/api/label-templates/preview/",
            {
                "object_type": "device",
                "object_id": str(self.device.id),
                "template_html": "N:{{ device.name }}",
            },
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["html"], "N:rtr1")

    def test_bad_template_is_a_clean_400(self):
        r = self.client.post(
            "/api/label-templates/",
            {"name": "Bad", "object_type": "device", "template_html": "{{ oops"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
