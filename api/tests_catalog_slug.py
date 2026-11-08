"""Catalog name and slug checks: the same rule on create and update, the
error on the field that clashed, and an edit that keeps the name is never
refused for it."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Platform

User = get_user_model()


class PlatformNameTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.client.force_login(User.objects.create_superuser("root", "r@a.c", "pw"))
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _post(self, **body):
        return self.client.post("/api/platforms/", body, format="json")

    def _patch(self, p, **body):
        return self.client.patch(f"/api/platforms/{p.id}/", body, format="json")

    def test_a_taken_name_is_refused_on_create_whatever_the_slug(self):
        self.assertEqual(self._post(name="Debian GNU/Linux").status_code, 201)
        r = self._post(name="Debian GNU/Linux", slug="debian")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(list(r.json()), ["name"])
        r = self._post(name="debian gnu/linux")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Platform.objects.count(), 1)

    def test_rows_sharing_a_name_stay_editable(self):
        # Made before the create check existed.
        a = Platform.objects.create(tenant=self.tenant, name="Debian GNU/Linux",
                                    slug="debian-gnulinux")
        b = Platform.objects.create(tenant=self.tenant, name="Debian GNU/Linux", slug="debian")
        for p in (a, b):
            r = self._patch(p, description="the OS")
            self.assertEqual(r.status_code, 200, r.content)
        b.refresh_from_db()
        self.assertEqual(b.slug, "debian")

    def test_a_rename_onto_a_taken_name_is_refused_on_name(self):
        self._post(name="Debian")
        other = Platform.objects.create(tenant=self.tenant, name="Ubuntu", slug="ubuntu")
        r = self._patch(other, name="Debian")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(list(r.json()), ["name"])

    def test_a_rename_without_a_slug_takes_the_new_names(self):
        p = Platform.objects.create(tenant=self.tenant, name="Debian", slug="debian")
        r = self._patch(p, name="Debian 13")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["slug"], "debian-13")

    def test_a_taken_slug_given_is_refused_on_slug(self):
        self._post(name="Debian")
        r = self._post(name="Ubuntu", slug="debian")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"slug": "Slug already in use."})
