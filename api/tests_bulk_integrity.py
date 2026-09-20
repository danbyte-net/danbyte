"""The bespoke bulk endpoints keep the invariants the single-object paths
keep: a deleted prefix's addresses move up (#207), a VRF move re-homes the
children (#208), an unknown field is refused (#209), and a VLAN id stays in
1-4094 wherever it is written (#206)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import VLAN, VRF, IPAddress, IPRange, Prefix, Site

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class PrefixBulkDeleteTests(_Base):
    def test_addresses_move_to_the_containing_prefix(self):
        parent = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16")
        child = Prefix.objects.create(tenant=self.tenant, cidr="10.0.1.0/24")
        for h in range(1, 6):
            IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.0.1.{h}", prefix=child, dns_name=f"h{h}"
            )
        r = self.client.post("/api/prefixes/bulk-delete/", {"ids": [str(child.id)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["moved"], 5)
        self.assertEqual(r.json()["removed"], 0)
        self.assertEqual(IPAddress.objects.filter(prefix=parent).count(), 5)
        self.assertEqual(IPAddress.objects.get(ip_address="10.0.1.3").dns_name, "h3")


class PrefixBulkUpdateTests(_Base):
    def test_vrf_move_rehomes_children(self):
        a = VRF.objects.create(tenant=self.tenant, name="A")
        b = VRF.objects.create(tenant=self.tenant, name="B")
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.8.0.0/24", vrf=a)
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.8.0.5", prefix=p)
        rng = IPRange.objects.create(
            tenant=self.tenant, prefix=p, start_address="10.8.0.10", end_address="10.8.0.20"
        )
        self.assertEqual(ip.vrf_id, a.id)
        r = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": [str(p.id)], "fields": {"vrf_id": str(b.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        ip.refresh_from_db()
        rng.refresh_from_db()
        self.assertEqual(ip.vrf_id, b.id)
        self.assertEqual(rng.vrf_id, b.id)

    def test_unknown_field_is_refused(self):
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24", description="original")
        r = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": [str(p.id)], "fields": {"totally_made_up_field": "x"}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("totally_made_up_field", str(r.json()))
        p.refresh_from_db()
        self.assertEqual(p.description, "original")
        for url in ("/api/ips/bulk-update/", "/api/sites/bulk-update/", "/api/vlans/bulk-update/"):
            r = self.client.post(url, {"ids": [str(p.id)], "fields": {"nope": 1}}, format="json")
            self.assertEqual(r.status_code, 400, url)


class VlanIdRangeTests(_Base):
    def test_out_of_range_ids_are_refused(self):
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        for vid in (99999, -5, 0, 4095):
            r = self.client.post(
                "/api/vlans/", {"name": "bad", "vlan_id": vid, "site_id": str(site.id)}, format="json"
            )
            self.assertEqual(r.status_code, 400, (vid, r.content))
            self.assertIn("vlan_id", r.json())
        r = self.client.post(
            "/api/vlans/", {"name": "ok", "vlan_id": 4094, "site_id": str(site.id)}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(VLAN.objects.get(name="ok").vlan_id, 4094)
