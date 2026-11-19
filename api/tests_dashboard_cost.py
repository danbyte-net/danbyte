"""The home dashboard (/api/dashboard/) answers in a fixed number of queries,
whatever the estate holds, and never reads the raw check results: a week of
those is millions of rows, and the page took ten seconds and more."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.test_utils import status_for
from core.models import Organization, Tenant
from monitoring.models import (
    Alert,
    CheckResult,
    CheckRollupHourly,
    CheckState,
    CheckTemplate,
    StateTransition,
)
from monitoring.rollups import HOUR, _floor

from .models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site

User = get_user_model()

#: What the whole request may cost a superuser, sign-in and tenant lookups
#: included. Today it is 44; the ceiling leaves room for a new widget, not
#: for a query per row.
CEILING = 50


class DashboardCostTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dtype = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, name="X")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Core", slug="core")
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind="icmp")
        self.http = CheckTemplate.objects.create(
            tenant=self.tenant, name="Web", slug="web", kind="http")
        self.n = 0
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def grow(self, k: int) -> None:
        """``k`` more of everything the dashboard reads: prefixes with
        addresses, devices, checks with a day of rollups, transitions,
        alerts and raw results."""
        now = timezone.now()
        top = _floor(now, HOUR)
        for _ in range(k):
            i = self.n
            self.n += 1
            p = Prefix.objects.create(
                tenant=self.tenant, cidr=f"10.{i}.0.0/24", site=self.site,
                status=status_for(self.tenant, "container"))
            dev = Device.objects.create(
                tenant=self.tenant, name=f"sw{i}", site=self.site, device_type=self.dtype,
                role=self.role, status=status_for(self.tenant))
            for h in (1, 2):
                ip = IPAddress.objects.create(
                    tenant=self.tenant, ip_address=f"10.{i}.0.{h}", prefix=p,
                    assigned_device=dev)
                for t in (self.ping, self.http):
                    CheckState.objects.create(
                        tenant=self.tenant, target_ip=ip, template=t, kind=t.kind,
                        status="down" if h == 2 else "up",
                        flapping_since=now if h == 2 else None, flap_count=3)
                    for ago in range(24):
                        CheckRollupHourly.objects.create(
                            tenant=self.tenant, target_ip=ip, template=t, kind=t.kind,
                            bucket=top - ago * HOUR, up_s=3000, down_s=600, samples=60,
                            lat_p50=4.0, lat_p95=9.0)
                    StateTransition.objects.create(
                        tenant=self.tenant, target_ip=ip, template=t, kind=t.kind,
                        from_status="up", to_status="down", at=now - timedelta(hours=2))
                    CheckResult.objects.create(
                        tenant=self.tenant, target_ip=ip, template=t, kind=t.kind,
                        status="up", latency_ms=4.0, timestamp=now - timedelta(minutes=5))
                Alert.objects.create(
                    tenant=self.tenant, target_ip=ip, template=self.ping, kind="icmp",
                    dedup_key=f"k{i}-{h}", severity="critical", status="firing",
                    check_status="down", opened_at=now - timedelta(days=1))

    def get(self, url="/api/dashboard/"):
        # The first request pays one-off lookups (settings rows); count the second.
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return ctx.captured_queries, r.json()

    def test_the_cost_does_not_grow_with_the_estate(self):
        self.grow(2)
        small, body = self.get()
        self.grow(6)
        big, body_big = self.get()
        self.assertEqual(len(small), len(big), "more rows must not cost more queries")
        self.assertLessEqual(len(big), CEILING)
        # And the payload is the estate's, not empty.
        self.assertEqual(body_big["counts"]["devices"], 8)
        self.assertEqual(len(body_big["recent_prefixes"]), 8)
        self.assertEqual(body_big["recent_prefixes"][0]["ip_count"], 2)
        self.assertEqual(len(body_big["flapping"]), 8)
        self.assertEqual(
            {k["kind"] for k in body_big["latency_by_kind"]}, {"icmp", "http"})
        self.assertEqual(body_big["latency_by_kind"][0]["series"][0]["p50"], 4.0)
        self.assertAlmostEqual(body_big["availability_7d"], 83.33, places=2)

    def test_the_raw_results_are_never_read(self):
        self.grow(2)
        queries, _body = self.get()
        self.assertFalse(
            [q["sql"] for q in queries if "monitoring_checkresult" in q["sql"]])

    def test_only_the_included_keys_are_computed(self):
        self.grow(2)
        every, _ = self.get()
        some, body = self.get("/api/dashboard/?include=recent_ips,latency_by_kind")
        self.assertLess(len(some), len(every))
        self.assertEqual(len(body["recent_ips"]), 4)
        self.assertTrue(body["latency_by_kind"])
        # The rest keep their shape, empty.
        self.assertEqual(body["ip_by_status"], [])
        self.assertEqual(body["flapping"], [])
        self.assertIsNone(body["availability_7d"])
        # The stat band's figures always come.
        self.assertEqual(body["counts"]["ips"], 4)
        self.assertTrue(body["check_by_status"])
        none, body = self.get("/api/dashboard/?include=")
        self.assertFalse([q for q in none if "checkrolluphourly" in q["sql"]])
        self.assertEqual(body["latency_by_kind"], [])

    def test_an_unknown_key_is_a_400(self):
        r = self.client.get("/api/dashboard/?include=recent_ips,nope")
        self.assertEqual(r.status_code, 400)
        self.assertIn("nope", str(r.json()["include"]))


class DashboardSummaryTests(APITestCase):
    """The busiest prefixes are counted from the addresses' side, and the
    tenant-wide IPAM figures are kept a few minutes per tenant and per
    reader's scope, started over by any prefix or address write (#535)."""

    URL = "/api/dashboard/?include=top_prefixes,ip_by_scope"

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        for i, n in enumerate([5, 3, 3, 3, 3, 3, 3, 3, 3, 1, 0]):
            p = Prefix.objects.create(
                tenant=self.tenant, cidr=f"10.{20 - i}.0.0/24",
                site=self.site_a if i % 2 else self.site_b)
            for h in range(n):
                IPAddress.objects.create(
                    tenant=self.tenant, ip_address=f"10.{20 - i}.0.{h + 1}", prefix=p,
                    site=p.site)
        theirs = Prefix.objects.create(tenant=self.other, cidr="10.99.0.0/24")
        for h in range(9):
            IPAddress.objects.create(tenant=self.other, ip_address=f"10.99.0.{h + 1}",
                                     prefix=theirs)
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _body(self):
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_top_prefixes_match_the_joined_count(self):
        from django.db.models import Count

        want = [
            {"cidr": p.cidr, "ip_count": p.ipc}
            for p in Prefix.objects.filter(tenant=self.tenant)
            .annotate(ipc=Count("ip_addresses")).order_by("-ipc", "cidr")[:8] if p.ipc
        ]
        got = [{"cidr": r["cidr"], "ip_count": r["ip_count"]}
               for r in self._body()["top_prefixes"]]
        self.assertEqual(got, want)
        self.assertEqual(got[0], {"cidr": "10.20.0.0/24", "ip_count": 5})

    def test_figures_are_kept_and_start_over_on_a_write(self):
        first = self._body()
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(self._body()["top_prefixes"], first["top_prefixes"])
        self.assertFalse([q for q in ctx.captured_queries
                          if 'GROUP BY "api_ipaddress"."prefix_id"' in q["sql"]])
        p = Prefix.objects.get(tenant=self.tenant, cidr="10.11.0.0/24")
        for h in range(7):
            IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.11.0.{h + 10}", prefix=p)
        top = self._body()["top_prefixes"][0]
        self.assertEqual((top["cidr"], top["ip_count"]), ("10.11.0.0/24", 8))

    def test_a_site_reader_never_gets_the_tenant_figures(self):
        from auth_api.api import assemble_site_role
        from auth_api.models import UserProfile

        admin_view = self._body()
        user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[user.id])
        self._login(user)
        mine = self._body()
        self.assertNotEqual(mine["top_prefixes"], admin_view["top_prefixes"])
        cidrs = {r["cidr"] for r in mine["top_prefixes"]}
        site_a = set(Prefix.objects.filter(site=self.site_a).values_list("cidr", flat=True))
        self.assertTrue(cidrs)
        self.assertLessEqual(cidrs, site_a)
        total = sum(r["count"] for r in mine["ip_by_scope"])
        self.assertEqual(total, IPAddress.objects.filter(site=self.site_a).count())
