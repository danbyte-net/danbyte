"""Fibre strands: colour derivation, per-tenant palette settings, and cable
fibre-count / strand annotations (validation + round-trip)."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .fiber_colors import fiber_color, is_fiber_type
from .models import (
    Cable,
    CableTermination,
    Device,
    FiberSettings,
    FrontPort,
    Interface,
    RearPort,
)
from .topology_views import cable_strand_path

User = get_user_model()


class ColorDerivationTests(APITestCase):
    def test_sequence_and_tracers(self):
        self.assertEqual(fiber_color(1)["name"], "Blue")
        self.assertEqual(fiber_color(8)["name"], "Black")
        self.assertEqual(fiber_color(12)["name"], "Aqua")
        # 13 wraps to Blue, gains a stripe (2nd dozen), no ring yet.
        c13 = fiber_color(13)
        self.assertEqual((c13["name"], c13["group"], c13["stripe"], c13["rings"]),
                         ("Blue", 1, True, 0))
        # 25 = 3rd dozen: stripe + one ring.
        c25 = fiber_color(25)
        self.assertEqual((c25["group"], c25["stripe"], c25["rings"]), (2, True, 1))

    def test_is_fiber_type(self):
        self.assertTrue(is_fiber_type("smf-os2"))
        self.assertTrue(is_fiber_type("mmf-om4"))
        self.assertFalse(is_fiber_type("cat6"))
        self.assertFalse(is_fiber_type(""))


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)


class FiberSettingsTests(_Base):
    def test_get_creates_default_palette(self):
        resp = self.client.get("/api/fiber-settings/")
        self.assertEqual(resp.status_code, 200)
        colors = resp.json()["colors"]
        self.assertEqual(len(colors), 12)
        self.assertEqual(colors[0]["name"], "Blue")
        # Persisted for the tenant.
        self.assertEqual(FiberSettings.objects.filter(tenant=self.tenant).count(), 1)

    def test_save_custom_order(self):
        custom = [{"name": "Red", "hex": "#FF0000"},
                  {"name": "Blue", "hex": "#0000FF"}]
        resp = self.client.post(
            "/api/fiber-settings/", {"colors": custom}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(
            [c["name"] for c in resp.json()["colors"]], ["Red", "Blue"]
        )

    def test_rejects_bad_hex(self):
        resp = self.client.post(
            "/api/fiber-settings/",
            {"colors": [{"name": "X", "hex": "notacolor"}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)


class CableFiberTests(_Base):
    def _cable(self, type="smf-os2"):
        return Cable.objects.create(tenant=self.tenant, type=type)

    def test_count_and_strands_round_trip(self):
        c = self._cable()
        resp = self.client.patch(
            f"/api/cables/{c.id}/",
            {"fiber_count": 24, "strands": {"7": {"label": "Cust-A", "status": "in-use"}}},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["fiber_count"], 24)
        self.assertEqual(data["strands"]["7"]["label"], "Cust-A")
        self.assertTrue(data["is_fiber"])

    def test_count_rejected_on_non_fiber(self):
        c = self._cable(type="cat6")
        resp = self.client.patch(
            f"/api/cables/{c.id}/", {"fiber_count": 12}, format="json"
        )
        self.assertEqual(resp.status_code, 400)

    def test_strand_out_of_range_rejected(self):
        c = self._cable()
        resp = self.client.patch(
            f"/api/cables/{c.id}/",
            {"fiber_count": 12, "strands": {"20": {"label": "x"}}},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)


class StrandTraceTests(_Base):
    """A 2-fibre trunk between two panels; each strand breaks out through a
    front port to a device, so strand k traces device-A ═ trunk ═ device-B."""

    def _term(self, cable, end, obj):
        kw = {"cable": cable, "end": end}
        kw[
            "interface" if isinstance(obj, Interface)
            else "front_port" if isinstance(obj, FrontPort)
            else "rear_port"
        ] = obj
        CableTermination.objects.create(**kw)

    def _cable(self, label, a, b):
        c = Cable.objects.create(
            tenant=self.tenant, label=label, type="mmf-om4"
        )
        self._term(c, "A", a)
        self._term(c, "B", b)
        return c

    def setUp(self):
        super().setUp()
        pa = Device.objects.create(tenant=self.tenant, name="panel-a")
        pb = Device.objects.create(tenant=self.tenant, name="panel-b")
        da = Device.objects.create(tenant=self.tenant, name="dev-a")
        db = Device.objects.create(tenant=self.tenant, name="dev-b")
        self.ra = RearPort.objects.create(device=pa, name="rear", positions=2)
        self.rb = RearPort.objects.create(device=pb, name="rear", positions=2)
        fa1 = FrontPort.objects.create(
            device=pa, name="f1", rear_port=self.ra, rear_port_position=1
        )
        fa2 = FrontPort.objects.create(
            device=pa, name="f2", rear_port=self.ra, rear_port_position=2
        )
        fb1 = FrontPort.objects.create(
            device=pb, name="f1", rear_port=self.rb, rear_port_position=1
        )
        fb2 = FrontPort.objects.create(
            device=pb, name="f2", rear_port=self.rb, rear_port_position=2
        )
        self.ea1 = Interface.objects.create(device=da, name="eth1")
        self.ea2 = Interface.objects.create(device=da, name="eth2")
        eb1 = Interface.objects.create(device=db, name="eth1")
        eb2 = Interface.objects.create(device=db, name="eth2")
        self.trunk = self._cable("TRUNK", self.ra, self.rb)
        self.trunk.fiber_count = 2
        self.trunk.save()
        self._cable("patch-a1", self.ea1, fa1)
        self._cable("patch-a2", self.ea2, fa2)
        self._cable("patch-b1", eb1, fb1)
        self._cable("patch-b2", eb2, fb2)

    def _devices(self, path):
        return [s["device"] for s in path["steps"] if s["t"] == "chip"]

    def test_strand1_traces_end_to_end(self):
        p = cable_strand_path(self.trunk, 1)
        self.assertTrue(p["complete"])
        self.assertEqual(p["color"]["name"], "Blue")
        devs = self._devices(p)
        self.assertEqual(devs[0], "dev-a")
        self.assertEqual(devs[-1], "dev-b")
        self.assertIn("panel-a", devs)
        self.assertIn("panel-b", devs)
        # The trunk segment carries the strand + colour.
        trunk_seg = next(
            s for s in p["steps"]
            if s["t"] == "seg" and s.get("strand") == 1
        )
        self.assertEqual(trunk_seg["strand_color"]["name"], "Blue")

    def test_each_strand_reaches_its_own_ports(self):
        # Strand 1 breaks out on f1 (eth1); strand 2 on f2 (eth2).
        p1 = cable_strand_path(self.trunk, 1)
        p2 = cable_strand_path(self.trunk, 2)
        ports1 = {
            pt["name"] for s in p1["steps"] if s["t"] == "chip"
            for pt in s["ports"]
        }
        ports2 = {
            pt["name"] for s in p2["steps"] if s["t"] == "chip"
            for pt in s["ports"]
        }
        self.assertIn("eth1", ports1)
        self.assertIn("eth2", ports2)
        self.assertNotIn("eth2", ports1)

    def test_endpoint(self):
        resp = self.client.get(f"/api/cables/{self.trunk.id}/strand/?n=1")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["complete"])
        # Out-of-range strand rejected.
        self.assertEqual(
            self.client.get(
                f"/api/cables/{self.trunk.id}/strand/?n=9"
            ).status_code,
            400,
        )


class FrontPortPositionsTests(_Base):
    """Phase A: a front port can span multiple rear positions (LC-duplex, MPO),
    with overlap + range validation, and strand_of maps the whole range."""

    def setUp(self):
        super().setUp()
        self.dev = Device.objects.create(tenant=self.tenant, name="pp")
        self.rear = RearPort.objects.create(
            device=self.dev, name="R", positions=4
        )

    def _post_front(self, name, start, positions):
        return self.client.post(
            "/api/front-ports/",
            {
                "device_id": str(self.dev.id),
                "name": name,
                "rear_port_id": str(self.rear.id),
                "rear_port_position": start,
                "positions": positions,
                "type": "lc-duplex",
            },
            format="json",
        )

    def test_positions_round_trip(self):
        resp = self._post_front("f1", 1, 2)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["positions"], 2)

    def test_overlap_rejected(self):
        self.assertEqual(self._post_front("f1", 1, 2).status_code, 201)
        # f2 at position 2 collides with f1's range [1–2].
        resp = self._post_front("f2", 2, 1)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("rear_port_position", resp.json())

    def test_range_must_fit_rear(self):
        # positions 3–4 fit; 3 with span 2 → 3–4 ok, 4 with span 2 → 4–5 fails.
        self.assertEqual(self._post_front("f1", 3, 2).status_code, 201)
        resp = self._post_front("f2", 4, 2)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("positions", resp.json())

    def test_strand_of_maps_the_range(self):
        from .cable_points import strand_of

        f1 = FrontPort.objects.create(
            device=self.dev, name="f1", rear_port=self.rear,
            rear_port_position=1, positions=2,
        )
        f2 = FrontPort.objects.create(
            device=self.dev, name="f2", rear_port=self.rear,
            rear_port_position=3, positions=2,
        )
        # Every rear position resolves to the covering front port + local index.
        self.assertEqual(strand_of("rear_port", self.rear, 1), ("front_port", f1, 1))
        self.assertEqual(strand_of("rear_port", self.rear, 2), ("front_port", f1, 2))
        self.assertEqual(strand_of("rear_port", self.rear, 3), ("front_port", f2, 1))
        self.assertEqual(strand_of("rear_port", self.rear, 4), ("front_port", f2, 2))
        # Front local fibre → rear position (offset).
        self.assertEqual(
            strand_of("front_port", f1, 2), ("rear_port", self.rear, 2)
        )

    def test_connector_choices_and_fibers(self):
        data = self.client.get("/api/dcim/choices/").json()
        vals = {c["value"] for c in data["front_port_types"]}
        self.assertIn("lc-duplex", vals)
        self.assertIn("mpo-12", vals)
        self.assertEqual(data["connector_fibers"]["lc-duplex"], 2)
        self.assertEqual(data["connector_fibers"]["mpo-12"], 12)

    def test_strand_modelling_setting(self):
        resp = self.client.post(
            "/api/fiber-settings/",
            {"strand_modelling": "accurate"},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(
            self.client.get("/api/fiber-settings/").json()["strand_modelling"],
            "accurate",
        )


class SplitterTests(_Base):
    """PON splitters: the ``is_splitter`` rear-port flag relaxes the
    one-front-port-per-position rule and makes tracing fan out."""

    def _pon(self, outputs=4):
        """OLT ─ feeder ─ [splitter rear | fronts×N] ─ drops ─ ONT ifaces."""
        olt = Device.objects.create(tenant=self.tenant, name="olt")
        spl = Device.objects.create(tenant=self.tenant, name="splitter")
        self.olt_if = Interface.objects.create(device=olt, name="pon1")
        self.spl_rear = RearPort.objects.create(
            device=spl, name="in", positions=1, is_splitter=True
        )
        self.onts = []
        for i in range(1, outputs + 1):
            fp = FrontPort.objects.create(
                device=spl, name=f"out{i}", rear_port=self.spl_rear,
                rear_port_position=1,
            )
            ont = Device.objects.create(tenant=self.tenant, name=f"ont-{i}")
            iface = Interface.objects.create(device=ont, name="pon0")
            self._cable(f"drop-{i}", fp, iface)
            self.onts.append(iface)
        self.feeder = self._cable("feeder", self.olt_if, self.spl_rear)
        return spl

    # reuse StrandTraceTests' cable/termination helpers
    _term = StrandTraceTests._term
    _cable = StrandTraceTests._cable

    def _trace_names(self, start):
        from .trace import trace

        graph = trace([start])
        names = {
            n["data"]["name"]
            for n in graph["nodes"] if n["type"] == "device"
        }
        return graph, names

    def test_splitter_allows_overlapping_front_ports(self):
        self._pon(outputs=4)
        self.assertEqual(self.spl_rear.front_ports.count(), 4)

    def test_non_splitter_still_rejects_overlap(self):
        from django.core.exceptions import ValidationError

        dev = Device.objects.create(tenant=self.tenant, name="panel")
        rear = RearPort.objects.create(device=dev, name="r", positions=1)
        FrontPort.objects.create(
            device=dev, name="f1", rear_port=rear, rear_port_position=1
        )
        clash = FrontPort(
            device=dev, name="f2", rear_port=rear, rear_port_position=1
        )
        with self.assertRaises(ValidationError):
            clash.clean()

    def test_splitter_requires_single_position(self):
        dev = Device.objects.create(tenant=self.tenant, name="x")
        resp = self.client.post(
            "/api/rear-ports/",
            {"device_id": str(dev.id), "name": "bad", "positions": 2,
             "is_splitter": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_clearing_flag_with_overlapping_fronts_rejected(self):
        self._pon(outputs=2)
        resp = self.client.patch(
            f"/api/rear-ports/{self.spl_rear.id}/",
            {"is_splitter": False},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_trace_from_olt_reaches_all_onts(self):
        self._pon(outputs=4)
        graph, names = self._trace_names(("interface", self.olt_if))
        self.assertTrue(graph["complete"])
        self.assertEqual(
            names, {"olt", "splitter", "ont-1", "ont-2", "ont-3", "ont-4"}
        )

    def test_trace_from_ont_reaches_olt_and_siblings(self):
        # The PON tree is one shared medium — tracing any leaf shows it all.
        self._pon(outputs=3)
        graph, names = self._trace_names(("interface", self.onts[0]))
        self.assertTrue(graph["complete"])
        self.assertEqual(
            names, {"olt", "splitter", "ont-1", "ont-2", "ont-3"}
        )

    def test_splitter_cascade(self):
        # 1:2 into two 1:2 splitters → 4 leaves, all reached from the OLT.
        olt = Device.objects.create(tenant=self.tenant, name="olt")
        olt_if = Interface.objects.create(device=olt, name="pon1")
        s1 = Device.objects.create(tenant=self.tenant, name="spl-1")
        r1 = RearPort.objects.create(
            device=s1, name="in", positions=1, is_splitter=True
        )
        leaves = set()
        self._cable("feeder", olt_if, r1)
        for i in (1, 2):
            f = FrontPort.objects.create(
                device=s1, name=f"out{i}", rear_port=r1, rear_port_position=1
            )
            s2 = Device.objects.create(tenant=self.tenant, name=f"spl-2{i}")
            r2 = RearPort.objects.create(
                device=s2, name="in", positions=1, is_splitter=True
            )
            self._cable(f"mid-{i}", f, r2)
            for j in (1, 2):
                f2 = FrontPort.objects.create(
                    device=s2, name=f"out{j}", rear_port=r2,
                    rear_port_position=1,
                )
                ont = Device.objects.create(
                    tenant=self.tenant, name=f"ont-{i}{j}"
                )
                iface = Interface.objects.create(device=ont, name="pon0")
                self._cable(f"drop-{i}{j}", f2, iface)
                leaves.add(f"ont-{i}{j}")
        graph, names = self._trace_names(("interface", olt_if))
        self.assertTrue(graph["complete"])
        self.assertTrue(leaves <= names)
        self.assertIn("spl-1", names)

    def test_splitter_without_outputs_is_incomplete(self):
        olt = Device.objects.create(tenant=self.tenant, name="olt")
        olt_if = Interface.objects.create(device=olt, name="pon1")
        spl = Device.objects.create(tenant=self.tenant, name="splitter")
        rear = RearPort.objects.create(
            device=spl, name="in", positions=1, is_splitter=True
        )
        self._cable("feeder", olt_if, rear)
        graph, names = self._trace_names(("interface", olt_if))
        self.assertFalse(graph["complete"])
        self.assertEqual(names, {"olt", "splitter"})

    def test_splitter_behind_panel_keeps_positions(self):
        # OLT ─ panel1 f2 ─ 2-strand trunk ─ panel2 f2 ─ splitter → 2 ONTs.
        # Strand 1 of the same trunk carries an unrelated pair that must NOT
        # leak into the PON tree.
        olt = Device.objects.create(tenant=self.tenant, name="olt")
        olt_if = Interface.objects.create(device=olt, name="pon1")
        p1 = Device.objects.create(tenant=self.tenant, name="panel-1")
        p2 = Device.objects.create(tenant=self.tenant, name="panel-2")
        pr = RearPort.objects.create(device=p1, name="r", positions=2)
        qr = RearPort.objects.create(device=p2, name="r", positions=2)
        pf1 = FrontPort.objects.create(
            device=p1, name="f1", rear_port=pr, rear_port_position=1
        )
        pf2 = FrontPort.objects.create(
            device=p1, name="f2", rear_port=pr, rear_port_position=2
        )
        qf1 = FrontPort.objects.create(
            device=p2, name="f1", rear_port=qr, rear_port_position=1
        )
        qf2 = FrontPort.objects.create(
            device=p2, name="f2", rear_port=qr, rear_port_position=2
        )
        self._cable("trunk", pr, qr)
        self._cable("olt-in", olt_if, pf2)
        spl = Device.objects.create(tenant=self.tenant, name="splitter")
        srear = RearPort.objects.create(
            device=spl, name="in", positions=1, is_splitter=True
        )
        self._cable("spl-in", qf2, srear)
        for i in (1, 2):
            f = FrontPort.objects.create(
                device=spl, name=f"out{i}", rear_port=srear,
                rear_port_position=1,
            )
            ont = Device.objects.create(tenant=self.tenant, name=f"ont-{i}")
            iface = Interface.objects.create(device=ont, name="pon0")
            self._cable(f"drop-{i}", f, iface)
        # Unrelated pair on strand 1 of the same trunk.
        oa = Device.objects.create(tenant=self.tenant, name="other-a")
        oa_if = Interface.objects.create(device=oa, name="eth0")
        ob = Device.objects.create(tenant=self.tenant, name="other-b")
        ob_if = Interface.objects.create(device=ob, name="eth0")
        self._cable("s1-a", oa_if, pf1)
        self._cable("s1-b", ob_if, qf1)
        graph, names = self._trace_names(("interface", olt_if))
        self.assertTrue(graph["complete"])
        self.assertEqual(
            names,
            {"olt", "panel-1", "panel-2", "splitter", "ont-1", "ont-2"},
        )

    def test_trunk_strand_beyond_splitter_input_dead_ends(self):
        # A 2-strand trunk wired straight into a 1-position splitter input:
        # strand 2 has nowhere to go — unmapped, never broadcast.
        olt = Device.objects.create(tenant=self.tenant, name="olt")
        olt_if = Interface.objects.create(device=olt, name="pon1")
        panel = Device.objects.create(tenant=self.tenant, name="panel")
        rear = RearPort.objects.create(device=panel, name="r", positions=2)
        f2 = FrontPort.objects.create(
            device=panel, name="f2", rear_port=rear, rear_port_position=2
        )
        self._cable("in", olt_if, f2)
        spl = Device.objects.create(tenant=self.tenant, name="splitter")
        srear = RearPort.objects.create(
            device=spl, name="in", positions=1, is_splitter=True
        )
        self._cable("trunk", rear, srear)
        FrontPort.objects.create(
            device=spl, name="out1", rear_port=srear, rear_port_position=1
        )
        graph, names = self._trace_names(("interface", olt_if))
        self.assertFalse(graph["complete"])
        self.assertNotIn("ont-1", names)
