"""The site gateway policy skips containers and prefixes with auto_gateway off."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import IPAddress, IPRole, Prefix, Site
from api.test_utils import status_for
from core.models import Organization, Tenant


class PrefixAutoGatewayTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(
            tenant=self.tenant, name="S1", gateway_policy="first"
        )
        self.gw_role = IPRole.objects.create(
            tenant=self.tenant, name="Gateway", slug="gateway", is_gateway=True
        )
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _create(self, cidr, **extra):
        body = {"cidr": cidr, "site_id": str(self.site.id), **extra}
        r = self.client.post("/api/prefixes/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json(), Prefix.objects.get(pk=r.json()["id"])

    def test_default_on_keeps_the_policy(self):
        data, p = self._create("10.0.0.0/24")
        self.assertTrue(data["auto_gateway"])
        self.assertTrue(p.auto_gateway)
        self.assertEqual(p.gateway, "10.0.0.1")
        self.assertTrue(
            IPAddress.objects.filter(
                prefix=p, ip_address="10.0.0.1", role=self.gw_role
            ).exists()
        )

    def test_off_creates_nothing(self):
        data, p = self._create("10.0.1.0/31", auto_gateway=False)
        self.assertFalse(data["auto_gateway"])
        self.assertFalse(p.auto_gateway)
        self.assertIsNone(p.gateway)
        self.assertFalse(IPAddress.objects.filter(prefix=p).exists())

    def test_container_is_skipped(self):
        container = status_for(self.tenant, "container")
        _, p = self._create("10.1.0.0/16", status_id=str(container.id))
        self.assertIsNone(p.gateway)
        self.assertFalse(IPAddress.objects.filter(ip_address="10.1.0.1").exists())

    def test_turning_it_off_keeps_the_gateway(self):
        _, p = self._create("10.0.2.0/24")
        r = self.client.patch(
            f"/api/prefixes/{p.id}/", {"auto_gateway": False}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["auto_gateway"])
        p.refresh_from_db()
        self.assertEqual(p.gateway, "10.0.2.1")
        self.assertTrue(
            IPAddress.objects.filter(prefix=p, ip_address="10.0.2.1").exists()
        )

    def test_bulk_update_sets_the_flag(self):
        _, p = self._create("10.0.3.0/24")
        r = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": [str(p.id)], "fields": {"auto_gateway": False}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        p.refresh_from_db()
        self.assertFalse(p.auto_gateway)
        r = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": [str(p.id)], "fields": {"auto_gateway": "nope"}},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
