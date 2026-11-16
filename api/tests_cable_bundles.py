"""Cable bundles, tighter tables and trace pages of the cable schedule PDF
and the floor-plan report (``api/cable_bundles.py``, ``api/cable_schedule.py``).

Bundles: the runs cut into pieces per line, each carrying the cables riding
all of it - a breakout's legs once, a cable riding several trays on each -
drawn as one stroke stepped by the count, coloured by type when it carries
one, counted where the count fits. Tables: values shared by a group are
said once; cables sharing a route are listed under it. Trace pages: a page
per cable the caller may view on this schedule, any other id refused alike.
"""
import datetime as dt
import math
import re
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase
from lxml import etree

from auth_api.models import ObjectPermission, UserProfile

from . import cable_bundles as cb
from . import cable_schedule
from . import cable_schedule_plan as cp
from . import floor_plan_report as rep
from .models import Cable, CableTermination, Device, FloorPlanTile, Interface
from .tests_floor_plan_report import SVG, _Report
from .tests_floorplan_cable_schedule import _Schedule

User = get_user_model()


def run(cid, pts, documented=True):
    return cb.Run(cid, [tuple(p) for p in pts], documented)


def pieces_by_count(pieces):
    return sorted((len(p.cables), round(p.length, 3)) for p in pieces)


class BundleCountTests(SimpleTestCase):
    def test_shared_stretch_carries_both_cables(self):
        pieces = cb.bundle([
            run("a", [(0, 0), (100, 0)]),
            run("b", [(40, 0), (100, 0), (100, 50)]),
        ])
        self.assertEqual(pieces_by_count(pieces), [(1, 40.0), (1, 50.0), (2, 60.0)])
        two = next(p for p in pieces if len(p.cables) == 2)
        self.assertEqual(two.cables, {"a", "b"})
        self.assertEqual((two.a, two.b), ((40.0, 0.0), (100.0, 0.0)))

    def test_runs_drawn_the_other_way_meet_on_one_line(self):
        pieces = cb.bundle([run("a", [(0, 10), (80, 10)]), run("b", [(80, 10), (0, 10)])])
        self.assertEqual(pieces_by_count(pieces), [(2, 80.0)])

    def test_a_breakout_counts_once_on_its_trunk(self):
        # One cable, two legs sharing the trunk to x=50, then apart.
        pieces = cb.bundle([
            run("brk", [(0, 0), (50, 0), (50, 30)]),
            run("brk", [(0, 0), (50, 0), (90, 0)]),
            run("other", [(0, 0), (50, 0)]),
        ])
        trunk = next(p for p in pieces if p.a == (0.0, 0.0))
        self.assertEqual(trunk.cables, {"brk", "other"})
        self.assertEqual(max(len(p.cables) for p in pieces), 2)

    def test_a_cable_riding_several_trays_counts_on_each(self):
        # Two trays at right angles; c1 rides both, c2 only the first,
        # c3 only the second.
        pieces = cb.bundle([
            run("c1", [(0, 0), (100, 0), (100, 100)]),
            run("c2", [(0, 0), (100, 0)]),
            run("c3", [(100, 0), (100, 100)]),
        ])
        self.assertEqual(pieces_by_count(pieces), [(2, 100.0), (2, 100.0)])
        self.assertEqual({p.cables for p in pieces}, {frozenset({"c1", "c2"}),
                                                     frozenset({"c1", "c3"})})

    def test_diagonal_trays_bundle_too(self):
        # A turned room: the tray at 28 degrees, points rounded as stored.
        d = (math.cos(math.radians(28)), math.sin(math.radians(28)))
        far = (round(400 * d[0], 2), round(400 * d[1], 2))
        mid = (round(150 * d[0], 2), round(150 * d[1], 2))
        pieces = cb.bundle([run("a", [(0, 0), far]), run("b", [mid, far])])
        self.assertEqual([len(p.cables) for p in sorted(pieces, key=lambda p: p.a[0])], [1, 2])

    def test_documented_and_inferred_are_kept_apart(self):
        pieces = cb.bundle([run("d", [(0, 0), (60, 0)]), run("i", [(0, 0), (60, 0)], False)])
        self.assertEqual(len(pieces), 1)
        self.assertEqual(pieces[0].documented, {"d"})
        self.assertEqual(pieces[0].inferred, {"i"})

    def test_excluded_cables_are_left_out(self):
        pieces = cb.bundle([run("a", [(0, 0), (60, 0)]), run("b", [(0, 0), (60, 0)])],
                           exclude={"a"})
        self.assertEqual([p.cables for p in pieces], [frozenset({"b"})])


class StepTests(SimpleTestCase):
    def test_width_steps(self):
        self.assertEqual([cb.step_of(n) for n in (1, 2, 3, 4, 7, 8, 16, 31, 32, 64, 500)],
                         [0, 1, 1, 2, 2, 3, 4, 4, 5, 6, 6])
        self.assertLess(cb.width_mm(1), cb.width_mm(2))
        self.assertLess(cb.width_mm(24), cb.width_mm(300))
        self.assertEqual([cb.step_text(i) for i in range(len(cb.STEPS))],
                         ["1", "2–3", "4–7", "8–15", "16–31", "32–63", "64+"])

    def test_a_small_print_narrows_the_strokes(self):
        self.assertEqual(cb.stroke_scale(0.1), 1.0)  # 4 mm a cell
        self.assertEqual(cb.stroke_scale(0.001), cb.MIN_SCALE)

    def test_the_palette_is_the_plans(self):
        info = {"1": {"type": "smf", "type_label": "OS2"}, "2": {"type": "smf"},
                "3": {"type": "cat6", "type_label": "CAT6"}}
        self.assertEqual(cb.palette(info), {"smf": cb.TYPE_PALETTE[0],
                                            "cat6": cb.TYPE_PALETTE[1]})


class DrawTests(SimpleTestCase):
    box = cp.Box(0, 0, 1000, 600)
    s = 0.2  # mm per px: 8 mm a cell

    def info(self, **types):
        return {cid: {"type": t, "type_label": t.upper()} for cid, t in types.items()}

    def draw(self, geometry, info, taken=None, **kw):
        b = cb.Bundles(geometry, info)
        root = etree.Element(f"{{{cb.SVG_NS}}}svg")
        b.draw(root, self.box, self.s, taken=taken, **kw)
        return b, root

    def geo(self, *runs, terms=()):
        return {"runs": [{"points": p, "documented": d} for p, d in runs], "terms": list(terms)}

    def strokes(self, root):
        g = root[0][1]
        return [(p.get("stroke"), float(p.get("stroke-width")) * self.s, p.get("stroke-dasharray"))
                for p in g]

    def test_one_stroke_per_piece_coloured_by_its_one_type(self):
        geometry = {c: self.geo(([(0, 100), (800, 100)], True)) for c in ("a", "b", "c")}
        b, root = self.draw(geometry, self.info(a="smf", b="smf", c="smf"))
        strokes = self.strokes(root)
        self.assertEqual(len(strokes), 1)
        colour, width, dash = strokes[0]
        self.assertEqual(colour, b.palette["smf"])
        self.assertAlmostEqual(width, cb.width_mm(3))
        self.assertIsNone(dash)
        # Counted on a shield.
        self.assertEqual([t.text for t in root.iter(f"{{{cb.SVG_NS}}}text")], ["3"])

    def test_a_mixed_piece_is_neutral_with_counts_per_type(self):
        geometry = {c: self.geo(([(0, 100), (800, 100)], True)) for c in ("a", "b", "c")}
        b, root = self.draw(geometry, self.info(a="smf", b="smf", c="cat6"))
        self.assertEqual(self.strokes(root)[0][0], cb.NEUTRAL)
        text = next(root.iter(f"{{{cb.SVG_NS}}}text"))
        self.assertEqual([(t.text, t.get("fill")) for t in text], [
            ("2", b.palette["smf"]), ("·", "#71717a"), ("1", b.palette["cat6"]),
        ])
        legend = b.legend_html()
        self.assertIn("Mixed", legend)
        self.assertIn("SMF <b>2</b>", legend)
        self.assertIn("2–3", legend)

    def test_every_piece_is_as_wide_as_its_count(self):
        # A trunk of 20 that sheds 15 on the way: two pieces, two widths.
        geometry = {f"c{i}": self.geo(([(0, 100), (800 if i < 5 else 300, 100)], True))
                    for i in range(20)}
        _b, root = self.draw(geometry, self.info(**{f"c{i}": "smf" for i in range(20)}))
        widths = sorted(round(w, 3) for _c, w, _d in self.strokes(root))
        self.assertEqual(widths, [cb.width_mm(5), cb.width_mm(20)])

    def test_inferred_runs_are_dashed_beside_documented_ones(self):
        geometry = {"d": self.geo(([(0, 100), (800, 100)], True)),
                    "i": self.geo(([(0, 100), (800, 100)], False))}
        b, root = self.draw(geometry, self.info(d="smf", i="smf"))
        strokes = self.strokes(root)
        self.assertEqual(len(strokes), 2)
        self.assertIsNone(strokes[0][2])
        self.assertIsNotNone(strokes[1][2])
        paths = list(root[0][1])
        self.assertNotEqual(paths[0].get("d"), paths[1].get("d"))
        self.assertIn("Inferred", b.legend_html())

    def test_counts_skip_short_pieces_tiles_and_repeats(self):
        # 10 px = 2 mm on paper: too short for its count.
        short = {c: self.geo(([(0, 100), (10, 100)], True)) for c in ("a", "b")}
        _b, root = self.draw(short, self.info(a="smf", b="smf"))
        self.assertEqual(list(root.iter(f"{{{cb.SVG_NS}}}text")), [])
        # A tile over the whole run: no free place.
        long = {c: self.geo(([(0, 100), (800, 100)], True)) for c in ("a", "b")}
        _b, root = self.draw(long, self.info(a="smf", b="smf"),
                             taken=[cb.Rect(0, 0, 1000, 200)])
        self.assertEqual(list(root.iter(f"{{{cb.SVG_NS}}}text")), [])
        # The same two cables round a corner close by: counted once.
        bend = {c: self.geo(([(0, 100), (300, 100), (300, 500)], True)) for c in ("a", "b")}
        _b, root = self.draw(bend, self.info(a="smf", b="smf"))
        self.assertEqual(len(list(root.iter(f"{{{cb.SVG_NS}}}text"))), 1)

    def test_counts_keep_off_each_other(self):
        geometry = {c: self.geo(([(0, 100), (800, 100)], True)) for c in ("a", "b")}
        geometry.update({c: self.geo(([(0, 104), (800, 104)], True)) for c in ("c", "d", "e")})
        b, root = self.draw(geometry, self.info(a="x", b="x", c="y", d="y", e="y"))
        rects = [r for r in root[0] if r.tag == f"{{{cb.SVG_NS}}}rect"]
        boxes = [cb.Rect(float(r.get("x")), float(r.get("y")),
                         float(r.get("x")) + float(r.get("width")),
                         float(r.get("y")) + float(r.get("height"))) for r in rects]
        self.assertEqual(len(boxes), 2)
        self.assertFalse(boxes[0].hits(boxes[1]))

    def test_one_stub_per_tile_with_its_count(self):
        terms = [("A", 400, 200, 440, 240, "sw", "e1")]
        geometry = {c: {"runs": [], "terms": terms} for c in ("a", "b", "c")}
        _b, root = self.draw(geometry, self.info(a="x", b="x", c="x"), stubs=True,
                             centre=(100, 100))
        g = root[0]
        stubs = [p for p in g if p.tag == f"{{{cb.SVG_NS}}}path"]
        self.assertEqual(len(stubs), 2)  # the line and its arrow
        self.assertEqual([t.text for t in g.iter(f"{{{cb.SVG_NS}}}text")], ["3"])

    def test_a_trace_draws_the_others_faint_and_names_its_ends(self):
        geometry = {
            "t": self.geo(([(50, 100), (800, 100)], True),
                          terms=[("A", 10, 80, 50, 120, "sw-a", "e1"),
                                 ("B", 800, 80, 840, 120, "", "")]),
            "o": self.geo(([(50, 100), (800, 100)], True)),
        }
        b = cb.Bundles(geometry, self.info(t="x", o="x"), exclude={"t"})
        root = etree.Element(f"{{{cb.SVG_NS}}}svg")
        b.draw(root, self.box, self.s, faint=True)
        b.draw_trace(root, "t", self.box, self.s)
        faint = root[0][1][0]
        self.assertEqual(faint.get("stroke"), cb.FAINT)
        texts = [t.text for t in root.iter(f"{{{cb.SVG_NS}}}text")]
        self.assertEqual(texts, ["A · sw-a · e1", "B · Hidden"])


class TextBoxTests(SimpleTestCase):
    def test_names_of_the_posted_drawing(self):
        root = etree.fromstring(
            "<svg xmlns='http://www.w3.org/2000/svg'>"
            "<text x='10' y='20' font-size='10'>Rack</text>"
            "<g transform='translate(100,0)'><text x='0' y='20' font-size='10' "
            "text-anchor='middle'>Row</text></g>"
            "<g transform='rotate(28,0,0)'><text x='0' y='0' font-size='10'>Turned</text></g>"
            "</svg>"
        )
        boxes = cb.text_boxes(root)
        self.assertEqual(len(boxes), 2)
        self.assertAlmostEqual(boxes[0].x0, 10)
        self.assertAlmostEqual(boxes[1].x0, 100 - 9)


def _row(i, **over):
    r = {
        "id": f"c{i}", "label": f"C-{i}", "type": "smf", "type_display": "OS2",
        "color": "", "status": {"name": "Connected", "color": "#22c55e", "text_color": ""},
        "a": [{"device": f"leaf-{i}", "port": "e1", "room": "Hall", "on_floor": True,
               "hidden": False}],
        "b": [{"device": "spine", "port": f"e{i}", "room": "MMR", "on_floor": True,
               "hidden": False}],
        "trays": ["OH-1"], "route": "OH-1 → OH-2", "route_source": "stored", "riser": None,
        "computed_m": 10.0, "length": 10.0, "length_unit": "m", "length_m": 10.0,
        "length_source": "computed", "notes": "", "rooms": ["Hall"],
    }
    r.update(over)
    return r


def _data(rows, groups):
    return {"group": "room", "rows": rows, "groups": groups, "totals": [],
            "total": {"count": len(rows), "metres": 0, "unmeasured": 0}, "hidden_count": 0}


class TableTests(SimpleTestCase):
    def test_values_shared_by_the_schedule_go_in_its_facts(self):
        rows = [_row(1), _row(2), _row(3, route="OH-3")]
        html, facts = cable_schedule.schedule_tables(
            _data(rows, [{"name": "Hall", "rows": ["c1", "c2", "c3"]}]), width_mm=270,
            group_word="Room")
        self.assertIn("OS2", facts)
        self.assertIn("Connected", facts)
        self.assertIn("Computed lengths", facts)
        self.assertIn("MMR", facts)
        for col in ("<th>Type</th>", "<th>Status</th>", "<th>Source</th>", "<th>B room</th>"):
            self.assertNotIn(col, html)
        # Kept: label, ends, lengths.
        for col in ("<th>Cable</th>", "<th>A end</th>", "<th>B end</th>",
                    "<th class='n'>Computed</th>"):
            self.assertIn(col, html)
        # Notes are empty for every cable: no column.
        self.assertNotIn("Notes", html)

    def test_values_shared_by_a_group_go_in_its_heading(self):
        rows = [_row(1), _row(2), _row(3, type="cat6", type_display="CAT6", route="X"),
                _row(4, type="cat6", type_display="CAT6", route="Y")]
        html, facts = cable_schedule.schedule_tables(
            _data(rows, [{"name": "Hall", "rows": ["c1", "c2"]},
                         {"name": "Lab", "rows": ["c3", "c4"]}]), width_mm=270,
            group_word="Room")
        self.assertNotIn("OS2", facts)
        first, second = html.split("<h2 class='grp'>")[1:]
        self.assertIn("2 cables · OS2", first)
        self.assertIn("2 cables · CAT6", second)
        self.assertNotIn("<th>Type</th>", first)

    def test_cables_sharing_a_route_are_listed_under_it(self):
        rows = [_row(1), _row(2), _row(3, route="OH-9"), _row(4, route="")]
        html, _facts = cable_schedule.schedule_tables(
            _data(rows, [{"name": "Hall", "rows": ["c1", "c2", "c3", "c4"]}]),
            width_mm=270)
        self.assertNotIn("<th>Route</th>", html)
        self.assertEqual(html.count("<tr class='band'>"), 3)
        self.assertIn("Route <b>OH-1 → OH-2</b><span class='cnt'>2 cables</span>", html)
        self.assertIn("<b>No route</b>", html)
        # One band per route, then its cables; no route last.
        self.assertLess(html.index("OH-1 → OH-2"), html.index("C-1"))
        self.assertLess(html.index("C-3"), html.index("No route"))

    def test_unique_routes_keep_the_route_column(self):
        rows = [_row(1, route="A"), _row(2, route="B")]
        html, _facts = cable_schedule.schedule_tables(
            _data(rows, [{"name": "Hall", "rows": ["c1", "c2"]}]), width_mm=270)
        self.assertIn("<th>Route</th>", html)
        self.assertNotIn("band", html)

    def test_columns_fit_labels_and_ends_whole(self):
        rows = [_row(1, label="XC-C101-B01-53"), _row(2)]
        html, _f = cable_schedule.schedule_tables(
            _data(rows, [{"name": "Hall", "rows": ["c1", "c2"]}]), width_mm=270)
        widths = [float(w) for w in re.findall(r"width:([\d.]+)mm", html)]
        self.assertGreaterEqual(widths[0], len("XC-C101-B01-53") * cable_schedule.BOLD_MM)

    def test_the_detail_column_names_trace_pages(self):
        rows = [_row(1), _row(2)]
        html = cable_schedule.sheet_html(
            _data(rows, [{"name": "Hall", "rows": ["c1", "c2"]}]), title="T", subtitle="",
            generated=dt.datetime(2026, 11, 1, tzinfo=dt.UTC), paper="a4",
            orientation="landscape", thumbnail=False,
            traces=[{"label": "T1", "url": "https://danbyte.invalid/_/trace-T1.svg",
                     "cable": "c2"}])
        self.assertIn("<td class='ref'>T1</td>", html)
        self.assertIn("Trace T1 · C-2", html)
        self.assertIn("<th>Trays</th><td>OH-1</td>", html.replace("\n", ""))


class _Many(_Schedule):
    """The schedule's plan with a second cable in OH-1 between the racks."""

    def setUp(self):
        super().setUp()
        cache.clear()
        self.c2 = self._cable("C-2", self.dev_a, self.dev_b)
        self.c2.type = "cat6"
        self.c2.save()
        self.store(self.c2)

    def url(self, rest):
        return f"/api/floor-plans/{self.plan.id}/cable-schedule/{rest}"


class TraceApiTests(_Many):
    def layout(self, ids, **kw):
        return self.client.get(self.url("closeups/"), {
            "closeups": "off", "trace": ",".join(str(i) for i in ids), **kw})

    def test_the_layout_frames_each_traced_cable(self):
        r = self.layout([self.cable.id, self.c2.id])
        self.assertEqual(r.status_code, 200, r.content)
        traces = r.json()["traces"]
        self.assertEqual([t["label"] for t in traces], ["T1", "T2"])
        self.assertEqual(traces[0]["cable"], str(self.cable.id))
        x, y, w, h = traces[0]["box"]
        # The route (x 0..11) and both tiles inside the frame.
        self.assertLessEqual(x, 0.5 * cp.CELL)
        self.assertGreaterEqual(x + w, 10.5 * cp.CELL)
        self.assertEqual(r.json()["traces_dropped"], 0)

    def test_without_closeups_no_box_is_needed_but_with_them_it_is(self):
        self.assertEqual(self.layout([self.cable.id]).status_code, 200)
        r = self.client.get(self.url("closeups/"), {"closeups": "auto"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("box", r.json())

    def refused(self, cid):
        r = self.layout([cid])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"trace": ["Not a cable of this schedule."]})
        with mock.patch.object(cable_schedule, "run_with_deadline") as render:
            r = self.client.post(self.url("pdf/"), {"trace": [str(cid)]}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"trace": ["Not a cable of this schedule."]})
        render.assert_not_called()

    def test_another_tenants_cable_is_refused(self):
        from core.models import Organization, Tenant

        other = Tenant.objects.create(org=Organization.objects.create(name="X", slug="x"),
                                      name="X", slug="x")
        self.refused(Cable.objects.create(tenant=other, label="theirs").id)

    def test_a_cable_not_on_this_plan_is_refused(self):
        lone = Device.objects.create(tenant=self.tenant, name="lone", site=self.site)
        far = Device.objects.create(tenant=self.tenant, name="far", site=self.site)
        self.refused(self._cable("C-elsewhere", lone, far).id)

    def test_a_hidden_cable_is_refused_like_any_other(self):
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile", "floorplancablepath",
                                    "device"], actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        cables = ObjectPermission.objects.create(
            name="c", object_types=["cable"], actions=["view"], constraints={"label": "C-1"})
        cables.users.add(user)
        cables.tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.layout([self.cable.id]).status_code, 200)
        self.refused(self.c2.id)

    def test_bad_ids_are_refused(self):
        r = self.client.get(self.url("closeups/"), {"closeups": "off", "trace": "nope"})
        self.assertEqual(r.status_code, 400)

    def test_pages_are_capped_and_the_rest_counted(self):
        extra = [self._cable(f"X-{i}", self.dev_a, self.dev_b) for i in range(21)]
        ids = [c.id for c in extra]
        r = self.layout(ids)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["traces"]), cp.MAX_TRACES)
        self.assertEqual(r.json()["traces_dropped"], 1)
        with mock.patch.object(cable_schedule, "run_with_deadline",
                               return_value=b"%PDF-1.7 fake") as render:
            r = self.client.post(self.url("pdf/"), {"trace": [str(i) for i in ids]},
                                 format="json")
        self.assertEqual(r.status_code, 200, r.content)
        kw = render.call_args.kwargs
        self.assertEqual(len(kw["traces"]), cp.MAX_TRACES)
        self.assertIn("1 more cable", kw["trace_note"])
        r = self.client.post(self.url("pdf/"), {
            "trace_svgs": {str(i): SVG for i in ids}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_trace_page_composes_the_cable_over_the_others(self):
        svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 800' "
               "width='1600' height='800'><rect width='10' height='10'/></svg>")
        with mock.patch.object(cable_schedule, "run_with_deadline",
                               return_value=b"%PDF-1.7 fake") as render:
            r = self.client.post(self.url("pdf/"), {
                "svg": svg, "cables": "bundles", "trace": [str(self.cable.id)],
                "closeups": "off"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        kw = render.call_args.kwargs
        page = kw["pages"][kw["traces"][0]["url"]].decode()
        self.assertIn(cb.FAINT, page)
        self.assertIn("A · sw-a", page)
        self.assertIn("B · sw-b", page)
        overview = render.call_args.args[1].decode()
        self.assertIn("data-bundles", overview)
        # Two cables in OH-1 between the racks: counted.
        self.assertIn(">2<", overview.replace("</tspan>", "<"))
        self.assertIn("Cables per stroke", kw["legend"])

    def test_lines_mode_draws_nothing_here(self):
        svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 800' "
               "width='1600' height='800'><rect width='10' height='10'/></svg>")
        with mock.patch.object(cable_schedule, "run_with_deadline",
                               return_value=b"%PDF-1.7 fake") as render:
            r = self.client.post(self.url("pdf/"), {"svg": svg, "closeups": "off"},
                                 format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn(b"data-bundles", render.call_args.args[1])
        self.assertEqual(render.call_args.kwargs["legend"], "")

    def test_a_real_render_with_bundles_and_a_trace(self):
        svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 800' "
               "width='1600' height='800'><rect width='10' height='10'/></svg>")
        r = self.client.post(self.url("pdf/"), {
            "svg": svg, "cables": "bundles", "trace": [str(self.c2.id)],
            "trace_svgs": {str(self.c2.id): svg}}, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF"))


class InferredRunTests(_Many):
    def test_a_cable_without_a_stored_route_is_routed_through_its_trays(self):
        from .models import FloorPlanCablePath

        FloorPlanCablePath.objects.filter(cable=self.c2).delete()
        self.tray.cables.add(self.c2)
        geometry: dict = {}
        cable_schedule.build(self.plan, None, self.admin, self.tenant, geometry=geometry,
                             routes=True)
        runs = geometry[str(self.c2.id)]["runs"]
        self.assertEqual(len(runs), 1)
        self.assertFalse(runs[0]["documented"])
        # Up to the tray at y=1, along it, back down.
        self.assertGreater(len(runs[0]["points"]), 2)
        self.assertTrue(all(abs(p[1] - 1) < 1e-6 for p in runs[0]["points"][1:-1]))
        stored = geometry[str(self.cable.id)]["runs"]
        self.assertTrue(stored[0]["documented"])
        self.assertEqual({t[0] for t in geometry[str(self.cable.id)]["terms"]}, {"A", "B"})

    def test_a_breakout_routes_a_leg_per_far_tile(self):
        tile_c = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt,
                                              x=20, y=2, device=Device.objects.create(
                                                  tenant=self.tenant, name="sw-c",
                                                  site=self.site), link_kind="device")
        brk = Cable.objects.create(tenant=self.tenant, label="BRK")
        CableTermination.objects.create(cable=brk, end="A", interface=Interface.objects.create(
            device=self.dev_a, name="brk0"))
        for d in (self.dev_b, tile_c.device):
            CableTermination.objects.create(cable=brk, end="B", interface=(
                Interface.objects.create(device=d, name="brk")))
        geometry: dict = {}
        cable_schedule.build(self.plan, None, self.admin, self.tenant, geometry=geometry,
                             routes=True)
        self.assertEqual(len(geometry[str(brk.id)]["runs"]), 2)
        pieces = cb.bundle(cb.runs_of(cp.to_px({str(brk.id): geometry[str(brk.id)]})))
        self.assertTrue(all(len(p.cables) == 1 for p in pieces))


class ReportTests(_Report):
    def sheet(self, plan=None):
        return {"floor": str((plan or self.plan).pk), "svg": SVG}

    def test_trace_pages_come_with_the_cable_schedule(self):
        with self.fake as render:
            r = self.post({"scope": "floor", "sheets": [self.sheet()],
                           "trace": [str(self.cable.id)]})
        self.assertEqual(r.status_code, 400, r.content)
        render.assert_not_called()

    def test_a_trace_page_of_a_cable_in_the_report(self):
        with self.fake as render:
            r = self.post({"scope": "floor", "include": ["plan", "cables"],
                           "sheets": [self.sheet()], "cables": "bundles",
                           "trace": [str(self.cable.id)]})
        self.assertEqual(r.status_code, 200, r.content)
        kw = render.call_args.kwargs
        self.assertEqual([t["label"] for t in kw["traces"]], ["T1"])
        self.assertIn(kw["traces"][0]["url"], kw["pages"])
        sheet = kw["pages"][kw["sheets"][0]["url"]].decode()
        self.assertIn("data-bundles", sheet)
        self.assertIn("Cables per stroke", kw["sheets"][0]["bundle_legend"])

    def test_a_cable_outside_the_report_is_refused(self):
        # A room round RA only lists the cables of its tiles; one of
        # another floor is not on this floor's schedule.
        with self.fake as render:
            r = self.post({"scope": "floor", "include": ["plan", "cables"],
                           "sheets": [self.sheet()], "trace": [str(self.plan2.pk)]})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"trace": ["Not a cable of this schedule."]})
        render.assert_not_called()

    def test_the_cable_section_uses_the_schedules_tables(self):
        data = self.ok({"scope": "floor"})["cables"]
        html = rep._cables_html(data, False, width_mm=400)
        self.assertIn("table class='sched'", html)
        self.assertIn("Totals by type", html)

    def test_a_real_render_with_bundles(self):
        r = self.post({"scope": "floor", "include": ["plan", "cables"],
                       "paper": {"size": "a4", "orientation": "landscape"},
                       "sheets": [self.sheet()], "cables": "bundles",
                       "trace": [str(self.cable.id)]})
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF-"))
