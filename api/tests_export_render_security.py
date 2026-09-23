"""Rendering an export template must not reach beyond what the caller may
view (#193) and must not come back as a page on the app's origin (#195)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from jinja2.sandbox import SecurityError
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant
from integrations.models import Webhook

from .export_templates import _env, render_export_template
from .models import Device, ExportTemplate, Site

User = get_user_model()


class ExportRenderSecurityTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        for n in ("sw1", "sw2"):
            Device.objects.create(tenant=self.tenant, name=n, site=site)
        self.hook = Webhook.objects.create(
            tenant=self.tenant, name="h", payload_url="http://x.test/h",
            object_types=["prefix"], secret="SIGNING-KEY",
            additional_headers="Authorization: Bearer LEAKED",
        )

    def test_a_credential_type_cannot_be_a_template_subject(self):
        r = self.client.post(
            "/api/export-templates/",
            {"name": "hooks", "object_type": "webhook", "template_code": "{{ count }}"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("object_type", r.json())
        # A row that slipped in before the rule renders nothing either.
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="hooks", object_type="webhook",
            template_code="{% for o in objects %}{{ o.secret }}{% endfor %}",
        )
        r = self.client.get(f"/api/export-templates/{t.id}/render/")
        self.assertEqual(r.status_code, 400)
        self.assertNotIn(b"SIGNING-KEY", r.content)

    def test_secret_attributes_are_unreachable_from_any_row(self):
        env = _env()
        # A blocked attribute renders as nothing - never its value.
        for code in ("{{ h.secret }}", "{{ h.additional_headers }}"):
            self.assertEqual(env.from_string(code).render(h=self.hook), "")
        # The escape hatches from one row to every row are shut too.
        dev = Device.objects.first()
        for code in (
            "{{ d.interfaces.model.objects.count() }}",
            "{{ d.__class__.objects.count() }}",
        ):
            with self.assertRaises(SecurityError):
                env.from_string(code).render(d=dev)
        # Ordinary fields still render.
        self.assertEqual(env.from_string("{{ d.name }}").render(d=dev), dev.name)

    def test_rows_are_what_the_caller_may_view(self):
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="devs", object_type="device",
            template_code="{{ count }}",
        )
        self.assertEqual(render_export_template(t, self.tenant, self.admin), "2")
        nobody = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=nobody).tenants.add(self.tenant)
        self.assertEqual(render_export_template(t, self.tenant, nobody), "0")
        self.assertEqual(render_export_template(t, self.tenant), "0")

    def test_render_is_always_an_inert_download(self):
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="page", object_type="device",
            template_code="<script>alert(1)</script>", mime_type="text/html",
            as_attachment=False, file_extension="html",
        )
        r = self.client.get(f"/api/export-templates/{t.id}/render/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(r["X-Content-Type-Options"], "nosniff")
        self.assertIn("attachment", r["Content-Disposition"])
        t.mime_type = "text/csv"
        t.save()
        r = self.client.get(f"/api/export-templates/{t.id}/render/")
        self.assertEqual(r["Content-Type"], "text/csv; charset=utf-8")


class PskSubjectTests(APITestCase):
    """An SSID sheet or a VPN report is inventory with a key attached, not a
    credential: the key lives in the secret store and the sandbox refuses the
    accessor that reads it. 0.16.9 refused all three as subjects (#219)."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_psk_types_are_legal_subjects_and_credentials_are_not(self):
        for slug, ok in (("wirelesslan", True), ("ipsecprofile", True),
                         ("routingkeychain", True), ("devicecredential", False)):
            for url in ("/api/export-templates/", "/api/label-templates/"):
                with self.subTest(slug=slug, url=url):
                    body = {"name": f"{slug}-{url[5:10]}", "object_type": slug,
                            "template_code": "{{ count }}"}
                    if "label" in url:
                        body.update({"width_mm": 50, "height_mm": 25})
                    r = self.client.post(url, body, format="json")
                    if ok:
                        self.assertEqual(r.status_code, 201, r.content)
                    else:
                        self.assertEqual(r.status_code, 400, r.content)
                        self.assertIn("object_type", r.json())

    def test_the_key_stays_unreachable_from_the_row(self):
        from routing.models import RoutingKeychain

        k = RoutingKeychain.objects.create(tenant=self.tenant, name="FABRIC")
        env = _env()
        for code in ("{{ k.resolve_psk() }}", "{{ k.store_psk('x') }}"):
            with self.subTest(code=code):
                try:
                    out = env.from_string(code).render(k=k)
                except SecurityError:
                    continue
                self.assertEqual(out.strip(), "")
        self.assertEqual(env.from_string("{{ k.name }}").render(k=k), "FABRIC")


class LabelRenderSecurityTests(ExportRenderSecurityTests):
    """Label templates get the same sandbox and the same subject rule (#205)."""

    def test_label_template_cannot_take_or_print_a_credential(self):
        from .label_templates import render_label
        from .models import LabelTemplate

        r = self.client.post(
            "/api/label-templates/",
            {"name": "hook", "object_type": "webhook", "template_html": "{{ obj.secret }}"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("object_type", r.json())
        t = LabelTemplate(tenant=self.tenant, name="hook", object_type="webhook",
                          template_html="<b>{{ obj.secret }}{{ obj.additional_headers }}</b>")
        out = render_label(t, self.hook)
        self.assertNotIn("SIGNING-KEY", out["html"])
        self.assertNotIn("LEAKED", out["html"])


class SandboxMethodTests(ExportRenderSecurityTests):
    """A model's METHODS are behaviour, not data: the sandbox refuses them
    unless they are a choice label, so a credential accessor reached through
    a relation cannot be called (#216)."""

    def test_a_credential_accessor_is_unreachable_from_any_row(self):
        from jinja2.sandbox import SecurityError

        from monitoring.models import DeviceCredential

        from .export_templates import _env, has_secret_fields
        from .models import Device

        # The model holds its secret in the store, not in a field - it is a
        # credential type all the same, and never a template's subject.
        self.assertTrue(has_secret_fields(DeviceCredential))
        env = _env()
        dev = Device.objects.first()
        for code in (
            "{% for c in d.credentials.all() %}{{ c.resolve_secret() }}{% endfor %}",
            "{% for c in d.credentials.all() %}{{ c.store_managed_secret('x') }}{% endfor %}",
        ):
            try:
                out = env.from_string(code).render(d=dev)
            except SecurityError:
                continue
            self.assertEqual(out.strip(), "")

    def test_a_choice_label_renders_but_other_methods_do_not(self):
        from jinja2.sandbox import SecurityError

        from .export_templates import _env
        from .models import Device

        env = _env()
        dev = Device.objects.first()
        self.assertEqual(env.from_string("{{ d.name }}").render(d=dev), dev.name)
        for code in ("{{ d.delete() }}", "{{ d.save() }}"):
            with self.assertRaises(SecurityError):
                env.from_string(code).render(d=dev)
