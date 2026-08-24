"""Blank slugs are filled from the name (#104).

36 models carry a unique slug and accept a blank one over the API, but
nothing generated it - so the first row stored "" and the second collided
with the unique constraint and 409'd. Locations were the visible case: their
form has no slug field, so every second location failed.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Location, Site, VLANGroup

User = get_user_model()


class SlugAutofillTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")

    def _location(self, name):
        return self.client.post(
            "/api/locations/",
            {"name": name, "site_id": str(self.site.id)},
            format="json",
        )

    def test_several_locations_can_be_created_without_a_slug(self):
        for name in ("Data Center A", "Data Center B", "Data Center C"):
            r = self._location(name)
            self.assertEqual(r.status_code, 201, r.content)
        slugs = set(Location.objects.values_list("slug", flat=True))
        self.assertEqual(slugs, {"data-center-a", "data-center-b", "data-center-c"})

    def test_duplicate_names_get_distinct_slugs(self):
        self.assertEqual(self._location("Room 1").status_code, 201)
        r = self._location("Room 1")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["slug"], "room-1-2")

    def test_a_supplied_slug_is_kept(self):
        r = self.client.post(
            "/api/locations/",
            {"name": "Basement", "slug": "b1", "site_id": str(self.site.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["slug"], "b1")

    def test_editing_a_location_keeps_its_slug(self):
        created = self._location("Ground floor").json()
        r = self.client.patch(
            f"/api/locations/{created['id']}/",
            {"description": "renamed nothing"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["slug"], created["slug"])

    def test_same_name_in_another_site_may_share_the_slug(self):
        """Uniqueness is per (tenant, site), so the scope must be respected -
        a second site's "Room 1" keeps the clean slug."""
        other = Site.objects.create(tenant=self.tenant, name="RTM")
        self.assertEqual(self._location("Room 1").status_code, 201)
        r = self.client.post(
            "/api/locations/",
            {"name": "Room 1", "site_id": str(other.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["slug"], "room-1")

    def test_other_slug_models_fill_too(self):
        for name in ("Campus", "Lab"):
            r = self.client.post("/api/vlan-groups/", {"name": name}, format="json")
            self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            set(VLANGroup.objects.values_list("slug", flat=True)),
            {"campus", "lab"},
        )

    def test_catalogs_still_reject_a_duplicate_name(self):
        """Suffixing is opt-in: for a catalog the collision IS the answer -
        you already have one of these."""
        self.assertEqual(
            self.client.post(
                "/api/vlan-groups/", {"name": "Campus"}, format="json"
            ).status_code,
            201,
        )
        r = self.client.post(
            "/api/vlan-groups/", {"name": "Campus"}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)
