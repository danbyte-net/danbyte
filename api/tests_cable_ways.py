"""Cable ways through racks (docs/dcim/racks.md → Cable ways): the
proposal engine's rules, the stored ways and their API with its
permissions and tenant and site fences, Record automatically, lengths
from ways and room routes, the management command, a pathway's cable
count and a 0U device's channel by key."""
from __future__ import annotations

from io import StringIO

from django.contrib.auth.models import User
from django.core.management import call_command
from django.test import SimpleTestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import TenantSettings

from . import cable_way_engine as eng
from . import rack_pathways as rp
from .cable_routing import length_total
from .models import (
    Cable,
    CableTermination,
    CableWay,
    Device,
    DeviceType,
    FloorPlan,
    FloorPlanCablePath,
    FloorPlanTile,
    FloorTileType,
    Interface,
    Location,
    Manufacturer,
    PowerOutlet,
    PowerPort,
    Rack,
    RackPathway,
    RackType,
    Site,
)
from .pathfinding import RACK_PLINTH_MM, U_PITCH_MM
from .tests_rack_look_kits import _Base

# ── the engine ──────────────────────────────────────────────────────────────


def frame(kind="cabinet", units=42):
    return rp.Frame(frame=kind, kit=None, top="solid", base="plinth", side_panels=True,
                    start=1, units=units, width_mm=600, depth_mm=1000)


def items(kind="cabinet", extra=(), hide=()):
    """A frame's default pathways plus ``extra`` ones of its own."""
    fr = frame(kind)
    out = rp.base_items(fr)
    for i, spec in enumerate(extra):
        out.append(rp._blank_item(key=f"manual:{i}", id=f"id-{i}", source="manual", **spec))
    for it in out:
        if it["key"] in hide:
            it["hidden"] = True
    return rp.finish(out, fr)


GEO = eng.Geo(start=1, units=42, width_mm=600, depth_mm=1000, cap_mm=rp.CAP_MM)
#: The cabinet's default front managers, hidden where a test brings its own.
FRONTS = ("path:vertical:left:front", "path:vertical:right:front")
FRONT_LEFT = {"kind": "vertical", "side": "left", "face": "front", "inner_w_mm": 50}
FRONT_RIGHT = {"kind": "vertical", "side": "right", "face": "front", "inner_w_mm": 50}
FULL_LEFT = {"kind": "vertical", "side": "left", "face": "full", "inner_w_mm": 50}


def end(e="A", u=20, face="front", side="left", **kw):
    return eng.End(end=e, port=f"p{u}", u=u, face=face, side=side, **kw)


def keys(doc):
    return [h["key"] for h in doc["hops"]]


class EngineTests(SimpleTestCase):
    def test_same_rack_front_to_front(self):
        its = items(extra=[FRONT_LEFT, FRONT_RIGHT], hide=FRONTS)
        doc = eng.propose(its, GEO, [end("A", 40), end("B", 30)])
        self.assertEqual(keys(doc), ["manual:0"])
        self.assertEqual((doc["hops"][0]["enter_u"], doc["hops"][0]["leave_u"]), (40, 30))
        self.assertEqual(doc["exit"], "port")
        self.assertIn("same-rack", doc["reasons"])
        # Across to the manager and into it, ten units down, back out and
        # across: the manager where the rack lays it out (its ``geo``).
        geo = next(i for i in its if i["key"] == "manual:0")["geo"]
        across = abs(geo["cx"]) - eng.FACEPLATE_MM / 4
        into = abs(geo["cy"] - eng.FACE_INSET_MM)
        self.assertEqual(doc["length_mm"], round(2 * (across + into) + 10 * U_PITCH_MM))
        self.assertEqual(keys(doc["alternatives"][0]), ["manual:1"])
        self.assertIn("other-side", doc["alternatives"][0]["reasons"])

    def test_front_to_rear_prefers_a_full_depth_manager(self):
        its = items(extra=[FRONT_LEFT, FULL_LEFT], hide=FRONTS)
        doc = eng.propose(its, GEO, [end("A", 40), end("B", 30, face="rear")])
        self.assertEqual(keys(doc), ["manual:1"])
        self.assertIn("full-depth", doc["reasons"])
        alt = next(a for a in doc["alternatives"] if keys(a) == ["manual:0"])
        self.assertIn("crosses-depth", alt["reasons"])

    def test_the_ports_side(self):
        its = items(extra=[FRONT_LEFT, FRONT_RIGHT], hide=FRONTS)
        doc = eng.propose(its, GEO, [end("A", 20, side="right")])
        self.assertEqual(keys(doc)[0], "manual:1")
        self.assertIn("side-right", doc["reasons"])
        doc = eng.propose(its, GEO, [end("A", 20, side="left")])
        self.assertEqual(keys(doc)[0], "manual:0")

    def test_overhead_and_underfloor_exits(self):
        its = items()
        up = eng.propose(its, GEO, [end("A", 20, face="rear")], exit_pref="top")
        self.assertEqual(keys(up), ["path:vertical:left:rear", "entry:top:roof"])
        self.assertEqual((up["hops"][0]["enter_u"], up["hops"][0]["leave_u"]), (20, 42))
        self.assertEqual(up["exit"], "top")
        self.assertIn("exit-overhead", up["reasons"])
        down = eng.propose(its, GEO, [end("A", 20, face="rear")], exit_pref="bottom")
        self.assertEqual(keys(down), ["path:vertical:left:rear", "entry:bottom:floor"])
        self.assertEqual(down["hops"][0]["leave_u"], 1)
        self.assertIn("exit-underfloor", down["reasons"])
        # The roof's way climbs to the top; the floor's drops to the floor.
        self.assertEqual(up["points"][-1][2], round(GEO.top_z))
        self.assertEqual(down["points"][-1][2], 0)

    def test_no_room_route_takes_the_first_way_out(self):
        doc = eng.propose(items(), GEO, [end("A", 30, face="rear")])
        self.assertIn("exit-default", doc["reasons"])
        self.assertTrue(doc["alternatives"])

    def test_power_cord_to_a_pdu_channel(self):
        its = items()
        server = end("A", 10, face="rear", side="right", power=True)
        pdu = end("B", 21, face="rear", side="left", power=True, channel="channel:0u:left:rear")
        doc = eng.propose(its, GEO, [server, pdu])
        self.assertEqual(keys(doc), ["channel:0u:left:rear"])
        self.assertIn("pdu-channel", doc["reasons"])
        # The PDU as A: the way still runs from A.
        flipped = eng.propose(its, GEO, [eng.End(**{**pdu.__dict__, "end": "A"}),
                                         eng.End(**{**server.__dict__, "end": "B"})])
        self.assertEqual(keys(flipped), ["channel:0u:left:rear"])
        self.assertEqual(flipped["length_mm"], doc["length_mm"])

    def test_a_pdus_own_cord_runs_its_channel(self):
        pdu = end("A", 21, face="rear", side="left", power=True,
                  channel="channel:0u:left:rear")
        doc = eng.propose(items(), GEO, [pdu], exit_pref="bottom")
        self.assertEqual(keys(doc), ["channel:0u:left:rear", "entry:bottom:floor"])

    def test_no_pathways_no_proposal(self):
        self.assertEqual(items("4-post"), [])
        self.assertIsNone(eng.propose([], GEO, [end()]))
        self.assertIsNone(eng.propose([], GEO, [end("A", 1), end("B", 2)]))

    def test_hidden_pathways_take_no_part(self):
        its = items(hide=("path:vertical:left:rear",))
        doc = eng.propose(its, GEO, [end("A", 20, face="rear")], exit_pref="top")
        self.assertEqual(keys(doc)[0], "path:vertical:right:rear")
        self.assertIn("other-side", doc["reasons"])
        for alt in doc["alternatives"]:
            self.assertNotIn("path:vertical:left:rear", keys(alt))

    def test_an_unknown_side_is_ambiguous_and_still_deterministic(self):
        its = items(extra=[FRONT_LEFT, FRONT_RIGHT], hide=FRONTS)
        a = eng.propose(its, GEO, [end("A", 20, side="")])
        b = eng.propose(its, GEO, [end("A", 20, side="")])
        self.assertEqual(a, b)
        self.assertIn("side-guessed", a["reasons"])
        firsts = {keys(x)[0] for x in [a, *a["alternatives"]]}
        self.assertEqual(firsts, {"manual:0", "manual:1"})

    def test_a_horizontal_manager_next_to_the_port(self):
        hm = {"kind": "horizontal", "face": "front", "u_from": 21, "u_to": 21}
        its = items(extra=[FRONT_LEFT, hm], hide=FRONTS)
        doc = eng.propose(its, GEO, [end("A", 20)])
        self.assertEqual(keys(doc)[:2], ["manual:1", "manual:0"])
        self.assertIn("horizontal-manager", doc["reasons"])
        # Two ports next to one manager: through it alone.
        doc = eng.propose(its, GEO, [end("A", 20), end("B", 22)])
        self.assertEqual(keys(doc), ["manual:1"])

    def test_without_a_vertical_straight_to_the_entry(self):
        doc = eng.propose(items("wall-cabinet"), GEO, [end("A", 5)], exit_pref="top")
        self.assertEqual(keys(doc), ["entry:top:roof"])
        self.assertIn("no-vertical", doc["reasons"])

    def test_measure_checks_a_way(self):
        its = items(hide=("path:vertical:right:rear",))
        e = [end("A", 20, face="rear")]
        hops = [{"key": "path:vertical:left:rear", "enter_u": 20, "leave_u": 42},
                {"key": "entry:top:roof"}]
        doc = eng.measure(its, GEO, e, hops, "top")
        self.assertEqual(doc["length_mm"], eng.propose(its, GEO, e, exit_pref="top")["length_mm"])
        with self.assertRaisesMessage(ValueError, "hidden"):
            eng.measure(its, GEO, e, [{"key": "path:vertical:right:rear"}], "top")
        with self.assertRaisesMessage(ValueError, "last hop"):
            eng.measure(its, GEO, e, list(reversed(hops)), "top")
        with self.assertRaisesMessage(ValueError, "does not reach U50"):
            eng.measure(its, GEO, e, [{"key": "path:vertical:left:rear", "enter_u": 50}], "top")
        with self.assertRaisesMessage(ValueError, "not a pathway"):
            eng.measure(its, GEO, e, [{"key": "path:vertical:left:full"}], "top")


# ── the database ────────────────────────────────────────────────────────────

MARKERS = {"front": [
    {"kind": "interface", "name": "eth-l", "x": 0.05, "y": 0.4, "w": 0.04, "h": 0.2},
    {"kind": "interface", "name": "eth-r", "x": 0.9, "y": 0.4, "w": 0.04, "h": 0.2},
]}


class _WayBase(_Base):
    def setUp(self):
        super().setUp()
        self.rt = RackType.objects.create(tenant=self.tenant, name="Cab", frame="cabinet")
        self.rack = Rack.objects.create(tenant=self.tenant, name="R1", site=self.site,
                                        rack_type=self.rt)
        self.rack2 = Rack.objects.create(tenant=self.tenant, name="R2", site=self.site,
                                         rack_type=self.rt)
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="G", slug="g")
        self.dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, name="1U",
                                            model="1U",
                                            u_height=1, image_ports=MARKERS)
        # Rear-facing: their front ports are at the rack's rear, where the
        # cabinet's corner channels are.
        self.sw = self.device("sw", self.rack, 40)
        self.pp = self.device("pp", self.rack, 30)
        self.far = self.device("far", self.rack2, 20)

    def device(self, name, rack, u, face="rear"):
        return Device.objects.create(tenant=self.tenant, name=name, site=rack.site, rack=rack,
                                     position=u, face=face, device_type=self.dt)

    def cable(self, a, b, a_port="eth-l", b_port="eth-l", tenant=None):
        c = Cable.objects.create(tenant=tenant or self.tenant)
        CableTermination.objects.create(
            cable=c, end="A", interface=Interface.objects.create(device=a, name=a_port))
        CableTermination.objects.create(
            cable=c, end="B", interface=Interface.objects.create(device=b, name=b_port))
        return c

    def summary(self, cable, code=200):
        r = self.client.get("/api/cable-ways/summary/", {"cable": cable.pk})
        self.assertEqual(r.status_code, code, r.content)
        return r.json()

    def post(self, url, data, code=201):
        r = self.client.post(url, data, format="json")
        self.assertEqual(r.status_code, code, r.content)
        return r.json()

    def record_mode(self):
        TenantSettings.objects.update_or_create(tenant=self.tenant,
                                                defaults={"cable_ways_mode": "record"})


class ProposeAcceptTests(_WayBase):
    def test_a_proposal_until_accepted(self):
        c = self.cable(self.sw, self.pp)
        doc = self.summary(c)
        self.assertEqual(doc["mode"], "propose")
        (rack,) = doc["racks"]
        self.assertEqual((rack["end"], rack["way"]), ("AB", None))
        prop = rack["proposal"]
        # eth-l on a rear-facing device's front: the rack's rear, its right.
        self.assertEqual([h["key"] for h in prop["hops"]], ["path:vertical:right:rear"])
        self.assertIn("side-right", prop["reasons"])
        self.assertFalse(CableWay.objects.exists())
        self.assertIsNone(doc["length"])

        way = self.post("/api/cable-ways/accept/", {"cable_id": str(c.pk),
                                                    "rack_id": str(self.rack.pk)})
        self.assertEqual((way["state"], way["source"], way["stale"]), ("recorded", "auto", False))
        row = RackPathway.objects.get(rack=self.rack, key="path:vertical:right:rear")
        self.assertEqual(way["hops"][0]["pathway"], str(row.pk))
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=way["id"]).exists())
        # The length now comes from the way, by the tenant's rules.
        doc = self.summary(c)
        rules = {"slack_pct": 10, "service_loop_mm": 0, "step_mm": 500}
        self.assertEqual(doc["length"]["length_mm"], length_total(way["length_mm"], rules)[2])
        self.assertEqual(self.client.get(f"/api/cables/{c.pk}/").json()["ways"][0]["hops"], 1)

    def test_an_alternative_and_dismiss(self):
        c = self.cable(self.sw, self.far)
        prop = self.summary(c)["racks"][0]["proposal"]
        self.assertTrue(prop["alternatives"])
        way = self.post("/api/cable-ways/accept/", {"cable_id": str(c.pk),
                                                    "rack_id": str(self.rack.pk),
                                                    "alternative": 0})
        self.assertEqual([h["key"] for h in way["hops"]],
                         [h["key"] for h in prop["alternatives"][0]["hops"]])
        self.post("/api/cable-ways/accept/", {"cable_id": str(c.pk), "rack_id": str(self.rack.pk),
                                              "alternative": 9}, code=400)
        way = self.post("/api/cable-ways/dismiss/", {"cable_id": str(c.pk),
                                                     "rack_id": str(self.rack2.pk)})
        self.assertEqual((way["state"], way["hops"]), ("dismissed", []))

    def test_propose_writes_nothing(self):
        c = self.cable(self.sw, self.far)
        doc = self.post("/api/cable-ways/propose/", {"cable_id": str(c.pk)}, code=200)
        self.assertEqual({r["end"] for r in doc["racks"]}, {"A", "B"})
        self.assertFalse(CableWay.objects.exists())
        self.assertFalse(RackPathway.objects.exists())


class ManualWayTests(_WayBase):
    def setUp(self):
        super().setUp()
        self.c = self.cable(self.sw, self.far)

    def way(self, hops, code=201, rack=None, **kw):
        return self.post("/api/cable-ways/", {"cable_id": str(self.c.pk),
                                              "rack_id": str((rack or self.rack).pk),
                                              "hops": hops, **kw}, code=code)

    def test_a_manual_way(self):
        way = self.way([{"key": "path:vertical:left:rear", "enter_u": 40, "leave_u": 42},
                        {"key": "entry:top:roof"}])
        self.assertEqual((way["source"], way["state"], way["exit"]), ("manual", "recorded", "top"))
        self.assertGreater(way["length_mm"], 0)
        r = self.client.patch(f"/api/cable-ways/{way['id']}/", {"hops": [
            {"key": "path:vertical:left:rear", "enter_u": 40, "leave_u": 1},
            {"key": "entry:bottom:floor"}]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["exit"], "bottom")
        self.way([{"key": "entry:top:roof"}], code=400)  # one per rack

    def test_hops_are_checked(self):
        RackPathway.objects.create(tenant=self.tenant, rack=self.rack,
                                   key="path:vertical:right:rear", hidden=True)
        bad = [
            [{"key": "path:vertical:right:rear"}],
            [{"key": "entry:top:roof"}, {"key": "path:vertical:left:rear"}],
            [{"key": "path:vertical:left:full"}],
            [{"key": "path:vertical:left:rear", "enter_u": 40, "leave_u": 42},
             {"key": "channel:0u:left:rear", "enter_u": 30}],
            [],
        ]
        for hops in bad:
            self.assertIn("hops", self.way(hops, code=400), hops)
        # Another rack's pathway row.
        other = RackPathway.objects.create(tenant=self.tenant, rack=self.rack2,
                                           key="entry:top:roof")
        self.assertIn("hops", self.way([{"pathway_id": str(other.pk)}], code=400))
        # A rack the cable has no end in.
        r3 = Rack.objects.create(tenant=self.tenant, name="R3", site=self.site, rack_type=self.rt)
        self.assertIn("rack_id", self.way([{"key": "entry:top:roof"}], code=400, rack=r3))


class RecordModeTests(_WayBase):
    def test_recorded_on_create_and_idempotent(self):
        self.record_mode()
        a = Interface.objects.create(device=self.sw, name="eth-r")
        b = Interface.objects.create(device=self.far, name="eth-r")
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post("/api/cables/", {"a": [{"kind": "interface", "id": str(a.pk)}],
                                                  "b": [{"kind": "interface", "id": str(b.pk)}]},
                                 format="json")
        self.assertEqual(r.status_code, 201, r.content)
        ways = CableWay.objects.filter(cable_id=r.json()["id"])
        self.assertEqual({(w.state, w.source) for w in ways}, {("recorded", "auto")})
        self.assertEqual(ways.count(), 2)
        stamps = sorted(w.updated_at for w in ways)
        from .cable_ways import refresh

        self.assertEqual(refresh(Cable.objects.get(pk=r.json()["id"])), [])
        self.assertEqual(sorted(w.updated_at for w in ways.all()), stamps)

    def test_a_manual_way_is_never_replaced(self):
        c = self.cable(self.sw, self.far)
        manual = CableWay.objects.create(tenant=self.tenant, cable=c, rack=self.rack, end="A",
                                         hops=[{"key": "entry:top:roof"}], exit="top")
        self.record_mode()
        with self.captureOnCommitCallbacks(execute=True):
            t = c.terminations.get(end="B")
            t.interface = Interface.objects.create(device=self.pp, name="x")
            t.save()
        manual.refresh_from_db()
        self.assertEqual((manual.source, manual.hops), ("manual", [{"key": "entry:top:roof"}]))
        # B moved into R1 too: the cable is now one way in one rack, kept manual.
        self.assertFalse(CableWay.objects.filter(cable=c, rack=self.rack2).exists())

    def test_propose_mode_writes_nothing_on_create(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.cable(self.sw, self.far)
        self.assertFalse(CableWay.objects.exists())


class LengthTests(_WayBase):
    def test_route_drops_start_at_the_entries(self):
        loc = Location.objects.create(tenant=self.tenant, site=self.site, name="H", slug="h")
        plan = FloorPlan.objects.create(tenant=self.tenant, location=loc, name="Hall",
                                        cell_mm=600, ceiling_mm=3000, grid_width=40,
                                        grid_height=20)
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        ta = FloorPlanTile.objects.create(floor_plan=plan, tile_type=tt, x=0, y=2,
                                          rack=self.rack, link_kind="rack")
        tb = FloorPlanTile.objects.create(floor_plan=plan, tile_type=tt, x=10, y=2,
                                          rack=self.rack2, link_kind="rack")
        c = self.cable(self.sw, self.far)
        leg = {"from": {"end": "A", "tile": str(ta.pk), "at": [0.5, 2.5]},
               "to": {"end": "B", "tile": str(tb.pk), "at": [10.5, 2.5]},
               "points": [[0.5, 2.5], [10.5, 2.5]],
               "trays": [{"id": "t", "entry": [0.5, 2.5], "exit": [10.5, 2.5],
                          "elevation_mm": 2700}], "waypoints": []}
        path = FloorPlanCablePath.objects.create(tenant=self.tenant, floor_plan=plan, cable=c,
                                                 legs=[leg], run_mm=6000)
        before = self.summary(c)
        # Without ways: the floor plan's own drops, from the ports.
        self.assertEqual((before["length"]["ways"], before["length"].get("way_a_mm")), ([], None))
        port_drop = before["length"]["drop_a_mm"]
        # The overhead route makes the proposal leave by the roof.
        self.assertEqual(before["racks"][0]["route"]["exit"], "top")
        for rack in (self.rack, self.rack2):
            way = self.post("/api/cable-ways/accept/", {"cable_id": str(c.pk),
                                                        "rack_id": str(rack.pk)})
            self.assertEqual(way["exit"], "top")
        doc = self.summary(c)["length"]
        top = RACK_PLINTH_MM + 42 * U_PITCH_MM
        ways = {w["rack"]["name"]: w["length_mm"] for w in doc["ways"]}
        self.assertEqual(doc["drop_a_mm"], round(2700 - top + ways["R1"]))
        self.assertEqual(doc["drop_b_mm"], round(2700 - top + ways["R2"]))
        self.assertEqual((doc["way_a_mm"], doc["route"]), (ways["R1"], "Hall"))
        self.assertNotEqual(doc["drop_a_mm"], port_drop)
        path.refresh_from_db()
        self.assertEqual(path.length_mm, doc["length_mm"])  # remeasured on accept


class PermissionTests(_WayBase):
    def test_default_closed(self):
        c = self.cable(self.sw, self.pp)
        self.login(self.user_with(["cable", "rack"], ("view",)))
        self.assertEqual(self.client.get("/api/cable-ways/summary/",
                                         {"cable": c.pk}).status_code, 403)
        self.assertEqual(self.client.post("/api/cable-ways/accept/", {}).status_code, 403)
        self.client.logout()
        self.assertIn(self.client.get("/api/cable-ways/").status_code, (401, 403))

    def test_the_cable_must_be_in_view(self):
        c = self.cable(self.sw, self.pp)
        self.login(self.user_with(["cableway", "rack"], ("view",)))
        self.assertEqual(self.client.get("/api/cable-ways/summary/",
                                         {"cable": c.pk}).status_code, 404)

    def test_other_tenant(self):
        far_site = Site.objects.create(tenant=self.other, name="X")
        far_rack = Rack.objects.create(tenant=self.other, name="X1", site=far_site)
        dt = DeviceType.objects.create(tenant=self.other, name="X", model="X", u_height=1)
        d1 = Device.objects.create(tenant=self.other, name="x1", site=far_site, rack=far_rack,
                                   position=1, device_type=dt)
        d2 = Device.objects.create(tenant=self.other, name="x2", site=far_site, rack=far_rack,
                                   position=2, device_type=dt)
        theirs = self.cable(d1, d2, tenant=self.other)
        self.summary(theirs, code=404)
        self.post("/api/cable-ways/accept/", {"cable_id": str(theirs.pk),
                                              "rack_id": str(far_rack.pk)}, code=404)
        r = self.client.post("/api/cable-ways/", {"cable_id": str(theirs.pk),
                                                  "rack_id": str(far_rack.pk),
                                                  "hops": [{"key": "entry:top:roof"}]},
                             format="json")
        self.assertEqual(r.status_code, 400)
        way = CableWay.objects.create(tenant=self.other, cable=theirs, rack=far_rack, end="AB")
        self.assertEqual(self.client.get(f"/api/cable-ways/{way.pk}/").status_code, 404)

    def test_site_scope(self):
        branch = Site.objects.create(tenant=self.tenant, name="Branch")
        b_rack = Rack.objects.create(tenant=self.tenant, name="B1", site=branch, rack_type=self.rt)
        b1, b2 = self.device("b1", b_rack, 10), self.device("b2", b_rack, 12)
        mine, theirs = self.cable(self.sw, self.pp), self.cable(b1, b2)
        user = User.objects.create_user("site", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="site", object_types=["cableway", "cable", "rack", "rackpathway", "device"],
            actions=["view", "add", "change", "delete"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site)
        self.login(user)
        self.post("/api/cable-ways/accept/", {"cable_id": str(mine.pk),
                                              "rack_id": str(self.rack.pk)})
        self.post("/api/cable-ways/accept/", {"cable_id": str(theirs.pk),
                                              "rack_id": str(b_rack.pk)}, code=404)
        self.assertFalse(CableWay.objects.filter(cable=theirs).exists())


class PathwayCountTests(_WayBase):
    def test_cables_per_pathway_and_the_cable_filter(self):
        c = self.cable(self.sw, self.pp)
        way = self.post("/api/cable-ways/accept/", {"cable_id": str(c.pk),
                                                    "rack_id": str(self.rack.pk)})
        pid = way["hops"][0]["pathway"]
        r = self.client.get("/api/rack-pathways/resolved/", {"rack": self.rack.pk})
        by_id = {i["id"]: i for i in r.json()["items"] if i["id"]}
        self.assertEqual(by_id[pid]["cables"], 1)
        rows = self.client.get("/api/cables/", {"pathway": pid}).json()["results"]
        self.assertEqual([x["id"] for x in rows], [str(c.pk)])
        self.assertEqual(self.client.get("/api/cables/", {"pathway": "x"}).status_code, 400)


class CommandTests(_WayBase):
    def test_dry_run_then_apply(self):
        c = self.cable(self.sw, self.far)
        out = StringIO()
        call_command("propose_cable_ways", "--tenant", "acme", "--rack", "R1", stdout=out)
        self.assertIn("dry run", out.getvalue())
        self.assertIn("1 cable(s), 1 proposed", out.getvalue())
        self.assertFalse(CableWay.objects.exists())
        call_command("propose_cable_ways", "--tenant", "acme", "--apply", stdout=StringIO())
        self.assertEqual({w.state for w in CableWay.objects.filter(cable=c)}, {"proposed"})
        call_command("propose_cable_ways", "--tenant", "acme", "--apply", stdout=StringIO())
        self.assertEqual(CableWay.objects.filter(cable=c).count(), 2)


class ChannelPickerTests(_WayBase):
    def setUp(self):
        super().setUp()
        pdu_type = DeviceType.objects.create(tenant=self.tenant, name="PDU", model="PDU",
                                             u_height=0)
        self.pdu = Device.objects.create(tenant=self.tenant, name="pdu", site=self.site,
                                         rack=self.rack, mount="side_left", face="rear",
                                         device_type=pdu_type)

    def patch(self, data, code=200):
        r = self.client.patch(f"/api/devices/{self.pdu.pk}/", data, format="json")
        self.assertEqual(r.status_code, code, r.content)
        return r.json()

    def test_a_channel_by_key(self):
        doc = self.patch({"mount_pathway_key": "channel:0u:left:rear"})
        row = RackPathway.objects.get(rack=self.rack, key="channel:0u:left:rear")
        self.assertEqual(doc["mount_pathway"], str(row.pk))
        self.assertIn("right", self.patch({"mount_pathway_key": "channel:0u:right:rear"},
                                          code=400)["mount_pathway_id"][0])
        self.assertIn("mount_pathway_key", self.patch({"mount_pathway_key": "entry:top:roof"},
                                                      code=400))
        self.assertIsNone(self.patch({"mount_pathway_key": ""})["mount_pathway"])

    def test_a_power_cord_to_the_pdu_takes_its_channel(self):
        self.patch({"mount_pathway_key": "channel:0u:left:rear"})
        c = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c, end="A", power_port=PowerPort.objects.create(
            device=self.sw, name="PSU1"))
        CableTermination.objects.create(cable=c, end="B", power_outlet=PowerOutlet.objects.create(
            device=self.pdu, name="O1"))
        prop = self.summary(c)["racks"][0]["proposal"]
        self.assertEqual([h["key"] for h in prop["hops"]], ["channel:0u:left:rear"])
        self.assertIn("pdu-channel", prop["reasons"])


# ── phase 3: places, moves, other writers, the scene ───────────────────────

class PlaceTests(SimpleTestCase):
    """Each pathway's place in the rack (``geo``, api.rack_pathways.Room),
    from the kit's parts scaled to the rack, else the frame's nominal one;
    the engine runs its ways through them."""

    def kit_items(self, width=600, depth=1000, units=42):
        from .tests_rack_pathways import cabinet, scan

        got, _ = scan(cabinet())
        kit = NS_KIT(pathways=got)
        fr = rp.Frame(frame="cabinet", kit=kit, top="vented", base="plinth", side_panels=True,
                      start=1, units=units, width_mm=width, depth_mm=depth)
        return {i["key"]: i for i in rp.finish(rp.base_items(fr), fr)}

    def test_a_kits_managers_where_its_parts_are(self):
        its = self.kit_items()
        front = its["path:vertical:left:front"]["geo"]
        rear = its["path:vertical:left:rear"]["geo"]
        # Beside the gear (the 19" opening is ±225 mm), inside the side panel:
        # the centre of its inside is its ``path`` empty.
        self.assertTrue(-300 < front["cx"] < -225, front)
        self.assertAlmostEqual(front["cx"], -271, delta=0.5)
        # The front one near the front, as deep as its inside and walls; the
        # rear one at the rear.
        self.assertAlmostEqual(front["y1"] - front["y0"], 88 + 2 * front["wall"], delta=1)
        self.assertGreater(rear["y0"], front["y1"] + 500)
        self.assertEqual(front["cy"], (front["y0"] + front["y1"]) / 2)
        # Up the rack's units.
        self.assertEqual((front["z0"], front["z1"]), (100.0, round(100 + 42 * U_PITCH_MM, 1)))

    def test_scaled_to_a_wider_deeper_rack(self):
        small = self.kit_items()
        big = self.kit_items(width=800, depth=1200)
        a, b = small["path:vertical:right:front"]["geo"], big["path:vertical:right:front"]["geo"]
        # As far in from the side panel; the front one as far from the front.
        self.assertAlmostEqual(300 - a["cx"], 400 - b["cx"], delta=0.2)
        self.assertEqual(a["y0"], b["y0"])
        ra, rb = small["path:vertical:right:rear"]["geo"], big["path:vertical:right:rear"]["geo"]
        self.assertEqual(rb["y1"] - ra["y1"], 200)
        full = big["path:vertical:right:full"]["geo"]
        self.assertGreater(full["y1"] - full["y0"], 888)

    def test_defaults_have_places_too(self):
        its = {i["key"]: i for i in items()}
        g = its["path:vertical:right:front"]["geo"]
        self.assertTrue(225 < g["x0"] < g["x1"] <= 300)
        roof = its["entry:top:roof"]["geo"]
        self.assertEqual(roof["z"], round(rp.BASE_MM + 42 * U_PITCH_MM + rp.CAP_MM, 1))
        two = {i["key"]: i for i in items("2-post")}
        # A 2-post's finger managers stand outside the frame.
        self.assertGreaterEqual(two["path:vertical:right:full"]["geo"]["x0"], 300)
        self.assertEqual(two["path:vertical:left:full"]["geo"]["open"], "front")

    def test_the_engine_runs_through_the_places(self):
        its = list(self.kit_items().values())
        geo = eng.Geo(start=1, units=42, width_mm=600, depth_mm=1000, cap_mm=30)
        doc = eng.propose(its, geo, [end("A", 20, face="front", side="left")],
                          exit_pref="top")
        self.assertEqual(keys(doc)[0], "path:vertical:left:front")
        g = next(i for i in its if i["key"] == "path:vertical:left:front")["geo"]
        # Into the manager at the port's unit, at its inner centre.
        self.assertIn([round(g["cx"]), round(g["cy"]), round(geo.z(20))], doc["points"])

    def test_numbered_from_the_top(self):
        geo = eng.Geo(start=1, units=42, desc=True)
        self.assertGreater(geo.z(1), geo.z(42))
        self.assertEqual(eng._unit_of(geo, geo.z(5)), 5)


class NS_KIT:
    """A kit as base_items reads it, without a model file."""

    def __init__(self, pathways):
        self.pathways = pathways
        self.widths_mm, self.depths_mm, self.parts, self.model_3d = [600, 800], [1000], {}, None


class InstalledTests(SimpleTestCase):
    def test_a_kit_says_which_managers_it_installs(self):
        from .rack_kits import read_kit
        from .tests_rack_pathways import cabinet, scan

        fields, notes = read_kit("rack-kits/G/K/kit.yaml", {
            "name": "K", "frame": "cabinet", "model3d": {"file": "models/G/K.kit.glb"},
            "pathways": {"installed": ["path:vertical:left:full", "bogus"]}})
        self.assertEqual(fields["installed"], ["path:vertical:left:full"])
        self.assertTrue(any("bogus" in n for n in notes))
        got, _ = scan(cabinet())
        notes = []
        rp.mark_installed(got, fields["installed"], notes)
        kit = NS_KIT(pathways=got)
        fr = rp.Frame(frame="cabinet", kit=kit, top="vented", base="plinth", side_panels=True,
                      start=1, units=42, width_mm=600, depth_mm=1000)
        shown = {i["key"] for i in rp.base_items(fr) if i["kind"] == "vertical"
                 and not i["hidden"]}
        self.assertEqual(shown, {"path:vertical:left:full"})
        # Not said: the cabinet's rule, front and rear.
        got, _ = scan(cabinet())
        kit.pathways = got
        shown = {i["key"] for i in rp.base_items(fr) if i["kind"] == "vertical"
                 and not i["hidden"]}
        self.assertEqual(shown, {f"path:vertical:{s}:{f}" for s in ("left", "right")
                                 for f in ("front", "rear")})
        self.assertIsNone(read_kit("rack-kits/G/K/kit.yaml", {
            "name": "K", "frame": "cabinet",
            "model3d": {"file": "models/G/K.kit.glb"}})[0]["installed"])


class MoveTests(_WayBase):
    """A device moving refreshes its cables' ways."""

    def move(self, dev, **kw):
        with self.captureOnCommitCallbacks(execute=True):
            for k, v in kw.items():
                setattr(dev, k, v)
            dev.save()

    def test_record_mode_records_again(self):
        self.record_mode()
        with self.captureOnCommitCallbacks(execute=True):
            c = self.cable(self.sw, self.far)
        w = CableWay.objects.get(cable=c, rack=self.rack)
        before = w.hops[0]["enter_u"]
        self.move(self.sw, position=10)
        w.refresh_from_db()
        self.assertEqual((w.state, w.source), ("recorded", "auto"))
        self.assertNotEqual(w.hops[0]["enter_u"], before)
        self.assertEqual(w.hops[0]["enter_u"], 10)

    def test_propose_mode_flags_an_accepted_way(self):
        c = self.cable(self.sw, self.far)
        self.post("/api/cable-ways/accept/", {"cable_id": str(c.pk), "rack_id": str(self.rack.pk)})
        self.move(self.sw, position=10)
        w = CableWay.objects.get(cable=c, rack=self.rack)
        # Out of date: back to proposed, waiting to be accepted again.
        self.assertEqual((w.state, w.source), ("proposed", "auto"))
        self.assertEqual(w.hops[0]["enter_u"], 10)

    def test_a_manual_way_is_kept_and_shows_stale(self):
        c = self.cable(self.sw, self.far)
        way = self.post("/api/cable-ways/", {"cable_id": str(c.pk), "rack_id": str(self.rack.pk),
                                             "hops": [{"key": "path:vertical:left:rear",
                                                       "enter_u": 40, "leave_u": 42},
                                                      {"key": "entry:top:roof"}]})
        self.assertFalse(way["stale"])
        self.move(self.sw, position=12)
        w = CableWay.objects.get(pk=way["id"])
        self.assertEqual((w.source, w.hops[0]["enter_u"]), ("manual", 40))
        rack = next(r for r in self.summary(c)["racks"] if r["rack"]["id"] == str(self.rack.pk))
        self.assertTrue(rack["way"]["stale"])

    def test_a_save_that_moves_nothing_refreshes_nothing(self):
        self.record_mode()
        with self.captureOnCommitCallbacks(execute=True):
            c = self.cable(self.sw, self.far)
        stamp = CableWay.objects.get(cable=c, rack=self.rack).updated_at
        self.move(self.sw, name="sw-renamed")
        self.assertEqual(CableWay.objects.get(cable=c, rack=self.rack).updated_at, stamp)


class OtherWriterTests(SimpleTestCase):
    def test_a_rolled_back_cable_is_refreshed_with_the_next_commit(self):
        from . import cable_ways as cw

        cw._queue().clear()
        cw._queue().add("gone")
        seen = []
        real = cw._run_refresh
        cw._run_refresh = seen.append
        try:
            cw._flush()
        finally:
            cw._run_refresh = real
        self.assertEqual(seen, ["gone"])
        self.assertEqual(cw._queue(), set())


class SceneTests(_WayBase):
    def test_the_rack_scene_carries_pathways_and_ways(self):
        self.record_mode()
        with self.captureOnCommitCallbacks(execute=True):
            c = self.cable(self.sw, self.far)
        r = self.client.get(f"/api/racks/{self.rack.pk}/scene/")
        self.assertEqual(r.status_code, 200, r.content)
        doc = r.json()
        keys_ = {p["key"] for p in doc["pathways"]}
        self.assertIn("path:vertical:left:front", keys_)
        self.assertTrue(all(p["geo"] for p in doc["pathways"]))
        (way,) = doc["ways"]
        self.assertEqual((way["cable_id"], way["end"], way["state"]), (str(c.pk), "A", "recorded"))
        self.assertEqual(way["ends"], [{"end": "A", "device": str(self.sw.pk), "port": "eth-l",
                                        "kind": "interface"}])
        self.assertTrue(way["hops"])

    def test_only_the_cables_the_reader_may_view(self):
        self.record_mode()
        with self.captureOnCommitCallbacks(execute=True):
            self.cable(self.sw, self.far)
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        g = ObjectPermission.objects.create(name="r", object_types=["rack", "device"],
                                            actions=["view"])
        g.users.add(user)
        g.tenants.add(self.tenant)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.pk)
        s.save()
        r = self.client.get(f"/api/racks/{self.rack.pk}/scene/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["ways"], [])
        self.assertTrue(r.json()["pathways"])


from .tests_stack_links import _Base as _StackBase  # noqa: E402


class StackAutoCableTests(_StackBase):
    def test_a_stacks_auto_cables_are_recorded_too(self):
        from .models import VirtualChassis

        TenantSettings.objects.update_or_create(tenant=self.tenant,
                                                defaults={"cable_ways_mode": "record"})
        rack = Rack.objects.create(tenant=self.tenant, name="SR", site=self.site)
        for i, m in enumerate(self.members):
            Device.objects.filter(pk=m.pk).update(rack=rack, position=10 + i, face="front")
        with self.captureOnCommitCallbacks(execute=True):
            vc = VirtualChassis.objects.get(pk=self.vc.pk)
            vc.auto_connect_stack = True
            vc.save()
        cables = list(Cable.objects.filter(auto_chassis=self.vc))
        self.assertTrue(cables)
        for c in cables:
            self.assertTrue(CableWay.objects.filter(cable=c, rack=rack, state="recorded",
                                                    source="auto").exists(), c)
