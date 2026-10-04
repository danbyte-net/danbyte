"""VLANs carry a status (#172): set on create, filtered, bulk-edited within
the tenant, counted as the status's usage, and seeded into the catalog."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import VLAN, Site, Status
from .status_registry import seed_builtin_statuses
from .test_utils import status_for

User = get_user_model()


class VlanStatusTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.active = status_for(self.tenant, "active")
        self.deprecated = status_for(self.tenant, "deprecated")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def vlan(self, vid, status=None):
        return VLAN.objects.create(tenant=self.tenant, vlan_id=vid, name=f"v{vid}",
                                   site=self.site, status=status)

    def test_create_with_a_status_and_read_it_back(self):
        r = self.client.post("/api/vlans/", {
            "vlan_id": 10, "name": "Users", "site_id": str(self.site.id),
            "status_id": str(self.active.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["status"]["slug"], "active")

    def test_filter_by_status(self):
        self.vlan(10, self.active)
        self.vlan(20, self.deprecated)
        self.vlan(30)
        rows = self.client.get(f"/api/vlans/?status={self.deprecated.id}").json()["results"]
        self.assertEqual([r["vlan_id"] for r in rows], [20])

    def test_bulk_edit_sets_the_status_and_refuses_another_tenants(self):
        a, b = self.vlan(10), self.vlan(20)
        r = self.client.post("/api/vlans/bulk-update/", {
            "ids": [str(a.id), str(b.id)], "fields": {"status_id": str(self.deprecated.id)}},
            format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(VLAN.objects.values_list("status__slug", flat=True)),
                         {"deprecated"})
        other = Tenant.objects.create(org=self.tenant.org, name="Other", slug="other")
        foreign = status_for(other, "active")
        r = self.client.post("/api/vlans/bulk-update/", {
            "ids": [str(a.id)], "fields": {"status_id": str(foreign.id)}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_status_counts_its_vlans(self):
        self.vlan(10, self.deprecated)
        rows = self.client.get("/api/statuses/").json()["results"]
        row = next(s for s in rows if s["id"] == str(self.deprecated.id))
        self.assertEqual(row["usage_count"], 1)


class VlanStatusSeedTests(APITestCase):
    def test_the_catalog_offers_vlan_statuses_with_active_the_default(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        seed_builtin_statuses(tenant)
        scoped = set(Status.objects.filter(
            tenant=tenant, available_to__contains=["vlan"]).values_list("slug", flat=True))
        self.assertEqual(scoped, {"active", "reserved", "deprecated"})
        self.assertEqual(
            list(Status.objects.filter(tenant=tenant, default_for__contains=["vlan"])
                 .values_list("slug", flat=True)), ["active"])
