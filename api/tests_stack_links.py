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
    VirtualChassis,
)
from .port_utilization import utilization_payload
from .stack_links import head_for, ring
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
                                              "name": "StackPort2/1"})
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
        self.assertEqual(s["links"], [{
            "a": {"device": str(self.dev.id), "port": "StackPort1/1", "name": "StackPort1/1"},
            "b": {"device": str(self.members[2].id), "port": "StackPort1/2",
                  "name": "StackPort3/2"},
            "derived": False, "cable": str(cable.id), "color": "#00ff00", "label": "X"}])
        one = out["devices"][str(self.dev.id)]
        # A cabled port hides its cover as any does; nothing is derived.
        self.assertEqual((one["covers"], one["stack_covers"]), (["StackPort1/1"], []))
        self.assertEqual(out["devices"][str(self.members[1].id)]["stack_plugs"], [])

    def test_a_recorded_cable_takes_its_terminations_sides(self):
        # Cabled B on member 1, A on member 3: the band follows the cable.
        self._cable("StackPort3/2", "StackPort1/1")
        out = self._payload()
        ends = {(dev, p["name"]): p["end"] for dev, e in out["devices"].items()
                for p in e["stack_plugs"]}
        self.assertEqual(ends, {(str(self.dev.id), "StackPort1/1"): "b",
                                (str(self.members[2].id), "StackPort3/2"): "a"})

    def test_a_recorded_cable_elsewhere_in_the_stack_stops_the_ring(self):
        self._cable("StackPort2/1", "StackPort3/2")
        self.assertEqual(self._links(self.dev), [])

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
        # Nor is a ring derived in their place.
        self.assertEqual(s["links"], [])

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
        [p] = two["stack_plugs"]
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
        [p] = one["stack_plugs"]
        self.assertEqual((p["transceiver"], p["transceiver_part"]["kind"]),
                         ({"part_id": "SFP-10G-SR", "serial": "X1"}, "transceiver"))
        self.assertEqual(one["plugs"], [])

    def test_a_chain_has_no_closing_link(self):
        VirtualChassis.objects.filter(pk=self.vc.pk).update(stack_topology="chain")
        self.assertEqual(self._links(), [
            ("StackPort1/1", "StackPort2/2", True),
            ("StackPort2/1", "StackPort3/2", True),
        ])

    def test_a_cable_off_the_stack_does_not_stop_the_ring(self):
        uplink = Interface.objects.create(device=self.dev, name="Te1/0/9")
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A",
                                        interface=Interface.objects.get(name="StackPort2/1"))
        CableTermination.objects.create(cable=cable, end="B", interface=uplink)
        self.assertEqual(len(self._links()), 3)

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
