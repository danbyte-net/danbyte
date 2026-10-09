"""Tests for the built-in Status catalog seeding and the dashboard status
aggregation regression - both from issue #51 (fresh-install first-run bugs)."""
from __future__ import annotations

import importlib
from io import StringIO

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Prefix, Status
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

User = get_user_model()


class SeedBuiltinStatusesTests(TestCase):
    """#51/2 - a runtime/fresh-install tenant should get the built-in catalog."""

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


class SeedKeepsOperatorScopesTests(APITestCase):
    """#361 - reseeding (bootstrap on every start and upgrade, the 0179/0188
    migrations) must not undo a default or availability the operator changed."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _row(self, slug):
        return Status.objects.get(tenant=self.tenant, slug=slug)

    def _defaults(self, model_slug):
        return sorted(
            Status.objects.filter(tenant=self.tenant, default_for__contains=[model_slug])
            .values_list("slug", flat=True)
        )

    def _patch(self, slug, **body):
        r = self.client.patch(f"/api/statuses/{self._row(slug).id}/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_bootstrap_keeps_the_operators_default(self):
        reserved = self._row("reserved")
        self._patch("reserved", default_for=[*reserved.default_for, "ipaddress"])
        self.assertEqual(self._defaults("ipaddress"), ["reserved"])

        call_command("bootstrap", stdout=StringIO())

        self.assertEqual(self._defaults("ipaddress"), ["reserved"])

    def test_reseed_keeps_a_removed_availability(self):
        decom = self._row("decommissioning")
        self._patch(
            "decommissioning",
            available_to=[t for t in decom.available_to if t != "device"],
        )
        self.assertEqual(seed_builtin_statuses(self.tenant), 0)
        self.assertNotIn("device", self._row("decommissioning").available_to)

    def test_reseed_keeps_a_type_with_no_default(self):
        active = self._row("active")
        self._patch("active", default_for=[t for t in active.default_for if t != "device"])
        seed_builtin_statuses(self.tenant)
        self.assertEqual(self._defaults("device"), [])

    def test_new_object_type_is_scoped_on_existing_rows(self):
        # A tenant from before VLANs had statuses: no row lists "vlan" yet,
        # as when 0179 runs on an upgrade.
        for s in Status.objects.filter(tenant=self.tenant):
            s.available_to = [t for t in s.available_to if t != "vlan"]
            s.default_for = [t for t in s.default_for if t != "vlan"]
            s.save(update_fields=["available_to", "default_for"])
        # The operator's IP default, which must survive the same run.
        self._patch("reserved", default_for=["ipaddress"])

        self.assertEqual(seed_builtin_statuses(self.tenant), 0)

        scoped = set(
            Status.objects.filter(tenant=self.tenant, available_to__contains=["vlan"])
            .values_list("slug", flat=True)
        )
        self.assertEqual(scoped, {"active", "reserved", "deprecated"})
        self.assertEqual(self._defaults("vlan"), ["active"])
        self.assertEqual(self._defaults("ipaddress"), ["reserved"])

    def test_a_deleted_builtin_is_recreated_without_taking_the_default(self):
        self._patch("planned", default_for=["device"])
        self.assertEqual(self._defaults("device"), ["planned"])
        self._row("active").delete()

        self.assertEqual(seed_builtin_statuses(self.tenant), 1)

        active = self._row("active")
        self.assertIn("device", active.available_to)
        self.assertIn("vlan", active.available_to)
        self.assertEqual(active.default_for, [])
        self.assertEqual(self._defaults("device"), ["planned"])

    def test_existing_custom_row_with_a_builtin_slug_is_not_rescoped(self):
        # "spare" is a built-in for inventory items only; an operator who also
        # uses it on devices and then narrows it keeps the narrowing.
        self._patch("spare", available_to=["device"])
        seed_builtin_statuses(self.tenant)
        self.assertEqual(self._row("spare").available_to, ["device"])


class RepairDuplicateStatusDefaultsTests(TestCase):
    """#361 - 0197 drops the default seeding re-added next to the operator's."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)

    def _run(self):
        from django.apps import apps

        module = importlib.import_module(
            "api.migrations.0197_repair_duplicate_status_defaults"
        )
        module.repair(apps, None)

    def _row(self, slug):
        return Status.objects.get(tenant=self.tenant, slug=slug)

    def _defaults(self, model_slug):
        return sorted(
            Status.objects.filter(tenant=self.tenant, default_for__contains=[model_slug])
            .values_list("slug", flat=True)
        )

    def _also_default(self, slug, *model_slugs):
        s = self._row(slug)
        s.default_for = [*s.default_for, *model_slugs]
        s.save(update_fields=["default_for"])

    def test_keeps_the_operators_default(self):
        self._also_default("reserved", "ipaddress")
        self._also_default("planned", "device")
        self._also_default("planned", "cable")  # cable's built-in is "connected"
        self._run()
        self.assertEqual(self._defaults("ipaddress"), ["reserved"])
        self.assertEqual(self._defaults("device"), ["planned"])
        self.assertEqual(self._defaults("cable"), ["planned"])
        # Untouched types keep the built-in.
        self.assertEqual(self._defaults("prefix"), ["active"])

    def test_leaves_ambiguous_duplicates(self):
        # Three claimants, or two where neither is the built-in default, did
        # not come from seeding alone.
        self._also_default("reserved", "ipaddress")
        self._also_default("deprecated", "ipaddress")
        a = self._row("active")
        a.default_for = [t for t in a.default_for if t != "prefix"]
        a.save(update_fields=["default_for"])
        self._also_default("reserved", "prefix")
        self._also_default("container", "prefix")
        self._run()
        self.assertEqual(self._defaults("ipaddress"), ["active", "deprecated", "reserved"])
        self.assertEqual(self._defaults("prefix"), ["container", "reserved"])

    def test_single_defaults_untouched(self):
        before = {s.slug: list(s.default_for) for s in Status.objects.filter(tenant=self.tenant)}
        self._run()
        after = {s.slug: list(s.default_for) for s in Status.objects.filter(tenant=self.tenant)}
        self.assertEqual(before, after)


class DashboardStatusRegressionTests(APITestCase):
    """#51/1 - the dashboard 500'd because prefix/device status aggregation
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
