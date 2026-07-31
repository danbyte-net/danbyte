"""Issuer + ACME order models/API (M4a). No protocol here — the engine (M4b)
is tested separately. These pin tenant scoping and EAB-secret handling."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import AcmeOrder, Issuer

User = get_user_model()


class IssuerApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other = Organization.objects.create(name="O2", slug="o2")
        self.other = Tenant.objects.create(org=other, name="O2", slug="o2")
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_create_issuer_stores_eab_hmac_write_only(self):
        r = self.client.post(
            "/api/monitoring/issuers/",
            {
                "name": "Internal step-ca",
                "directory_url": "https://stepca.danbyte.lan/acme/acme/directory",
                "eab_kid": "kid-123",
                "eab_hmac": "super-secret-hmac",
                "contact_email": "pki@danbyte.lan",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertNotIn("eab_hmac", body)  # write-only, never echoed
        self.assertTrue(body["eab_hmac_set"])
        self.assertFalse(body["account_registered"])
        # Stored encrypted in `secrets`, not the API payload.
        iss = Issuer.objects.get(id=body["id"])
        self.assertEqual(iss.secrets.get("eab_hmac"), "super-secret-hmac")

    def test_eab_hmac_encrypted_at_rest(self):
        from django.db import connection

        self.client.post(
            "/api/monitoring/issuers/",
            {"name": "LE", "directory_url": "https://acme.example/dir",
             "eab_hmac": "TOPSECRETHMAC"},
            format="json",
        )
        with connection.cursor() as cur:
            cur.execute("SELECT secrets FROM monitoring_issuer WHERE name = %s", ["LE"])
            raw = cur.fetchone()[0]
        self.assertNotIn("TOPSECRETHMAC", raw or "")

    def test_list_is_tenant_scoped(self):
        Issuer.objects.create(
            tenant=self.other, name="theirs", directory_url="https://x/dir"
        )
        Issuer.objects.create(
            tenant=self.tenant, name="mine", directory_url="https://y/dir"
        )
        r = self.client.get("/api/monitoring/issuers/")
        names = [i["name"] for i in r.json()["results"]]
        self.assertEqual(names, ["mine"])

    def test_duplicate_name_per_tenant_rejected(self):
        Issuer.objects.create(
            tenant=self.tenant, name="dup", directory_url="https://y/dir"
        )
        r = self.client.post(
            "/api/monitoring/issuers/",
            {"name": "dup", "directory_url": "https://z/dir"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)


class AcmeOrderApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.issuer = Issuer.objects.create(
            tenant=self.tenant, name="ca", directory_url="https://ca/dir"
        )
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_orders_are_read_only_and_scoped(self):
        AcmeOrder.objects.create(
            tenant=self.tenant, issuer=self.issuer,
            identifiers=["svc.danbyte.lan"], status="pending",
        )
        r = self.client.get("/api/monitoring/acme-orders/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["results"]), 1)
        self.assertEqual(r.json()["results"][0]["issuer_name"], "ca")
        # Read-only: POST is not allowed.
        p = self.client.post("/api/monitoring/acme-orders/", {}, format="json")
        self.assertIn(p.status_code, (403, 405))
