from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Region

User = get_user_model()


class RegionBulkUpdateTests(APITestCase):
    """POST /api/regions/bulk-update/ - bulk parent assignment."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        mk = lambda n: Region.objects.create(  # noqa: E731
            tenant=self.tenant, name=n, slug=n.lower()
        )
        self.dk = mk("Denmark")
        self.fyn = mk("Fyn")
        self.jylland = mk("Jylland")

    def _bulk(self, ids, parent_id):
        return self.client.post(
            "/api/regions/bulk-update/",
            {"ids": ids, "fields": {"parent_id": parent_id}},
            format="json",
        )

    def test_assigns_parent_to_many(self):
        r = self._bulk([str(self.fyn.id), str(self.jylland.id)], str(self.dk.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.fyn.refresh_from_db()
        self.jylland.refresh_from_db()
        self.assertEqual(self.fyn.parent_id, self.dk.id)
        self.assertEqual(self.jylland.parent_id, self.dk.id)

    def test_clears_parent_with_null(self):
        self.fyn.parent = self.dk
        self.fyn.save(update_fields=["parent"])
        r = self._bulk([str(self.fyn.id)], None)
        self.assertEqual(r.status_code, 200, r.content)
        self.fyn.refresh_from_db()
        self.assertIsNone(self.fyn.parent_id)

    def test_parent_among_selection_is_rejected(self):
        r = self._bulk([str(self.dk.id), str(self.fyn.id)], str(self.dk.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("parent_id", r.json())

    def test_cycle_through_descendant_is_rejected(self):
        # Fyn under Denmark; selecting Denmark with parent=Fyn would loop.
        self.fyn.parent = self.dk
        self.fyn.save(update_fields=["parent"])
        r = self._bulk([str(self.dk.id)], str(self.fyn.id))
        self.assertEqual(r.status_code, 400)

    def test_foreign_tenant_rows_fall_out(self):
        other_t = Tenant.objects.create(org=self.org, name="B", slug="b")
        foreign = Region.objects.create(tenant=other_t, name="X", slug="x")
        r = self._bulk([str(foreign.id), str(self.fyn.id)], str(self.dk.id))
        self.assertEqual(r.json()["updated"], 1)
        foreign.refresh_from_db()
        self.assertIsNone(foreign.parent_id)
