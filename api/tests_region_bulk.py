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


class RegionBoundaryTests(APITestCase):
    """OSM boundary fields + the Nominatim lookup proxy."""

    POLY = {"type": "Polygon", "coordinates": [[[8.0, 55.0], [9.0, 55.0], [8.5, 56.0], [8.0, 55.0]]]}

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_boundary_round_trip(self):
        r = self.client.post(
            "/api/regions/",
            {"name": "Fyn", "slug": "fyn", "color": "#2563eb",
             "boundary": self.POLY, "boundary_label": "Fyn, Danmark"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["boundary"]["type"], "Polygon")
        self.assertEqual(body["boundary_label"], "Fyn, Danmark")
        self.assertEqual(body["color"], "#2563eb")

    def test_non_polygon_boundary_rejected(self):
        r = self.client.post(
            "/api/regions/",
            {"name": "X", "slug": "x",
             "boundary": {"type": "Point", "coordinates": [8.0, 55.0]}},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("boundary", r.json())

    def test_oversized_boundary_rejected(self):
        huge = {"type": "Polygon",
                "coordinates": [[[float(i), float(i)] for i in range(25000)]]}
        r = self.client.post(
            "/api/regions/",
            {"name": "X", "slug": "x", "boundary": huge},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("boundary", r.json())

    def test_lookup_requires_query(self):
        r = self.client.get("/api/regions/boundary-lookup/")
        self.assertEqual(r.status_code, 400)

    def test_lookup_filters_to_polygons(self):
        from unittest.mock import patch

        rows = [
            {"display_name": "Fyn, Danmark", "category": "place",
             "type": "island", "geojson": self.POLY},
            {"display_name": "Fyn (point)", "category": "place",
             "type": "locality",
             "geojson": {"type": "Point", "coordinates": [10.3, 55.3]}},
        ]
        fake = type("R", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: rows,
        })()
        with patch("core.ssrf.safe_get", return_value=fake) as mock_get:
            r = self.client.get("/api/regions/boundary-lookup/?q=Fyn")
        self.assertEqual(r.status_code, 200, r.content)
        results = r.json()["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["label"], "Fyn, Danmark")
        self.assertEqual(results[0]["boundary"]["type"], "Polygon")
        # Policy: identifying UA on the one outbound request.
        _, kwargs = mock_get.call_args
        self.assertIn("Danbyte/", kwargs["headers"]["User-Agent"])

    def test_lookup_upstream_failure_is_502(self):
        from unittest.mock import patch

        with patch("core.ssrf.safe_get", side_effect=OSError("boom")):
            r = self.client.get("/api/regions/boundary-lookup/?q=Fyn")
        self.assertEqual(r.status_code, 502)
