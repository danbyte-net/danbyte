"""The id printed on a label finds the object again: the per-tenant number
and the UUID prefix match in every list's search, and ``?numid=`` filters."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .label_templates import available_fields, render_label
from .models import Cable, Device, LabelTemplate, Site

User = get_user_model()


class IdSearchTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.cables = [Cable.objects.create(tenant=self.tenant, description=d) for d in ("alpha", "beta", "gamma")]
        self.devices = [Device.objects.create(tenant=self.tenant, name=n, site=self.site) for n in ("spine", "leaf", "edge")]

    def _ids(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return [row["id"] for row in r.json()["results"]]

    def test_number_and_uuid_prefix_find_a_cable(self):
        c = self.cables[1]
        self.assertEqual(self._ids(f"/api/cables/?search={c.numid}"), [str(c.id)])
        self.assertEqual(self._ids(f"/api/cables/?search={str(c.id)[:8]}"), [str(c.id)])
        self.assertEqual(self._ids(f"/api/cables/?search={c.id}"), [str(c.id)])
        self.assertEqual(self._ids("/api/cables/?search=999999"), [])

    def test_the_same_for_devices(self):
        d = self.devices[2]
        self.assertEqual(self._ids(f"/api/devices/?search={d.numid}"), [str(d.id)])
        self.assertEqual(self._ids(f"/api/devices/?search={str(d.id)[:8].upper()}"), [str(d.id)])
        self.assertIn(str(d.id), self._ids("/api/devices/?search=edge"))

    def test_numid_filter(self):
        c = self.cables[0]
        self.assertEqual(self._ids(f"/api/cables/?numid={c.numid}"), [str(c.id)])
        self.assertEqual(self._ids("/api/cables/?numid=424242"), [])
        r = self.client.get("/api/cables/?numid=abc")
        self.assertEqual(r.status_code, 400)

    def test_labels_carry_a_hex_id(self):
        c = self.cables[0]
        self.assertIn("short_hex", available_fields("cable")["special"])
        t = LabelTemplate.objects.create(
            tenant=self.tenant, name="flag", object_type="cable",
            template_html="{{ short_id }}|{{ short_hex }}",
        )
        out = render_label(t, c)
        self.assertIn(f"{c.numid}|{str(c.id)[:8]}", out["html"])
        c.numid = None
        self.assertIn(f"{str(c.id)[:8]}|{str(c.id)[:8]}", render_label(t, c)["html"])
