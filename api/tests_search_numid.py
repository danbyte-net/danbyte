"""An all-digit query matches numid - the short id printed on labels finds
its object, including cables (which have no name to search by)."""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Cable, Device


class NumidSearchTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = User.objects.create_superuser("nsr", "n@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _hit_ids(self, group, q):
        r = self.client.get(f"/api/search/?q={q}")
        self.assertEqual(r.status_code, 200, r.content)
        return [h["id"] for h in r.json()["groups"][group]]

    def test_device_found_by_short_id(self):
        dev = Device.objects.create(tenant=self.tenant, name="edge-fw")
        dev.refresh_from_db()
        self.assertIsNotNone(dev.numid)
        self.assertIn(str(dev.id), self._hit_ids("devices", dev.numid))

    def test_cable_found_by_short_id(self):
        cable = Cable.objects.create(tenant=self.tenant)
        cable.refresh_from_db()
        self.assertIsNotNone(cable.numid)
        self.assertIn(str(cable.id), self._hit_ids("cables", cable.numid))

    def test_digits_in_names_still_match(self):
        dev = Device.objects.create(tenant=self.tenant, name="rack42-sw")
        self.assertIn(str(dev.id), self._hit_ids("devices", "42"))


class ContainedInFilterTests(APITestCase):
    """?contained_in=<cidr> narrows the prefix list to networks inside it -
    the aggregate page's Prefixes tab (#133)."""

    def setUp(self):
        org = Organization.objects.create(name="O2", slug="o2")
        self.tenant = Tenant.objects.create(org=org, name="T2", slug="t2")
        admin = User.objects.create_superuser("cif", "c@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_only_contained_prefixes_return(self):
        from .models import Prefix

        inside = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/16")
        deeper = Prefix.objects.create(tenant=self.tenant, cidr="10.1.2.0/24")
        outside = Prefix.objects.create(tenant=self.tenant, cidr="192.168.0.0/24")
        r = self.client.get("/api/prefixes/?contained_in=10.0.0.0/8")
        ids = [p["id"] for p in r.json()["results"]]
        self.assertIn(str(inside.id), ids)
        self.assertIn(str(deeper.id), ids)
        self.assertNotIn(str(outside.id), ids)

    def test_bad_cidr_returns_nothing(self):
        from .models import Prefix

        Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/16")
        r = self.client.get("/api/prefixes/?contained_in=not-a-net")
        self.assertEqual(r.json()["results"], [])


class IpSearchRankingTests(APITestCase):
    """Searching the IP list puts the closest address first: exact, then
    prefix, then substring - .13 above .130-.139."""

    def test_exact_and_prefix_rank_first(self):
        from api.models import IPAddress, Prefix

        org = Organization.objects.create(name="O3", slug="o3")
        tenant = Tenant.objects.create(org=org, name="T3", slug="t3")
        admin = User.objects.create_superuser("ipr", "i@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        pfx = Prefix.objects.create(tenant=tenant, cidr="10.196.192.0/24")
        for host in (137, 131, 13, 136, 139, 132):
            IPAddress.objects.create(
                tenant=tenant, prefix=pfx, ip_address=f"10.196.192.{host}"
            )
        r = self.client.get("/api/ips/?search=10.196.192.13")
        addrs = [row["ip_address"] for row in r.json()["results"]]
        self.assertEqual(addrs[0], "10.196.192.13")  # exact first
        # prefix matches follow in numeric order
        self.assertEqual(
            addrs[1:],
            ["10.196.192.131", "10.196.192.132", "10.196.192.136",
             "10.196.192.137", "10.196.192.139"],
        )
