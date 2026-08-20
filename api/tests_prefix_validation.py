"""Prefix CIDR input validation (issue #47).

`Prefix.cidr` is a plain CharField, so before this a bare `10.0.0.1` saved
fine and then haunted the install - invisible in the prefix tree (which
parses CIDRs) but counted by the dashboard.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Prefix

User = get_user_model()


class PrefixCidrValidationTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = User.objects.create_superuser("a", "a@x.dk", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, cidr):
        return self.client.post("/api/prefixes/", {"cidr": cidr}, format="json")

    def test_a_bare_address_is_rejected_with_a_cidr_hint(self):
        r = self._post("10.0.0.1")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("CIDR", str(r.json()["cidr"]))
        self.assertFalse(Prefix.objects.exists())

    def test_host_bits_are_rejected_with_the_network_named(self):
        """The error tells the user what they probably meant, not just no."""
        r = self._post("10.0.10.5/24")
        self.assertEqual(r.status_code, 400)
        self.assertIn("10.0.10.0/24", str(r.json()["cidr"]))

    def test_garbage_is_rejected(self):
        for bad in ("not-an-ip/24", "10.0.0.0/99", "10.0.0.0/", "/24"):
            r = self._post(bad)
            self.assertEqual(r.status_code, 400, bad)

    def test_valid_prefixes_still_create_and_normalise(self):
        r = self._post("10.0.10.0/24")
        self.assertEqual(r.status_code, 201, r.content)
        r6 = self._post("2001:0db8:0001::/64")
        self.assertEqual(r6.status_code, 201, r6.content)
        # IPv6 stored compressed, so uniqueness can't be dodged by formatting.
        self.assertTrue(
            Prefix.objects.filter(cidr="2001:db8:1::/64").exists()
        )

    def test_repair_migration_fixes_maskless_rows(self):
        """Rows created before the validation become host prefixes - visible
        and deletable again - and garbage is left untouched."""
        import importlib

        mod = importlib.import_module(
            "api.migrations.0126_repair_maskless_prefixes"
        )
        broken = Prefix.objects.create(tenant=self.tenant, cidr="10.9.9.9")
        garbage = Prefix.objects.create(tenant=self.tenant, cidr="banana")
        from django.apps import apps

        mod._repair(apps, None)
        broken.refresh_from_db()
        garbage.refresh_from_db()
        self.assertEqual(broken.cidr, "10.9.9.9/32")
        self.assertEqual(garbage.cidr, "banana")


class PrefixBulkImportValidationTests(PrefixCidrValidationTests):
    """The bulk importer bypasses DRF serializers and validates with
    full_clean - the model-level clean() must close the same #47 hole."""

    def test_bulk_import_rejects_a_maskless_address(self):
        from api.bulk_import import import_rows

        res = import_rows(Prefix, self.tenant, [{"cidr": "10.0.0.7"}])
        self.assertEqual(res["created"], 0, res)
        self.assertTrue(res["errors"], "the row must fail, not silently skip")
        self.assertFalse(Prefix.objects.filter(cidr="10.0.0.7").exists())

    def test_bulk_import_accepts_valid_cidr(self):
        from api.bulk_import import import_rows

        res = import_rows(Prefix, self.tenant, [{"cidr": "10.44.0.0/24"}])
        self.assertEqual(res["created"], 1, res)
        self.assertTrue(Prefix.objects.filter(cidr="10.44.0.0/24").exists())
