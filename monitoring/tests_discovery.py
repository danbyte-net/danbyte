"""M12 discovery + M13 stale cleanup — opt-in subnet lifecycle."""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .discovery import cleanup_stale_ips, discover_prefix, run_discovery
from .models import MonitoringSettings


from api.test_utils import status_for


def _host(addr, alive):
    # Mirror the icmplib Host shape discovery reads (.address, .is_alive).
    return SimpleNamespace(address=addr, is_alive=alive)


class DiscoveryTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.settings = MonitoringSettings.for_tenant(self.tenant)
        self.settings.discovery_enabled = True
        self.settings.discovery_min_prefix_length = 24
        self.settings.save()
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="192.0.2.0/24", status=status_for(self.tenant),
            auto_discover=True,
        )

    def _sweep(self, alive_addrs):
        def fake(addresses, count, timeout_ms):
            return [_host(a, a in alive_addrs) for a in addresses]

        return patch("monitoring.worker._multiping", side_effect=fake)

    def test_creates_responders(self):
        with self._sweep({"192.0.2.10", "192.0.2.20"}):
            res = discover_prefix(self.prefix, self.settings)
        self.assertEqual(res["created"], 2)
        addrs = set(
            IPAddress.objects.filter(prefix=self.prefix).values_list(
                "ip_address", flat=True
            )
        )
        self.assertEqual(addrs, {"192.0.2.10", "192.0.2.20"})
        self.assertTrue(IPAddress.objects.get(ip_address="192.0.2.10").discovered)

    def test_assigns_auto_discovered_status(self):
        from api.models import Status

        with self._sweep({"192.0.2.10"}):
            discover_prefix(self.prefix, self.settings)
        ip = IPAddress.objects.get(ip_address="192.0.2.10")
        self.assertIsNotNone(ip.status)
        self.assertEqual(ip.status.slug, "auto-discovered")
        self.assertFalse(ip.status.is_available)
        # The status is a real, editable per-tenant catalog row (not seeded).
        self.assertEqual(
            Status.objects.filter(
                tenant=self.tenant, slug="auto-discovered"
            ).count(),
            1,
        )

    def test_status_created_once_and_reused(self):
        from api.models import Status

        with self._sweep({"192.0.2.10", "192.0.2.11"}):
            discover_prefix(self.prefix, self.settings)
        self.assertEqual(
            Status.objects.filter(
                tenant=self.tenant, slug="auto-discovered"
            ).count(),
            1,
        )

    def test_does_not_duplicate_existing(self):
        IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="192.0.2.10"
        )
        with self._sweep({"192.0.2.10", "192.0.2.20"}):
            res = discover_prefix(self.prefix, self.settings)
        self.assertEqual(res["created"], 1)  # only .20 is new
        self.assertFalse(
            IPAddress.objects.get(ip_address="192.0.2.10").discovered
        )  # pre-existing row untouched

    def test_skips_too_large_prefix(self):
        big = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container"),
            auto_discover=True,
        )
        with self._sweep({"10.0.0.1"}) as m:
            res = discover_prefix(big, self.settings)
        self.assertEqual(res.get("skipped"), "too_large")
        m.assert_not_called()

    def test_skips_huge_ipv6(self):
        # A /64 is too large to enumerate — skipped (no longer a blanket
        # "ipv6" skip; small v6 prefixes are swept).
        v6 = Prefix.objects.create(
            tenant=self.tenant, cidr="2001:db8::/64", status=status_for(self.tenant),
            auto_discover=True,
        )
        res = discover_prefix(v6, self.settings)
        self.assertEqual(res.get("skipped"), "too_large")

    def test_sweeps_small_ipv6(self):
        # A /120 (256 hosts) is enumerable → it sweeps like an IPv4 prefix.
        v6 = Prefix.objects.create(
            tenant=self.tenant, cidr="2001:db8::/120", status=status_for(self.tenant),
            auto_discover=True,
        )
        with patch(
            "monitoring.discovery._sweep_hosts", return_value=[]
        ) as m:
            res = discover_prefix(v6, self.settings)
        self.assertNotIn("skipped", res)
        self.assertEqual(res.get("scanned"), 255)  # v6 /120 excludes only ::0
        m.assert_called_once()

    def test_run_discovery_respects_opt_in(self):
        self.settings.discovery_enabled = False
        self.settings.save()
        with self._sweep({"192.0.2.10"}) as m:
            total = run_discovery()
        self.assertEqual(total["created"], 0)
        m.assert_not_called()

    def test_global_switch_discovers_all_prefixes(self):
        # A second prefix with NO auto_discover flag.
        other = Prefix.objects.create(
            tenant=self.tenant, cidr="192.0.3.0/24", status=status_for(self.tenant)
        )
        self.prefix.auto_discover = False
        self.prefix.save(update_fields=["auto_discover"])
        self.settings.discovery_all_prefixes = True
        self.settings.save()
        with self._sweep({"192.0.2.10", "192.0.3.10"}):
            run_discovery()
        self.assertTrue(
            IPAddress.objects.filter(prefix=self.prefix, ip_address="192.0.2.10").exists()
        )
        self.assertTrue(
            IPAddress.objects.filter(prefix=other, ip_address="192.0.3.10").exists()
        )

    def test_master_prefix_enrols_children(self):
        from monitoring.discovery import discovery_candidates

        master = Prefix.objects.create(
            tenant=self.tenant, cidr="10.10.0.0/16", status=status_for(self.tenant, "container"),
            auto_discover=True,
        )
        child = Prefix.objects.create(
            tenant=self.tenant, cidr="10.10.5.0/24", status=status_for(self.tenant)
        )
        unrelated = Prefix.objects.create(
            tenant=self.tenant, cidr="172.16.0.0/24", status=status_for(self.tenant)
        )
        cands = discovery_candidates(self.tenant, self.settings)
        self.assertIn(child, cands)  # inherited from the /16 master
        self.assertIn(master, cands)  # the master itself (size-guarded at sweep)
        self.assertNotIn(unrelated, cands)

    def test_interval_gates_recently_swept_prefix(self):
        from django.utils import timezone

        self.settings.discovery_interval_minutes = 30
        self.settings.save()
        # Swept 5 min ago → not due yet; run_discovery must skip it.
        self.prefix.last_discovered_at = timezone.now() - timedelta(minutes=5)
        self.prefix.save(update_fields=["last_discovered_at"])
        with self._sweep({"192.0.2.10"}) as m:
            run_discovery()
        m.assert_not_called()

    def test_interval_allows_due_prefix(self):
        from django.utils import timezone

        self.settings.discovery_interval_minutes = 30
        self.settings.save()
        self.prefix.last_discovered_at = timezone.now() - timedelta(minutes=45)
        self.prefix.save(update_fields=["last_discovered_at"])
        with self._sweep({"192.0.2.10"}):
            total = run_discovery()
        self.assertEqual(total["created"], 1)
        self.prefix.refresh_from_db()
        # Sweep stamps last_discovered_at fresh.
        self.assertGreater(
            self.prefix.last_discovered_at, timezone.now() - timedelta(minutes=1)
        )


class CleanupTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.settings = MonitoringSettings.for_tenant(self.tenant)
        self.settings.cleanup_enabled = True
        self.settings.cleanup_after_days = 30
        self.settings.save()
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="192.0.2.0/24", status=status_for(self.tenant)
        )
        self.old = timezone.now() - timedelta(days=40)

    def _ip(self, addr, **kw):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address=addr, **kw
        )

    def test_deletes_stale_discovered(self):
        ip = self._ip("192.0.2.10", discovered=True, last_seen=self.old)
        res = cleanup_stale_ips()
        self.assertEqual(res["deleted"], 1)
        self.assertFalse(IPAddress.objects.filter(id=ip.id).exists())

    def test_keeps_user_created_even_if_stale(self):
        ip = self._ip("192.0.2.11", discovered=False, last_seen=self.old)
        cleanup_stale_ips()
        self.assertTrue(IPAddress.objects.filter(id=ip.id).exists())

    def test_keeps_recently_seen(self):
        ip = self._ip(
            "192.0.2.12", discovered=True, last_seen=timezone.now()
        )
        cleanup_stale_ips()
        self.assertTrue(IPAddress.objects.filter(id=ip.id).exists())

    def test_never_seen_uses_created_age(self):
        # discovered, never seen, but created long ago → eligible.
        ip = self._ip("192.0.2.13", discovered=True, last_seen=None)
        IPAddress.objects.filter(id=ip.id).update(created_at=self.old)
        res = cleanup_stale_ips()
        self.assertEqual(res["deleted"], 1)

    def test_opt_out_disables_cleanup(self):
        self.settings.cleanup_enabled = False
        self.settings.save()
        ip = self._ip("192.0.2.14", discovered=True, last_seen=self.old)
        res = cleanup_stale_ips()
        self.assertEqual(res["deleted"], 0)
        self.assertTrue(IPAddress.objects.filter(id=ip.id).exists())


class DiscoverNowEndpointTests(TestCase):
    """M19 — synchronous 'Scan now' endpoint returns a scan summary."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        ms = MonitoringSettings.for_tenant(self.tenant)
        ms.discovery_min_prefix_length = 24
        ms.save()
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="192.0.2.0/24", status=status_for(self.tenant)
        )
        self.user = get_user_model().objects.create_superuser("a", "a@b.c", "pw")
        self.client = APIClient()
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_scan_now_returns_summary_and_creates(self):
        from unittest.mock import patch

        def fake(addresses, count, timeout_ms):
            return [_host(a, a == "192.0.2.50") for a in addresses]

        with patch("monitoring.worker._multiping", side_effect=fake):
            r = self.client.post(
                f"/api/monitoring/prefixes/{self.prefix.id}/discover/"
            )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["created"], 1)
        self.assertEqual(body["responders"], 1)
        self.assertTrue(
            IPAddress.objects.filter(prefix=self.prefix, ip_address="192.0.2.50").exists()
        )

    def test_scan_now_reports_too_large(self):
        big = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        r = self.client.post(f"/api/monitoring/prefixes/{big.id}/discover/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json().get("skipped"), "too_large")


class SweepConcurrencyFdCapTests(SimpleTestCase):
    """The ICMP sweep concurrency must never exceed the process fd limit — else
    icmplib raises EMFILE per probe and floods syslog (the 400 GB disk incident)."""

    def test_full_concurrency_when_fds_plentiful(self):
        import resource
        from monitoring import worker

        with override_settings(MONITORING_SWEEP_CONCURRENCY=2000), patch.object(
            resource, "getrlimit", return_value=(524288, 524288)
        ):
            self.assertEqual(worker._sweep_concurrency(), 2000)

    def test_capped_below_low_fd_limit(self):
        import resource
        from monitoring import worker

        # The exact condition that caused the flood: 2000 requested, 1024 fds.
        with override_settings(MONITORING_SWEEP_CONCURRENCY=2000), patch.object(
            resource, "getrlimit", return_value=(1024, 1024)
        ):
            got = worker._sweep_concurrency()
        self.assertLess(got, 1024)        # must stay under the fd ceiling
        self.assertEqual(got, 1024 - 128)  # headroom for DB/Redis/file fds

    def test_never_below_one(self):
        import resource
        from monitoring import worker

        with override_settings(MONITORING_SWEEP_CONCURRENCY=2000), patch.object(
            resource, "getrlimit", return_value=(16, 16)
        ):
            self.assertGreaterEqual(worker._sweep_concurrency(), 1)
