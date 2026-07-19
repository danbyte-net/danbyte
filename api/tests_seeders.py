"""Smoke tests for the install/seed flow (issue #148).

Runs the documented commands on a clean (test) DB and asserts they complete —
so the seeders never silently drift from the models again. Covers: bootstrap
creating a default tenant + the built-in Status catalog, and both demo seeders
resolving status **names** to the Status FK (Prefix.status is no longer a
string) with no tenant/`Site.slug` prerequisites.
"""
from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from api.models import Device, IPAddress, Prefix, Status
from core.models import Tenant


def _run(cmd, *args):
    call_command(cmd, *args, stdout=StringIO(), stderr=StringIO())


class BootstrapTests(TestCase):
    def test_creates_default_tenant_and_builtin_statuses(self):
        _run("bootstrap")
        tenant = Tenant.objects.first()
        self.assertIsNotNone(tenant)  # a default tenant now exists
        # The catalog features rely on — resolved from STATUS_MODEL_VALUES.
        for slug in ("active", "connected", "container", "reserved", "offline"):
            self.assertTrue(
                Status.objects.filter(tenant=tenant, slug=slug).exists(),
                f"missing built-in status {slug!r}",
            )

    def test_no_default_tenant_flag_skips_tenant(self):
        _run("bootstrap", "--no-default-tenant")
        self.assertFalse(Tenant.objects.exists())

    def test_idempotent(self):
        _run("bootstrap")
        _run("bootstrap")
        self.assertEqual(Tenant.objects.count(), 1)


class SeedDemoTests(TestCase):
    def test_runs_and_prefix_status_is_a_fk(self):
        _run("seed_demo")
        p = Prefix.objects.exclude(status=None).first()
        self.assertIsNotNone(p, "seed_demo created no prefix with a status")
        self.assertIsInstance(p.status, Status)  # not a raw string


class SeedDemo172Tests(TestCase):
    def test_bootstraps_its_own_tenant_and_resolves_statuses(self):
        # No tenant exists yet — the seeder must create one (issue: it aborted).
        _run("seed_demo_172")
        root = Prefix.objects.filter(cidr="172.16.0.0/16").first()
        self.assertIsNotNone(root)
        self.assertEqual(root.status.slug, "container")  # name → FK
        self.assertTrue(Device.objects.filter(name="sw-core-01").exists())
        self.assertTrue(IPAddress.objects.filter(ip_address__startswith="172.16.").exists())


class FullInstallFlowTests(TestCase):
    def test_documented_order_runs_clean(self):
        # docs/getting-started/installation.md order.
        _run("bootstrap")
        _run("seed_demo")
        _run("seed_demo_172")
        self.assertTrue(Device.objects.filter(name="db-01").exists())
        self.assertTrue(
            Prefix.objects.filter(cidr="172.16.0.0/16", status__slug="container").exists()
        )
