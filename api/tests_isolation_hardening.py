"""Tenant-isolation hardening regressions (issue #59).

Two gaps that survived the base TenantScopedViewSet:
1. bulk-update paths wrote FK ids (IP status/role, VLAN site) with no
   tenant-ownership check → cross-tenant assignment.
2. standalone @api_view reads (dashboard, search, topology, macs, compliance
   evaluate, VM render) skipped per-object-type RBAC → a member walled off from
   a type still saw its data/counts.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    ExportTemplate,
    IPAddress,
    IPRole,
    MACAddress,
    Prefix,
    Site,
    VLAN,
    VirtualMachine,
)
from api.test_utils import status_for
from auth_api.models import UserProfile
from core.models import Organization, Tenant


class _TenantClientMixin:
    def _user(self, name, tenant, group=None, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(tenant)
        if group:
            u.groups.add(Group.objects.get(name=group))
        return u

    def _client(self, user, tenant):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()


class BulkFkIsolationTests(_TenantClientMixin, APITestCase):
    """bulk-update must reject FK ids that belong to another tenant (#59)."""

    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.a = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.b = Tenant.objects.create(org=org, name="Beta", slug="beta")
        self.status_a = status_for(self.a)
        self.status_b = status_for(self.b)
        self.role_b = IPRole.objects.create(tenant=self.b, name="r", slug="r")
        self.site_a = Site.objects.create(tenant=self.a, name="sa")
        self.site_b = Site.objects.create(tenant=self.b, name="sb")
        self.prefix_a = Prefix.objects.create(
            tenant=self.a, cidr="10.0.0.0/24", status=self.status_a
        )
        self.ip_a = IPAddress.objects.create(
            tenant=self.a, ip_address="10.0.0.5", prefix=self.prefix_a
        )
        self.vlan_a = VLAN.objects.create(tenant=self.a, vlan_id=10, name="v")
        self._client(self._user("admin", self.a, superuser=True), self.a)

    def test_ip_bulk_rejects_foreign_status(self):
        r = self.client.post(
            "/api/ips/bulk-update/",
            {"ids": [str(self.ip_a.id)], "fields": {"status_id": str(self.status_b.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.ip_a.refresh_from_db()
        self.assertNotEqual(self.ip_a.status_id, self.status_b.id)

    def test_ip_bulk_rejects_foreign_role(self):
        r = self.client.post(
            "/api/ips/bulk-update/",
            {"ids": [str(self.ip_a.id)], "fields": {"role_id": str(self.role_b.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_ip_bulk_allows_same_tenant_status(self):
        r = self.client.post(
            "/api/ips/bulk-update/",
            {"ids": [str(self.ip_a.id)], "fields": {"status_id": str(self.status_a.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_vlan_bulk_rejects_foreign_site(self):
        r = self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(self.vlan_a.id)], "fields": {"site_id": str(self.site_b.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.vlan_a.refresh_from_db()
        self.assertNotEqual(self.vlan_a.site_id, self.site_b.id)

    def test_vlan_bulk_allows_same_tenant_site(self):
        r = self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(self.vlan_a.id)], "fields": {"site_id": str(self.site_a.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)


class StandaloneReadRbacTests(_TenantClientMixin, APITestCase):
    """The standalone @api_view reads now enforce per-object-type view (#59):
    a walled-off member (no grants) is blocked / sees nothing; a Read-only
    member (wildcard view) is unaffected."""

    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        Device.objects.create(tenant=self.t, name="d1")
        MACAddress.objects.create(tenant=self.t, mac_address="aa:bb:cc:dd:ee:ff")
        Prefix.objects.create(
            tenant=self.t, cidr="10.9.0.0/24", status=status_for(self.t)
        )
        Site.objects.create(tenant=self.t, name="s1")
        ct = ClusterType.objects.create(tenant=self.t, name="ct", slug="ct")
        cl = Cluster.objects.create(tenant=self.t, name="cl", type=ct)
        self.vm = VirtualMachine.objects.create(
            tenant=self.t, name="vm1", cluster=cl
        )
        self.et = ExportTemplate.objects.create(
            tenant=self.t, name="tf", object_type="virtualmachine",
            template_code="name = {{ vm.name }}",
        )
        self.walled = self._user("walled", self.t)               # no group → no grants
        self.reader = self._user("reader", self.t, group="Read-only")

    # ── walled-off member: blocked / empty ──────────────────────────────────
    def test_walled_blocked_on_reads(self):
        self._client(self.walled, self.t)
        self.assertEqual(self.client.get("/api/topology/").status_code, 403)
        self.assertEqual(self.client.get("/api/macs/").status_code, 403)
        self.assertEqual(self.client.get("/api/compliance/evaluate/").status_code, 403)
        # Row-scoped: the VM render fetches through restrict_queryset, so a
        # walled member (no virtualmachine.view) gets 404 (non-leaking) rather
        # than 403 — it must not confirm the VM exists.
        self.assertEqual(
            self.client.get(
                f"/api/virtual-machines/{self.vm.id}/render/?template={self.et.id}"
            ).status_code,
            404,
        )

    def test_walled_dashboard_counts_zero(self):
        self._client(self.walled, self.t)
        counts = self.client.get("/api/dashboard/").json()["counts"]
        for k in ("devices", "prefixes", "sites", "vlans"):
            self.assertEqual(counts.get(k), 0, f"{k} leaked to walled user")

    def test_walled_search_object_groups_empty(self):
        self._client(self.walled, self.t)
        groups = self.client.get("/api/search/?q=10.9").json()["groups"]
        self.assertEqual(groups["prefixes"], [])

    # ── Read-only member (wildcard view): unaffected ─────────────────────────
    def test_reader_sees_reads(self):
        self._client(self.reader, self.t)
        self.assertEqual(self.client.get("/api/topology/").status_code, 200)
        macs = self.client.get("/api/macs/")
        self.assertEqual(macs.status_code, 200)
        self.assertGreaterEqual(macs.json()["count"], 1)
        self.assertEqual(self.client.get("/api/compliance/evaluate/").status_code, 200)
        self.assertNotEqual(
            self.client.get(
                f"/api/virtual-machines/{self.vm.id}/render/?template={self.et.id}"
            ).status_code,
            403,
        )

    def test_reader_dashboard_and_search_populated(self):
        self._client(self.reader, self.t)
        counts = self.client.get("/api/dashboard/").json()["counts"]
        self.assertGreaterEqual(counts["devices"], 1)
        self.assertGreaterEqual(counts["prefixes"], 1)
        groups = self.client.get("/api/search/?q=10.9").json()["groups"]
        self.assertGreaterEqual(len(groups["prefixes"]), 1)


class TagWriteRBACTests(_TenantClientMixin, APITestCase):
    """/api/tags/ writes are RBAC-gated server-side (they used to be checked
    in the SPA only — any authenticated user could create/edit/delete tags)."""

    def setUp(self):
        org = Organization.objects.create(name="OT", slug="ot")
        self.tenant = Tenant.objects.create(org=org, name="TT", slug="tt")
        self.plain = self._user("plain", self.tenant)
        self.tagger = self._user("tagger", self.tenant)
        from auth_api.models import ObjectPermission

        p = ObjectPermission.objects.create(
            name="tags", object_types=["tag"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.tagger)

    def test_ungranted_user_cannot_write_tags(self):
        self._client(self.plain, self.tenant)
        res = self.client.post("/api/tags/", {"name": "prod"}, format="json")
        self.assertEqual(res.status_code, 403)

    def test_granted_user_can_write_tags(self):
        self._client(self.tagger, self.tenant)
        res = self.client.post("/api/tags/", {"name": "prod"}, format="json")
        self.assertIn(res.status_code, (200, 201))
        tag_id = res.json()["id"]
        res = self.client.delete(f"/api/tags/{tag_id}/")
        self.assertEqual(res.status_code, 204)


class TenantWriteRBACTests(_TenantClientMixin, APITestCase):
    """Tenant writes require a `tenant` grant — a plain member must not be
    able to DELETE their tenant (single or bulk) or create new ones. Reads and
    the switch/active actions stay open to every member."""

    def setUp(self):
        org = Organization.objects.create(name="OW", slug="ow")
        self.tenant = Tenant.objects.create(org=org, name="TW", slug="tw")
        self.plain = self._user("member", self.tenant)
        self.admin = self._user("tadmin", self.tenant)
        from auth_api.models import ObjectPermission

        p = ObjectPermission.objects.create(
            name="tenant-admin", object_types=["tenant"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.admin)

    def test_member_cannot_delete_tenant(self):
        self._client(self.plain, self.tenant)
        res = self.client.delete(f"/api/tenants/{self.tenant.id}/")
        self.assertEqual(res.status_code, 403)
        res = self.client.post(
            "/api/tenants/bulk-delete/", {"ids": [str(self.tenant.id)]}, format="json"
        )
        self.assertEqual(res.status_code, 403)
        self.assertTrue(Tenant.objects.filter(pk=self.tenant.pk).exists())

    def test_member_cannot_create_tenant(self):
        self._client(self.plain, self.tenant)
        res = self.client.post(
            "/api/tenants/", {"name": "Rogue", "slug": "rogue"}, format="json"
        )
        self.assertEqual(res.status_code, 403)

    def test_member_can_still_list_and_switch(self):
        self._client(self.plain, self.tenant)
        self.assertEqual(self.client.get("/api/tenants/").status_code, 200)
        res = self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        self.assertEqual(res.status_code, 200)

    def test_granted_user_can_delete_tenant(self):
        other = Tenant.objects.create(
            org=self.tenant.org, name="Gone", slug="gone"
        )
        prof = UserProfile.objects.get(user=self.admin)
        prof.tenants.add(other)
        self._client(self.admin, self.tenant)
        res = self.client.delete(f"/api/tenants/{other.id}/")
        self.assertEqual(res.status_code, 204)


class DashboardMonitoringRbacTests(_TenantClientMixin, APITestCase):
    """The dashboard's monitoring roll-ups (checks, alerts, recent activity)
    follow the member's view grants — a walled-off member must not see the
    tenant's check counts or a status-change feed carrying IP addresses."""

    def setUp(self):
        org = Organization.objects.create(name="OD", slug="od")
        self.t = Tenant.objects.create(org=org, name="TD", slug="td")
        self.walled = self._user("walled2", self.t)          # no grants
        self.reader = self._user("reader2", self.t, group="Read-only")

    def test_walled_member_gets_empty_monitoring(self):
        self._client(self.walled, self.t)
        d = self.client.get("/api/dashboard/").json()
        self.assertEqual(d["check_by_status"], [])
        self.assertEqual(d["alerts_by_severity"], [])
        self.assertIsNone(d["reachable_pct"])
        self.assertEqual(d["recent_activity"], [])

    def test_reader_still_gets_monitoring(self):
        self._client(self.reader, self.t)
        d = self.client.get("/api/dashboard/").json()
        # Empty tenant → empty lists, but the sections aren't suppressed
        # (shape identical to before for granted readers).
        self.assertIn("check_by_status", d)
        self.assertIn("recent_activity", d)


class VlanBulkZoneTests(_TenantClientMixin, APITestCase):
    """VLAN bulk-update accepts zone_id — tenant-checked like site_id."""

    def setUp(self):
        from api.models import VLAN, Zone

        org = Organization.objects.create(name="OZ", slug="oz")
        self.t = Tenant.objects.create(org=org, name="TZ", slug="tz")
        self.other = Tenant.objects.create(org=org, name="UZ", slug="uz")
        self.zone = Zone.objects.create(tenant=self.t, name="dmz", slug="dmz")
        self.foreign = Zone.objects.create(
            tenant=self.other, name="evil", slug="evil"
        )
        self.v = VLAN.objects.create(tenant=self.t, vlan_id=10, name="v10")
        self.u = self._user("zadmin", self.t, group="Administrator")

    def test_bulk_set_zone(self):
        self._client(self.u, self.t)
        res = self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(self.v.id)], "fields": {"zone_id": str(self.zone.id)}},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.v.refresh_from_db()
        self.assertEqual(self.v.zone_id, self.zone.id)

    def test_foreign_tenant_zone_rejected(self):
        self._client(self.u, self.t)
        res = self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(self.v.id)],
             "fields": {"zone_id": str(self.foreign.id)}},
            format="json",
        )
        self.assertEqual(res.status_code, 400)
