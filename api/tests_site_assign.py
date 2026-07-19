"""Prefix↔Location↔Site wiring: location sets site, prefix auto-assigns IP site."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import (
    Device,
    DeviceType,
    IPAddress,
    Location,
    Manufacturer,
    Prefix,
    Site,
    Status,
    VLAN,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


from api.test_utils import status_for


class SiteAssignmentTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="DC-AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Rack row A", slug="row-a"
        )
        self.status = Status.objects.create(
            tenant=self.tenant, name="Active", slug="active"
        )

    def _prefix(self, **kw):
        opts = dict(tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant))
        opts.update(kw)
        return Prefix.objects.create(**opts)

    def _ip(self, prefix, addr="10.0.0.5", **kw):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address=addr,
            status=self.status, **kw
        )

    def test_location_sets_prefix_site(self):
        p = self._prefix(location=self.loc)
        p.refresh_from_db()
        self.assertEqual(p.site_id, self.site.id)  # inherited from location

    def test_auto_assign_site_fills_ip_site(self):
        p = self._prefix(site=self.site, auto_assign_site=True)
        ip = self._ip(p)
        self.assertEqual(ip.site_id, self.site.id)

    def test_no_auto_assign_leaves_ip_site_null(self):
        p = self._prefix(site=self.site, auto_assign_site=False)
        ip = self._ip(p)
        self.assertIsNone(ip.site_id)

    def test_explicit_ip_site_not_overwritten(self):
        other = Site.objects.create(tenant=self.tenant, name="DC-LON")
        p = self._prefix(site=self.site, auto_assign_site=True)
        ip = self._ip(p, site=other)
        self.assertEqual(ip.site_id, other.id)  # explicit wins

    def test_auto_assign_without_site_is_noop(self):
        p = self._prefix(auto_assign_site=True)  # no site on prefix
        ip = self._ip(p)
        self.assertIsNone(ip.site_id)


class BulkSiteFenceTests(APITestCase):
    """Bulk endpoints must respect site scope: bulk-update can't move rows to
    a foreign site (post-write re-check, rolled back), bulk-delete demands the
    `delete` action, and interface bulk-create can't target a foreign-site
    device."""

    def setUp(self):
        org = Organization.objects.create(name="OB", slug="ob")
        self.tenant = Tenant.objects.create(org=org, name="TB", slug="tb")
        self.a = Site.objects.create(tenant=self.tenant, name="A")
        self.b = Site.objects.create(tenant=self.tenant, name="B")
        self.st = status_for(self.tenant)
        self.p_a = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", site=self.a, status=self.st
        )
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.dev_b = Device.objects.create(
            tenant=self.tenant, name="devb", device_type=self.dt, site=self.b
        )
        self.user = User.objects.create_user("bulk", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        # Site-A editor WITHOUT the delete action.
        self.grant = ObjectPermission.objects.create(
            name="site-a-editor",
            object_types=["prefix", "vlan", "interface", "device"],
            actions=["view", "add", "change"],
        )
        self.grant.users.add(self.user)
        self.grant.sites.set([self.a])
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_bulk_update_cannot_move_prefix_to_foreign_site(self):
        res = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": [str(self.p_a.id)], "fields": {"site_id": str(self.b.id)}},
            format="json",
        )
        self.assertEqual(res.status_code, 403)
        self.p_a.refresh_from_db()
        self.assertEqual(self.p_a.site_id, self.a.id)  # rolled back

    def test_bulk_update_within_scope_ok(self):
        res = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": [str(self.p_a.id)], "fields": {"description": "x"}},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.p_a.refresh_from_db()
        self.assertEqual(self.p_a.description, "x")

    def test_vlan_bulk_update_cannot_move_to_foreign_site(self):
        v = VLAN.objects.create(tenant=self.tenant, vlan_id=5, name="v", site=self.a)
        res = self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(v.id)], "fields": {"site_id": str(self.b.id)}},
            format="json",
        )
        self.assertEqual(res.status_code, 403)
        v.refresh_from_db()
        self.assertEqual(v.site_id, self.a.id)

    def test_bulk_delete_requires_delete_action(self):
        res = self.client.post(
            "/api/prefixes/bulk-delete/", {"ids": [str(self.p_a.id)]}, format="json"
        )
        self.assertEqual(res.status_code, 403)  # change grant is not enough
        self.assertTrue(Prefix.objects.filter(pk=self.p_a.pk).exists())

    def test_bulk_delete_with_grant_skips_foreign_rows(self):
        self.grant.actions = ["view", "add", "change", "delete"]
        self.grant.save()
        p_b = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", site=self.b, status=self.st
        )
        res = self.client.post(
            "/api/prefixes/bulk-delete/",
            {"ids": [str(self.p_a.id), str(p_b.id)]},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertFalse(Prefix.objects.filter(pk=self.p_a.pk).exists())
        self.assertTrue(Prefix.objects.filter(pk=p_b.pk).exists())  # out of scope

    def test_interface_bulk_create_foreign_site_device_403(self):
        res = self.client.post(
            "/api/interfaces/bulk-create/",
            {"device_id": str(self.dev_b.id), "names": ["eth0"]},
            format="json",
        )
        self.assertEqual(res.status_code, 403)
        self.assertEqual(self.dev_b.interfaces.count(), 0)

    def test_interface_bulk_create_own_site_ok(self):
        dev_a = Device.objects.create(
            tenant=self.tenant, name="deva", device_type=self.dt, site=self.a
        )
        res = self.client.post(
            "/api/interfaces/bulk-create/",
            {"device_id": str(dev_a.id), "names": ["eth0"]},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(dev_a.interfaces.count(), 1)


class SeparationWriteFenceTests(APITestCase):
    """Behavior that only exists when `enhanced_site_separation` is ON:
    FK pickers reject foreign-site targets at validation (400), a single-site
    user's create defaults its site, and an IP under a non-auto-assign prefix
    inherits the stamped site instead of 403ing."""

    def setUp(self):
        from core.models import DeploymentSettings

        org = Organization.objects.create(name="OSF", slug="osf")
        self.tenant = Tenant.objects.create(org=org, name="TSF", slug="tsf")
        self.a = Site.objects.create(tenant=self.tenant, name="A")
        self.b = Site.objects.create(tenant=self.tenant, name="B")
        self.st = status_for(self.tenant)
        self.p_a = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", site=self.a,
            status=self.st, auto_assign_site=False,
        )
        self.p_b = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", site=self.b, status=self.st
        )
        self.user = User.objects.create_user("sep", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="site-a", object_types=["prefix", "ipaddress", "device", "vlan"],
            actions=["view", "add", "change", "delete"],
        )
        grant.users.add(self.user)
        grant.sites.set([self.a])
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _mk_ip(self, prefix, addr):
        return self.client.post(
            "/api/ips/",
            {"ip_address": addr, "prefix_id": str(prefix.id),
             "status_id": str(self.st.id)},
            format="json",
        )

    def test_foreign_site_fk_fails_validation(self):
        # The prefix picker no longer offers site B's prefixes → 400, not 403.
        res = self._mk_ip(self.p_b, "10.2.0.5")
        self.assertEqual(res.status_code, 400)

    def test_ip_under_non_auto_assign_prefix_gets_creators_site(self):
        # Flag OFF this 403s (IP lands site=NULL); flag ON the create defaults
        # the single-site user's site.
        res = self._mk_ip(self.p_a, "10.1.0.5")
        self.assertIn(res.status_code, (200, 201), res.content)
        ip = IPAddress.objects.get(ip_address="10.1.0.5")
        self.assertEqual(ip.site_id, self.a.id)

    def test_vlan_create_defaults_site(self):
        res = self.client.post(
            "/api/vlans/", {"vlan_id": 42, "name": "v42"}, format="json"
        )
        self.assertIn(res.status_code, (200, 201), res.content)
        v = VLAN.objects.get(name="v42")
        self.assertEqual(v.site_id, self.a.id)

    def test_flag_off_is_unchanged(self):
        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = False
        dep.save()
        # No defaulting: the site-less VLAN create now lands NULL → the write
        # guard denies it for a site-scoped user (pre-flag behavior).
        res = self.client.post(
            "/api/vlans/", {"vlan_id": 43, "name": "v43"}, format="json"
        )
        self.assertEqual(res.status_code, 403)
        self.assertFalse(VLAN.objects.filter(name="v43").exists())
