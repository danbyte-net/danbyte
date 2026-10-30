"""Building outlines on the Site map: polygon rules, colour and label
resolution, tenant and site scope, hidden locations, and the drill-down."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import is_registered
from auth_api.site_paths import SITE_PATHS, site_role_catalog_types, site_role_types
from core.models import Organization, Tenant

from .models import (
    Device,
    FloorPlan,
    FloorPlanStack,
    Location,
    LocationType,
    Rack,
    Room,
    Site,
    SiteMapOutline,
)

SQUARE = [[56.0, 10.0], [56.0, 10.001], [56.001, 10.001], [56.001, 10.0]]


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Depot")
        self.building = LocationType.objects.create(
            tenant=self.tenant, name="Building", slug="building", color="#2563eb"
        )
        self.bldg = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Building A", slug="building-a",
            code="A1", location_type=self.building, color="#f97316",
        )
        self.floor = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Floor 2", slug="floor-2",
            parent=self.bldg,
        )
        self.other = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Building B", slug="building-b"
        )
        self.depot_loc = Location.objects.create(
            tenant=self.tenant, site=self.site_b, name="Shed", slug="shed"
        )
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.their_site = Site.objects.create(tenant=self.tenant2, name="Theirs")
        self.their_loc = Location.objects.create(
            tenant=self.tenant2, site=self.their_site, name="Theirs", slug="theirs"
        )
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _user(self, name, grants):
        """A tenant member holding ``(types, actions, sites, constraints)``."""
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        for i, (types, actions, sites, constraints) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"{name}-{i}", object_types=types, actions=actions,
                constraints=constraints,
            )
            perm.tenants.add(self.tenant)
            if sites:
                perm.sites.set(sites)
            perm.users.add(u)
        return u

    def _post(self, **body):
        body.setdefault("site_id", str(self.site.id))
        body.setdefault("points", SQUARE)
        return self.client.post("/api/site-map-outlines/", body, format="json")


class PolygonTests(_Base):
    def test_create_rounds_and_drops_closing_point(self):
        pts = [[56.00000049, 10.0], [56.0, 10.001], [56.001, 10.001], [56.001, 10.0],
               [56.00000049, 10.0]]
        r = self._post(points=pts, location_id=str(self.bldg.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["points"], [[56.0, 10.0], *SQUARE[1:]])

    def test_too_few_and_too_many_points(self):
        self.assertEqual(self._post(points=SQUARE[:2]).status_code, 400)
        ring = [[56 + i * 1e-5, 10 + (i % 2) * 1e-5] for i in range(501)]
        r = self._post(points=ring)
        self.assertEqual(r.status_code, 400)
        self.assertIn("points", r.json())

    def test_self_intersecting_is_refused(self):
        bow = [[56.0, 10.0], [56.001, 10.001], [56.0, 10.001], [56.001, 10.0]]
        r = self._post(points=bow)
        self.assertEqual(r.status_code, 400)
        self.assertIn("crosses itself", str(r.json()["points"]))

    def test_bad_points(self):
        for pts in ("nope", [[1, 2], [3]], [[100, 0], [0, 1], [1, 1]],
                    [[1, 1], [1, 1], [2, 2]], [[0, 0], [0, 1], [0, 2]]):
            r = self._post(points=pts)
            self.assertEqual(r.status_code, 400, (pts, r.content))

    def test_reshape_by_patch(self):
        o = self._post().json()
        pts = [*SQUARE, [56.0005, 9.9995]]
        r = self.client.patch(f"/api/site-map-outlines/{o['id']}/", {"points": pts},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["points"]), 5)

    def test_bad_colour(self):
        self.assertEqual(self._post(color="red").status_code, 400)


class ResolutionTests(_Base):
    def test_colour_override_then_type_then_location(self):
        o = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=SQUARE
        )
        self.assertEqual(o.display_color, "#2563eb")  # the type's, over the location's
        o.color = "#111111"
        self.assertEqual(o.display_color, "#111111")
        o.color = ""
        self.building.color = ""
        self.building.save()
        o.refresh_from_db()
        self.assertEqual(o.display_color, "#f97316")
        self.assertEqual(
            SiteMapOutline(tenant=self.tenant, site=self.site, points=SQUARE).display_color,
            "",
        )

    def test_label_override_then_code_then_name(self):
        o = SiteMapOutline(tenant=self.tenant, site=self.site, location=self.bldg)
        self.assertEqual(o.display_label, "A1")
        o.label = "HQ"
        self.assertEqual(o.display_label, "HQ")
        o2 = SiteMapOutline(tenant=self.tenant, site=self.site, location=self.other)
        self.assertEqual(o2.display_label, "Building B")

    def test_list_carries_the_resolved_figures(self):
        self._post(location_id=str(self.bldg.id))
        row = self.client.get("/api/site-map-outlines/").json()["results"][0]
        self.assertEqual(row["display_color"], "#2563eb")
        self.assertEqual(row["display_label"], "A1")
        self.assertEqual(row["location"]["location_type"]["name"], "Building")


class ScopeTests(_Base):
    def test_location_must_be_at_the_outline_site(self):
        r = self._post(location_id=str(self.depot_loc.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_id", r.json())

    def test_other_tenant_rows_are_refused_and_invisible(self):
        self.assertEqual(self._post(site_id=str(self.their_site.id)).status_code, 400)
        self.assertEqual(self._post(location_id=str(self.their_loc.id)).status_code, 400)
        theirs = SiteMapOutline.objects.create(
            tenant=self.tenant2, site=self.their_site, points=SQUARE
        )
        self.assertEqual(self.client.get("/api/site-map-outlines/").json()["count"], 0)
        r = self.client.get(f"/api/site-map-outlines/{theirs.id}/")
        self.assertEqual(r.status_code, 404)

    def test_site_scoped_reader_sees_only_their_site(self):
        SiteMapOutline.objects.create(tenant=self.tenant, site=self.site, points=SQUARE)
        SiteMapOutline.objects.create(tenant=self.tenant, site=self.site_b, points=SQUARE)
        u = self._user("reader", [(["sitemapoutline", "location"], ["view"], [self.site], None)])
        self._login(u)
        rows = self.client.get("/api/site-map-outlines/").json()["results"]
        self.assertEqual([r["site_id"] for r in rows], [str(self.site.id)])

    def test_site_scoped_editor_cannot_draw_elsewhere(self):
        u = self._user("editor", [
            (["sitemapoutline"], ["view", "add", "change", "delete"], [self.site], None),
            (["location", "site"], ["view"], None, None),
        ])
        self._login(u)
        self.assertEqual(self._post().status_code, 201)
        r = self._post(site_id=str(self.site_b.id))
        self.assertIn(r.status_code, (400, 403))
        self.assertEqual(SiteMapOutline.objects.filter(site=self.site_b).count(), 0)

    def test_hidden_location_hides_its_outline(self):
        linked = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=SQUARE
        )
        shown = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.other, points=SQUARE
        )
        bare = SiteMapOutline.objects.create(tenant=self.tenant, site=self.site, points=SQUARE)
        u = self._user("partial", [
            (["sitemapoutline"], ["view"], None, None),
            (["location"], ["view"], None, {"name": "Building B"}),
        ])
        self._login(u)
        ids = {r["id"] for r in self.client.get("/api/site-map-outlines/").json()["results"]}
        self.assertEqual(ids, {str(shown.id), str(bare.id)})
        self.assertEqual(
            self.client.get(f"/api/site-map-outlines/{linked.id}/").status_code, 404
        )
        self.assertEqual(
            self.client.get(f"/api/site-map-outlines/{linked.id}/drilldown/").status_code, 404
        )

    def test_no_location_grant_sees_only_unlinked(self):
        SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=SQUARE
        )
        bare = SiteMapOutline.objects.create(tenant=self.tenant, site=self.site, points=SQUARE)
        u = self._user("bare", [(["sitemapoutline"], ["view"], None, None)])
        self._login(u)
        ids = [r["id"] for r in self.client.get("/api/site-map-outlines/").json()["results"]]
        self.assertEqual(ids, [str(bare.id)])

    def test_linking_a_location_the_writer_cannot_see_is_refused(self):
        u = self._user("blind", [
            (["sitemapoutline"], ["view", "add", "change"], None, None),
            (["location"], ["view"], None, {"name": "Building B"}),
        ])
        self._login(u)
        r = self._post(location_id=str(self.bldg.id))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self._post(location_id=str(self.other.id)).status_code, 201)

    def test_filters(self):
        a = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=SQUARE
        )
        SiteMapOutline.objects.create(tenant=self.tenant, site=self.site_b, points=SQUARE)
        rows = self.client.get(f"/api/site-map-outlines/?site={self.site.id}").json()
        self.assertEqual(rows["count"], 1)
        rows = self.client.get(f"/api/site-map-outlines/?location={self.bldg.id}").json()
        self.assertEqual([r["id"] for r in rows["results"]], [str(a.id)])


class QueryCountTests(_Base):
    def test_list_cost_is_flat(self):
        def count(url):
            self.client.get(url)
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(url)
            self.assertEqual(r.status_code, 200)
            return len(ctx.captured_queries)

        for _ in range(2):
            SiteMapOutline.objects.create(
                tenant=self.tenant, site=self.site, location=self.bldg, points=SQUARE
            )
        small = count("/api/site-map-outlines/")
        for loc in (self.other, self.floor, self.bldg):
            for _ in range(5):
                SiteMapOutline.objects.create(
                    tenant=self.tenant, site=self.site, location=loc, points=SQUARE
                )
        self.assertEqual(count("/api/site-map-outlines/"), small)

    def test_viewer_list_cost_is_flat(self):
        u = self._user("viewer", [(["sitemapoutline", "location"], ["view"], [self.site], None)])
        self._login(u)
        SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=SQUARE
        )
        self.client.get("/api/site-map-outlines/")
        with CaptureQueriesContext(connection) as ctx:
            self.client.get("/api/site-map-outlines/")
        small = len(ctx.captured_queries)
        for _ in range(10):
            SiteMapOutline.objects.create(
                tenant=self.tenant, site=self.site, location=self.other, points=SQUARE
            )
        with CaptureQueriesContext(connection) as ctx:
            self.client.get("/api/site-map-outlines/")
        self.assertEqual(len(ctx.captured_queries), small)


class DrilldownTests(_Base):
    def setUp(self):
        super().setUp()
        self.room = Room.objects.create(
            tenant=self.tenant, location=self.floor, name="Room 210", slug="room-210"
        )
        Rack.objects.create(tenant=self.tenant, site=self.site, location=self.floor, name="R1")
        Rack.objects.create(tenant=self.tenant, site=self.site, location=self.other, name="R9")
        for i, loc in enumerate((self.bldg, self.floor, self.other)):
            Device.objects.create(
                tenant=self.tenant, site=self.site, location=loc, name=f"d{i}"
            )
        self.own = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, name="Building A"
        )
        self.ground = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, name="Ground",
            stack=self.own, floor_order=0,
        )
        FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, name="1",
            stack=self.own, floor_order=10,
        )
        self.campus = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, name="Campus"
        )
        self.campus_floor = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, name="Site", stack=self.campus,
        )
        FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, location=self.other, name="Building B"
        )
        self.outline = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=SQUARE
        )

    def test_counts_plans_and_open_floor(self):
        r = self.client.get(f"/api/site-map-outlines/{self.outline.id}/drilldown/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["location"]["location_type"]["name"], "Building")
        self.assertEqual(body["counts"], {"locations": 1, "rooms": 1, "racks": 1, "devices": 2})
        self.assertEqual([p["name"] for p in body["floor_plans"]], ["Building A", "Campus"])
        self.assertEqual(body["floor_plans"][0]["first_floor_id"], str(self.ground.id))
        self.assertEqual(body["floor_plans"][0]["floor_count"], 2)
        self.assertTrue(body["floor_plans"][1]["site_wide"])
        self.assertEqual(body["open_floor_id"], str(self.ground.id))

    def test_without_own_plan_opens_the_site_wide_one(self):
        o = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.floor, points=SQUARE
        )
        body = self.client.get(f"/api/site-map-outlines/{o.id}/drilldown/").json()
        self.assertEqual([p["name"] for p in body["floor_plans"]], ["Campus"])
        self.assertEqual(body["open_floor_id"], str(self.campus_floor.id))

    def test_counts_follow_the_reader(self):
        u = self._user("narrow", [
            (["sitemapoutline", "location", "floorplan"], ["view"], None, None),
            (["device"], ["view"], None, {"name": "d0"}),
        ])
        self._login(u)
        body = self.client.get(f"/api/site-map-outlines/{self.outline.id}/drilldown/").json()
        self.assertEqual(body["counts"]["devices"], 1)
        self.assertEqual(body["counts"]["rooms"], 0)
        self.assertEqual(body["counts"]["racks"], 0)

    def test_unlinked_outline(self):
        o = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, points=SQUARE, label="Gate"
        )
        body = self.client.get(f"/api/site-map-outlines/{o.id}/drilldown/").json()
        self.assertIsNone(body["location"])
        self.assertIsNone(body["counts"])
        self.assertEqual([p["name"] for p in body["floor_plans"]], ["Campus"])


class RegistryTests(_Base):
    def test_registered_audited_and_site_scoped(self):
        self.assertTrue(is_registered("sitemapoutline"))
        self.assertEqual(SITE_PATHS["sitemapoutline"], "site")
        self.assertIn("sitemapoutline", site_role_types())
        self.assertIn("locationtype", site_role_catalog_types())
        o = self._post(location_id=str(self.bldg.id)).json()
        self.assertTrue(
            ChangeLogEntry.objects.filter(object_id=o["id"], action="create").exists()
        )
