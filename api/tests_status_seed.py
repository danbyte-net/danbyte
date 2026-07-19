"""Tests for the built-in Status catalog seeding and the dashboard status
aggregation regression — both from issue #51 (fresh-install first-run bugs)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Prefix, Status
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

User = get_user_model()


class SeedBuiltinStatusesTests(TestCase):
    """#51/2 — a runtime/fresh-install tenant should get the built-in catalog."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_seeds_catalog_with_scope_and_defaults(self):
        created = seed_builtin_statuses(self.tenant)
        self.assertGreater(created, 0)

        active = Status.objects.get(tenant=self.tenant, slug="active")
        # "active" is usable on, and the default for, both prefixes and devices.
        self.assertIn("prefix", active.available_to)
        self.assertIn("device", active.available_to)
        self.assertIn("prefix", active.default_for)
        self.assertIn("device", active.default_for)

        # A prefix-only built-in carries just the prefix scope.
        container = Status.objects.get(tenant=self.tenant, slug="container")
        self.assertIn("prefix", container.available_to)
        self.assertNotIn("device", container.available_to)

    def test_idempotent(self):
        seed_builtin_statuses(self.tenant)
        count_after_first = Status.objects.filter(tenant=self.tenant).count()
        created_second = seed_builtin_statuses(self.tenant)
        self.assertEqual(created_second, 0)
        self.assertEqual(
            Status.objects.filter(tenant=self.tenant).count(), count_after_first
        )

    def test_merges_into_existing_row(self):
        existing = Status.objects.create(
            tenant=self.tenant, name="Active", slug="active",
            available_to=["ipaddress"], default_for=[],
        )
        seed_builtin_statuses(self.tenant)
        existing.refresh_from_db()
        # No duplicate "active" row; the existing scope is extended in place.
        self.assertEqual(
            Status.objects.filter(tenant=self.tenant, slug="active").count(), 1
        )
        self.assertIn("ipaddress", existing.available_to)
        self.assertIn("prefix", existing.available_to)


class DashboardStatusRegressionTests(APITestCase):
    """#51/1 — the dashboard 500'd because prefix/device status aggregation
    still read the pre-0047 enum column instead of the Status FK."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.status = Status.objects.create(
            tenant=self.tenant, name="Active", slug="active",
            available_to=["prefix"], default_for=["prefix"],
        )
        Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=self.status
        )
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_dashboard_ok_with_prefix_status(self):
        resp = self.client.get("/api/dashboard/")
        self.assertEqual(resp.status_code, 200)
        names = [row["name"] for row in resp.json()["prefix_by_status"]]
        self.assertIn("Active", names)
