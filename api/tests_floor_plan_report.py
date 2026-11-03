"""The floor-plan report: ``POST /api/floor-plans/{id}/export/report/`` and
``.../export/report/tables/`` - the scope worked out and checked on the
server (the view's box, a room or area of this floor, the building's
levels), ids from another plan or tenant refused, the tables filtered by
the reader's object permissions, the posted sheets checked against the
scope, the drawing PDFs' limits, and a real render."""

from __future__ import annotations

import re
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import drawing_pdf
from . import floor_plan_report as rep
from .models import Device, FloorPlan, FloorPlanArea, Location, Room, Site
from .tests_elevation_pdf import _pdf_objects
from .tests_floorplan_risers import _Floors

User = get_user_model()
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 800" width="1600" '
    'height="800"><rect x="2" y="82" width="36" height="36" fill="#2563eb"/>'
    '<text x="20" y="100" font-size="11" fill="#18181b">RA</text></svg>'
)


@override_settings(CACHES=LOCMEM)
class _Report(_Floors):
    """Two floors of one building: Hall A (RA with sw-a, RB with sw-b, the
    tray OH-1, C-1 between sw-a and sw-b) and Floor 2 (RC with sw-c);
    C-up runs from sw-a to sw-c. A room drawn round RA on Hall A."""

    fake = mock.patch.object(rep, "render_with_deadline", return_value=b"%PDF-1.7 fake")

    def setUp(self):
        super().setUp()
        cache.clear()
        self.room = Room.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall B", slug="hall-b"
        )
        self.rack_a.room = self.room
        self.rack_a.save()
        self.area = FloorPlanArea.objects.create(
            floor_plan=self.plan, x=0, y=1, width=4, height=4, room=self.room,
        )
        self.store()

    def tables(self, body, plan=None):
        return self.client.post(
            f"/api/floor-plans/{(plan or self.plan).pk}/export/report/tables/",
            {"include": ["cables", "inventory", "ports"], **body}, format="json",
        )

    def ok(self, body, plan=None):
        r = self.tables(body, plan)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def post(self, body, plan=None, query=""):
        return self.client.post(
            f"/api/floor-plans/{(plan or self.plan).pk}/export/report/{query}",
            {"include": ["plan"], **body}, format="json",
        )

    @staticmethod
    def names(data):
        return [r["name"] for g in data["inventory"]["groups"] for r in g["rows"]]

    @staticmethod
    def cables(data):
        return sorted(r["label"] for r in data["cables"]["rows"])

    def member(self, name, types, **constraints):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name=name, object_types=types, actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        for i, (slug, c) in enumerate(constraints.items()):
            q = ObjectPermission.objects.create(
                name=f"{name}-{i}", object_types=[slug], actions=["view"], constraints=c,
            )
            q.users.add(user)
            q.tenants.add(self.tenant)
        return user


class ScopeTests(_Report):
    def test_the_whole_floor(self):
        data = self.ok({"scope": "floor"})
        self.assertEqual(data["levels"], ["Hall A"])
        self.assertEqual(self.names(data), ["RA", "sw-a", "RB", "sw-b"])
        self.assertEqual([g["name"] for g in data["inventory"]["groups"]],
                         ["Hall B", "No room"])
        self.assertEqual(self.cables(data), ["C-1", "C-up"])
        ra = data["inventory"]["groups"][0]["rows"]
        self.assertEqual(ra[1]["holder"], "RA")
        self.assertEqual(ra[1]["position"], "U41")
        self.assertEqual(ra[1]["parent"], str(self.rack_a.pk))
        ports = {(r["device"], r["far"]) for r in data["ports"]["rows"]}
        self.assertIn(("sw-a", "sw-b · " + self.dev_b.interfaces.first().name), ports)
        self.assertIn(("sw-b", "sw-a · " + self.cable.terminations.get(end="A").point.name),
                      ports)

    def test_a_room(self):
        data = self.ok({"scope": "area", "area": str(self.area.pk)})
        self.assertEqual(self.names(data), ["RA", "sw-a"])
        # C-1 and C-up end on sw-a; nothing of RB's alone.
        self.assertEqual(self.cables(data), ["C-1", "C-up"])
        self.assertEqual(data["scope"], "Room")
        self.assertTrue(data["title"].endswith("Hall B"))

    def test_a_room_keeps_the_cables_of_its_tiles_or_routes_only(self):
        peer = Device.objects.create(tenant=self.tenant, name="sw-b2", site=self.site,
                                     rack=self.rack_b, device_type=self.dtype, position=30)
        lone = self._cable("C-lone", self.dev_b, peer)
        data = self.ok({"scope": "area", "area": str(self.area.pk)})
        self.assertNotIn(lone.label, self.cables(data))
        data = self.ok({"scope": "floor"})
        self.assertIn(lone.label, self.cables(data))

    def test_an_area_of_another_floor_or_tenant_is_refused(self):
        theirs = FloorPlanArea.objects.create(floor_plan=self.plan2, x=0, y=0, width=2, height=2)
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="X", slug="x")
        site = Site.objects.create(tenant=other, name="LON")
        loc = Location.objects.create(tenant=other, site=site, name="L", slug="l")
        far = FloorPlan.objects.create(tenant=other, location=loc, name="Far")
        foreign = FloorPlanArea.objects.create(floor_plan=far, x=0, y=0, width=2, height=2)
        for area in (theirs, foreign):
            with self.subTest(area=str(area.floor_plan)):
                r = self.tables({"scope": "area", "area": str(area.pk)})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("area", r.json())
        self.assertEqual(self.tables({"scope": "area"}).status_code, 400)

    def test_this_view(self):
        # RB stands at x=10 (cells); the view shows cells 9 to 12.
        data = self.ok({"scope": "view", "box": [360, 0, 120, 400]})
        self.assertEqual(self.names(data), ["RB", "sw-b"])
        self.assertEqual(data["scope"], "This view")

    def test_a_view_off_the_plan_or_without_a_box_is_refused(self):
        for body in ({"scope": "view"}, {"scope": "view", "box": [5000, 5000, 10, 10]},
                     {"scope": "view", "box": [0, 0, 0, 10]},
                     {"scope": "view", "box": [0, 0, "nan", 10]}):
            with self.subTest(body=body):
                self.assertEqual(self.tables(body).status_code, 400)

    def test_a_building_of_two_levels(self):
        data = self.ok({"scope": "building"})
        self.assertEqual(data["levels"], ["Hall A", "Floor 2"])
        self.assertEqual(self.names(data), ["RA", "sw-a", "RB", "sw-b", "RC", "sw-c"])
        groups = [g["name"] for g in data["inventory"]["groups"]]
        self.assertEqual(groups, ["Hall A · Hall B", "Hall A · No room", "Floor 2 · No room"])
        # C-up has an end on both levels: listed once.
        self.assertEqual(self.cables(data), ["C-1", "C-up"])
        self.assertEqual(data["cables"]["total"]["count"], 2)

    def test_the_same_building_from_any_level(self):
        a = self.ok({"scope": "building"})
        b = self.ok({"scope": "building"}, plan=self.plan2)
        self.assertEqual(self.names(a), self.names(b))

    def test_a_level_the_reader_may_not_view_is_left_out(self):
        user = self.member(
            "lv", ["floorplantile", "floorplancablepath", "rack", "device", "cable"],
            floorplan={"name": "Hall A"},
        )
        self.login(user)
        data = self.ok({"scope": "building"})
        self.assertEqual(data["levels"], ["Hall A"])
        self.assertNotIn("sw-c", self.names(data))

    def test_hidden_tiles_leave_the_inventory(self):
        data = self.ok({"scope": "floor", "hidden_tiles": [str(self.tile_b.pk)]})
        self.assertEqual(self.names(data), ["RA", "sw-a"])


class PermissionTests(_Report):
    def test_inventory_and_cables_follow_object_permissions(self):
        user = self.member(
            "v", ["floorplan", "floorplantile", "floorplancablepath", "rack"],
            device={"name": "sw-a"}, cable={"label": "C-1"},
        )
        self.login(user)
        data = self.ok({"scope": "floor"})
        self.assertEqual(self.names(data), ["RA", "sw-a", "RB"])
        self.assertEqual(data["inventory"]["hidden_count"], 1)
        self.assertEqual(self.cables(data), ["C-1"])
        self.assertEqual(data["cables"]["hidden_count"], 1)
        c1 = data["cables"]["rows"][0]
        self.assertTrue(c1["b"][0]["hidden"])
        self.assertNotIn("sw-b", str(data["cables"]))
        self.assertNotIn("sw-b", str(data["ports"]))
        self.assertEqual({r["far"] for r in data["ports"]["rows"]}, {"Hidden"})
        self.assertEqual(data["ports"]["hidden_count"], 1)

    def test_a_rack_the_reader_may_not_view_is_counted_and_its_devices_say_hidden(self):
        user = self.member(
            "r", ["floorplan", "floorplantile", "floorplancablepath", "device", "cable"],
            rack={"name": "RA"},
        )
        self.login(user)
        data = self.ok({"scope": "floor"})
        self.assertNotIn("RB", self.names(data))
        rows = {r["name"]: r for g in data["inventory"]["groups"] for r in g["rows"]}
        self.assertEqual(rows["sw-b"]["holder"], "Hidden")
        self.assertEqual(data["inventory"]["hidden_count"], 1)

    def test_floorplan_view_is_needed(self):
        user = self.member("n", ["rack", "device"])
        self.login(user)
        self.assertIn(self.tables({"scope": "floor"}).status_code, (403, 404))
        self.assertIn(self.post({"scope": "floor"}).status_code, (403, 404))

    def test_another_tenants_plan_is_not_found(self):
        org = Organization.objects.create(name="Y", slug="y")
        other = Tenant.objects.create(org=org, name="Y", slug="y")
        site = Site.objects.create(tenant=other, name="LON")
        loc = Location.objects.create(tenant=other, site=site, name="L", slug="l")
        far = FloorPlan.objects.create(tenant=other, location=loc, name="Far")
        self.assertEqual(self.tables({"scope": "floor"}, plan=far).status_code, 404)

    def test_anonymous_refused(self):
        self.client.logout()
        self.assertIn(self.tables({"scope": "floor"}).status_code, (401, 403))


class PdfTests(_Report):
    def sheet(self, plan=None):
        return {"floor": str((plan or self.plan).pk), "svg": SVG}

    def test_the_sheets_and_tables_reach_the_renderer(self):
        with self.fake as render:
            r = self.post({"scope": "building", "include": ["plan", "cables", "inventory"],
                           "sheets": [self.sheet(self.plan2), self.sheet()]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r["Content-Type"], "application/pdf")
        kw = render.call_args.kwargs
        # In floor order, whatever order they were posted in.
        self.assertEqual([s["title"] for s in kw["sheets"]], ["Hall A", "Floor 2"])
        self.assertEqual(len(kw["pages"]), 2)
        self.assertIn("cables", kw["data"])
        self.assertIn("inventory", kw["data"])
        self.assertNotIn("ports", kw["data"])

    def test_a_sheet_of_a_floor_outside_the_scope_is_refused(self):
        with self.fake as render:
            r = self.post({"scope": "floor", "sheets": [self.sheet(self.plan2)]})
            self.assertEqual(r.status_code, 400, r.content)
            r = self.post({"scope": "floor", "sheets": [
                {"floor": "00000000-0000-0000-0000-000000000000", "svg": SVG}]})
            self.assertEqual(r.status_code, 400, r.content)
        render.assert_not_called()

    def test_the_plan_needs_a_drawing(self):
        with self.fake as render:
            self.assertEqual(self.post({"scope": "floor"}).status_code, 400)
            r = self.post({"scope": "floor", "include": ["inventory"]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(render.call_args.kwargs["sheets"], [])

    def test_the_drawing_is_sanitised(self):
        hostile = SVG.replace("</svg>", '<script>alert(1)</script></svg>')
        with self.fake as render:
            r = self.post({"scope": "floor", "sheets": [{**self.sheet(), "svg": hostile}]})
        self.assertEqual(r.status_code, 200, r.content)
        svg = next(iter(render.call_args.kwargs["pages"].values()))
        self.assertNotIn(b"script", svg)
        self.assertIn(b"RA", svg)
        with self.fake:
            r = self.post({"scope": "floor", "sheets": [{**self.sheet(), "svg": "not xml"}]})
        self.assertEqual(r.status_code, 400)

    def test_a_room_sheet_is_framed_to_the_room(self):
        with self.fake as render:
            r = self.post({"scope": "area", "area": str(self.area.pk),
                           "sheets": [self.sheet()]})
        self.assertEqual(r.status_code, 200, r.content)
        svg = next(iter(render.call_args.kwargs["pages"].values()))
        # The room's cells 0..4 x 1..5, two more round them, inside the plan.
        self.assertIn(b'viewBox="0 0 240 280"', svg)

    def test_limits(self):
        with self.fake, mock.patch.object(rep, "MAX_BODY_BYTES", 100):
            self.assertEqual(self.post({"scope": "floor", "sheets": [self.sheet()]})
                             .status_code, 413)
        too_many = [self.sheet()] * (rep.MAX_SHEETS + 1)
        with self.fake:
            self.assertEqual(self.post({"scope": "floor", "sheets": too_many}).status_code, 400)
        with mock.patch.object(rep, "render_with_deadline",
                               side_effect=drawing_pdf.RenderTimeout):
            r = self.post({"scope": "floor", "sheets": [self.sheet()]})
        self.assertEqual(r.status_code, 413)
        cache.add(f"topology-pdf-busy:{self.admin.pk}", 1, 60)
        with self.fake as render:
            r = self.post({"scope": "floor", "sheets": [self.sheet()]})
        self.assertEqual(r.status_code, 429)
        render.assert_not_called()

    def test_a_building_over_the_cap_is_refused(self):
        with mock.patch.object(rep, "MAX_SHEETS", 1), self.fake:
            r = self.tables({"scope": "building"})
        self.assertEqual(r.status_code, 400)

    def test_print_link(self):
        with self.fake:
            r = self.post({"scope": "floor", "sheets": [self.sheet()]}, query="?print=1")
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()["url"]
        got = self.client.get(url)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, b"%PDF-1.7 fake")
        other = self.member("o", ["floorplan"])
        self.login(other)
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_a_real_render(self):
        r = self.post({
            "scope": "building",
            "include": ["plan", "cables", "inventory", "ports"],
            "paper": {"size": "a4", "orientation": "landscape"},
            "sheets": [self.sheet(), self.sheet(self.plan2)],
        })
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF-"))
        objects = _pdf_objects(r.content)
        pages = len(re.findall(rb"/Type\s*/Page(?![s\w])", objects))
        # The title page, two sheets, then the three tables.
        self.assertEqual(pages, 6)
