"""An address carries its own mask length when the interface uses one that
differs from the containing prefix - a /31 link inside an aggregate. The
API accepts ``address/length`` and ``cidr`` is always the effective form."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import IPAddress, Prefix

User = get_user_model()


class IpMaskLengthTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.links = Prefix.objects.create(tenant=self.tenant, cidr="10.50.10.0/24")
        self.v6 = Prefix.objects.create(tenant=self.tenant, cidr="2001:db8::/48")

    def _post(self, **body):
        body.setdefault("prefix_id", str(self.links.id))
        return self.client.post("/api/ips/", body, format="json")

    def test_length_in_the_address_is_stored(self):
        r = self._post(ip_address="10.50.10.1/31")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["ip_address"], "10.50.10.1")
        self.assertEqual(r.json()["mask_length"], 31)
        self.assertEqual(r.json()["cidr"], "10.50.10.1/31")
        ip = IPAddress.objects.get(ip_address="10.50.10.1")
        self.assertEqual(ip.mask_length, 31)
        self.assertEqual(ip.cidr, "10.50.10.1/31")

    def test_without_a_mask_the_prefix_length_applies(self):
        r = self._post(ip_address="10.50.10.9")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["mask_length"])
        self.assertEqual(r.json()["cidr"], "10.50.10.9/24")

    def test_explicit_field_wins_over_the_address_suffix(self):
        r = self._post(ip_address="10.50.10.3/31", mask_length=30)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["mask_length"], 30)

    def test_the_prefix_length_in_the_address_is_not_stored(self):
        r = self._post(ip_address="10.50.10.4/24")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["mask_length"])
        self.assertEqual(r.json()["cidr"], "10.50.10.4/24")

    def test_an_explicit_field_equal_to_the_prefix_is_kept(self):
        r = self._post(ip_address="10.50.10.6/24", mask_length=24)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["mask_length"], 24)

    def test_the_api_and_save_agree(self):
        """address/length leaves the same mask_length through the API as
        through IPAddress.save(), on create and on an update."""
        cases = (
            # created with, changed to, mask_length after each
            (31, 30, 31, 30),
            (31, 24, 31, None),
            (24, 31, None, 31),
            (None, 24, None, None),
        )
        for n, (first, then, created, updated) in enumerate(cases):
            with self.subTest(first=first, then=then):
                api_host, orm_host = f"10.50.10.{20 + n}", f"10.50.10.{120 + n}"

                def written(host, length):
                    return f"{host}/{length}" if length else host

                r = self._post(ip_address=written(api_host, first))
                self.assertEqual(r.status_code, 201, r.content)
                self.assertEqual(r.json()["mask_length"], created)
                r = self.client.patch(
                    f"/api/ips/{r.json()['id']}/",
                    {"ip_address": written(api_host, then)},
                    format="json",
                )
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()["mask_length"], updated)

                ip = IPAddress.objects.create(
                    tenant=self.tenant, prefix=self.links,
                    ip_address=written(orm_host, first),
                )
                ip.refresh_from_db()
                self.assertEqual(ip.mask_length, created)
                ip.ip_address = written(orm_host, then)
                ip.save()
                ip.refresh_from_db()
                self.assertEqual(ip.mask_length, updated)

    def test_family_bounds(self):
        r = self._post(ip_address="10.50.10.5/33")
        self.assertEqual(r.status_code, 400)
        self.assertIn("mask_length", r.json())
        r = self._post(ip_address="2001:db8::1/64", prefix_id=str(self.v6.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["cidr"], "2001:db8::1/64")

    def test_clearing_returns_to_the_prefix_length(self):
        r = self._post(ip_address="10.50.10.7/31")
        r = self.client.patch(
            f"/api/ips/{r.json()['id']}/", {"mask_length": None}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cidr"], "10.50.10.7/24")
