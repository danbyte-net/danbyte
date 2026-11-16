"""Port covers (export spec v1.5, api.port_covers): the scan collects
``cover:port:`` nodes and checks their names as ports' (stack-aware), and the
``/api/device-leds/`` and device studio payloads name the covers a device's
ports in use hide - cabled or marked connected, for a reader who may view
the interfaces - in a query count that does not grow with the devices."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from auth_api.models import ObjectPermission, UserProfile

from .model_anchors import interface_matcher, mismatches, scan, summary
from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    Interface,
    InterfaceTemplate,
    ModuleInterfaceTemplate,
    VirtualChassis,
)
from .tests_led_state import _Base as _LedBase
from .tests_model_anchors import model


def _scan(data):
    from .model_3d import validate_glb

    return scan(validate_glb(data))


class ScanTests(SimpleTestCase):
    def test_covers_are_collected(self):
        anchors, warnings = _scan(model([
            {"name": "Shell", "mesh": "Metal"},
            # gltfpack -kn: the named node keeps its mesh on a child.
            {"name": "cover:port:StackPort1/1", "children": [2]},
            {"mesh": "Metal", "scale": [0.01, 0.01, 0.01]},
            {"name": "cover:port:StackPort1/2", "mesh": "Metal"},
            {"name": "empty:NM", "children": [5]},
            {"name": "cover:port:Te1/1/1", "mesh": "Metal"},
            {"name": "cover:StackPort1/1", "mesh": "Metal"},
            {"name": "cover:port:", "mesh": "Metal"},
        ]))
        self.assertEqual(anchors["port_covers"], {
            "StackPort1/1": {"node": 1},
            "StackPort1/2": {"node": 3},
            "Te1/1/1": {"node": 5, "cover": "NM"},
        })
        self.assertIn("“cover:StackPort1/1” is not a port cover "
                      "(cover:port:<interface>); it is ignored.", warnings)
        self.assertIn("“cover:port:” has no name after the prefix.", warnings)
        self.assertEqual(summary(anchors), "0 bays, 0 ports, 0 LEDs, 3 port covers")

    def test_a_model_without_covers_summarises_as_before(self):
        anchors, _ = _scan(model([{"name": "port:Gi1"}]))
        self.assertEqual(anchors["port_covers"], {})
        self.assertEqual(summary(anchors), "0 bays, 1 port, 0 LEDs")

    def test_cover_names_match_as_ports(self):
        anchors = {"port_covers": {"StackPort1/1": {}, "StackPort1/9": {}}}
        warnings = mismatches(anchors, [], ["StackPort{position}/1", "StackPort{position}/2"])
        self.assertEqual(warnings, ["cover:port:StackPort1/9 matches no interface."])

    def test_module_covers_keep_the_token(self):
        warnings = mismatches({"port_covers": {"Te1/{module}/1": {}}}, None,
                              ["Te1/{module}/1"])
        self.assertEqual(warnings, [])


class _Base(_LedBase):
    def setUp(self):
        super().setUp()
        self.dt.model_anchors = {**self.dt.model_anchors, "port_covers": {
            "Te1/0/1": {"node": 20}, "Te1/0/2": {"node": 21}}}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=self.dt.model_anchors)
        self.dev.refresh_from_db()

    def _cable(self, iface):
        cable = Cable.objects.create(tenant=self.tenant, type="cat6")
        CableTermination.objects.create(cable=cable, end="A", interface=iface)

    def _iface(self, dev, name):
        return Interface.objects.get(device=dev, name=name)

    def _entry(self, dev=None):
        dev = dev or self.dev
        return self._leds(dev)[str(dev.id)]


class PayloadTests(_Base):
    def test_free_ports_keep_their_covers(self):
        e = self._entry()
        self.assertEqual((e["covers"], e["bay_covers"]), ([], {}))

    def test_cabled_and_marked_ports_hide_theirs(self):
        self._cable(self._iface(self.dev, "Te1/0/1"))
        self.assertEqual(self._entry()["covers"], ["Te1/0/1"])
        Interface.objects.filter(device=self.dev, name="Te1/0/2").update(mark_connected=True)
        self.assertEqual(self._entry()["covers"], ["Te1/0/1", "Te1/0/2"])

    def test_a_device_without_leds_still_gets_its_covers(self):
        anchors = {**self.dt.model_anchors, "leds": {}}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=anchors)
        self._cable(self._iface(self.dev, "Te1/0/2"))
        e = self._entry()
        self.assertEqual((e["leds"], e["covers"]), ({}, ["Te1/0/2"]))

    def test_module_covers_take_the_bay_position(self):
        self.psu.model_anchors = {**self.psu.model_anchors,
                                  "port_covers": {"Te1/{module}/9": {"node": 3}}}
        self.psu.save()
        self._cable(Interface.objects.create(device=self.dev, name="Te1/1/9"))
        e = self._entry()
        # PS-1 (position 1) is cabled; PS-0's Te1/0/9 does not exist.
        self.assertEqual(e["bay_covers"], {"PS-1": ["Te1/1/9"]})
        self.assertEqual(e["covers"], [])

    def test_stack_member_two(self):
        InterfaceTemplate.objects.create(device_type=self.dt, name="Te{position}/0/1")
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.dev.pk).update(virtual_chassis=vc, vc_position=2)
        member = Interface.objects.create(device=self.dev, name="Te2/0/1")
        # Member 1's spelling on member 2 is a different port, cabled: no hit.
        self._cable(self._iface(self.dev, "Te1/0/1"))
        self.assertEqual(self._entry()["covers"], [])
        self._cable(member)
        # The anchor as authored (member 1) names the member's own port.
        self.assertEqual(self._entry()["covers"], ["Te1/0/1"])

    def test_module_cover_on_stack_member_two(self):
        ModuleInterfaceTemplate.objects.create(module_type=self.psu,
                                               name="Te{position}/{module}/9")
        self.psu.model_anchors = {**self.psu.model_anchors,
                                  "port_covers": {"Te1/{module}/9": {"node": 3}}}
        self.psu.save()
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.dev.pk).update(virtual_chassis=vc, vc_position=2)
        self._cable(Interface.objects.create(device=self.dev, name="Te2/1/9"))
        self.assertEqual(self._entry()["bay_covers"], {"PS-1": ["Te1/1/9"]})

    def test_query_count_does_not_grow_with_devices(self):
        self._cable(self._iface(self.dev, "Te1/0/1"))
        with CaptureQueriesContext(connection) as one:
            self._leds(self.dev)
        more = [self._device(f"sw{i}") for i in range(2, 7)]
        for d in more:
            self._cable(self._iface(d, "Te1/0/2"))
        with CaptureQueriesContext(connection) as six:
            out = self._leds(self.dev, *more)
        self.assertEqual(len(six), len(one))
        self.assertEqual({k: v["covers"] for k, v in out.items()},
                         {str(self.dev.id): ["Te1/0/1"],
                          **{str(d.id): ["Te1/0/2"] for d in more}})

    def test_device_studio_payload(self):
        self._cable(self._iface(self.dev, "Te1/0/2"))
        res = self.client.get(f"/api/devices/{self.dev.id}/studio/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.json()["covers"], res.json()["bay_covers"]), (["Te1/0/2"], {}))


class ScopeTests(_Base):
    def _reader(self, types):
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="r", object_types=types,
                                                actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)

    def test_without_interface_view_covers_stay_as_authored(self):
        self._cable(self._iface(self.dev, "Te1/0/1"))
        self._reader(["device", "devicetype", "module", "modulebay", "moduletype"])
        self.assertEqual(self._entry()["covers"], [])

    def test_with_interface_view_they_hide(self):
        self._cable(self._iface(self.dev, "Te1/0/1"))
        self._reader(["device", "devicetype", "interface"])
        self.assertEqual(self._entry()["covers"], ["Te1/0/1"])


class StackMatcherTests(_LedBase):
    def test_a_members_own_model_matches_covers_through_the_type(self):
        InterfaceTemplate.objects.create(device_type=self.dt, name="StackPort{position}/1")
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.dev.pk).update(virtual_chassis=vc, vc_position=2)
        Interface.objects.create(device=self.dev, name="StackPort2/1")
        dev = Device.objects.get(pk=self.dev.pk)
        ifaces = list(dev.interfaces.values_list("name", flat=True))
        warnings = mismatches({"port_covers": {"StackPort1/1": {}, "StackPort1/2": {}}},
                              None, interface_matcher(dev, ifaces))
        self.assertEqual(warnings, ["cover:port:StackPort1/2 matches no interface."])
