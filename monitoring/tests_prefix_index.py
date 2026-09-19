"""Enclosing prefixes per address come from a tenant index built once, not a
scan of every prefix row per address (#198)."""
from __future__ import annotations

from django.test import TestCase

from api.models import VRF, IPAddress, Prefix
from core.models import Organization, Tenant

from .resolver import PrefixIndex, _enclosing_prefixes


class PrefixIndexTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.red = VRF.objects.create(tenant=self.tenant, name="red")
        self.p8 = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/8")
        self.p16 = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/16")
        self.p24 = Prefix.objects.create(tenant=self.tenant, cidr="10.1.2.0/24")
        self.red16 = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/16", vrf=self.red)
        Prefix.objects.create(tenant=self.tenant, cidr="2001:db8::/32")
        self.ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.1.2.5", prefix=self.p24)
        self.red_ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.1.9.9", prefix=self.red16)

    def test_most_specific_first_within_the_vrf(self):
        index = PrefixIndex(self.tenant.id)
        with self.assertNumQueries(0):
            self.assertEqual(index.enclosing(self.ip), [self.p24, self.p16, self.p8])
            self.assertEqual(index.enclosing(self.red_ip), [self.red16])
        self.assertEqual(_enclosing_prefixes(self.ip), [self.p24, self.p16, self.p8])

    def test_a_masked_or_bad_address_is_tolerated(self):
        index = PrefixIndex(self.tenant.id)
        self.ip.ip_address = "10.1.2.5/24"
        self.assertEqual(index.enclosing(self.ip), [self.p24, self.p16, self.p8])
        self.ip.ip_address = "garbage"
        self.assertEqual(index.enclosing(self.ip), [])
