"""GET /api/floor-plans/{id}/contents/ - the editor's one read on open:
every tile, tray, wall, raised floor, area and label of a plan, unpaginated, tenant- and
permission-scoped, at a query count that does not grow with the plan."""
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Cabinet,
    Cable,
    Device,
    DeviceRole,
    AreaType,
    FloorPlan,
    FloorPlanArea,
    FloorPlanLabel,
    FloorPlanRaisedFloorArea,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    FloorTileType,
    Location,
    PowerPanel,
    Rack,
    Room,
    Site,
)

User = get_user_model()

# Queries for one contents/ read as a superuser - session, user and tenant
# resolution, the plan, then one per kind plus the trays' cables, and the
# tile photos (the visible devices and racks, and their images), and the
# stored cable routes. The same
# for 2 rows of each kind as for 12.
CONTENTS_QUERIES = 20

KINDS = ("tiles", "trays", "walls", "raised_floors", "areas", "labels", "cable_paths")


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self._login(self.admin)
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Floor 1",
            grid_width=512, grid_height=512,
        )
        self.tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Access", slug="access"
        )

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _url(self, plan=None):
        return f"/api/floor-plans/{(plan or self.plan).id}/contents/"

    def _fill(self, n, start=0):
        """``n`` of each kind, every tile linked to its own object and every
        tray carrying two cables - the shapes a lazy serializer would pay
        for per row."""
        tiles = []
        for i in range(start, start + n):
            rack = Rack.objects.create(
                tenant=self.tenant, site=self.site, location=self.loc, name=f"R{i}"
            )
            cab = Cabinet.objects.create(
                tenant=self.tenant, site=self.site, name=f"K{i}",
                inner_width_mm=500, inner_height_mm=600,
            )
            dev = Device.objects.create(tenant=self.tenant, site=self.site, name=f"d{i}")
            panel = PowerPanel.objects.create(
                tenant=self.tenant, site=self.site, name=f"P{i}"
            )
            y = 3 * i
            tiles += [
                FloorPlanTile(floor_plan=self.plan, tile_type=self.tt, x=0, y=y,
                              link_kind="rack", rack=rack),
                FloorPlanTile(floor_plan=self.plan, tile_type=self.tt, x=1, y=y,
                              link_kind="cabinet", cabinet=cab),
                FloorPlanTile(floor_plan=self.plan, role_type=self.role, x=2, y=y,
                              link_kind="device", device=dev),
                FloorPlanTile(floor_plan=self.plan, tile_type=self.tt, x=3, y=y,
                              link_kind="powerpanel", power_panel=panel),
            ]
            tray = FloorPlanTray.objects.create(
                floor_plan=self.plan, name=f"T{i}", points=[[0, y], [5, y]]
            )
            tray.cables.set([
                Cable.objects.create(tenant=self.tenant, label=f"C{i}a"),
                Cable.objects.create(tenant=self.tenant, label=f"C{i}b"),
            ])
            FloorPlanWall.objects.create(
                floor_plan=self.plan, label=f"W{i}", points=[[10, y], [12, y]]
            )
            FloorPlanRaisedFloorArea.objects.create(
                floor_plan=self.plan, x=20, y=y, width=2, height=2
            )
            # An area per room and per location, and a label: their links
            # are what a lazy serializer would pay for per row.
            room = Room.objects.create(
                tenant=self.tenant, location=self.loc, name=f"Room {i}", slug=f"room-{i}"
            )
            FloorPlanArea.objects.create(
                floor_plan=self.plan, x=30, y=y, width=2, height=2, room=room
            )
            FloorPlanArea.objects.create(
                floor_plan=self.plan, x=33, y=y, width=2, height=2, location=self.loc
            )
            # A plain area of its own type (parking, fence...): joined too.
            FloorPlanArea.objects.create(
                floor_plan=self.plan, x=36, y=y, width=2, height=2,
                area_type=AreaType.objects.create(
                    tenant=self.tenant, name=f"Type {i}", slug=f"type-{i}",
                    pattern="hatched",
                ),
            )
            FloorPlanLabel.objects.create(floor_plan=self.plan, text=f"L{i}", x=40, y=y)
        FloorPlanTile.objects.bulk_create(tiles)

    def _queries(self):
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get(self._url())
        self.assertEqual(resp.status_code, 200, resp.content)
        return len(ctx.captured_queries), resp.json()


class ContentsTests(_Base):
    def test_shape_matches_the_list_endpoints(self):
        self._fill(2)
        body = self.client.get(self._url()).json()
        self.assertEqual(set(body), {"version", *KINDS})
        for key, path in (
            ("tiles", "floor-plan-tiles"),
            ("trays", "floor-plan-trays"),
            ("walls", "floor-plan-walls"),
            ("raised_floors", "floor-plan-raised-floors"),
            ("areas", "floor-plan-areas"),
            ("labels", "floor-plan-labels"),
        ):
            listed = self.client.get(
                f"/api/{path}/?floor_plan={self.plan.id}&page_size=1000"
            ).json()["results"]
            by_id = {row["id"]: row for row in listed}
            self.assertEqual(len(body[key]), len(listed), key)
            for row in body[key]:
                self.assertEqual(row, by_id[row["id"]], key)
        tray = body["trays"][0]
        self.assertEqual(len(tray["cables"]), 2)
        linked = {t["linked"]["kind"] for t in body["tiles"]}
        self.assertEqual(linked, {"rack", "cabinet", "device", "powerpanel"})
        self.assertEqual(
            sorted(bool(a["room"]) for a in body["areas"]), [False] * 4 + [True] * 2
        )
        # A plain area's type comes joined, as the list endpoint has it.
        self.assertEqual(
            [a["area_type"]["pattern"] for a in body["areas"] if a["area_type"]],
            ["hatched", "hatched"],
        )
        newest = max(row["updated_at"] for key in KINDS for row in body[key])
        # Same instant; the serializer and isoformat may spell it apart.
        self.assertEqual(body["version"][:19], newest[:19])

    def test_an_empty_plan(self):
        body = self.client.get(self._url()).json()
        self.assertEqual(body["version"], None)
        for key in KINDS:
            self.assertEqual(body[key], [])

    def test_more_than_a_thousand_tiles_all_load(self):
        # The editor used to read tiles with page_size=1000 and silently drew
        # only the first thousand.
        FloorPlanTile.objects.bulk_create(
            FloorPlanTile(floor_plan=self.plan, tile_type=self.tt, x=i % 64, y=i // 64)
            for i in range(1205)
        )
        body = self.client.get(self._url()).json()
        self.assertEqual(len(body["tiles"]), 1205)
        self.assertEqual(len({t["id"] for t in body["tiles"]}), 1205)

    def test_query_count_is_flat_as_the_plan_grows(self):
        self._fill(2)
        small, body = self._queries()
        self.assertEqual(len(body["tiles"]), 8)
        self._fill(10, start=2)
        large, body = self._queries()
        self.assertEqual(len(body["tiles"]), 48)
        self.assertEqual(len(body["trays"]), 12)
        self.assertEqual(len(body["areas"]), 36)
        self.assertEqual(len(body["labels"]), 12)
        self.assertEqual(small, large)
        self.assertEqual(large, CONTENTS_QUERIES)

    def test_other_tenants_plan_is_404(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        site = Site.objects.create(tenant=other, name="LON")
        loc = Location.objects.create(tenant=other, site=site, name="B", slug="b")
        theirs = FloorPlan.objects.create(tenant=other, location=loc, name="Hidden")
        FloorPlanTile.objects.create(floor_plan=theirs, tile_type=FloorTileType.objects.create(
            tenant=other, name="X", slug="x"), x=0, y=0)
        self.assertEqual(self.client.get(self._url(theirs)).status_code, 404)

    def test_anonymous_is_refused(self):
        self.client.logout()
        self.assertIn(self.client.get(self._url()).status_code, (401, 403))


class ContentsPermissionTests(_Base):
    def setUp(self):
        super().setUp()
        self._fill(1)
        self.user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def grant(self, types, sites=()):
        perm = ObjectPermission.objects.create(
            name="g-" + "-".join(types), object_types=list(types), actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.set(sites)

    def test_each_kind_follows_its_own_view_grant(self):
        self.grant(["floorplan", "floorplantile", "floorplanwall"])
        self._login(self.user)
        body = self.client.get(self._url()).json()
        self.assertEqual(len(body["tiles"]), 4)
        self.assertEqual(len(body["walls"]), 1)
        self.assertEqual(body["trays"], [])
        self.assertEqual(body["raised_floors"], [])
        self.assertEqual(body["areas"], [])
        self.assertEqual(body["labels"], [])

    def test_areas_and_labels_follow_their_grants(self):
        self.grant(["floorplan", "floorplanarea", "floorplanlabel"])
        self._login(self.user)
        body = self.client.get(self._url()).json()
        self.assertEqual(len(body["areas"]), 3)
        self.assertEqual(len(body["labels"]), 1)
        self.assertEqual(body["tiles"], [])

    def test_no_plan_grant_is_refused(self):
        self.grant(["floorplantile"])
        self._login(self.user)
        self.assertIn(self.client.get(self._url()).status_code, (403, 404))

    def test_site_scope_narrows_the_rows(self):
        elsewhere = Site.objects.create(tenant=self.tenant, name="FRA")
        self.grant(["floorplan"], [self.site])
        self.grant(
            ["floorplantile", "floorplantray", "floorplanwall",
             "floorplanraisedfloorarea", "floorplanarea", "floorplanlabel"],
            [elsewhere],
        )
        self._login(self.user)
        body = self.client.get(self._url()).json()
        for key in KINDS:
            self.assertEqual(body[key], [], key)

    def test_plan_at_another_site_is_404(self):
        elsewhere = Site.objects.create(tenant=self.tenant, name="FRA")
        self.grant(
            ["floorplan", "floorplantile", "floorplantray", "floorplanwall",
             "floorplanraisedfloorarea"],
            [elsewhere],
        )
        self._login(self.user)
        self.assertEqual(self.client.get(self._url()).status_code, 404)
