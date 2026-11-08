"""The cable schedule of a floor plan (floor-plan cables, phase 6).

``GET /api/floor-plans/{id}/cable-schedule/`` lists the cables with a stored
route on the plan or an end on it - ends, route, lengths, notes - grouped
by room or by tray, with totals per type; hidden cables are counted, not
listed. ``POST .../cable-schedule/pdf/`` lays it out on paper.
"""
from unittest import mock

from django.contrib.auth import get_user_model

from auth_api.models import ObjectPermission, UserProfile

from . import cable_schedule
from .models import Device, Room
from .tests_floorplan_cable_paths import _Plan
from .tests_floorplan_risers import _Floors

User = get_user_model()


class _Schedule(_Plan):
    def setUp(self):
        super().setUp()
        self.room = Room.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall B", slug="hall-b"
        )
        self.dev_a.room = self.room
        self.dev_a.save()
        self.cable.type = "cat6"
        self.cable.description = "Pull with the patch run"
        self.cable.save()
        self.store()
        self.ghost = Device.objects.create(tenant=self.tenant, name="ghost", site=self.site)
        self.off = self._cable("C-off", self.dev_b, self.ghost)
        self.off.length = 12
        self.off.save()

    def schedule(self, group="room", plan=None):
        r = self.client.get(
            f"/api/floor-plans/{(plan or self.plan).id}/cable-schedule/?group={group}"
        )
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class CableScheduleTests(_Schedule):
    def test_lists_routes_and_ends_with_lengths(self):
        data = self.schedule()
        rows = {r["label"]: r for r in data["rows"]}
        self.assertEqual(set(rows), {"C-1", "C-off"})
        c1 = rows["C-1"]
        self.assertEqual(c1["type_display"], "CAT6")
        self.assertEqual(c1["route"], "OH-1")
        self.assertEqual(c1["route_source"], "stored")
        self.assertEqual(c1["a"][0]["device"], "sw-a")
        self.assertEqual(c1["a"][0]["room"], "Hall B")
        self.assertTrue(c1["a"][0]["on_floor"])
        self.assertIsNotNone(c1["computed_m"])
        self.assertIsNone(c1["length"])
        self.assertEqual(c1["length_source"], "")
        self.assertEqual(c1["notes"], "Pull with the patch run")
        off = rows["C-off"]
        self.assertEqual(off["route"], "")
        self.assertFalse(off["b"][0]["on_floor"])
        self.assertEqual(off["length_source"], "entered")
        self.assertEqual(data["hidden_count"], 0)

    def test_grouped_by_room(self):
        data = self.schedule()
        names = [g["name"] for g in data["groups"]]
        self.assertEqual(names, ["Hall B", "No room"])
        by = {g["name"]: g["rows"] for g in data["groups"]}
        self.assertEqual(by["Hall B"], [str(self.cable.id)])
        self.assertEqual(by["No room"], [str(self.off.id)])

    def test_grouped_by_tray(self):
        data = self.schedule("tray")
        by = {g["name"]: g["rows"] for g in data["groups"]}
        self.assertEqual(by, {"OH-1": [str(self.cable.id)], "No tray": [str(self.off.id)]})
        self.assertEqual(data["groups"][-1]["name"], "No tray")

    def test_totals_per_type(self):
        data = self.schedule()
        totals = {t["label"]: t for t in data["totals"]}
        self.assertEqual(totals["CAT6"]["count"], 1)
        self.assertEqual(totals["CAT6"]["metres"], self.schedule()["rows"][0]["computed_m"])
        self.assertEqual(totals["No type"], {
            "type": "", "label": "No type", "count": 1, "metres": 12.0, "unmeasured": 0,
        })
        self.assertEqual(data["total"]["count"], 2)

    def test_hidden_cables_are_counted_not_listed(self):
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile", "floorplancablepath",
                                    "device"],
            actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        cables = ObjectPermission.objects.create(
            name="c", object_types=["cable"], actions=["view"], constraints={"label": "C-1"},
        )
        cables.users.add(user)
        cables.tenants.add(self.tenant)
        self.login(user)
        data = self.schedule()
        self.assertEqual([r["label"] for r in data["rows"]], ["C-1"])
        self.assertEqual(data["hidden_count"], 1)
        self.assertEqual(data["total"]["count"], 1)
        self.assertNotIn("C-off", str(data))

    def test_an_end_on_a_hidden_device_reads_hidden(self):
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile", "floorplancablepath",
                                    "cable"],
            actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        devs = ObjectPermission.objects.create(
            name="d", object_types=["device"], actions=["view"], constraints={"name": "sw-a"},
        )
        devs.users.add(user)
        devs.tenants.add(self.tenant)
        self.login(user)
        rows = {r["label"]: r for r in self.schedule()["rows"]}
        b = rows["C-1"]["b"][0]
        self.assertTrue(b["hidden"])
        self.assertIsNone(b["device"])
        self.assertNotIn("sw-b", str(rows))
        self.assertNotIn("ghost", str(rows))

    def test_floorplan_view_is_needed(self):
        user = User.objects.create_user("n", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self.login(user)
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/cable-schedule/")
        self.assertIn(r.status_code, (403, 404))
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/cable-schedule/pdf/", {},
                             format="json")
        self.assertIn(r.status_code, (403, 404))


class CableSchedulePdfTests(_Schedule):
    def test_renders_a_pdf(self):
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/cable-schedule/pdf/",
            {"group": "tray", "paper": {"size": "a4", "orientation": "portrait"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertEqual(r["Content-Type"], "application/pdf")
        self.assertTrue(r.content.startswith(b"%PDF"))

    def test_renders_with_the_plan_on_the_first_page(self):
        svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 50' width='100' "
               "height='50'><rect width='100' height='50' fill='#eee'/>"
               "<path d='M5 25 H95' stroke='#0ea5e9'/></svg>")
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/cable-schedule/pdf/?print=1",
            {"svg": svg}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        got = self.client.get(r.json()["url"])
        self.assertEqual(got.status_code, 200)
        self.assertTrue(got.content.startswith(b"%PDF"))

    def test_the_sheet_carries_groups_totals_and_hidden(self):
        data = self.schedule()
        data["hidden_count"] = 2
        import datetime as dt

        html = cable_schedule.sheet_html(
            data, title="Hall A", subtitle="Hall · AMS · T",
            generated=dt.datetime(2026, 10, 31, tzinfo=dt.UTC),
            paper="a4", orientation="landscape", thumbnail=False,
        )
        self.assertIn("Room: Hall B", html)
        self.assertIn("Totals by type", html)
        self.assertIn("2 cables hidden", html)
        self.assertIn("Pull with the patch run", html)

    def test_titles_are_escaped_in_the_page_footer(self):
        self.assertEqual(cable_schedule._css_str("a'b</style>"), "a\\27 b\\3c /style\\3e ")

    def test_a_bad_svg_is_refused(self):
        with mock.patch.object(cable_schedule, "run_with_deadline") as render:
            r = self.client.post(
                f"/api/floor-plans/{self.plan.id}/cable-schedule/pdf/",
                {"svg": "<svg><script>alert(1)</script>"}, format="json",
            )
        self.assertEqual(r.status_code, 400, r.content)
        render.assert_not_called()


class RiserScheduleTests(_Floors):
    def test_a_riser_cable_lists_its_riser_and_far_floor(self):
        self.pair()
        r = self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.up.id), "riser": str(self.r1.id)},
        ]}})
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/cable-schedule/")
        rows = {x["label"]: x for x in r.json()["rows"]}
        self.assertEqual(rows["C-up"]["route"], "OH-1 → R1 to Floor 2")
        self.assertEqual(rows["C-up"]["riser"]["vertical_m"], 3.0)
        r = self.client.get(f"/api/floor-plans/{self.plan2.id}/cable-schedule/")
        rows = {x["label"]: x for x in r.json()["rows"]}
        self.assertEqual(rows["C-up"]["route"], "OH-2 → R1 up to Hall A")
