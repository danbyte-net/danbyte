"""Front/rear port mapping and strand-aware trace (#334).

A front-port name range takes consecutive rear positions, a front port maps
only onto its own device's rear port, a rear port can't drop positions that
front ports still use, and the cable trace carries the strand through
multi-position (MPO) front ports instead of falling back to position 1.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    FrontPort,
    FrontPortTemplate,
    Interface,
    RearPort,
    RearPortTemplate,
)
from .trace import trace

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _dev(self, name):
        return Device.objects.create(tenant=self.tenant, name=name)

    def _cable(self, a, b, label=""):
        c = Cable.objects.create(tenant=self.tenant, label=label, type="smf-os2")
        for end, obj in (("A", a), ("B", b)):
            kind = (
                "interface" if isinstance(obj, Interface)
                else "front_port" if isinstance(obj, FrontPort)
                else "rear_port"
            )
            CableTermination.objects.create(cable=c, end=end, **{kind: obj})
        return c


class FrontPortRangeTests(_Base):
    def setUp(self):
        super().setUp()
        self.panel = self._dev("panel-a")
        self.r1 = RearPort.objects.create(device=self.panel, name="R1", positions=12)

    def _post(self, name, start=1, positions=1, rear=None, device=None):
        return self.client.post(
            "/api/front-ports/",
            {"device_id": str((device or self.panel).id), "name": name,
             "rear_port_id": str((rear or self.r1).id),
             "rear_port_position": start, "positions": positions},
            format="json",
        )

    def _map(self):
        return {
            f.name: (f.rear_port_position, f.positions)
            for f in FrontPort.objects.filter(rear_port=self.r1)
        }

    def test_range_takes_consecutive_positions(self):
        r = self._post("FP[1-12]")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["rear_port_position"], 1)
        m = self._map()
        self.assertEqual(len(m), 12)
        self.assertEqual({m[f"FP{i}"][0] for i in range(1, 13)}, set(range(1, 13)))
        self.assertEqual(m["FP7"], (7, 1))

    def test_range_from_a_later_start(self):
        self.assertEqual(self._post("FP[1-4]", start=5).status_code, 201)
        self.assertEqual(sorted(p for p, _ in self._map().values()), [5, 6, 7, 8])

    def test_multi_position_range_steps_by_width(self):
        r = self._post("MPO[1-3]", positions=4)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            self._map(), {"MPO1": (1, 4), "MPO2": (5, 4), "MPO3": (9, 4)}
        )

    def test_range_past_the_rear_is_refused_whole(self):
        r = self._post("FP[1-12]", start=2)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("positions", r.json())
        self.assertEqual(FrontPort.objects.count(), 0)

    def test_range_overlapping_a_sibling_is_refused_whole(self):
        self.assertEqual(self._post("X", start=3).status_code, 201)
        r = self._post("FP[1-4]")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("rear_port_position", r.json())
        self.assertEqual(list(self._map()), ["X"])

    def test_splitter_outputs_share_position_one(self):
        spl = RearPort.objects.create(
            device=self.panel, name="in", positions=1, is_splitter=True
        )
        r = self._post("out[1-4]", rear=spl)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            set(FrontPort.objects.filter(rear_port=spl)
                .values_list("rear_port_position", flat=True)),
            {1},
        )
        self.assertEqual(spl.front_ports.count(), 4)

    def test_single_create_unchanged(self):
        r = self._post("F1", start=6)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._map(), {"F1": (6, 1)})


class SameDeviceTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = self._dev("panel-a")
        self.b = self._dev("panel-b")
        self.ra = RearPort.objects.create(device=self.a, name="R1", positions=4)
        self.rb = RearPort.objects.create(device=self.b, name="R1", positions=4)

    def test_create_against_another_devices_rear_is_refused(self):
        r = self.client.post(
            "/api/front-ports/",
            {"device_id": str(self.b.id), "name": "F1",
             "rear_port_id": str(self.ra.id), "rear_port_position": 1},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("rear_port_id", r.json())
        self.assertEqual(FrontPort.objects.count(), 0)

    def test_range_against_another_devices_rear_is_refused(self):
        r = self.client.post(
            "/api/front-ports/",
            {"device_id": str(self.b.id), "name": "F[1-2]",
             "rear_port_id": str(self.ra.id), "rear_port_position": 1},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(FrontPort.objects.count(), 0)

    def test_patch_cannot_move_either_side_apart(self):
        fp = FrontPort.objects.create(device=self.b, name="F1", rear_port=self.rb)
        r = self.client.patch(
            f"/api/front-ports/{fp.id}/", {"rear_port_id": str(self.ra.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(
            f"/api/front-ports/{fp.id}/", {"device_id": str(self.a.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        fp.refresh_from_db()
        self.assertEqual((fp.device_id, fp.rear_port_id), (self.b.id, self.rb.id))
        # Unrelated edits to a valid port still go through.
        r = self.client.patch(
            f"/api/front-ports/{fp.id}/", {"description": "ok"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_template_on_another_device_type_is_refused(self):
        dt1 = DeviceType.objects.create(tenant=self.tenant, name="cassette-1")
        dt2 = DeviceType.objects.create(tenant=self.tenant, name="cassette-2")
        rpt = RearPortTemplate.objects.create(device_type=dt1, name="R1", positions=4)
        r = self.client.post(
            "/api/front-port-templates/",
            {"device_type_id": str(dt2.id), "name": "F1",
             "rear_port_template_id": str(rpt.id), "rear_port_position": 1},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("rear_port_template_id", r.json())


class TemplateRangeTests(_Base):
    def setUp(self):
        super().setUp()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="cassette")
        self.rpt = RearPortTemplate.objects.create(
            device_type=self.dt, name="R1", positions=12
        )

    def _post(self, name, start=1):
        return self.client.post(
            "/api/front-port-templates/",
            {"device_type_id": str(self.dt.id), "name": name,
             "rear_port_template_id": str(self.rpt.id),
             "rear_port_position": start},
            format="json",
        )

    def test_range_takes_consecutive_positions(self):
        self.assertEqual(self._post("FP[1-12]").status_code, 201)
        self.assertEqual(
            sorted(self.rpt.front_port_templates.values_list(
                "rear_port_position", flat=True)),
            list(range(1, 13)),
        )

    def test_overlap_and_overflow_are_refused(self):
        self.assertEqual(self._post("A", start=4).status_code, 201)
        self.assertEqual(self._post("B", start=4).status_code, 400)
        self.assertEqual(self._post("C", start=13).status_code, 400)
        self.assertEqual(self._post("D[1-6]").status_code, 400)
        self.assertEqual(
            list(self.rpt.front_port_templates.values_list("name", flat=True)),
            ["A"],
        )

    def test_rear_template_cannot_shrink_below_mapped(self):
        FrontPortTemplate.objects.create(
            device_type=self.dt, name="F9", rear_port_template=self.rpt,
            rear_port_position=9,
        )
        r = self.client.patch(
            f"/api/rear-port-templates/{self.rpt.id}/", {"positions": 8},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(
            f"/api/rear-port-templates/{self.rpt.id}/", {"positions": 9},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)


class RearPortShrinkTests(_Base):
    def setUp(self):
        super().setUp()
        self.panel = self._dev("panel-a")
        self.r1 = RearPort.objects.create(device=self.panel, name="R1", positions=12)
        for i in range(1, 13):
            FrontPort.objects.create(
                device=self.panel, name=f"F{i}", rear_port=self.r1,
                rear_port_position=i,
            )

    def test_patch_below_mapped_positions_is_refused(self):
        r = self.client.patch(
            f"/api/rear-ports/{self.r1.id}/", {"positions": 1}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("positions", r.json())
        self.r1.refresh_from_db()
        self.assertEqual(self.r1.positions, 12)

    def test_growing_or_keeping_is_fine(self):
        for n in (12, 24):
            r = self.client.patch(
                f"/api/rear-ports/{self.r1.id}/", {"positions": n}, format="json"
            )
            self.assertEqual(r.status_code, 200, r.content)

    def test_shrink_to_the_last_multi_position_port(self):
        FrontPort.objects.filter(rear_port=self.r1).delete()
        FrontPort.objects.create(
            device=self.panel, name="MPO", rear_port=self.r1,
            rear_port_position=1, positions=8,
        )
        r = self.client.patch(
            f"/api/rear-ports/{self.r1.id}/", {"positions": 7}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(
            f"/api/rear-ports/{self.r1.id}/", {"positions": 8}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_bulk_update_is_held_to_the_same_rule(self):
        spare = RearPort.objects.create(device=self.panel, name="R2", positions=12)
        r = self.client.post(
            "/api/rear-ports/bulk-update/",
            {"ids": [str(self.r1.id), str(spare.id)], "fields": {"positions": 4}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.r1.refresh_from_db()
        spare.refresh_from_db()
        self.assertEqual((self.r1.positions, spare.positions), (12, 12))
        r = self.client.post(
            "/api/rear-ports/bulk-update/",
            {"ids": [str(spare.id)], "fields": {"positions": 4}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        spare.refresh_from_db()
        self.assertEqual(spare.positions, 4)


class MultiPositionTraceTests(_Base):
    """The cassette chain: X ─ L5 | cassette 2 (R2 ⇢ L1-L12) ═ F1 (MPO-12) |
    cassette 1 (F1 ⇢ R1) ═ R3 | cassette 3 (R3 ⇢ M1-M12) ─ Y. Strand 5 must
    leave on M5, not M1, and nothing off the path may join the graph."""

    def _cassette(self, name, prefix, mpo=False):
        dev = self._dev(name)
        rear = RearPort.objects.create(device=dev, name=f"R-{name}", positions=12)
        if mpo:
            fronts = [FrontPort.objects.create(
                device=dev, name=prefix, rear_port=rear,
                rear_port_position=1, positions=12,
            )]
        else:
            fronts = [
                FrontPort.objects.create(
                    device=dev, name=f"{prefix}{i}", rear_port=rear,
                    rear_port_position=i,
                )
                for i in range(1, 13)
            ]
        return rear, fronts

    def setUp(self):
        super().setUp()
        self.r1, (self.f1,) = self._cassette("cassette-1", "F1", mpo=True)
        self.r2, self.ls = self._cassette("cassette-2", "L")
        self.r3, self.ms = self._cassette("cassette-3", "M")
        self.x = Interface.objects.create(device=self._dev("host-x"), name="X")
        self._cable(self.f1, self.r2, "mpo-patch")
        self._cable(self.r1, self.r3, "trunk")
        self.start = self._cable(self.x, self.ls[4], "x-l5")

    def _ports(self, graph):
        return sorted(
            n["data"]["name"] for n in graph["nodes"] if n["type"] != "device"
        )

    def test_strand_five_exits_on_m5(self):
        y = Interface.objects.create(device=self._dev("host-y"), name="Y")
        self._cable(self.ms[4], y, "m5-y")
        graph = trace([("interface", self.x)])
        self.assertEqual(
            self._ports(graph),
            ["F1", "L5", "M5", "R-cassette-1", "R-cassette-2", "R-cassette-3",
             "X", "Y"],
        )
        self.assertTrue(graph["complete"])

    def test_cable_trace_endpoint_follows_the_strand(self):
        r = self.client.get(f"/api/cables/{self.start.id}/trace/")
        self.assertEqual(r.status_code, 200, r.content)
        names = {
            n["data"]["name"] for n in r.json()["nodes"] if n["type"] != "device"
        }
        self.assertIn("M5", names)
        self.assertNotIn("M1", names)
        self.assertNotIn("L1", names)

    def test_each_strand_keeps_its_own_exit(self):
        for i in (1, 7, 12):
            with self.subTest(strand=i):
                host = Interface.objects.create(
                    device=self._dev(f"host-{i}"), name=f"H{i}"
                )
                self._cable(host, self.ls[i - 1])
                ports = self._ports(trace([("interface", host)]))
                self.assertIn(f"M{i}", ports)
                self.assertEqual([p for p in ports if p.startswith("M")], [f"M{i}"])

    def test_strand_beyond_the_mpo_dead_ends(self):
        # A 24-strand trunk into a 12-fibre MPO: strand 13 has no fibre there.
        dev = self._dev("cassette-24")
        r24 = RearPort.objects.create(device=dev, name="R24", positions=24)
        f13 = FrontPort.objects.create(
            device=dev, name="P13", rear_port=r24, rear_port_position=13
        )
        dev_b = self._dev("cassette-mpo")
        rb = RearPort.objects.create(device=dev_b, name="RB", positions=12)
        mpo = FrontPort.objects.create(
            device=dev_b, name="MPO", rear_port=rb, rear_port_position=1,
            positions=12,
        )
        self._cable(r24, mpo)
        host = Interface.objects.create(device=self._dev("host-z"), name="Z")
        self._cable(host, f13)
        graph = trace([("interface", host)])
        self.assertFalse(graph["complete"])
        self.assertNotIn("RB", self._ports(graph))

    def test_mpo_to_mpo_patch_keeps_the_strand(self):
        # cassette-2's MPO side patched straight into another MPO cassette.
        self.r4, (mpo4,) = self._cassette("cassette-4", "F4", mpo=True)
        self.r5, es = self._cassette("cassette-5", "E")
        self._cable(self.r4, self.r5, "trunk-2")
        f6 = FrontPort.objects.create(
            device=self.f1.device, name="F6", rear_port=self._spare_rear(),
            rear_port_position=1, positions=12,
        )
        self._cable(f6, mpo4, "mpo-mpo")
        host = Interface.objects.create(device=self._dev("host-w"), name="W")
        # Reach f6 strand 3 through its own rear from a 1:1 breakout.
        breakout_dev = self._dev("breakout")
        rb = RearPort.objects.create(device=breakout_dev, name="RB", positions=12)
        b3 = FrontPort.objects.create(
            device=breakout_dev, name="B3", rear_port=rb, rear_port_position=3
        )
        self._cable(rb, f6.rear_port, "breakout-trunk")
        self._cable(host, b3)
        ports = self._ports(trace([("interface", host)]))
        self.assertIn("E3", ports)
        self.assertEqual([p for p in ports if p.startswith("E")], ["E3"])

    def _spare_rear(self):
        return RearPort.objects.create(
            device=self.f1.device, name="R-spare", positions=12
        )


class SimplePanelTraceTests(_Base):
    """1:1 panels trace exactly as before: host ─ f2 | panel ═ trunk ═ panel |
    f2 ─ host, strand 1 never joining."""

    def test_one_to_one_panels_unchanged(self):
        pa, pb = self._dev("panel-a"), self._dev("panel-b")
        ra = RearPort.objects.create(device=pa, name="rear", positions=2)
        rb = RearPort.objects.create(device=pb, name="rear", positions=2)
        fa = [FrontPort.objects.create(device=pa, name=f"f{i}", rear_port=ra,
                                       rear_port_position=i) for i in (1, 2)]
        fb = [FrontPort.objects.create(device=pb, name=f"f{i}", rear_port=rb,
                                       rear_port_position=i) for i in (1, 2)]
        a = Interface.objects.create(device=self._dev("dev-a"), name="eth2")
        b = Interface.objects.create(device=self._dev("dev-b"), name="eth2")
        other = Interface.objects.create(device=self._dev("dev-c"), name="eth1")
        self._cable(ra, rb)
        self._cable(a, fa[1])
        self._cable(fb[1], b)
        self._cable(other, fa[0])
        graph = trace([("interface", a)])
        self.assertTrue(graph["complete"])
        ports = sorted(
            (n["data"]["device_name"], n["data"]["name"])
            for n in graph["nodes"] if n["type"] != "device"
        )
        self.assertEqual(ports, [
            ("dev-a", "eth2"), ("dev-b", "eth2"),
            ("panel-a", "f2"), ("panel-a", "rear"),
            ("panel-b", "f2"), ("panel-b", "rear"),
        ])
