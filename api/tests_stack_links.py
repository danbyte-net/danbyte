"""Switch stacks in 3D (api.stack_links): the ``/api/device-leds/`` payload's
``stacks`` - recorded stack cables, else the ring derived from member order -
each member's ``stack``, ``stack_plugs`` and ``stack_covers``, the reader's
scope, and a query count that does not grow with the members."""
from __future__ import annotations

from types import SimpleNamespace

from django.contrib.auth.models import User
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from auth_api.models import ObjectPermission, UserProfile

from .models import (
    AccessoryType,
    Cable,
    CableTermination,
    Device,
    DeviceType,
    Interface,
    InterfaceTemplate,
    PowerPort,
    PowerPortTemplate,
    VirtualChassis,
)
from .port_utilization import utilization_payload
from .stack_links import head_for, power_ring, ring
from .tests_led_state import _Base as _LedBase

STACK = "cisco-stackwise-480"


class RingTests(SimpleTestCase):
    def _ports(self, n):
        return [(f"m{i}", [f"S{i}/1", f"S{i}/2"]) for i in range(1, n + 1)]

    def test_two_members_get_two_cables(self):
        self.assertEqual(ring(self._ports(2)), [
            (("m1", "S1/1"), ("m2", "S2/2")),
            (("m2", "S2/1"), ("m1", "S1/2")),
        ])

    def test_three_members_close_the_ring(self):
        self.assertEqual(ring(self._ports(3)), [
            (("m1", "S1/1"), ("m2", "S2/2")),
            (("m2", "S2/1"), ("m3", "S3/2")),
            (("m3", "S3/1"), ("m1", "S1/2")),
        ])

    def test_n_members(self):
        links = ring(self._ports(8))
        self.assertEqual(len(links), 8)
        self.assertEqual(links[-1], (("m8", "S8/1"), ("m1", "S1/2")))

    def test_a_chain_leaves_out_the_closing_link(self):
        self.assertEqual(ring(self._ports(3), closed=False), [
            (("m1", "S1/1"), ("m2", "S2/2")),
            (("m2", "S2/1"), ("m3", "S3/2")),
        ])
        self.assertEqual(len(ring(self._ports(2), closed=False)), 1)

    def test_one_member_no_ring(self):
        self.assertEqual(ring(self._ports(1)), [])

    def test_a_member_without_the_port_skips_its_links(self):
        ports = self._ports(3)
        ports[1] = ("m2", ["S2/1"])
        self.assertEqual(ring(ports), [
            (("m2", "S2/1"), ("m3", "S3/2")),
            (("m3", "S3/1"), ("m1", "S1/2")),
        ])

    def test_head_by_type_then_label(self):
        a = SimpleNamespace(vendor="Cisco", name="STACK-T1", kind="cord", fits=[STACK],
                            parts=["STACK-T1-50CM", "STACK-T1-1M"])
        b = SimpleNamespace(vendor="Cisco", name="STACK-T0", kind="cord", fits=[STACK],
                            parts=["STACK-T0-3M"])
        plug = SimpleNamespace(vendor="A", name="X", kind="plug", fits=[STACK], parts=[])
        self.assertIs(head_for([a, b, plug], STACK), b)
        self.assertIs(head_for([a, b, plug], STACK, "stack-t1-1m="), a)
        self.assertIsNone(head_for([a, b], "cisco-stackwise-160"))

    def test_a_generic_family_port_takes_a_member_head(self):
        t1 = SimpleNamespace(vendor="Cisco", name="STACK-T1", kind="cord",
                             fits=["cisco-stackwise-480", "cisco-stackwise-1t"],
                             parts=["STACK-T1-50CM", "STACK-T1-1M"])
        old = SimpleNamespace(vendor="A", name="OLD", kind="cord",
                              fits=["cisco-stackwise-160"], parts=["CAB-STK-E-1M"])
        exact = SimpleNamespace(vendor="Z", name="GENERIC", kind="cord",
                                fits=["cisco-stackwise"], parts=[])
        # The family's order: 480 before 160, whatever the names.
        self.assertIs(head_for([old, t1], "cisco-stackwise"), t1)
        self.assertIs(head_for([old, t1], "Cisco-StackWise"), t1)
        # A recorded cable's label names a family member's part.
        self.assertIs(head_for([old, t1], "cisco-stackwise", "CAB-STK-E-1M"), old)
        # An exact fit wins over the family.
        self.assertIs(head_for([old, t1, exact], "cisco-stackwise"), exact)
        # A specific type never falls back to its siblings.
        self.assertIsNone(head_for([old], "cisco-stackwise-480"))
        ext = SimpleNamespace(vendor="Extreme", name="SS", kind="cord",
                              fits=["extreme-summitstack-256"], parts=[])
        self.assertIs(head_for([ext], "extreme-summitstack"), ext)
        self.assertIsNone(head_for([t1], "juniper-vcp"))


class _Base(_LedBase):
    def setUp(self):
        super().setUp()
        for t in ("StackPort{position}/1", "StackPort{position}/2"):
            InterfaceTemplate.objects.create(device_type=self.dt, name=t, type=STACK)
        self.dt.model_anchors = {
            **self.dt.model_anchors,
            "ports": {"StackPort1/1": {"node": 40}, "StackPort1/2": {"node": 41}},
            "port_covers": {"StackPort1/1": {"node": 42}, "StackPort1/2": {"node": 43}},
        }
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=self.dt.model_anchors)
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="STACK")
        self.members = [self._member(self.dev, 1)]
        for i in (2, 3):
            self.members.append(self._member(self._device(f"sw{i}", modules=False), i))
        VirtualChassis.objects.filter(pk=self.vc.pk).update(master=self.dev)

    def _member(self, dev, pos, ports=(1, 2)):
        Device.objects.filter(pk=dev.pk).update(virtual_chassis=self.vc, vc_position=pos)
        for p in ports:
            Interface.objects.create(device=dev, name=f"StackPort{pos}/{p}", type=STACK)
        dev.refresh_from_db()
        return dev

    def _payload(self, *devs):
        devs = devs or self.members
        res = self.client.post("/api/device-leds/",
                               {"devices": [str(d.id) for d in devs]}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _links(self, *devs):
        stacks = self._payload(*devs)["stacks"]
        return [(lk["a"]["name"], lk["b"]["name"], lk["derived"])
                for s in stacks for lk in s["links"]]

    def _cable(self, a, b, **kw):
        cable = Cable.objects.create(tenant=self.tenant, **{"type": "", **kw})
        CableTermination.objects.create(cable=cable, end="A",
                                        interface=Interface.objects.get(name=a))
        CableTermination.objects.create(cable=cable, end="B",
                                        interface=Interface.objects.get(name=b))
        return cable


class PayloadTests(_Base):
    def test_derived_ring_of_three(self):
        out = self._payload()
        [s] = out["stacks"]
        self.assertEqual((s["name"], s["master"]), ("STACK", str(self.dev.id)))
        self.assertEqual([m["position"] for m in s["members"]], [1, 2, 3])
        self.assertEqual([(lk["a"]["name"], lk["b"]["name"], lk["derived"])
                          for lk in s["links"]], [
            ("StackPort1/1", "StackPort2/2", True),
            ("StackPort2/1", "StackPort3/2", True),
            ("StackPort3/1", "StackPort1/2", True),
        ])
        # The anchor as drawn: every member's model is authored as member 1.
        self.assertEqual(s["links"][1]["a"], {"device": str(self.members[1].id),
                                              "port": "StackPort1/1",
                                              "name": "StackPort2/1",
                                              "id": str(Interface.objects.get(
                                                  name="StackPort2/1").id)})
        two = out["devices"][str(self.members[1].id)]
        self.assertEqual(two["stack"], {"id": str(self.vc.id), "name": "STACK", "position": 2,
                                        "master": False, "master_name": "sw1"})
        self.assertTrue(out["devices"][str(self.dev.id)]["stack"]["master"])
        self.assertEqual([(p["port"], p["name"], p["derived"], p["cord_part"], p["end"])
                          for p in two["stack_plugs"]],
                         [("StackPort1/1", "StackPort2/1", True, None, "a"),
                          ("StackPort1/2", "StackPort2/2", True, None, "b")])
        # Derived: the covers hide only while the ring is drawn.
        self.assertEqual(two["covers"], [])
        self.assertEqual(two["stack_covers"], ["StackPort1/1", "StackPort1/2"])

    def test_derived_ring_of_two(self):
        Device.objects.filter(pk=self.members[2].pk).update(virtual_chassis=None,
                                                            vc_position=None)
        self.assertEqual(self._links(*self.members[:2]), [
            ("StackPort1/1", "StackPort2/2", True),
            ("StackPort2/1", "StackPort1/2", True),
        ])

    def test_recorded_cables_win(self):
        cable = self._cable("StackPort1/1", "StackPort3/2", color="#00FF00", label="X")
        out = self._payload()
        [s] = out["stacks"]
        ids = dict(Interface.objects.values_list("name", "id"))
        self.assertEqual(s["links"], [{
            "a": {"device": str(self.dev.id), "port": "StackPort1/1", "name": "StackPort1/1",
                  "id": str(ids["StackPort1/1"])},
            "b": {"device": str(self.members[2].id), "port": "StackPort1/2",
                  "name": "StackPort3/2", "id": str(ids["StackPort3/2"])},
            "kind": "data", "derived": False, "cable": str(cable.id), "color": "#00ff00",
            "label": "X", "length_m": None, "parts": []}, {
            "a": {"device": str(self.members[2].id), "port": "StackPort1/1",
                  "name": "StackPort3/1", "id": str(ids["StackPort3/1"])},
            "b": {"device": str(self.dev.id), "port": "StackPort1/2", "name": "StackPort1/2",
                  "id": str(ids["StackPort1/2"])},
            "kind": "data", "derived": True, "cable": None, "color": None,
            "label": "", "length_m": None, "parts": []}])
        one = out["devices"][str(self.dev.id)]
        # A cabled port hides its cover as any does; the free link stays derived.
        self.assertEqual((one["covers"], one["stack_covers"]),
                         (["StackPort1/1"], ["StackPort1/2"]))
        self.assertEqual(out["devices"][str(self.members[1].id)]["stack_plugs"], [])

    def test_a_recorded_cable_takes_its_terminations_sides(self):
        # Cabled B on member 1, A on member 3: the band follows the cable.
        self._cable("StackPort3/2", "StackPort1/1")
        out = self._payload()
        ends = {(dev, p["name"]): p["end"] for dev, e in out["devices"].items()
                for p in e["stack_plugs"] if not p["derived"]}
        self.assertEqual(ends, {(str(self.dev.id), "StackPort1/1"): "b",
                                (str(self.members[2].id), "StackPort3/2"): "a"})

    def test_a_recorded_cable_replaces_only_its_own_link(self):
        self._cable("StackPort2/1", "StackPort3/2")
        self.assertEqual(self._links(), [
            ("StackPort2/1", "StackPort3/2", False),
            ("StackPort1/1", "StackPort2/2", True),
            ("StackPort3/1", "StackPort1/2", True),
        ])

    def test_missing_ports_skip_their_links(self):
        Interface.objects.filter(name="StackPort2/2").delete()
        self.assertEqual(self._links(), [
            ("StackPort2/1", "StackPort3/2", True),
            ("StackPort3/1", "StackPort1/2", True),
        ])

    def test_ports_without_an_anchor_are_not_drawn(self):
        anchors = {**self.dt.model_anchors, "ports": {"StackPort1/1": {"node": 40}}}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=anchors)
        self.assertEqual(self._links(), [])

    def test_only_drawn_members_are_linked(self):
        self.assertEqual(self._links(*self.members[:2]),
                         [("StackPort1/1", "StackPort2/2", True)])

    def test_a_stack_head_seats_at_each_end(self):
        acc = AccessoryType(tenant=self.tenant, vendor="Cisco", name="STACK-T1",
                            kind="cord", connector="stackwise", fits=[STACK],
                            cable={"profile": "round", "jacket_mm": 6.0, "pitch_mm": None,
                                   "min_bend_mm": 40.0})
        acc.model_3d.name = "device-models/stack-t1.glb"
        acc.save()
        two = self._payload()["devices"][str(self.members[1].id)]
        self.assertEqual({p["cord_part"]["kind"] for p in two["stack_plugs"]}, {"cord"})
        self.assertEqual(two["stack_plugs"][0]["cord_part"]["cable"]["jacket_mm"], 6.0)
        # Stack ports' parts ride in stack_plugs only.
        self.assertEqual(two["plugs"], [])

    def test_a_generic_stackwise_port_seats_the_480_head(self):
        Interface.objects.filter(device__in=self.members).update(type="cisco-stackwise")
        acc = AccessoryType(tenant=self.tenant, vendor="Cisco", name="STACK-T1",
                            kind="cord", connector="stack", fits=[STACK],
                            cable={"profile": "round", "jacket_mm": 6.0, "pitch_mm": None,
                                   "min_bend_mm": 40.0})
        acc.model_3d.name = "device-models/stack-t1.glb"
        acc.save()
        two = self._payload()["devices"][str(self.members[1].id)]
        self.assertTrue(two["stack_plugs"])
        self.assertTrue(all(p["cord_part"] and p["cord_part"]["kind"] == "cord"
                            for p in two["stack_plugs"]))

    def test_not_counted_as_connected(self):
        self._payload()
        util = utilization_payload(Device.objects.filter(pk=self.members[1].pk),
                                   count_virtual=False)
        self.assertEqual(util["combined"]["connected"], 0)
        self.assertFalse(Interface.objects.filter(mark_connected=True).exists())

    def test_a_device_outside_a_stack_has_none(self):
        Device.objects.filter(pk__in=[m.pk for m in self.members]).update(
            virtual_chassis=None, vc_position=None)
        out = self._payload()
        self.assertEqual(out["stacks"], [])
        e = out["devices"][str(self.dev.id)]
        self.assertEqual((e["stack"], e["stack_plugs"], e["stack_covers"]), (None, [], []))

    def test_query_count_does_not_grow_with_members(self):
        with CaptureQueriesContext(connection) as two:
            self._payload(*self.members[:2])
        for i in range(4, 9):
            self.members.append(self._member(self._device(f"sw{i}", modules=False), i))
        with CaptureQueriesContext(connection) as eight:
            self.assertEqual(len(self._links()), 8)
        self.assertEqual(len(eight), len(two))

    def test_no_stacks_no_queries(self):
        Device.objects.filter(pk__in=[m.pk for m in self.members]).update(
            virtual_chassis=None, vc_position=None)
        with CaptureQueriesContext(connection) as q:
            self._payload()
        self.assertFalse(any("api_virtualchassis" in x["sql"] for x in q.captured_queries))


class ScopeTests(_Base):
    def _reader(self, types, *, devices=None):
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="r", object_types=types, actions=["view"],
            constraints={"name__in": devices} if devices else None)
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        if devices:
            rest = ObjectPermission.objects.create(
                name="rest", object_types=[t for t in types if t != "device"],
                actions=["view"])
            rest.users.add(user)
            rest.tenants.add(self.tenant)
            grant.object_types = ["device"]
            grant.save()
        self._login(user)

    def test_hidden_members_are_never_listed_or_linked(self):
        self._reader(["device", "devicetype", "interface", "cable"], devices=["sw1", "sw3"])
        out = self._payload()
        [s] = out["stacks"]
        self.assertEqual([m["name"] for m in s["members"]], ["sw1", "sw3"])
        # 1→2 and 2→3 touch the hidden member; 3→1 stays.
        self.assertEqual([(lk["a"]["name"], lk["b"]["name"]) for lk in s["links"]],
                         [("StackPort3/1", "StackPort1/2")])
        self.assertNotIn(str(self.members[1].id), out["devices"])

    def test_without_interface_view_no_links(self):
        self._reader(["device", "devicetype", "cable"])
        [s] = self._payload()["stacks"]
        self.assertEqual(s["links"], [])

    def test_without_cable_view_recorded_cables_are_not_drawn(self):
        self._cable("StackPort1/1", "StackPort2/2")
        self._reader(["device", "devicetype", "interface"])
        [s] = self._payload()["stacks"]
        # Not drawn, and not derived over: the free links stay derived.
        self.assertEqual([(lk["a"]["name"], lk["b"]["name"], lk["derived"])
                          for lk in s["links"]],
                         [("StackPort2/1", "StackPort3/2", True),
                          ("StackPort3/1", "StackPort1/2", True)])

    def test_another_tenants_stack_never_shows(self):
        other_vc = VirtualChassis.objects.create(tenant=self.other, name="OTHER")
        Device.objects.filter(pk=self.members[1].pk).update(virtual_chassis=other_vc)
        out = self._payload()
        self.assertEqual([s["name"] for s in out["stacks"]], ["STACK"])
        self.assertEqual([(lk["a"]["name"], lk["b"]["name"]) for s in out["stacks"]
                          for lk in s["links"]],
                         [("StackPort1/1", "StackPort3/2"), ("StackPort3/1", "StackPort1/2")])
        self.assertIsNone(out["devices"][str(self.members[1].id)]["stack"])


class AnyVendorTests(_Base):
    """Stacks over data ports marked ``stack_port`` and chains."""

    def _data_ports(self):
        # Every member's two QSFP ports carry the stack; the media type stays.
        Interface.objects.filter(type=STACK).delete()
        for m in self.members:
            pos = m.vc_position
            for p in (49, 50):
                Interface.objects.create(device=m, name=f"{pos}/1/{p}", type="10gbase-x-sfpp",
                                         stack_port=True)
        InterfaceTemplate.objects.filter(device_type=self.dt).delete()
        InterfaceTemplate.objects.create(device_type=self.dt, name="{position}/1/49",
                                         type="10gbase-x-sfpp", stack_port=True)
        InterfaceTemplate.objects.create(device_type=self.dt, name="{position}/1/50",
                                         type="10gbase-x-sfpp", stack_port=True)
        anchors = {**self.dt.model_anchors,
                   "ports": {"1/1/49": {"node": 40}, "1/1/50": {"node": 41}}}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=anchors)

    def test_marked_data_ports_form_the_ring(self):
        self._data_ports()
        self.assertEqual(self._links(), [
            ("1/1/49", "2/1/50", True),
            ("2/1/49", "3/1/50", True),
            ("3/1/49", "1/1/50", True),
        ])

    def test_marked_data_ports_take_their_media_heads(self):
        self._data_ports()
        dac = AccessoryType(tenant=self.tenant, vendor="Generic", name="SFP-DAC",
                            kind="cord", connector="dac", fits=["10gbase-x-sfpp"])
        dac.model_3d.name = "device-models/sfp-dac.glb"
        dac.save()
        self._cable("1/1/49", "2/1/50", type="dac-passive")
        two = self._payload()["devices"][str(self.members[1].id)]
        [p] = [q for q in two["stack_plugs"] if q["name"] == "2/1/50"]
        self.assertEqual((p["name"], p["derived"], p["cord_part"]["connector"]),
                         ("2/1/50", False, "dac"))

    def test_a_recorded_transceiver_stays_in_its_port(self):
        from .models import InventoryItem

        self._data_ports()
        sr = AccessoryType(tenant=self.tenant, vendor="Generic", name="SFP-SR",
                           kind="transceiver", connector="lc", fits=["10gbase-x-sfpp"],
                           parts=["SFP-10G-SR"])
        sr.model_3d.name = "device-models/sfp-sr.glb"
        sr.save()
        self._cable("1/1/49", "2/1/50", type="mmf-om4")
        InventoryItem.objects.create(device=self.dev, name="optic", kind="transceiver",
                                     part_id="SFP-10G-SR", serial_number="X1",
                                     interface=Interface.objects.get(name="1/1/49"))
        one = self._payload()["devices"][str(self.dev.id)]
        [p] = [q for q in one["stack_plugs"] if q["name"] == "1/1/49"]
        self.assertEqual((p["transceiver"], p["transceiver_part"]["kind"]),
                         ({"part_id": "SFP-10G-SR", "serial": "X1"}, "transceiver"))
        self.assertEqual(one["plugs"], [])

    def test_a_chain_has_no_closing_link(self):
        VirtualChassis.objects.filter(pk=self.vc.pk).update(stack_topology="chain")
        self.assertEqual(self._links(), [
            ("StackPort1/1", "StackPort2/2", True),
            ("StackPort2/1", "StackPort3/2", True),
        ])

    def test_a_cable_off_the_stack_takes_only_its_port(self):
        uplink = Interface.objects.create(device=self.dev, name="Te1/0/9")
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A",
                                        interface=Interface.objects.get(name="StackPort2/1"))
        CableTermination.objects.create(cable=cable, end="B", interface=uplink)
        # The port is taken: no stack cable is derived into it.
        self.assertEqual(self._links(), [
            ("StackPort1/1", "StackPort2/2", True),
            ("StackPort3/1", "StackPort1/2", True),
        ])

    def test_the_mark_is_copied_from_the_template(self):
        from .models import materialize_device_components

        dev = self._device("sw9", modules=False)
        Device.objects.filter(pk=dev.pk).update(virtual_chassis=self.vc, vc_position=9)
        dev.refresh_from_db()
        InterfaceTemplate.objects.create(device_type=self.dt, name="{position}/1/49",
                                         type="10gbase-x-sfpp", stack_port=True)
        materialize_device_components(dev)
        self.assertTrue(Interface.objects.get(device=dev, name="9/1/49").stack_port)
        self.assertFalse(Interface.objects.get(device=dev, name="StackPort9/1").stack_port)


class PackKeyTests(_Base):
    def test_stack_true_marks_the_template(self):
        from .devicetype_import import import_devicetype_yaml

        r = import_devicetype_yaml(self.tenant, """\
manufacturer: Generic
model: Stacker
slug: stacker
u_height: 1
interfaces:
  - name: 1/1/49
    type: 25gbase-x-sfp28
    stack: true
  - name: 1/1/1
    type: 1000base-t
""")
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="Stacker")
        marks = dict(dt.interface_templates.values_list("name", "stack_port"))
        self.assertEqual(marks, {"1/1/49": True, "1/1/1": False})


# ── StackPower ──────────────────────────────────────────────────────────────

SPWR = "cisco-stackpower"


class PowerRingTests(SimpleTestCase):
    def _ports(self, n):
        return [(f"m{i}", ["StackPower1/A", "StackPower1/B"]) for i in range(1, n + 1)]

    def _pairs(self, n):
        return [(a[0], b[0]) for a, b in power_ring(self._ports(n))]

    def test_two_members_get_two_cables(self):
        self.assertEqual(power_ring(self._ports(2)), [
            (("m1", "StackPower1/B"), ("m2", "StackPower1/A")),
            (("m2", "StackPower1/B"), ("m1", "StackPower1/A")),
        ])

    def test_three_and_four_close_one_ring(self):
        self.assertEqual(self._pairs(3), [("m1", "m2"), ("m2", "m3"), ("m3", "m1")])
        self.assertEqual(self._pairs(4), [("m1", "m2"), ("m2", "m3"), ("m3", "m4"),
                                          ("m4", "m1")])

    def test_five_split_into_four_and_a_lone_member(self):
        self.assertEqual(self._pairs(5), self._pairs(4))

    def test_nine_split_into_two_rings_of_four(self):
        self.assertEqual(self._pairs(9), [
            ("m1", "m2"), ("m2", "m3"), ("m3", "m4"), ("m4", "m1"),
            ("m5", "m6"), ("m6", "m7"), ("m7", "m8"), ("m8", "m5"),
        ])

    def test_six_leave_a_ring_of_two(self):
        self.assertEqual(self._pairs(6)[4:], [("m5", "m6"), ("m6", "m5")])

    def test_a_member_without_the_port_skips_its_links(self):
        ports = self._ports(3)
        ports[1] = ("m2", ["StackPower1/A"])
        self.assertEqual(power_ring(ports), [
            (("m1", "StackPower1/B"), ("m2", "StackPower1/A")),
            (("m3", "StackPower1/B"), ("m1", "StackPower1/A")),
        ])

    def test_the_type_is_a_power_port_choice(self):
        from .dcim_choices import POWER_PORT_TYPE_CHOICES, STACK_POWER_PORT_TYPES

        self.assertEqual(STACK_POWER_PORT_TYPES, frozenset({SPWR}))
        self.assertIn((SPWR, "Cisco StackPower"),
                      [o for _g, opts in POWER_PORT_TYPE_CHOICES for o in opts])


class _PowerBase(_Base):
    """The stack's members with a C9300's two StackPower ports, anchored
    and covered on the model."""

    def setUp(self):
        super().setUp()
        for t in ("StackPower1/A", "StackPower1/B"):
            PowerPortTemplate.objects.create(device_type=self.dt, name=t, type=SPWR)
        anchors = self.dt.model_anchors
        self.dt.model_anchors = {
            **anchors,
            "ports": {**anchors["ports"], "StackPower1/A": {"node": 50},
                      "StackPower1/B": {"node": 51}},
            "port_covers": {**anchors["port_covers"], "StackPower1/A": {"node": 52},
                            "StackPower1/B": {"node": 53}},
        }
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=self.dt.model_anchors)
        for m in self.members:
            self._power(m)

    def _power(self, dev):
        for name in ("StackPower1/A", "StackPower1/B"):
            PowerPort.objects.get_or_create(device=dev, name=name, defaults={"type": SPWR})

    def _add(self, n):
        for i in range(len(self.members) + 1, n + 1):
            m = self._member(self._device(f"sw{i}", modules=False), i)
            self._power(m)
            self.members.append(m)

    def _power_links(self, *devs):
        stacks = self._payload(*devs)["stacks"]
        pos = {str(m.id): m.vc_position for m in self.members}
        return [(pos[lk["a"]["device"]], lk["a"]["name"], pos[lk["b"]["device"]],
                 lk["b"]["name"], lk["derived"])
                for s in stacks for lk in s["links"] if lk["kind"] == "power"]

    def _power_cable(self, a_dev, a, b_dev, b, **kw):
        cable = Cable.objects.create(tenant=self.tenant, **{"type": "power", **kw})
        CableTermination.objects.create(cable=cable, end="A",
                                        power_port=PowerPort.objects.get(device=a_dev, name=a))
        CableTermination.objects.create(cable=cable, end="B",
                                        power_port=PowerPort.objects.get(device=b_dev, name=b))
        return cable


class StackPowerTests(_PowerBase):
    def test_derived_power_ring_of_three_beside_the_data_ring(self):
        out = self._payload()
        [s] = out["stacks"]
        self.assertEqual([lk["kind"] for lk in s["links"]], ["data"] * 3 + ["power"] * 3)
        self.assertEqual(self._power_links(), [
            (1, "StackPower1/B", 2, "StackPower1/A", True),
            (2, "StackPower1/B", 3, "StackPower1/A", True),
            (3, "StackPower1/B", 1, "StackPower1/A", True),
        ])
        two = out["devices"][str(self.members[1].id)]
        power = [(p["port"], p["port_type"], p["derived"], p["end"])
                 for p in two["stack_plugs"] if p["port_type"] == SPWR]
        # Member 2's A is the B end of 1→2, its B the A end of 2→3.
        self.assertEqual(power, [("StackPower1/A", SPWR, True, "b"),
                                 ("StackPower1/B", SPWR, True, "a")])
        self.assertEqual(two["stack_covers"], ["StackPort1/1", "StackPort1/2",
                                               "StackPower1/A", "StackPower1/B"])
        self.assertEqual(two["covers"], [])

    def test_two_and_four_members(self):
        Device.objects.filter(pk=self.members[2].pk).update(virtual_chassis=None,
                                                            vc_position=None)
        self.assertEqual(self._power_links(*self.members[:2]), [
            (1, "StackPower1/B", 2, "StackPower1/A", True),
            (2, "StackPower1/B", 1, "StackPower1/A", True),
        ])
        Device.objects.filter(pk=self.members[2].pk).update(virtual_chassis=self.vc,
                                                            vc_position=3)
        self._add(4)
        self.assertEqual([(a, b) for a, _, b, _, _ in self._power_links()],
                         [(1, 2), (2, 3), (3, 4), (4, 1)])

    def test_five_members_ring_four_and_leave_the_fifth(self):
        self._add(5)
        self.assertEqual([(a, b) for a, _, b, _, _ in self._power_links()],
                         [(1, 2), (2, 3), (3, 4), (4, 1)])
        # The data ring still runs through all five.
        links = self._payload()["stacks"][0]["links"]
        self.assertEqual(len([lk for lk in links if lk["kind"] == "data"]), 5)
        five = self._payload()["devices"][str(self.members[4].id)]
        self.assertFalse([p for p in five["stack_plugs"] if p["port_type"] == SPWR])

    def test_nine_members_make_two_rings(self):
        self._add(9)
        self.assertEqual([(a, b) for a, _, b, _, _ in self._power_links()],
                         [(1, 2), (2, 3), (3, 4), (4, 1), (5, 6), (6, 7), (7, 8), (8, 5)])

    def test_a_chain_stack_still_closes_its_power_ring(self):
        VirtualChassis.objects.filter(pk=self.vc.pk).update(stack_topology="chain")
        self.assertEqual(len(self._power_links()), 3)

    def test_recorded_power_cables_win(self):
        m1, m2, m3 = self.members
        cable = self._power_cable(m1, "StackPower1/A", m3, "StackPower1/B",
                                  label="CAB-SPWR-30CM", color="#808080",
                                  length=30, length_unit="cm")
        pa = PowerPort.objects.get(device=m1, name="StackPower1/A")
        pb = PowerPort.objects.get(device=m3, name="StackPower1/B")
        out = self._payload()
        [s] = out["stacks"]
        power = [lk for lk in s["links"] if lk["kind"] == "power"]
        self.assertEqual(power, [{
            "a": {"device": str(m1.id), "port": "StackPower1/A", "name": "StackPower1/A",
                  "id": str(pa.id)},
            "b": {"device": str(m3.id), "port": "StackPower1/B", "name": "StackPower1/B",
                  "id": str(pb.id)},
            "kind": "power", "derived": False, "cable": str(cable.id), "color": "#808080",
            "label": "CAB-SPWR-30CM", "length_m": 0.3, "parts": []}] + power[1:])
        # The rest of the power ring stays derived.
        self.assertEqual([lk["derived"] for lk in power], [False, True, True])
        # The data ring is decided apart and still derived.
        self.assertEqual([lk["derived"] for lk in s["links"] if lk["kind"] == "data"],
                         [True] * 3)
        one = out["devices"][str(m1.id)]
        # A cabled power port hides its cover as any cabled port does.
        self.assertEqual(one["covers"], ["StackPower1/A"])
        self.assertNotIn("StackPower1/A", one["stack_covers"])
        self.assertEqual([p["end"] for p in one["stack_plugs"]
                          if p["port_type"] == SPWR and not p["derived"]], ["a"])
        # Member 2's StackPower ports are in the two derived links.
        self.assertEqual([p["port_type"] for p in out["devices"][str(m2.id)]["stack_plugs"]],
                         [STACK, STACK, SPWR, SPWR])

    def test_a_recorded_data_cable_leaves_the_power_ring(self):
        self._cable("StackPort1/1", "StackPort2/2")
        links = self._payload()["stacks"][0]["links"]
        self.assertEqual([(lk["kind"], lk["derived"]) for lk in links],
                         [("data", False), ("data", True), ("data", True)]
                         + [("power", True)] * 3)

    def test_the_stackpower_head_seats_at_each_end(self):
        acc = AccessoryType(tenant=self.tenant, vendor="Cisco", name="CAB-SPWR",
                            kind="cord", connector="stack", fits=[SPWR],
                            parts=["CAB-SPWR-30CM", "CAB-SPWR-150CM"],
                            cable={"profile": "round", "jacket_mm": 8.5, "pitch_mm": None,
                                   "min_bend_mm": 40.0})
        acc.model_3d.name = "device-models/cab-spwr.glb"
        acc.save()
        two = self._payload()["devices"][str(self.members[1].id)]
        heads = {p["name"]: p["cord_part"] for p in two["stack_plugs"]}
        self.assertEqual(heads["StackPower1/A"]["cable"]["jacket_mm"], 8.5)
        self.assertEqual(heads["StackPower1/A"]["connector"], "stack")
        # A StackWise port does not take it.
        self.assertIsNone(heads["StackPort2/1"])

    def test_not_counted_as_connected(self):
        self._payload()
        self.assertFalse(CableTermination.objects.filter(power_port__isnull=False).exists())

    def test_query_count_does_not_grow_with_members(self):
        with CaptureQueriesContext(connection) as two:
            self._payload(*self.members[:2])
        self._add(8)
        with CaptureQueriesContext(connection) as eight:
            self.assertEqual(len(self._power_links()), 8)
        self.assertEqual(len(eight), len(two))

    def test_power_ports_add_no_query(self):
        with CaptureQueriesContext(connection) as with_power:
            self._payload()
        PowerPort.objects.all().delete()
        with CaptureQueriesContext(connection) as without:
            self._payload()
        self.assertEqual(len(with_power), len(without))


class StackPowerScopeTests(_PowerBase):
    def _reader(self, types):
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="r", object_types=types,
                                                actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)

    def test_without_power_port_view_no_power_links(self):
        self._reader(["device", "devicetype", "interface", "cable"])
        out = self._payload()
        [s] = out["stacks"]
        self.assertEqual({lk["kind"] for lk in s["links"]}, {"data"})
        one = out["devices"][str(self.dev.id)]
        self.assertNotIn("StackPower1/A", one["stack_covers"])

    def test_with_power_port_view_power_links(self):
        self._reader(["device", "devicetype", "interface", "powerport", "cable"])
        self.assertEqual(len(self._power_links()), 3)

    def test_without_cable_view_recorded_power_cables_are_not_drawn(self):
        self._power_cable(self.members[0], "StackPower1/B", self.members[1], "StackPower1/A")
        self._reader(["device", "devicetype", "interface", "powerport"])
        # Not drawn; only the links between free ports stay derived.
        self.assertTrue(self._power_links())
        self.assertTrue(all(lk[-1] for lk in self._power_links()))
        # The port is cabled and theirs to view: its cover still hides.
        one = self._payload()["devices"][str(self.dev.id)]
        self.assertIn("StackPower1/B", one["covers"])

    def test_without_power_port_view_a_cabled_port_keeps_its_cover(self):
        self._power_cable(self.members[0], "StackPower1/B", self.members[1], "StackPower1/A")
        self._reader(["device", "devicetype", "interface", "cable"])
        one = self._payload()["devices"][str(self.dev.id)]
        self.assertNotIn("StackPower1/B", one["covers"])

    def test_another_tenants_member_never_joins_the_power_ring(self):
        other_vc = VirtualChassis.objects.create(tenant=self.other, name="OTHER")
        Device.objects.filter(pk=self.members[1].pk).update(virtual_chassis=other_vc)
        self.assertEqual([(a, b) for a, _, b, _, _ in self._power_links()],
                         [(1, 3), (3, 1)])


class StackPowerImportTests(_Base):
    YAML = """\
manufacturer: Cisco
model: C9300-24P
part_number: C9300-24P
u_height: 1
interfaces:
  - name: GigabitEthernet1/0/1
    type: 1000base-t
power-ports:
  - name: StackPower1/A
    type: cisco-stackpower
  - name: StackPower1/B
    type: cisco-stackpower
"""

    def test_a_new_type_keeps_the_stackpower_type(self):
        from .devicetype_import import import_devicetype_yaml

        r = import_devicetype_yaml(self.tenant, self.YAML)
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="C9300-24P")
        self.assertEqual(sorted(dt.power_port_templates.values_list("name", "type")),
                         [("StackPower1/A", SPWR), ("StackPower1/B", SPWR)])

    def test_a_matched_type_gains_its_stackpower_ports(self):
        import os
        import shutil
        import tempfile

        from .devicetype_import import import_devicetype_yaml
        from .model_pack import PackFiles, import_pack

        old = self.YAML.split("power-ports:")[0]
        self.assertTrue(import_devicetype_yaml(self.tenant, old)["ok"])
        dt = DeviceType.objects.get(tenant=self.tenant, name="C9300-24P")
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, "device-types/Cisco"))
            with open(os.path.join(root, "pack.yaml"), "w") as fh:
                fh.write("name: Test\nversion: 1.0.0\n")
            with open(os.path.join(root, "device-types/Cisco/C9300-24P.yaml"), "w") as fh:
                fh.write(self.YAML)
            files = PackFiles(root)
            try:
                result = import_pack(self.tenant, files, dry_run=False)
            finally:
                files.close()
            [row] = result.types
            self.assertEqual(row.action, "matched")
            self.assertIn("added 2 power ports: StackPower1/A, StackPower1/B", row.notes)
            self.assertEqual(dt.power_port_templates.filter(type=SPWR).count(), 2)
            # Again: nothing more to add.
            files = PackFiles(root)
            try:
                again = import_pack(self.tenant, files, dry_run=False)
            finally:
                files.close()
            self.assertFalse([n for n in again.types[0].notes if n.startswith("added")])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_a_differing_interface_type_is_reported_not_changed(self):
        from .devicetype_import import interface_type_notes

        # self.dt carries StackPort{position}/n templates typed STACK.
        InterfaceTemplate.objects.filter(device_type=self.dt, name__startswith="StackPort"
                                         ).update(type="cisco-stackwise")
        notes = interface_type_notes(self.dt, {"interfaces": [
            {"name": "StackPort1/1", "type": STACK},
            {"name": "StackPort1/2", "type": "cisco-stackwise"},
            {"name": "Nowhere1/1", "type": STACK}, {"type": STACK}, "junk"]})
        self.assertEqual(notes, [
            "StackPort{position}/1: type cisco-stackwise here, cisco-stackwise-480 in the "
            "pack - set the template's type and sync the type to update."])
        self.assertEqual(set(InterfaceTemplate.objects.filter(
            device_type=self.dt, name__startswith="StackPort").values_list("type", flat=True)),
            {"cisco-stackwise"})

    def test_a_pack_import_notes_the_differing_type(self):
        import os
        import shutil
        import tempfile

        from .devicetype_import import import_devicetype_yaml
        from .model_pack import PackFiles, import_pack

        self.assertTrue(import_devicetype_yaml(self.tenant, self.YAML.replace(
            "1000base-t", "1000base-x-sfp"))["ok"])
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, "device-types/Cisco"))
            with open(os.path.join(root, "device-types/Cisco/C9300-24P.yaml"), "w") as fh:
                fh.write(self.YAML)
            files = PackFiles(root)
            try:
                [row] = import_pack(self.tenant, files, dry_run=True).types
            finally:
                files.close()
            self.assertEqual(row.action, "matched")
            # A library type has no pack record: reported, not changed.
            self.assertIn("kept 1 interface, type 1000base-x-sfp (the pack has 1000base-t): "
                          "GigabitEthernet1/0/1", row.notes)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_a_positioned_type_gets_positioned_names(self):
        from .devicetype_import import add_device_power_ports

        # self.dt carries StackPort{position}/n interface templates.
        n = add_device_power_ports(self.dt, {"power-ports": [
            {"name": "StackPower1/A", "type": SPWR}, {"name": "StackPower1/B", "type": SPWR},
            {"name": "StackPower1/B", "type": SPWR}, {"type": SPWR}, "junk"]})
        self.assertEqual(n, 2)
        self.assertEqual(sorted(self.dt.power_port_templates.values_list("name", flat=True)),
                         ["StackPower{position}/A", "StackPower{position}/B"])

    def test_the_anchor_matches_the_chassis_power_port(self):
        from .anchor_names import chassis_port

        PowerPortTemplate.objects.create(device_type=self.dt, name="StackPower1/A", type=SPWR)
        dev = Device.objects.get(pk=self.dev.pk)
        self.assertEqual(chassis_port(dev, "StackPower1/A"), ("power-port", "StackPower1/A"))
        from .model_anchors import interface_matcher, mismatches

        warnings = mismatches({"ports": {"StackPower1/A": {}}}, None,
                              interface_matcher(self.dt, ["StackPort{position}/1"]))
        self.assertFalse([w for w in warnings if "StackPower" in w])


class ModulePortTests(_Base):
    """A stack port a module brings (a stack kit's ``StackPort{module}``,
    drawn in its bay): the chassis has no ``port:`` anchor for it, the
    module does."""

    def setUp(self):
        super().setUp()
        from .models import Module, ModuleBay, ModuleInterfaceTemplate, ModuleType
        from .tests_led_state import _anchors

        anchors = {**self.dt.model_anchors, "ports": {}, "port_covers": {},
                   "bays": {**self.dt.model_anchors.get("bays", {}),
                            "Stack1": {"node": 60, "m": []}, "Stack2": {"node": 61, "m": []}}}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=anchors)
        self.kit = ModuleType.objects.create(
            tenant=self.tenant, name="KIT", manufacturer=self.dt.manufacturer,
            model_anchors={**_anchors(), "ports": {"StackPort{module}": {"node": 1}}})
        self.kit.model_3d.name = "device-models/kit.glb"
        self.kit.save()
        self.t = ModuleInterfaceTemplate.objects.create(
            module_type=self.kit, name="StackPort{module}", type=STACK)
        self.Module, self.ModuleBay = Module, ModuleBay

    def _seat(self):
        for m in self.members:
            pos = m.vc_position
            for p in (1, 2):
                bay = self.ModuleBay.objects.create(device=m, name=f"Stack{p}",
                                                    position=f"{pos}/{p}")
                module = self.Module.objects.create(device=m, module_bay=bay,
                                                    module_type=self.kit)
                Interface.objects.filter(device=m, name=f"StackPort{pos}/{p}").update(
                    module=module, module_template=self.t)

    def test_no_anchor_on_the_chassis_no_link(self):
        self.assertEqual(self._links(), [])

    def test_a_module_port_is_drawn_in_its_bay(self):
        self._seat()
        self.assertEqual(self._links(), [
            ("StackPort1/1", "StackPort2/2", True),
            ("StackPort2/1", "StackPort3/2", True),
            ("StackPort3/1", "StackPort1/2", True),
        ])
        out = self._payload()
        two = out["devices"][str(self.members[1].id)]
        self.assertEqual([(p["bay"], p["port"], p["name"]) for p in two["stack_plugs"]],
                         [("Stack1", "StackPort2/1", "StackPort2/1"),
                          ("Stack2", "StackPort2/2", "StackPort2/2")])

    def test_a_recorded_cable_on_module_ports(self):
        self._seat()
        cable = self._cable("StackPort1/1", "StackPort2/2")
        out = self._payload()
        links = [lk for s in out["stacks"] for lk in s["links"] if not lk["derived"]]
        self.assertEqual([(lk["a"]["name"], lk["b"]["name"], lk["cable"]) for lk in links],
                         [("StackPort1/1", "StackPort2/2", str(cable.id))])
        one = out["devices"][str(self.dev.id)]
        # The cabled module port's part rides in stack_plugs only.
        self.assertFalse([p for p in one["plugs"] if p["name"] == "StackPort1/1"])
        self.assertIn(("Stack1", "StackPort1/1"),
                      [(p["bay"], p["name"]) for p in one["stack_plugs"]])
