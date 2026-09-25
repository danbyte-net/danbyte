"""Bulk marker colour and icon for sites, regions and locations (#183)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import Location, Region, Site

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.a = Site.objects.create(tenant=self.tenant, name="A")
        self.b = Site.objects.create(tenant=self.tenant, name="B")
        self.login(User.objects.create_superuser("admin", "a@example.com", "x"))

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def bulk(self, path, ids, fields):
        return self.client.post(f"/api/{path}/bulk-update/", {
            "ids": [str(i) for i in ids], "fields": fields}, format="json")


class SiteTests(_Base):
    def test_colour_and_icon(self):
        r = self.bulk("sites", [self.a.id, self.b.id], {"color": "#10B981", "icon": "factory"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(Site.objects.values_list("color", "icon")),
                         {("#10b981", "factory")})

    def test_bad_values_are_refused(self):
        self.assertEqual(self.bulk("sites", [self.a.id], {"color": "red"}).status_code, 400)
        self.assertEqual(self.bulk("sites", [self.a.id], {"icon": "<svg>"}).status_code, 400)
        # Clearing is allowed.
        self.assertEqual(self.bulk("sites", [self.a.id], {"color": ""}).status_code, 200)


class RegionTests(_Base):
    def test_colour_alone_and_with_a_parent(self):
        top = Region.objects.create(tenant=self.tenant, name="EU", slug="eu")
        r1 = Region.objects.create(tenant=self.tenant, name="DK", slug="dk")
        r2 = Region.objects.create(tenant=self.tenant, name="SE", slug="se")
        self.assertEqual(self.bulk("regions", [r1.id, r2.id], {"color": "#3b82f6"}).status_code,
                         200)
        self.assertEqual(set(Region.objects.filter(pk__in=[r1.id, r2.id])
                             .values_list("color", flat=True)), {"#3b82f6"})
        r = self.bulk("regions", [r1.id], {"parent_id": str(top.id), "color": "#ef4444"})
        self.assertEqual(r.status_code, 200, r.content)
        r1.refresh_from_db()
        self.assertEqual((r1.parent_id, r1.color), (top.id, "#ef4444"))
        self.assertEqual(self.bulk("regions", [r1.id], {"name": "x"}).status_code, 400)


class LocationTests(_Base):
    def test_colour_and_icon(self):
        la = Location.objects.create(tenant=self.tenant, site=self.a, name="Floor 1")
        lb = Location.objects.create(tenant=self.tenant, site=self.b, name="Floor 1")
        r = self.bulk("locations", [la.id, lb.id], {"color": "#a855f7", "icon": "layers"})
        self.assertEqual(r.json()["updated"], 2)
        self.assertEqual(set(Location.objects.values_list("color", "icon")),
                         {("#a855f7", "layers")})
        self.assertEqual(self.bulk("locations", [la.id], {"name": "x"}).status_code, 400)

    def test_a_site_scoped_user_only_touches_their_site(self):
        la = Location.objects.create(tenant=self.tenant, site=self.a, name="Floor 1")
        lb = Location.objects.create(tenant=self.tenant, site=self.b, name="Floor 1")
        user = User.objects.create_user("local", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="loc", object_types=["location"], actions=["view", "change"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.a)
        self.login(user)
        r = self.bulk("locations", [la.id, lb.id], {"color": "#a855f7"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 1)
        lb.refresh_from_db()
        self.assertEqual(lb.color, "")
