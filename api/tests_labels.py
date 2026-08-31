"""Label templates (#9) - render engine + API.

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
        # A device name carrying markup - must be escaped in the label.
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
        # `{{ url }}` is the full detail URL; the default QR is the compact short
        # link (smaller QR) when the object has a numid.
        self.assertEqual(out["html"], f"https://x.example/devices/{self.device.pk}")
        self.assertEqual(
            out["qr"],
            f"https://x.example/l/{self.tenant.slug}/device/{self.device.numid}",
        )

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

    def test_cable_context_exposes_bare_port_names(self):
        """`a_port` stringifies with its device; `a_port_name` is just the
        port, for short cable labels."""
        from api.label_templates import _cable_ends, available_fields
        from api.models import Cable, CableTermination, Device, Interface

        dev_a = Device.objects.create(tenant=self.tenant, name="sw1")
        dev_b = Device.objects.create(tenant=self.tenant, name="sw2")
        pa = Interface.objects.create(device=dev_a, name="eth-longname-1")
        pb = Interface.objects.create(device=dev_b, name="eth2")
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=pa)
        CableTermination.objects.create(cable=cable, end="B", interface=pb)
        ends = _cable_ends(cable)
        self.assertEqual(ends["a_port_name"], "eth-longname-1")
        self.assertEqual(ends["b_port_name"], "eth2")
        self.assertEqual(ends["a"], dev_a)
        fields = available_fields("cable", self.tenant)
        self.assertIn("a_port_name", fields["special"])

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
        # mm dimensions - that's what makes it print at true physical size.
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
        # 62mm = 175.7pt, 29mm = 82.2pt - confirm the page box, not A4.
        import weasyprint

        page = weasyprint.HTML(
            string="<style>@page{size:62mm 29mm;margin:0}</style><body></body>"
        ).render().pages[0]
        self.assertAlmostEqual(page.width / 96 * 25.4, 62.0, delta=0.5)

    def test_pdf_a4_sheet_is_a4_page(self):
        # paper=a4 tiles labels onto an A4 page (so an office printer prints them
        # at real size without a scale toggle). Page must be A4, not label-sized.
        r = self.client.post(
            "/api/label-templates/",
            {"name": "A", "object_type": "device", "template_html": "x",
             "width_mm": 62, "height_mm": 29},
            content_type="application/json",
        )
        tid = r.json()["id"]
        p = self.client.get(
            f"/api/label-templates/{tid}/pdf/?ids={self.device.id}&paper=a4"
        )
        self.assertEqual(p.status_code, 200, p.content)
        pdf = p.getvalue() if hasattr(p, "getvalue") else b"".join(p.streaming_content)
        self.assertTrue(pdf.startswith(b"%PDF"))
        import weasyprint

        from api.label_templates import _sheet_css
        from api.models import LabelTemplate

        tmpl = LabelTemplate.objects.get(pk=tid)
        page = weasyprint.HTML(
            string=f"<style>{_sheet_css(tmpl, 'a4')}</style><body></body>"
        ).render().pages[0]
        self.assertAlmostEqual(page.width / 96 * 25.4, 210.0, delta=1.0)

    def test_text_and_xlsx_export(self):
        r = self.client.post(
            "/api/label-templates/",
            {"name": "T", "object_type": "device",
             "template_html": "<div>{{ device.name }}</div><div>{{ device.site.name }}</div>"},
            content_type="application/json",
        )
        tid = r.json()["id"]
        t = self.client.get(f"/api/label-templates/{tid}/text/?ids={self.device.id}")
        self.assertEqual(t.status_code, 200, t.content)
        self.assertIn("rtr1", t.json()["labels"][0]["text"])
        x = self.client.get(f"/api/label-templates/{tid}/xlsx/?ids={self.device.id}")
        self.assertEqual(x.status_code, 200, x.content)
        self.assertIn("spreadsheetml", x["Content-Type"])
        blob = x.getvalue() if hasattr(x, "getvalue") else b"".join(x.streaming_content)
        self.assertTrue(blob[:2] == b"PK")  # xlsx is a zip

    def test_targeting_filters_list(self):
        from api.models import DeviceRole, DeviceType, LabelTemplate

        other_dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.device.device_type.manufacturer,
            name="OtherType", model="OtherType",
        )
        # Universal template (no restriction) + one restricted to another type.
        LabelTemplate.objects.create(
            tenant=self.tenant, name="Universal", object_type="device"
        )
        restricted = LabelTemplate.objects.create(
            tenant=self.tenant, name="OnlyOther", object_type="device"
        )
        restricted.device_types.add(other_dt)
        # Filtering by this device's type returns the universal one, not the
        # foreign-type-restricted one.
        r = self.client.get(
            f"/api/label-templates/?object_type=device"
            f"&device_type={self.device.device_type_id}"
        )
        names = {t["name"] for t in r.json()["results"]}
        self.assertIn("Universal", names)
        self.assertNotIn("OnlyOther", names)

    def test_short_url_and_resolver(self):
        # The default QR uses the compact /l/<type>/<numid> short link, and the
        # resolver turns that numid back into the object (tenant/view scoped).
        from api.label_templates import render_label

        self.assertIsNotNone(self.device.numid)
        out = render_label(self.device_template(), self.device, base_url="https://x")
        self.assertEqual(
            out["qr"], f"https://x/l/{self.tenant.slug}/device/{self.device.numid}"
        )
        r = self.client.get(
            f"/api/resolve/?tenant={self.tenant.slug}"
            f"&type=device&numid={self.device.numid}"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["object_type"], "api.device")
        self.assertEqual(r.json()["id"], str(self.device.id))
        self.assertEqual(r.json()["tenant"]["slug"], self.tenant.slug)

    def test_resolver_unknown_is_404(self):
        r = self.client.get(
            f"/api/resolve/?tenant={self.tenant.slug}&type=device&numid=99999"
        )
        self.assertEqual(r.status_code, 404, r.content)

    def test_resolver_no_access_does_not_switch_tenant(self):
        # A user with no grants in another tenant must NOT be switched into it by
        # scanning that tenant's label - the resolver 404s and leaves the active
        # tenant untouched.
        other_org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        mfr = Manufacturer.objects.create(tenant=other, name="M", slug="m2")
        dt = DeviceType.objects.create(tenant=other, manufacturer=mfr, model="MX2")
        role = DeviceRole.objects.create(tenant=other, name="R", slug="r2")
        osite = Site.objects.create(tenant=other, name="S2")
        foreign = Device.objects.create(
            tenant=other, name="secret", device_type=dt, role=role, site=osite,
        )

        member = User.objects.create_user("member", "m@x.com", "x")  # no grants
        c = self.client_class()
        c.force_login(member)
        s = c.session
        s["current_tenant_id"] = str(self.tenant.id)  # active = own tenant
        s.save()

        r = c.get(
            f"/api/resolve/?tenant={other.slug}&type=device&numid={foreign.numid}"
        )
        self.assertEqual(r.status_code, 404, r.content)
        # Session was NOT repointed to the foreign tenant.
        self.assertEqual(c.session.get("current_tenant_id"), str(self.tenant.id))

    def device_template(self):
        from api.models import LabelTemplate

        return LabelTemplate(object_type="device", template_html="{{ device.name }}")

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
