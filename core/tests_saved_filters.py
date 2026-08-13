"""Saved filters: yours are yours, shared ones stop at the tenant boundary."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, SavedFilter, Tenant


class SavedFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Rival", slug="rival")
        self.alice = self._user("alice", self.tenant)
        self.bob = self._user("bob", self.tenant)
        self.mallory = self._user("mallory", self.other)

    def _user(self, name, tenant):
        user = User.objects.create_user(name, f"{name}@x.com", "pw")
        profile, _ = UserProfile.objects.get_or_create(user=user)
        profile.tenants.add(tenant)
        return user

    def _as(self, user, tenant=None):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str((tenant or self.tenant).id)
        session.save()

    def _create(self, **over):
        body = {
            "object_type": "device",
            "name": "Aarhus switches",
            "query": {"q": "sw", "facets": {"site": ["abc"]}},
        }
        body.update(over)
        return self.client.post("/api/saved-filters/", body, format="json")

    def test_saving_and_listing_your_own(self):
        self._as(self.alice)
        response = self._create()
        self.assertEqual(response.status_code, 201, response.content)
        self.assertTrue(response.json()["mine"])

        listing = self.client.get("/api/saved-filters/?object_type=device")
        self.assertEqual(
            [f["name"] for f in listing.json()["results"]], ["Aarhus switches"]
        )

    def test_another_list_does_not_show_it(self):
        self._as(self.alice)
        self._create()
        listing = self.client.get("/api/saved-filters/?object_type=prefix")
        self.assertEqual(listing.json()["results"], [])

    def test_private_by_default_and_shared_when_asked(self):
        self._as(self.alice)
        private = self._create(name="Mine only")
        self.assertFalse(private.json()["shared"])

        self._as(self.bob)
        self.assertEqual(self.client.get("/api/saved-filters/").json()["results"], [])

        self._as(self.alice)
        self._create(name="Everyone", shared=True)
        self._as(self.bob)
        rows = self.client.get("/api/saved-filters/").json()["results"]
        self.assertEqual([f["name"] for f in rows], ["Everyone"])
        # Someone else's shared view is readable, but not theirs to change.
        self.assertFalse(rows[0]["mine"])
        self.assertEqual(rows[0]["owner"], "alice")

    def test_a_shared_view_cannot_be_redefined_by_its_readers(self):
        self._as(self.alice)
        created = self._create(shared=True).json()
        self._as(self.bob)
        response = self.client.patch(
            f"/api/saved-filters/{created['id']}/",
            {"query": {"q": "hijacked"}},
            format="json",
        )
        self.assertEqual(response.status_code, 403, response.content)
        self.assertEqual(
            SavedFilter.objects.get(pk=created["id"]).query["q"], "sw"
        )

    def test_a_reader_cannot_delete_someone_elses_view(self):
        self._as(self.alice)
        created = self._create(shared=True).json()
        self._as(self.bob)
        self.assertEqual(
            self.client.delete(f"/api/saved-filters/{created['id']}/").status_code, 403
        )
        self.assertTrue(SavedFilter.objects.filter(pk=created["id"]).exists())

    def test_shared_does_not_cross_the_tenant_boundary(self):
        self._as(self.alice)
        self._create(shared=True)
        self._as(self.mallory, self.other)
        self.assertEqual(self.client.get("/api/saved-filters/").json()["results"], [])

    def test_the_owner_can_edit_and_delete(self):
        self._as(self.alice)
        created = self._create().json()
        patched = self.client.patch(
            f"/api/saved-filters/{created['id']}/",
            {"name": "Renamed", "shared": True},
            format="json",
        )
        self.assertEqual(patched.status_code, 200, patched.content)
        self.assertEqual(patched.json()["name"], "Renamed")
        self.assertEqual(
            self.client.delete(f"/api/saved-filters/{created['id']}/").status_code, 204
        )

    def test_ownership_cannot_be_handed_over_by_patching(self):
        self._as(self.alice)
        created = self._create().json()
        self.client.patch(
            f"/api/saved-filters/{created['id']}/",
            {"created_by": self.bob.id, "tenant": str(self.other.id)},
            format="json",
        )
        row = SavedFilter.objects.get(pk=created["id"])
        self.assertEqual(row.created_by_id, self.alice.id)
        self.assertEqual(row.tenant_id, self.tenant.id)

    def test_a_name_is_required(self):
        self._as(self.alice)
        self.assertEqual(self._create(name="   ").status_code, 400)
