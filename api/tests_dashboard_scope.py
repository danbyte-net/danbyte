"""Dashboard "Public vs private IPs" widget - address-scope classification
and the aggregated distribution on /api/dashboard/. The buckets are derived
from the address alone (no seed data, no config), so this pins the RFC ranges
we sort into Public / Private / CGNAT / Special."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.dashboard_views import _classify_ip_scope
from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

User = get_user_model()


class ClassifyIpScopeTests(APITestCase):
    def test_buckets(self):
        cases = {
            # Private - RFC 1918 (v4) + ULA fc00::/7 (v6)
            "192.168.1.10": "Private",
            "10.5.5.5": "Private",
            "172.16.9.9": "Private",
            "fc00::1": "Private",
            # CGNAT - RFC 6598
            "100.64.0.1": "CGNAT",
            "100.127.255.254": "CGNAT",
            # Special - loopback / link-local / unspecified / multicast
            "127.0.0.1": "Special",
            "169.254.1.1": "Special",
            "::1": "Special",
            "fe80::1": "Special",
            "224.0.0.1": "Special",
            # Public - globally routable
            "8.8.8.8": "Public",
            "1.1.1.1": "Public",
            "2606:4700:4700::1111": "Public",
        }
        for addr, want in cases.items():
            self.assertEqual(_classify_ip_scope(addr), want, addr)

    def test_unparseable_is_none(self):
        self.assertIsNone(_classify_ip_scope("not-an-ip"))
        self.assertIsNone(_classify_ip_scope(""))


class DashboardScopeWidgetTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/8")
        for addr in (
            "192.168.1.10",  # Private
            "10.5.5.5",  # Private
            "fc00::1",  # Private
            "8.8.8.8",  # Public
            "2606:4700:4700::1111",  # Public
            "100.64.0.1",  # CGNAT
            "169.254.1.1",  # Special
        ):
            IPAddress.objects.create(
                tenant=self.tenant, prefix=self.prefix, ip_address=addr
            )
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_ip_by_scope_distribution(self):
        resp = self.client.get("/api/dashboard/")
        self.assertEqual(resp.status_code, 200)
        by_name = {r["name"]: r["count"] for r in resp.json()["ip_by_scope"]}
        self.assertEqual(by_name, {"Public": 2, "Private": 3, "CGNAT": 1, "Special": 1})

    def test_scope_rows_carry_a_colour(self):
        resp = self.client.get("/api/dashboard/")
        for row in resp.json()["ip_by_scope"]:
            self.assertTrue(row["color"])

    def test_empty_bucket_is_omitted(self):
        # Only Public IPs → the other three buckets don't appear at all.
        IPAddress.objects.filter(tenant=self.tenant).delete()
        IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="9.9.9.9"
        )
        resp = self.client.get("/api/dashboard/")
        rows = resp.json()["ip_by_scope"]
        self.assertEqual([r["name"] for r in rows], ["Public"])


class ScopeAggregateTests(APITestCase):
    """The dashboard's scope distribution is a grouped count in the database
    and agrees with the Python classifier for every bucket (#201)."""

    def test_sql_buckets_match_the_classifier(self):
        from api.dashboard_views import _ip_by_scope

        org = Organization.objects.create(name="Acme", slug="acme")
        tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        v4 = Prefix.objects.create(tenant=tenant, cidr="0.0.0.0/0")
        v6 = Prefix.objects.create(tenant=tenant, cidr="::/0")
        addrs = [
            "192.168.1.10", "10.5.5.5", "172.16.9.9", "fc00::1", "192.0.2.7",
            "100.64.0.1", "100.127.255.254",
            "127.0.0.1", "169.254.1.1", "::1", "fe80::1", "224.0.0.1", "240.0.0.9",
            "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111",
        ]
        for a in addrs:
            IPAddress.objects.create(tenant=tenant, ip_address=a, prefix=v6 if ":" in a else v4)
        want = {"Public": 0, "Private": 0, "CGNAT": 0, "Special": 0}
        for a in addrs:
            want[_classify_ip_scope(a)] += 1
        got = {row["name"]: row["count"] for row in _ip_by_scope(IPAddress.objects.filter(tenant=tenant))}
        self.assertEqual(got, want)


class DashboardScopeParamTests(APITestCase):
    """A named dashboard's scope narrows the payload; the new-user default
    layout survives the trip."""

    def setUp(self):
        from django.contrib.auth.models import User

        from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site
        from api.test_utils import status_for
        from core.models import Organization, Tenant

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.a = Site.objects.create(tenant=self.tenant, name="A")
        b = Site.objects.create(tenant=self.tenant, name="B")
        for n, site in (("a1", self.a), ("a2", self.a), ("b1", b)):
            Device.objects.create(tenant=self.tenant, name=n, site=site, device_type=dt,
                                  role=role, status=status_for(self.tenant))
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_site_scope_narrows_devices(self):
        body = self.client.get(f"/api/dashboard/?site={self.a.id}&frame=30d").json()
        self.assertEqual(body["counts"]["devices"], 2)
        self.assertEqual(body["scope"], {"site": [str(self.a.id)]})
        self.assertEqual(body["frame_hours"], 720)
        self.assertEqual(self.client.get("/api/dashboard/").json()["counts"]["devices"], 3)

    def test_v2_default_layout_is_returned_whole(self):
        from core.models import TenantSettings

        layout = {"v": 2, "items": [{"id": "alerts-per-day", "x": 0, "y": 0, "w": 2, "h": 2}]}
        TenantSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"default_dashboard_widgets": layout}
        )
        self.assertEqual(self.client.get("/api/dashboard/").json()["default_widgets"], layout)
