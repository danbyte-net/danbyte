"""Floor-plan tiles and the site map name nothing the reader may not view
(#453).

A tile on a plan the reader may view can link another site's device, rack or
cabinet. Every read of it - ``contents/``, the tile list and detail, ``scene/``,
``state/``, ``snap-all`` collisions and a save's answer - keeps the tile and
reads its link ``{kind, id: null, name: "Hidden", hidden: true}``; a write
cannot link an object the writer may not view, and saving the tile keeps its
link. ``scene/`` counts a tray's cables the reader may view and the hidden
others. The site map lists only the markers, floor plans, cables and devices
the reader may view and names a marker's hidden device nothing.
"""
import json

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.api import assemble_site_role
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import (
    Cabinet,
    Cable,
    CableTermination,
    Device,
    FloorPlan,
    FloorPlanTile,
    FloorPlanTray,
    FloorTileType,
    Interface,
    Location,
    Rack,
    Site,
    SiteMarker,
)
from .status_registry import seed_builtin_statuses

User = get_user_model()

#: Names of site B's objects - never in a site-A reader's payload.
SECRETS = ("far-b", "rack-b", "cab-b", "plan-b", "X-SECRET")


class _Fixture(APITestCase):
    separation = False

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = self.separation
        dep.save(update_fields=["enhanced_site_separation", "updated_at"])
        self.site_a = Site.objects.create(
            tenant=self.tenant, name="SiteA", latitude="55.0", longitude="12.0"
        )
        self.site_b = Site.objects.create(
            tenant=self.tenant, name="SiteB", latitude="56.0", longitude="10.0"
        )
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site_a, name="Hall A", slug="hall-a"
        )
        loc_b = Location.objects.create(
            tenant=self.tenant, site=self.site_b, name="Hall B", slug="hall-b"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        self.plan_b = FloorPlan.objects.create(
            tenant=self.tenant, location=loc_b, name="plan-b"
        )
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Box", slug="box")
        self.rack_a = Rack.objects.create(
            tenant=self.tenant, site=self.site_a, location=self.loc, name="rack-a"
        )
        self.sw = Device.objects.create(
            tenant=self.tenant, name="sw-a1", site=self.site_a, rack=self.rack_a
        )
        self.own_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, x=1, y=1, rack=self.rack_a, link_kind="rack"
        )
        # Site B's device, rack, cabinet and plan, each on a tile here.
        self.far = Device.objects.create(tenant=self.tenant, name="far-b", site=self.site_b)
        self.rack_b = Rack.objects.create(
            tenant=self.tenant, site=self.site_b, location=loc_b, name="rack-b"
        )
        Device.objects.create(
            tenant=self.tenant, name="in-rack-b", site=self.site_b, rack=self.rack_b
        )
        self.cab_b = Cabinet.objects.create(
            tenant=self.tenant, site=self.site_b, location=loc_b, name="cab-b",
            inner_width_mm=500, inner_height_mm=600,
        )
        self.far_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, x=5, y=1, device=self.far, link_kind="device"
        )
        self.rack_b_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, x=7, y=1, rack=self.rack_b, link_kind="rack"
        )
        self.cab_b_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, x=9, y=1, cabinet=self.cab_b, link_kind="cabinet"
        )
        self.plan_b_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, x=11, y=1, tile_type=self.tt,
            linked_floor_plan=self.plan_b, link_kind="floorplan",
        )
        self.hidden_ids = {
            str(t.pk) for t in (self.far_tile, self.rack_b_tile, self.cab_b_tile,
                                self.plan_b_tile)
        }
        # A cable to site B in a tray here.
        self.cross = self._cable("X-SECRET", self.sw, "e1", self.far, "e1")
        self.local = self._cable("L-1", self.sw, "e2", self.sw, "e3")
        self.tray = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="T1", points=[[1, 0], [10, 0]]
        )
        self.tray.cables.set([self.cross, self.local])

        self.user = User.objects.create_user("viewer-a", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _cable(self, label, dev_a, port_a, dev_b, port_b):
        cable = Cable.objects.create(tenant=self.tenant, label=label)
        CableTermination.objects.create(
            cable=cable, end="A", interface=Interface.objects.create(device=dev_a, name=port_a)
        )
        CableTermination.objects.create(
            cable=cable, end="B", interface=Interface.objects.create(device=dev_b, name=port_b)
        )
        return cable

    def grant(self, types, actions=("view",), sites=(), constraints=None):
        perm = ObjectPermission.objects.create(
            name="g-" + "-".join(types) + "-".join(actions),
            object_types=list(types), actions=list(actions), constraints=constraints,
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.set(sites)
        return perm

    def login(self, user=None):
        self.client.force_login(user or self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r

    def contents(self):
        return self.get(f"/api/floor-plans/{self.plan.id}/contents/")

    def tile_rows(self):
        """Each tile as contents/, the tile list and the tile detail read it."""
        contents = self.contents()
        listing = self.get(f"/api/floor-plan-tiles/?floor_plan={self.plan.id}&page_size=100")
        detail = self.get(f"/api/floor-plan-tiles/{self.far_tile.id}/")
        return (contents, listing, detail), [
            *contents.json()["tiles"], *listing.json()["results"], detail.json()
        ]

    def assertNoSecrets(self, *responses):
        hidden_pks = (self.far.pk, self.rack_b.pk, self.cab_b.pk, self.plan_b.pk)
        for r in responses:
            text = r.content.decode() if hasattr(r, "content") else json.dumps(r)
            for s in SECRETS:
                self.assertNotIn(s, text)
            for pk in hidden_pks:
                self.assertNotIn(str(pk), text)


class SiteViewerTests(_Fixture):
    """A site-A viewer: the tiles stay, their site-B links read Hidden."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.login()

    def test_tile_reads_mask_the_link(self):
        responses, rows = self.tile_rows()
        seen = set()
        for row in rows:
            if row["id"] in self.hidden_ids:
                seen.add(row["id"])
                self.assertEqual(
                    row["linked"],
                    {"kind": row["link_kind"], "id": None, "name": "Hidden", "hidden": True},
                )
                self.assertIsNone(row["photo"])
        self.assertEqual(seen, self.hidden_ids)
        own = next(r for r in rows if r["id"] == str(self.own_tile.id))
        self.assertEqual(own["linked"]["name"], "rack-a")
        self.assertNotIn("hidden", own["linked"])
        self.assertNoSecrets(*responses)

    def test_tiles_keep_their_geometry(self):
        rows = {t["id"]: t for t in self.contents().json()["tiles"]}
        self.assertEqual(rows[str(self.far_tile.id)]["x"], 5)
        self.assertEqual(rows[str(self.rack_b_tile.id)]["x"], 7)

    def test_scene_masks_the_link(self):
        r = self.get(f"/api/floor-plans/{self.plan.id}/scene/")
        tiles = {t["id"]: t for t in r.json()["tiles"]}
        far = tiles[str(self.far_tile.id)]
        self.assertTrue(far["hidden"])
        self.assertEqual(far["device_name"], "Hidden")
        self.assertIsNone(tiles[str(self.rack_b_tile.id)]["rack"])
        self.assertIsNone(tiles[str(self.cab_b_tile.id)]["cabinet"])
        self.assertFalse(tiles[str(self.own_tile.id)]["hidden"])
        self.assertEqual(tiles[str(self.own_tile.id)]["rack"]["name"], "rack-a")
        self.assertNoSecrets(r)

    def test_scene_counts_only_viewable_cables(self):
        tray = self.get(f"/api/floor-plans/{self.plan.id}/scene/").json()["trays"][0]
        # A site viewer holds no cable grant (cables span sites).
        self.assertEqual(tray["cable_count"], 0)
        self.assertEqual(tray["hidden_cable_count"], 2)

    def test_tile_filter_by_a_hidden_object_answers_nothing(self):
        r = self.get(f"/api/floor-plan-tiles/?device={self.far.pk}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["count"], 0)
        r = self.get("/api/floor-plan-tiles/?device=not-a-uuid")
        self.assertEqual(r.json()["count"], 0)

    def test_state_skips_hidden_tiles(self):
        tiles = self.get(f"/api/floor-plans/{self.plan.id}/state/").json()["tiles"]
        self.assertIn(str(self.own_tile.id), tiles)
        for pk in self.hidden_ids:
            self.assertNotIn(pk, tiles)


class SiteScopedCableTests(_Fixture):
    """A site-A cable grant: the scene's tray counts the site-A cable."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.grant(["cable"], sites=[self.site_a])
        self.login()

    def test_scene_tray_counts(self):
        tray = self.get(f"/api/floor-plans/{self.plan.id}/scene/").json()["trays"][0]
        self.assertEqual(tray["cable_count"], 1)
        self.assertEqual(tray["hidden_cable_count"], 1)


class SeparationSiteViewerTests(SiteViewerTests):
    separation = True


class SeparationSiteScopedCableTests(SiteScopedCableTests):
    separation = True


class BothSitesViewerTests(_Fixture):
    """A viewer of both sites reads every link by name."""

    def setUp(self):
        super().setUp()
        assemble_site_role(
            self.tenant, "viewer", [self.site_a, self.site_b], user_ids=[self.user.id]
        )
        self.login()

    def test_links_named(self):
        _responses, rows = self.tile_rows()
        far = next(r for r in rows if r["id"] == str(self.far_tile.id))
        self.assertEqual(far["linked"]["name"], "far-b")
        self.assertEqual(far["linked"]["id"], str(self.far.pk))
        scene = self.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        tiles = {t["id"]: t for t in scene["tiles"]}
        self.assertEqual(tiles[str(self.far_tile.id)]["device_name"], "far-b")
        self.assertEqual(tiles[str(self.rack_b_tile.id)]["rack"]["name"], "rack-b")

    def test_tile_filter_by_a_viewable_object(self):
        r = self.get(f"/api/floor-plan-tiles/?device={self.far.pk}")
        self.assertEqual(r.json()["count"], 1)


class SeparationBothSitesViewerTests(BothSitesViewerTests):
    separation = True


class SuperuserTests(_Fixture):
    def test_superuser_reads_every_link(self):
        self.login(User.objects.create_superuser("admin", "a@example.com", "x"))
        _responses, rows = self.tile_rows()
        names = {r["linked"]["name"] for r in rows if r["linked"]}
        self.assertTrue({"far-b", "rack-b", "cab-b", "plan-b"} <= names)
        scene = self.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        self.assertEqual(scene["trays"][0]["cable_count"], 2)
        self.assertEqual(scene["trays"][0]["hidden_cable_count"], 0)


class EditorWriteTests(_Fixture):
    """A site-A editor (no tenant-wide read): cannot link a site-B object,
    and saving a tile whose link they cannot see keeps it."""

    def setUp(self):
        super().setUp()
        assemble_site_role(
            self.tenant, "editor", [self.site_a], user_ids=[self.user.id], silo=True
        )
        self.login()

    def bulk(self, tiles):
        return self.client.post(
            f"/api/floor-plans/{self.plan.id}/bulk/", {"tiles": tiles}, format="json"
        )

    def test_cannot_link_a_hidden_object(self):
        r = self.client.patch(
            f"/api/floor-plan-tiles/{self.own_tile.id}/",
            {"link_kind": "device", "link_id": str(self.far.pk)}, format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("link_id", r.json())
        self.own_tile.refresh_from_db()
        self.assertEqual(self.own_tile.rack_id, self.rack_a.pk)
        # Answered as unknown: the id sent is echoed, nothing of the object.
        self.assertNotIn("far-b", r.content.decode())

    def test_saving_a_hidden_tile_keeps_its_link(self):
        r = self.bulk({"update": [{
            "id": str(self.far_tile.id), "x": 6, "y": 1, "label": "",
            "link_kind": "device", "link_id": "",
        }]})
        self.assertEqual(r.status_code, 200, r.content)
        self.far_tile.refresh_from_db()
        self.assertEqual(self.far_tile.device_id, self.far.pk)
        self.assertEqual(self.far_tile.x, 6)
        row = next(t for t in r.json()["tiles"] if t["id"] == str(self.far_tile.id))
        self.assertTrue(row["linked"]["hidden"])
        self.assertNoSecrets(r)

    def test_unlinking_a_hidden_tile(self):
        r = self.bulk({"update": [{
            "id": str(self.far_tile.id), "tile_type_id": str(self.tt.pk),
            "link_kind": "", "link_id": "",
        }]})
        self.assertEqual(r.status_code, 200, r.content)
        self.far_tile.refresh_from_db()
        self.assertIsNone(self.far_tile.device_id)

    def test_snap_all_collision_reads_hidden(self):
        # Two tiles on one cell once snapped: one of them site B's device.
        FloorPlanTile.objects.filter(pk=self.far_tile.pk).update(x=1.4)
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/snap-all/", {"dry_run": True}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        names = {c["id"]: c["name"] for c in r.json()["collisions"]}
        self.assertEqual(names.get(str(self.far_tile.id)), "Hidden")
        self.assertNoSecrets(r)


class SeparationEditorWriteTests(EditorWriteTests):
    separation = True


class ContentsQueryTests(_Fixture):
    """contents/ reads a flat number of queries however many hidden links
    the plan holds."""

    def _add(self, n, start):
        for i in range(start, start + n):
            d = Device.objects.create(tenant=self.tenant, name=f"q{i}", site=self.site_b)
            FloorPlanTile.objects.create(
                floor_plan=self.plan, x=20 + i, y=5, device=d, link_kind="device"
            )

    def _count(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"/api/floor-plans/{self.plan.id}/contents/")
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), len(r.json()["tiles"])

    def _flat(self):
        self._add(2, 0)
        small, n_small = self._count()
        self._add(10, 2)
        big, n_big = self._count()
        self.assertEqual(n_big, n_small + 10)
        self.assertEqual(small, big)

    def test_flat_for_a_site_viewer(self):
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.login()
        self._flat()

    def test_flat_as_superuser(self):
        self.login(User.objects.create_superuser("admin", "a@example.com", "x"))
        self._flat()


class SiteMapTests(_Fixture):
    """The site map lists what the reader may view."""

    def setUp(self):
        super().setUp()
        self.marker = SiteMarker.objects.create(
            tenant=self.tenant, latitude="56.0", longitude="10.0", label="",
            tile_type=self.tt, device=self.far,
        )
        self.free_marker = SiteMarker.objects.create(
            tenant=self.tenant, latitude="55.5", longitude="11.0", label="Pole",
            tile_type=self.tt,
        )

    def site_map(self):
        return self.get("/api/site-map/")

    def test_site_viewer(self):
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.login()
        r = self.site_map()
        body = r.json()
        self.assertEqual([m["id"] for m in body["markers"]], [str(self.free_marker.id)])
        self.assertEqual([s["name"] for s in body["sites"]], ["SiteA"])
        self.assertNoSecrets(r)

    def test_marker_device_hidden_from_a_tenant_wide_marker_reader(self):
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.grant(["sitemarker"])
        self.login()
        r = self.site_map()
        markers = {m["id"]: m for m in r.json()["markers"]}
        m = markers[str(self.marker.id)]
        self.assertIsNone(m["device"])
        self.assertTrue(m["device_hidden"])
        self.assertFalse(markers[str(self.free_marker.id)]["device_hidden"])
        self.assertNoSecrets(r)
        r = self.get(f"/api/site-markers/{self.marker.id}/")
        self.assertEqual(r.json()["device"], {"id": None, "name": "Hidden", "hidden": True})
        self.assertNoSecrets(r)
        r = self.get("/api/site-markers/")
        self.assertNoSecrets(r)

    def test_counts_follow_the_reader(self):
        """A site's device and floor-plan counts are the ones they may view."""
        self.grant(["site"])
        self.grant(["device"], constraints={"name": "sw-a1"})
        self.grant(["floorplan"], constraints={"name": "nothing"})
        self.login()
        sites = {s["name"]: s for s in self.site_map().json()["sites"]}
        self.assertEqual(sites["SiteA"]["device_count"], 1)
        self.assertEqual(sites["SiteB"]["device_count"], 0)
        self.assertEqual(sites["SiteA"]["floor_plan_count"], 0)
        self.assertEqual(sites["SiteA"]["floor_plans"], [])

    def test_both_sites_viewer(self):
        assemble_site_role(
            self.tenant, "viewer", [self.site_a, self.site_b], user_ids=[self.user.id]
        )
        self.login()
        markers = {m["id"]: m for m in self.site_map().json()["markers"]}
        self.assertEqual(markers[str(self.marker.id)]["device"]["name"], "far-b")
        self.assertFalse(markers[str(self.marker.id)]["device_hidden"])

    def test_superuser(self):
        self.login(User.objects.create_superuser("admin", "a@example.com", "x"))
        body = self.site_map().json()
        self.assertEqual(len(body["markers"]), 2)
        sites = {s["name"]: s for s in body["sites"]}
        self.assertEqual(sites["SiteB"]["floor_plan_count"], 1)
        self.assertEqual(sites["SiteA"]["device_count"], 1)


class SeparationSiteMapTests(SiteMapTests):
    separation = True


class SiteMapCableTests(_Fixture):
    """Site-map cable lines and edges carry only the cables the reader may
    view - a cable grant's constraints apply, not only its existence."""

    def setUp(self):
        super().setUp()
        self.far.latitude, self.far.longitude = "56.0", "10.0"
        self.far.save()
        self.grant(["site", "device"])

    def test_constrained_cable_grant(self):
        self.grant(["cable"], constraints={"label": "L-1"})
        self.login()
        r = self.get("/api/site-map/cables/")
        self.assertNotIn("X-SECRET", r.content.decode())
        r = self.get("/api/site-map/connections/?include=capacity")
        self.assertEqual([c for c in r.json()["connections"] if c["kind"] == "cable"], [])
        self.assertNotIn("X-SECRET", r.content.decode())

    def test_cable_grant_covers_it(self):
        self.grant(["cable"])
        self.login()
        r = self.get("/api/site-map/cables/")
        self.assertIn("X-SECRET", [c["label"] for c in r.json()["cables"]])
        edges = self.get("/api/site-map/connections/").json()["connections"]
        self.assertEqual([c["kind"] for c in edges], ["cable"])

    def test_superuser(self):
        self.login(User.objects.create_superuser("admin", "a@example.com", "x"))
        labels = [c["label"] for c in self.get("/api/site-map/cables/").json()["cables"]]
        self.assertIn("X-SECRET", labels)


class SeparationSiteMapCableTests(SiteMapCableTests):
    separation = True
