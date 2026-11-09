"""Template and script bodies round-trip byte for byte over the API: what a
client sends is what it reads back, trailing newline and indentation
included, while names are still trimmed."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import ExportTemplate, LabelTemplate

User = get_user_model()

BODY = "  {# leading indent #}\n{% for d in objects %}{{ d.name }}\n{% endfor %}\n\n  \n"


class TemplateRoundTripTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_export_template_body_round_trips(self):
        r = self.client.post("/api/export-templates/", {
            "name": "  devs  ", "object_type": "device", "template_code": BODY,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["template_code"], BODY)
        self.assertEqual(r.json()["name"], "devs")
        tmpl = ExportTemplate.objects.get(pk=r.json()["id"])
        self.assertEqual(tmpl.template_code, BODY)
        got = self.client.get(f"/api/export-templates/{tmpl.id}/").json()
        self.assertEqual(got["template_code"], BODY)

        edited = BODY + "end\n"
        r = self.client.patch(f"/api/export-templates/{tmpl.id}/",
                              {"template_code": edited}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        tmpl.refresh_from_db()
        self.assertEqual(tmpl.template_code, edited)

    def test_label_template_bodies_round_trip(self):
        html = "<div>{{ device.name }}</div>\n"
        css = ".x { color: red; }\n"
        r = self.client.post("/api/label-templates/", {
            "name": "lbl", "object_type": "device", "template_html": html, "css": css,
            "qr_content": "{{ url }}\n",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        lt = LabelTemplate.objects.get(pk=r.json()["id"])
        self.assertEqual((lt.template_html, lt.css, lt.qr_content),
                         (html, css, "{{ url }}\n"))

    def test_script_source_round_trips(self):
        source = "def main(ctx):\n    return 1\n"
        r = self.client.post("/api/scripts/", {
            "name": "S", "language": "python", "source": source,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["source"], source)
        got = self.client.get(f"/api/scripts/{r.json()['id']}/").json()
        self.assertEqual(got["source"], source)
