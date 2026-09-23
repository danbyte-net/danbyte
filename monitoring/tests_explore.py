"""The check page, explore and latency endpoints: figures from the rollups,
scoped like the checks list."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix, Site
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import figures, rollups
from .models import CheckKind, CheckRollupDaily, CheckRollupHourly, CheckState, CheckTemplate


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="Alpha")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Bravo")
        pa = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", site=self.site_a,
            status=status_for(self.tenant, "container"),
        )
        pb = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", site=self.site_b,
            status=status_for(self.tenant, "container"),
        )
        self.ip_a = IPAddress.objects.create(tenant=self.tenant, ip_address="10.1.0.1", prefix=pa)
        self.ip_b = IPAddress.objects.create(tenant=self.tenant, ip_address="10.2.0.1", prefix=pb)
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        self.web = CheckTemplate.objects.create(
            tenant=self.tenant, name="Web", slug="web", kind=CheckKind.HTTP
        )
        self.st_a = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.ping, kind="icmp", status="up"
        )
        self.st_b = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_b, template=self.ping, kind="icmp", status="down"
        )
        self.st_web = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.web, kind="http", status="up"
        )
        self.now = timezone.now()
        self.today = rollups._floor(self.now, rollups.DAY)
        self.hour = rollups._floor(self.now, rollups.HOUR)
        # Yesterday: A up all day at 2 ms, B down six hours, web 300 ms.
        self.day(self.ip_a, self.ping, up_s=86400, lat_p50=2, lat_p95=3, samples=100)
        self.day(self.ip_b, self.ping, up_s=64800, down_s=21600, incidents=2)
        self.day(self.ip_a, self.web, kind="http", up_s=86400, lat_p50=300, lat_p95=400,
                 samples=10)
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def day(self, ip, tmpl, kind="icmp", **kw):
        CheckRollupDaily.objects.create(
            tenant=self.tenant, target_ip=ip, template=tmpl, kind=kind,
            bucket=self.today - rollups.DAY, closed=True, **kw,
        )


class WindowTests(_Base):
    def test_days_window_is_closed_days_plus_todays_hours(self):
        win = figures.window(days=7, now=self.now)
        self.assertEqual(win.since, self.today - timedelta(days=6))
        self.assertEqual([m for m, _a, _b in win.parts], [CheckRollupDaily, CheckRollupHourly])

    def test_hours_window_reads_hours_only(self):
        win = figures.window(hours=12, now=self.now)
        self.assertEqual([m for m, _a, _b in win.parts], [CheckRollupHourly])
        self.assertFalse(win.daily)


class CheckDetailTests(_Base):
    def test_figures_series_and_baseline(self):
        CheckRollupHourly.objects.create(
            tenant=self.tenant, target_ip=self.ip_b, template=self.ping, kind="icmp",
            bucket=self.hour - rollups.HOUR, lat_p50=4.0, closed=True, up_s=3600,
        )
        r = self.client.get(f"/api/monitoring/checks/{self.st_b.id}/?days=7")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["target_ip"]["ip_address"], "10.2.0.1")
        self.assertEqual(body["figures"]["incidents"], 2)
        self.assertAlmostEqual(body["figures"]["availability"], 100 * 68400 / 90000, places=2)
        self.assertEqual(body["figures"]["mttr_s"], 10800)
        self.assertEqual(len(body["series"]), 2)  # yesterday and today
        self.assertEqual(body["baseline_ms"], 4.0)
        self.assertEqual(body["spike_threshold_ms"], 12.0)  # 3 x 4 beats 4 + 5

    def test_another_tenants_check_is_404(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        tmpl = CheckTemplate.objects.create(tenant=other, name="P", slug="p", kind="icmp")
        pfx = Prefix.objects.create(
            tenant=other, cidr="10.9.0.0/24", status=status_for(other, "container")
        )
        ip = IPAddress.objects.create(tenant=other, ip_address="10.9.0.1", prefix=pfx)
        st = CheckState.objects.create(tenant=other, target_ip=ip, template=tmpl, kind="icmp")
        self.assertEqual(self.client.get(f"/api/monitoring/checks/{st.id}/").status_code, 404)


class ChecksListFiguresTests(_Base):
    def test_with_figures_adds_window_numbers_per_row(self):
        r = self.client.get("/api/monitoring/checks/?with=figures&days=7&ordering=ip")
        self.assertEqual(r.status_code, 200, r.content)
        rows = {(x["target_ip"]["ip_address"], x["kind"]): x for x in r.json()["results"]}
        self.assertEqual(rows[("10.1.0.1", "icmp")]["figures"]["availability"], 100.0)
        self.assertEqual(rows[("10.2.0.1", "icmp")]["figures"]["incidents"], 2)
        self.assertEqual(rows[("10.1.0.1", "http")]["figures"]["p95"], 400.0)

    def test_without_it_the_list_is_unchanged(self):
        r = self.client.get("/api/monitoring/checks/")
        self.assertNotIn("figures", r.json()["results"][0])


class ExploreTests(_Base):
    def test_group_by_site_worst_first_with_latency_per_kind(self):
        r = self.client.get("/api/monitoring/explore/?group_by=site&days=7")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["rows"]
        self.assertEqual([x["name"] for x in rows], ["Bravo", "Alpha"])
        alpha = rows[1]
        self.assertEqual(alpha["checks"], 2)
        # A ping and a web check are never averaged together.
        self.assertEqual(
            [(k["kind"], k["p95"]) for k in alpha["latency"]], [("icmp", 3.0), ("http", 400.0)]
        )

    def test_filters_narrow_the_groups(self):
        r = self.client.get("/api/monitoring/explore/?group_by=kind&kind=http")
        self.assertEqual([x["key"] for x in r.json()["rows"]], ["http"])

    def test_unknown_dimension_is_400(self):
        self.assertEqual(self.client.get("/api/monitoring/explore/?group_by=x").status_code, 400)

    def test_no_ip_view_means_no_rows(self):
        user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="v", object_types=["vlan"], actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        r = self.client.get("/api/monitoring/explore/?group_by=site")
        self.assertEqual(r.json()["rows"], [])


class LatencyTests(_Base):
    def test_busiest_kind_and_offenders_against_baseline(self):
        # A's ping usually runs at 1 ms; this window's p95 is 3.
        CheckRollupHourly.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.ping, kind="icmp",
            bucket=self.hour - rollups.HOUR, lat_p50=1.0, closed=True,
        )
        r = self.client.get("/api/monitoring/latency/?days=7")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["kind"], "icmp")
        self.assertEqual([k["kind"] for k in body["kinds"]], ["icmp", "http"])
        self.assertEqual(body["slowest"][0]["target_ip"]["ip_address"], "10.1.0.1")
        self.assertEqual(body["slowest"][0]["ratio"], 3.0)

    def test_picking_a_kind(self):
        body = self.client.get("/api/monitoring/latency/?kind=http").json()
        self.assertEqual(body["kind"], "http")
        self.assertEqual(len(body["kinds"]), 2)
