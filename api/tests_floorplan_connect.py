"""Connect to… (floor-plan cables, phase 5).

New cables planned on the floor plan: ``cable-plan`` with ``mode: new``
proposes port pairs between a placed object and its targets (free,
compatible ports; uplinks first; a stable pairing) and routes them like
existing cables; ``cable-plan/ports/`` lists the free compatible ports of
one device for the picker; ``bulk/`` makes the cables (``cables.create``,
validated as ``/api/cables/bulk-create/``, in a planned status, all or
nothing) and their routes in one save.
"""
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase

from auth_api.models import ObjectPermission, UserProfile

from .cable_connect import Port, compatible, interface_media, propose
from .models import (
    Cable,
    CableTermination,
    Device,
    FloorPlanCablePath,
    FrontPort,
    Interface,
    PowerOutlet,
    PowerPort,
    RearPort,
    Site,
    Status,
)
from .tests_floorplan_cable_paths import _Plan

User = get_user_model()


def _p(name, dev="d1", kind="interface", media="", speed=None, connector="", uplink=False):
    return Port(kind=kind, id=f"{dev}-{name}", name=name, device=dev, media=media,
                speed_mbps=speed, connector=connector, uplink=uplink)


class CompatibilityTests(SimpleTestCase):
    def test_media_from_interface_type(self):
        self.assertEqual(interface_media("1000base-t"), ("copper", "rj45", 1000))
        self.assertEqual(interface_media("10gbase-x-sfpp"), ("cage", "sfpp", 10000))
        self.assertEqual(interface_media("25gbase-cr"), ("dac", "", 25000))
        self.assertEqual(interface_media("10gbase-sr"), ("fibre", "", 10000))
        self.assertEqual(interface_media("1.6tbase-dr8")[2], 1_600_000)
        self.assertEqual(interface_media("")[0], "")

    def test_copper_does_not_meet_fibre(self):
        ok, why = compatible(_p("a", media="copper", speed=1000),
                             _p("b", "d2", media="fibre", speed=1000))
        self.assertFalse(ok)
        self.assertIn("plug", why)

    def test_a_cage_takes_fibre_or_dac(self):
        cage = _p("a", media="cage", connector="sfpp", speed=10000)
        self.assertTrue(compatible(cage, _p("b", "d2", media="fibre", speed=10000))[0])
        self.assertTrue(compatible(cage, _p("b", "d2", media="dac", speed=10000))[0])
        self.assertFalse(compatible(cage, _p("b", "d2", media="copper", speed=10000))[0])

    def test_cages_of_another_family_do_not_meet(self):
        sfp = _p("a", media="cage", connector="sfp28", speed=25000)
        self.assertTrue(compatible(sfp, _p("b", "d2", media="cage", connector="sfpp"))[0])
        self.assertFalse(
            compatible(sfp, _p("b", "d2", media="cage", connector="qsfp28"))[0]
        )

    def test_speeds_must_agree_when_known(self):
        self.assertFalse(compatible(_p("a", media="copper", speed=1000),
                                    _p("b", "d2", media="copper", speed=10000))[0])
        self.assertTrue(compatible(_p("a", media="copper", speed=1000),
                                   _p("b", "d2", media="copper"))[0])

    def test_kinds_follow_the_cable_rules(self):
        self.assertFalse(compatible(_p("a"), _p("b", "d2", kind="power_port"))[0])
        self.assertTrue(compatible(_p("a", kind="power_port"),
                                   _p("b", "d2", kind="power_outlet"))[0])


class PairingTests(SimpleTestCase):
    def switch(self, dev, n=24, uplinks=(), speed=1000, media="copper"):
        return [_p(f"ge-{i}", dev, media=media, speed=speed, uplink=f"ge-{i}" in uplinks)
                for i in range(1, n + 1)]

    def test_server_lands_on_the_lowest_free_switch_port(self):
        free = {"srv": [_p("eth1", "srv", media="copper", speed=1000),
                        _p("eth0", "srv", media="copper", speed=1000)],
                "sw": self.switch("sw")}
        pairs, short = propose([("srv", "sw")], free, per_target=2)
        self.assertEqual([(a.name, b.name) for a, b in pairs],
                         [("eth0", "ge-1"), ("eth1", "ge-2")])
        self.assertEqual(short, [])

    def test_the_faster_server_port_first(self):
        free = {"srv": [_p("eth0", "srv", media="copper", speed=1000),
                        _p("p1", "srv", media="cage", connector="sfp28", speed=25000)],
                "sw": [*self.switch("sw"),
                       _p("xe-49", "sw", media="cage", connector="sfp28", speed=25000)]}
        pairs, _ = propose([("srv", "sw")], free)
        self.assertEqual([(a.name, b.name) for a, b in pairs], [("p1", "xe-49")])

    def test_switch_to_switch_takes_uplinks_then_the_last_ports(self):
        free = {"a": self.switch("a", uplinks=("ge-5",)), "b": self.switch("b")}
        pairs, _ = propose([("a", "b")], free, per_target=2)
        self.assertEqual([(a.name, b.name) for a, b in pairs],
                         [("ge-5", "ge-24"), ("ge-24", "ge-23")])

    def test_ports_are_used_once_across_targets(self):
        free = {"sw": self.switch("sw"),
                "s1": [_p("eth0", "s1", media="copper", speed=1000)],
                "s2": [_p("eth0", "s2", media="copper", speed=1000)]}
        pairs, _ = propose([("sw", "s1"), ("sw", "s2")], free)
        self.assertEqual([(a.name, b.device) for a, b in pairs],
                         [("ge-1", "s1"), ("ge-2", "s2")])

    def test_the_pairing_is_stable(self):
        free = {"a": self.switch("a"), "b": self.switch("b")}
        first = propose([("a", "b")], free, per_target=3)[0]
        again = propose([("a", "b")], {k: list(reversed(v)) for k, v in free.items()},
                        per_target=3)[0]
        self.assertEqual([(a.id, b.id) for a, b in first], [(a.id, b.id) for a, b in again])

    def test_no_free_or_no_compatible_ports_are_reported(self):
        pairs, short = propose([("a", "b")], {"a": [], "b": self.switch("b")})
        self.assertEqual(pairs, [])
        self.assertEqual(short[0]["reason"], "No free ports.")
        pairs, short = propose(
            [("a", "b")],
            {"a": [_p("x", "a", media="fibre", speed=10000)], "b": self.switch("b")},
        )
        self.assertEqual(short[0]["reason"], "No compatible free ports.")


class _Connect(_Plan):
    """The base plan with ports to connect: sw-a (8 copper ports + 2 SFP+)
    in RA, sw-b (8 copper ports) in RB, and a planned status."""

    def setUp(self):
        super().setUp()
        self.url = f"/api/floor-plans/{self.plan.id}/cable-plan/"
        for dev in (self.dev_a, self.dev_b):
            for i in range(1, 9):
                Interface.objects.create(device=dev, name=f"ge-0/0/{i}", type="1000base-t")
        Interface.objects.create(device=self.dev_a, name="xe-0/1/0", type="10gbase-x-sfpp")
        Interface.objects.create(device=self.dev_a, name="xe-0/1/1", type="10gbase-x-sfpp")
        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned-x", color="#888888",
            available_to=["cable"], is_planned=True,
        )

    def preview(self, body, status=200):
        r = self.client.post(self.url, {"mode": "new", **body}, format="json")
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def connect(self, **kw):
        return self.preview({
            "source": [{"kind": "device", "id": str(self.dev_a.id)}],
            "targets": [{"kind": "device", "id": str(self.dev_b.id)}],
            **kw,
        })

    def iface(self, dev, name):
        return Interface.objects.get(device=dev, name=name)


class ConnectPreviewTests(_Connect):
    def test_proposes_free_compatible_pairs_uplinks_last_ports(self):
        data = self.connect(per_target=2)
        pairs = [(p["a"]["name"], p["b"]["name"]) for p in data["pairs"]]
        # Both switch-sized: an uplink link, from the last copper ports.
        self.assertEqual(pairs, [("ge-0/0/8", "ge-0/0/8"), ("ge-0/0/7", "ge-0/0/7")])
        p = data["pairs"][0]
        self.assertEqual(p["type"], "cat6")
        self.assertEqual(p["via"], "trays")
        self.assertGreater(p["route"]["length_mm"], 0)
        self.assertEqual(p["route"]["tray_order"], [str(self.tray.id)])
        self.assertEqual(data["statuses"], [
            {"id": str(self.planned.id), "name": "Planned", "color": "#888888"}
        ])
        self.assertTrue(data["can_add"])
        self.assertEqual(Cable.objects.count(), 1)  # nothing stored

    def test_cabled_disabled_and_mgmt_ports_are_not_free(self):
        self.iface(self.dev_a, "ge-0/0/8").delete()
        Interface.objects.filter(device=self.dev_a, name="ge-0/0/7").update(enabled=False)
        Interface.objects.filter(device=self.dev_a, name="ge-0/0/6").update(mgmt_only=True)
        Interface.objects.filter(device=self.dev_a, name="ge-0/0/5").update(
            mark_connected=True
        )
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(
            cable=cable, end="A", interface=self.iface(self.dev_a, "ge-0/0/4")
        )
        data = self.connect()
        self.assertEqual(data["pairs"][0]["a"]["name"], "ge-0/0/3")
        data = self.connect(include_mgmt=True)
        self.assertEqual(data["pairs"][0]["a"]["name"], "ge-0/0/6")

    def test_ports_the_draft_takes_are_left_out(self):
        taken = self.iface(self.dev_a, "ge-0/0/8")
        data = self.connect(exclude_ports=[{"kind": "interface", "id": str(taken.id)}])
        self.assertEqual(data["pairs"][0]["a"]["name"], "ge-0/0/7")

    def test_no_free_ports_says_so(self):
        Interface.objects.filter(device=self.dev_b).update(enabled=False)
        data = self.connect()
        self.assertEqual(data["pairs"], [])
        (s,) = data["short"]
        self.assertEqual(s["reason"], "No free ports.")
        self.assertEqual(s["b_device"]["name"], "sw-b")

    def test_a_rack_target_expands_to_its_placed_devices(self):
        srv = Device.objects.create(
            tenant=self.tenant, name="srv-1", site=self.site, rack=self.rack_b,
            device_type=self.dtype, position=10,
        )
        Interface.objects.create(device=srv, name="eth0", type="1000base-t")
        data = self.connect(targets=[{"kind": "rack", "id": str(self.rack_b.id)}])
        by_dev = {p["b"]["device_name"]: p for p in data["pairs"]}
        self.assertEqual(set(by_dev), {"sw-b", "srv-1"})
        # A server on a switch: the switch's lowest free port.
        self.assertEqual(by_dev["srv-1"]["a"]["name"], "ge-0/0/1")

    def test_edited_pairs_are_checked(self):
        a = self.iface(self.dev_a, "xe-0/1/0")
        b = self.iface(self.dev_b, "ge-0/0/1")
        c = self.iface(self.dev_a, "ge-0/0/2")
        data = self.connect(pairs=[
            {"key": "k1", "a": {"kind": "interface", "id": str(a.id)},
             "b": {"kind": "interface", "id": str(b.id)}},
            {"key": "k2", "a": {"kind": "interface", "id": str(c.id)},
             "b": {"kind": "interface", "id": str(b.id)}},
        ])
        k1, k2 = data["pairs"]
        self.assertIn("plug", k1["error"])
        self.assertIsNone(k1["route"])
        self.assertIn("two cables", k2["error"])

    def test_an_edited_pair_routes(self):
        a = self.iface(self.dev_a, "ge-0/0/3")
        b = self.iface(self.dev_b, "ge-0/0/4")
        data = self.connect(pairs=[{"key": "k", "a": {"kind": "interface", "id": str(a.id)},
                                    "b": {"kind": "interface", "id": str(b.id)}}],
                            choices={"k": {"via": "direct"}})
        (p,) = data["pairs"]
        self.assertEqual(p["error"], "")
        self.assertEqual(p["via"], "direct")

    def test_power_family(self):
        PowerPort.objects.create(device=self.dev_b, name="PSU1")
        PowerOutlet.objects.create(device=self.dev_a, name="Out-1")
        data = self.connect(family="power")
        (p,) = data["pairs"]
        self.assertEqual((p["a"]["name"], p["b"]["name"], p["type"]),
                         ("Out-1", "PSU1", "power"))

    def test_hidden_devices_are_never_offered(self):
        editor = User.objects.create_user("ed", password="x")
        UserProfile.objects.create(user=editor).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile", "rack", "cable"],
            actions=["view"],
        )
        perm.users.add(editor)
        perm.tenants.add(self.tenant)
        dperm = ObjectPermission.objects.create(
            name="d", object_types=["device"], actions=["view"], constraints={"name": "sw-a"},
        )
        dperm.users.add(editor)
        dperm.tenants.add(self.tenant)
        self.login(editor)
        r = self.client.post(self.url, {
            "mode": "new",
            "source": [{"kind": "device", "id": str(self.dev_a.id)}],
            "targets": [{"kind": "device", "id": str(self.dev_b.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["pairs"], [])
        self.assertFalse(r.json()["can_add"])
        # The picker answers no port of it either.
        r = self.client.get(
            f"/api/floor-plans/{self.plan.id}/cable-plan/ports/?device={self.dev_b.id}"
        )
        self.assertEqual(r.status_code, 400)

    def test_port_picker_lists_free_compatible_ports(self):
        far = self.iface(self.dev_b, "ge-0/0/1")
        r = self.client.get(
            f"/api/floor-plans/{self.plan.id}/cable-plan/ports/"
            f"?device={self.dev_a.id}&for=interface:{far.id}"
        )
        self.assertEqual(r.status_code, 200, r.content)
        names = [p["name"] for p in r.json()["ports"]]
        self.assertNotIn("xe-0/1/0", names)
        self.assertIn("ge-0/0/1", names)
        r = self.client.get(
            f"/api/floor-plans/{self.plan.id}/cable-plan/ports/?device={self.dev_a.id}"
        )
        self.assertIn("xe-0/1/0", [p["name"] for p in r.json()["ports"]])

    def test_panel_ports_take_data_cables(self):
        rp = RearPort.objects.create(device=self.dev_b, name="R1", type="8p8c", positions=1)
        FrontPort.objects.create(device=self.dev_b, name="F1", type="8p8c", rear_port=rp)
        r = self.client.get(
            f"/api/floor-plans/{self.plan.id}/cable-plan/ports/?device={self.dev_b.id}"
            f"&for=interface:{self.iface(self.dev_a, 'ge-0/0/1').id}"
        )
        self.assertIn("F1", [p["name"] for p in r.json()["ports"]])


class ConnectSaveTests(_Connect):
    def body(self, status=None, **extra):
        data = self.connect()
        (p,) = data["pairs"]
        return {
            "cables": {"create": [{
                "key": "new-1",
                "a": [{"kind": p["a"]["kind"], "id": p["a"]["id"]}],
                "b": [{"kind": p["b"]["kind"], "id": p["b"]["id"]}],
                "type": p["type"],
                "status_id": str(status or self.planned.id),
                **extra,
            }]},
            "cable_paths": {"upsert": [{
                "cable": "new-1", "kind": p["route"]["kind"],
                "legs": [{"points": leg["points"]} for leg in p["route"]["legs"]],
                "tray_order": p["route"]["tray_order"], "write_length": True,
            }]},
        }, p

    def test_save_makes_the_cable_and_its_route(self):
        body, p = self.body()
        r = self.bulk(body)
        self.assertEqual(r.status_code, 200, r.content)
        (made,) = r.json()["cables"]
        self.assertEqual(made["key"], "new-1")
        cable = Cable.objects.get(pk=made["id"])
        self.assertEqual(cable.status, self.planned)
        self.assertEqual(cable.tenant, self.tenant)
        self.assertEqual(cable.length_source, "computed")
        path = FloorPlanCablePath.objects.get(cable=cable)
        self.assertEqual(path.length_mm, p["route"]["length_mm"])
        self.assertEqual(list(cable.trays.values_list("id", flat=True)), [self.tray.id])
        self.assertEqual(
            {t.interface.name for t in cable.terminations.all()},
            {p["a"]["name"], p["b"]["name"]},
        )

    def test_a_planned_status_is_required(self):
        active = Status.objects.create(
            tenant=self.tenant, name="Active", slug="active-x", available_to=["cable"],
        )
        body, _p = self.body(status=active.id)
        r = self.bulk(body)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("status_id", r.json()["cables"][0])
        self.assertEqual(Cable.objects.count(), 1)

    def test_all_or_nothing(self):
        body, p = self.body()
        # A second cable on the same A port: nothing at all is written.
        other = self.iface(self.dev_b, "ge-0/0/1")
        body["cables"]["create"].append({
            "key": "new-2", "a": [{"kind": "interface", "id": p["a"]["id"]}],
            "b": [{"kind": "interface", "id": str(other.id)}],
            "status_id": str(self.planned.id),
        })
        body["tiles"] = {"update": [{"id": str(self.tile_a.id), "x": 1}]}
        r = self.bulk(body)
        self.assertEqual(r.status_code, 400, r.content)
        errs = r.json()["cables"]
        self.assertEqual(errs[0], {})
        self.assertIn("a", errs[1])
        self.assertEqual(Cable.objects.count(), 1)
        self.tile_a.refresh_from_db()
        self.assertEqual(self.tile_a.x, 0)

    def test_a_port_cabled_since_is_refused(self):
        body, p = self.body()
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface_id=p["a"]["id"])
        r = self.bulk(body)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Cable.objects.count(), 2)

    def test_needs_cable_add(self):
        body, _p = self.body()
        editor = User.objects.create_user("ed", password="x")
        UserProfile.objects.create(user=editor).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="e", object_types=["floorplan", "floorplantile", "floorplancablepath",
                                    "cable", "device", "rack", "interface"],
            actions=["view", "change", "add"],
        )
        perm.users.add(editor)
        perm.tenants.add(self.tenant)
        no_add = ObjectPermission.objects.create(
            name="n", object_types=["floorplan", "floorplantile", "floorplancablepath",
                                    "cable", "device", "rack", "interface"],
            actions=["view", "change"],
        )
        self.login(editor)
        r = self.bulk(body)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Cable.objects.count(), 2)

        # Without cable · add: refused, nothing written.
        no_add.users.add(editor)
        no_add.tenants.add(self.tenant)
        perm.users.remove(editor)
        Cable.objects.exclude(pk=self.cable.pk).delete()
        r = self.bulk(body)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(Cable.objects.count(), 1)

    def test_add_outside_the_grant_sites_is_refused(self):
        body, _p = self.body()
        other = Site.objects.create(tenant=self.tenant, name="FRA")
        editor = User.objects.create_user("ed2", password="x")
        UserProfile.objects.create(user=editor).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="e", object_types=["floorplan", "floorplantile", "floorplancablepath",
                                    "device", "rack", "interface"],
            actions=["view", "change", "add"],
        )
        perm.users.add(editor)
        perm.tenants.add(self.tenant)
        cperm = ObjectPermission.objects.create(
            name="c", object_types=["cable"], actions=["view", "change", "add"],
        )
        cperm.users.add(editor)
        cperm.tenants.add(self.tenant)
        cperm.sites.add(other)
        self.login(editor)
        r = self.bulk(body)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(Cable.objects.count(), 1)

    def test_another_tenants_port_is_refused(self):
        from core.models import Tenant

        t2 = Tenant.objects.create(org=self.org, name="T2", slug="t2")
        s2 = Site.objects.create(tenant=t2, name="X")
        d2 = Device.objects.create(tenant=t2, name="x", site=s2, device_type=self.dtype)
        foreign = Interface.objects.create(device=d2, name="eth0")
        body, _p = self.body()
        body["cables"]["create"][0]["b"] = [{"kind": "interface", "id": str(foreign.id)}]
        del body["cable_paths"]
        r = self.bulk(body)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Cable.objects.count(), 1)
