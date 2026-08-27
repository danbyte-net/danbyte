"""Importing a region boundary from a GeoJSON / QGIS export (#80).

The parsing is the easy half. What matters here is that a real GIS export -
megabytes of vertices, sometimes in a projected coordinate system - either
fits the stored budget or is refused with something an operator can act on.
"""
from __future__ import annotations

import json
import math

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .geojson_import import MAX_BYTES, GeoJSONError, boundary_from_geojson
from .models import Region

User = get_user_model()


def square(x: float, y: float = 56.0, d: float = 0.1) -> list:
    return [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]]


def dense_ring(n: int = 20000) -> list:
    """A circle with `n` vertices - what a traced municipality looks like."""
    ring = [
        [10 + math.cos(i / n * 2 * math.pi) * 0.5,
         56 + math.sin(i / n * 2 * math.pi) * 0.5]
        for i in range(n)
    ]
    ring.append(ring[0])
    return ring


class GeoJSONParsingTests(APITestCase):
    def test_a_plain_polygon_passes_through(self):
        geom, report = boundary_from_geojson(
            json.dumps({"type": "Polygon", "coordinates": square(10)})
        )
        self.assertEqual(geom["type"], "Polygon")
        self.assertEqual(report["tolerance"], 0.0)

    def test_a_dense_export_is_simplified_to_fit(self):
        doc = {"type": "Feature", "properties": {},
               "geometry": {"type": "Polygon", "coordinates": [dense_ring()]}}
        raw = json.dumps(doc)
        self.assertGreater(len(raw), MAX_BYTES)  # the file really is too big
        geom, report = boundary_from_geojson(raw)
        self.assertLessEqual(report["bytes"], MAX_BYTES)
        self.assertLess(report["vertices_after"], report["vertices_before"])
        self.assertGreater(report["tolerance"], 0)
        # Still an area, and still closed.
        ring = geom["coordinates"][0]
        self.assertGreaterEqual(len(ring), 4)
        self.assertEqual(ring[0], ring[-1])

    def test_several_features_become_one_multipolygon(self):
        # An archipelago is one region in several parts - keeping only the
        # first would quietly drop the rest.
        doc = {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature",
                 "geometry": {"type": "Polygon", "coordinates": square(10)}},
                {"type": "Feature",
                 "geometry": {"type": "Polygon", "coordinates": square(11)}},
            ],
        }
        geom, report = boundary_from_geojson(json.dumps(doc))
        self.assertEqual(geom["type"], "MultiPolygon")
        self.assertEqual(len(geom["coordinates"]), 2)
        self.assertEqual(report["features"], 2)

    def test_projected_coordinates_are_refused_not_drawn(self):
        # UTM metres read as degrees land in the Gulf of Guinea.
        doc = {"type": "Polygon", "coordinates": [
            [[500000, 6200000], [500100, 6200000],
             [500100, 6200100], [500000, 6200000]]]}
        with self.assertRaises(GeoJSONError) as caught:
            boundary_from_geojson(json.dumps(doc))
        self.assertIn("EPSG:4326", str(caught.exception))

    def test_a_declared_non_wgs84_crs_is_refused(self):
        doc = {
            "type": "FeatureCollection",
            "crs": {"type": "name",
                    "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}},
            "features": [{"type": "Feature",
                          "geometry": {"type": "Polygon",
                                       "coordinates": square(10)}}],
        }
        with self.assertRaises(GeoJSONError) as caught:
            boundary_from_geojson(json.dumps(doc))
        self.assertIn("25832", str(caught.exception))

    def test_a_wgs84_crs_member_is_accepted(self):
        doc = {
            "type": "FeatureCollection",
            "crs": {"type": "name",
                    "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
            "features": [{"type": "Feature",
                          "geometry": {"type": "Polygon",
                                       "coordinates": square(10)}}],
        }
        geom, _ = boundary_from_geojson(json.dumps(doc))
        self.assertEqual(geom["type"], "Polygon")

    def test_points_and_lines_are_refused(self):
        for doc in (
            {"type": "Point", "coordinates": [10, 56]},
            {"type": "LineString", "coordinates": [[10, 56], [11, 56]]},
        ):
            with self.assertRaises(GeoJSONError):
                boundary_from_geojson(json.dumps(doc))

    def test_a_binary_file_says_what_to_do(self):
        with self.assertRaises(GeoJSONError) as caught:
            boundary_from_geojson(b"PK\x03\x04\xff\xfe binary shapefile zip")
        self.assertIn("GeoJSON", str(caught.exception))

    def test_broken_json_is_reported_as_such(self):
        with self.assertRaises(GeoJSONError):
            boundary_from_geojson('{"type": "Polygon", ')

    def test_a_collapsed_ring_is_dropped_not_stored(self):
        # Three coincident points aren't an area at any tolerance.
        doc = {"type": "Polygon",
               "coordinates": [[[10, 56], [10, 56], [10, 56]]]}
        with self.assertRaises(GeoJSONError):
            boundary_from_geojson(json.dumps(doc))


class ParseBoundaryEndpointTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
    def _url(self):
        return "/api/regions/parse-boundary/"

    def test_uploading_a_file_returns_a_storable_boundary(self):
        doc = json.dumps({"type": "Polygon", "coordinates": square(10)})
        upload = SimpleUploadedFile(
            "fyn.geojson", doc.encode(), content_type="application/geo+json"
        )
        r = self.client.post(self._url(), {"file": upload}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["boundary"]["type"], "Polygon")
        # Provenance: where the shape came from, same slot OSM lookups fill.
        self.assertEqual(body["boundary_label"], "fyn.geojson")

    def test_the_parsed_boundary_saves_onto_a_region(self):
        # The form holds it and saves with everything else, so the serializer
        # has to accept exactly what the parser returns.
        region = Region.objects.create(
            tenant=self.tenant, name="Fyn", slug="fyn"
        )
        parsed = self.client.post(
            self._url(),
            {"geojson": json.dumps(
                {"type": "Feature", "properties": {},
                 "geometry": {"type": "Polygon", "coordinates": [dense_ring()]}}
            )},
            format="json",
        ).json()
        r = self.client.patch(
            f"/api/regions/{region.id}/",
            {"boundary": parsed["boundary"],
             "boundary_label": parsed["boundary_label"]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        region.refresh_from_db()
        self.assertEqual(region.boundary["type"], "Polygon")

    def test_pasted_text_works_too(self):
        r = self.client.post(
            self._url(),
            {"geojson": json.dumps({"type": "Polygon",
                                    "coordinates": square(10)})},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["report"]["features"], 1)

    def test_a_bad_file_is_a_field_error(self):
        upload = SimpleUploadedFile(
            "nope.geojson", b'{"type":"Point","coordinates":[1,2]}',
            content_type="application/geo+json",
        )
        r = self.client.post(self._url(), {"file": upload}, format="multipart")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("file", r.json())

    def test_nothing_attached_is_asked_for(self):
        r = self.client.post(self._url(), {}, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_it_is_not_open_to_anonymous_callers(self):
        # It parses only, but every endpoint here is default-closed.
        self.client.logout()
        r = self.client.post(
            self._url(),
            {"geojson": json.dumps({"type": "Polygon",
                                    "coordinates": square(10)})},
            format="json",
        )
        self.assertIn(r.status_code, (401, 403), r.content)
