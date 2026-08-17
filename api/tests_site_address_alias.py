"""Site.location is exposed as the `address` alias too (hybrid rename, #26).

Both names must keep working: `location` stays for backward compatibility, and
`address` reads/writes the same underlying field.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from api.models import Site
from core.models import Organization, Tenant


class SiteAddressAliasTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_superuser("addr-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()

    def test_read_exposes_both_names(self):
        site = Site.objects.create(
            tenant=self.tenant, name="DC", location="Vestergade 45, 5000 Odense C"
        )
        r = self.client_api.get(f"/api/sites/{site.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["location"], "Vestergade 45, 5000 Odense C")
        self.assertEqual(body["address"], "Vestergade 45, 5000 Odense C")

    def test_write_via_address(self):
        r = self.client_api.post(
            "/api/sites/", {"name": "AddrSite", "address": "Main St 1"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        site = Site.objects.get(name="AddrSite")
        self.assertEqual(site.location, "Main St 1")
        self.assertEqual(r.json()["address"], "Main St 1")

    def test_write_via_location_still_works(self):
        r = self.client_api.post(
            "/api/sites/", {"name": "LocSite", "location": "Old Rd 2"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        site = Site.objects.get(name="LocSite")
        self.assertEqual(site.location, "Old Rd 2")

    def test_patch_address_updates_location(self):
        site = Site.objects.create(tenant=self.tenant, name="P", location="before")
        r = self.client_api.patch(
            f"/api/sites/{site.id}/", {"address": "after"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        site.refresh_from_db()
        self.assertEqual(site.location, "after")
