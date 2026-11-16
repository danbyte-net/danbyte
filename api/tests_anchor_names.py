"""Model anchor names against ``{position}`` templates (api.anchor_names):
the matcher (cases shared with frontend/src/lib/anchor-names.test.ts), the
scan's warnings, the projection's index, and a stack member's ports and port
LEDs found from a model authored as member 1."""
from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings
from django.test import SimpleTestCase

from .anchor_names import NameMatcher, authored, interface_name
from .model_anchors import interface_matcher, mismatches
from .model_projection import image_ports_from_anchors
from .models import (
    Device,
    Interface,
    InterfaceTemplate,
    Module,
    ModuleInterfaceTemplate,
    VirtualChassis,
    install_module,
    materialize_device_components,
)
from .tests_led_state import _Base as _LedBase
from .tests_model_anchors import _Base, chassis, module_glb

CASES = json.loads(
    (Path(settings.BASE_DIR) / "frontend/src/lib/anchor-names.cases.json").read_text())


class MatcherCaseTests(SimpleTestCase):
    def test_authored(self):
        for name, want in CASES["authored"]:
            with self.subTest(name=name):
                self.assertEqual(authored(name), want)

    def test_match(self):
        for c in CASES["match"]:
            with self.subTest(c["why"]):
                m = NameMatcher(c["names"])
                self.assertEqual(m.candidates(c["anchor"]), c["candidates"])
                self.assertEqual(m.resolve(c["anchor"]), c["resolve"])


class InterfaceNameTests(SimpleTestCase):
    def test_member_two(self):
        m = NameMatcher(["GigabitEthernet{position}/0/1"])
        self.assertEqual(interface_name("GigabitEthernet1/0/1", m, 2), "GigabitEthernet2/0/1")
        self.assertEqual(interface_name("GigabitEthernet1/0/1", m, None), "GigabitEthernet1/0/1")

    def test_an_anchor_with_its_own_token(self):
        self.assertEqual(interface_name("Gi{position}/0/1", NameMatcher([]), 3), "Gi3/0/1")

    def test_literal_templates_stay_literal(self):
        m = NameMatcher(["GigabitEthernet1/0/1"])
        self.assertEqual(interface_name("GigabitEthernet1/0/1", m, 2), "GigabitEthernet1/0/1")

    def test_module_and_position_compose(self):
        m = NameMatcher(["TenGigabitEthernet{position}/{module}/1"])
        self.assertEqual(
            interface_name("TenGigabitEthernet1/{module}/1", m, 2, "1"),
            "TenGigabitEthernet2/1/1")
        # The device library's literal module names keep their member digit.
        m = NameMatcher(["TenGigabitEthernet1/{module}/1"])
        self.assertEqual(
            interface_name("TenGigabitEthernet1/{module}/1", m, 2, "1"),
            "TenGigabitEthernet1/1/1")


class PositionMismatchTests(SimpleTestCase):
    templates = [f"GigabitEthernet{{position}}/0/{i}" for i in (1, 2)]

    def test_member_one_anchors_match_position_templates(self):
        anchors = {"ports": {"GigabitEthernet1/0/1": {}, "GigabitEthernet1/0/2": {}},
                   "leds": {"port:GigabitEthernet1/0/1": {}}}
        self.assertEqual(mismatches(anchors, [], self.templates), [])

    def test_other_members_and_strays_still_warn(self):
        anchors = {"ports": {"GigabitEthernet1/0/1": {}, "GigabitEthernet2/0/2": {}}}
        self.assertEqual(mismatches(anchors, [], self.templates), [
            "port:GigabitEthernet2/0/2 matches no interface.",
            "1 interface without a port: anchor (first: GigabitEthernet{position}/0/2).",
        ])

    def test_ambiguous_names_warn(self):
        anchors = {"ports": {"Gi1/0/1": {}}}
        warnings = mismatches(anchors, [], ["Gi{position}/0/1", "Gi{position:1}/0/1"])
        self.assertIn(
            "port:Gi1/0/1 matches more than one interface "
            "(Gi{position}/0/1, Gi{position:1}/0/1).", warnings)


class ProjectionIndexTests(SimpleTestCase):
    def test_a_marker_takes_the_template_it_matched(self):
        frame = {"w": 0.4826, "h": 0.04445}
        out = image_ports_from_anchors(
            [{"name": "GigabitEthernet1/0/1", "p": [0.0, 0.02, -0.2], "n": [0, 0, -1]},
             {"name": "GigabitEthernet1/0/9", "p": [0.1, 0.02, -0.2], "n": [0, 0, -1]}],
            {"GigabitEthernet{position}/0/1": ["interface", "1000base-t"]}, frame)
        self.assertEqual([m["name"] for m in out["doc"]["front"]],
                         ["GigabitEthernet{position}/0/1", "GigabitEthernet1/0/9"])
        self.assertEqual(out["unknown"], ["GigabitEthernet1/0/9"])


class StackMemberPortTests(_Base):
    """The test chassis names ``port:Te1/0/1``, ``port:Te1/0/2`` and the
    module ``port:Te1/{module}/1``; here the types use ``{position}``."""

    def setUp(self):
        super().setUp()
        InterfaceTemplate.objects.filter(device_type=self.dt).delete()
        for i in (1, 2, 3):
            InterfaceTemplate.objects.create(device_type=self.dt, name=f"Te{{position}}/0/{i}")
        ModuleInterfaceTemplate.objects.filter(module_type=self.mt).update(
            name="Te{position}/{module}/1")
        res = self._upload(f"/api/device-types/{self.dt.id}/model/", chassis())
        self.report = res.json()["model_scan"]
        self._upload(f"/api/module-types/{self.mt.id}/model/", module_glb())
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        self.dev = Device.objects.create(tenant=self.tenant, name="sw2", device_type=self.dt,
                                         site=self.site, virtual_chassis=self.vc,
                                         vc_position=2)
        materialize_device_components(self.dev)
        self.bays = {b.name: b for b in self.dev.module_bays.all()}

    def test_scan_matches_the_position_templates(self):
        warnings = [w for w in self.report["warnings"] if "interface" in w]
        self.assertEqual(warnings, ["1 interface without a port: anchor "
                                    "(first: Te{position}/0/3)."])

    def test_ports_are_the_members_own(self):
        from .model_ports import effective_model_ports

        self.assertEqual(sorted(self.dev.interfaces.values_list("name", flat=True)),
                         ["Te2/0/1", "Te2/0/2", "Te2/0/3"])
        install_module(Module.objects.create(device=self.dev, module_bay=self.bays["FAN 1"],
                                             module_type=self.mt))
        doc = effective_model_ports(Device.objects.get(pk=self.dev.pk))
        self.assertEqual(sorted(p["name"] for p in doc["ports"]),
                         ["Te2/0/1", "Te2/0/2", "Te2/1/1"])
        self.assertIn("Te2/1/1", set(self.dev.interfaces.values_list("name", flat=True)))

    def test_face_ports_resolve_the_members_interfaces(self):
        res = self.client.get(f"/api/devices/{self.dev.id}/face-ports/")
        self.assertEqual(res.status_code, 200, res.content)
        model = {e["name"]: e for e in res.json()["model"]}
        self.assertEqual(set(model), {"Te2/0/1", "Te2/0/2"})
        self.assertTrue(all(e["id"] for e in model.values()))

    def test_a_photo_marker_authored_as_member_one(self):
        self.dt.image_ports = {"front": [{"kind": "interface", "name": "Te1/0/3",
                                          "x": 0.5, "y": 0.5, "w": 0.01, "h": 0.1}]}
        self.dt.save()
        res = self.client.get(f"/api/devices/{self.dev.id}/face-ports/")
        front = res.json()["front"]
        want = str(self.dev.interfaces.get(name="Te2/0/3").id)
        self.assertEqual([e["id"] for e in front], [want])

    def test_a_members_own_model_matches_through_the_type(self):
        anchors = {"ports": {"Te1/0/1": {}}}
        ifaces = list(self.dev.interfaces.values_list("name", flat=True))
        self.assertEqual(
            mismatches(anchors, None, interface_matcher(self.dev, ifaces)),
            ["2 interfaces without a port: anchor (first: Te2/0/2)."])


class StackMemberLedTests(_LedBase):
    def test_port_led_of_member_two(self):
        InterfaceTemplate.objects.create(device_type=self.dt, name="Te{position}/0/1")
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.dev.pk).update(virtual_chassis=vc, vc_position=2)
        Interface.objects.create(device=self.dev, name="Te2/0/1")
        self._snmp(self.dev, [{"name": "Te2/0/1", "oper_status": "up"},
                              {"name": "Te1/0/1", "oper_status": "down"}])
        leds = self._leds(self.dev)[str(self.dev.id)]["leds"]
        self.assertEqual(leds.get("port:Te1/0/1"), "green")

    def test_module_port_led_of_member_two(self):
        ModuleInterfaceTemplate.objects.create(module_type=self.psu, name="Te{position}/{module}/9")
        self.psu.model_anchors = {**self.psu.model_anchors,
                                  "leds": {"port:Te1/{module}/9": {"node": 0,
                                                                   "led_material": True}}}
        self.psu.model_leds = {"port:*": {"source": "interface.oper_status"}}
        self.psu.save()
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.dev.pk).update(virtual_chassis=vc, vc_position=2)
        Interface.objects.create(device=self.dev, name="Te2/1/9")
        self._snmp(self.dev, [{"name": "Te2/1/9", "oper_status": "up"}])
        bays = self._leds(self.dev)[str(self.dev.id)]["bays"]
        self.assertEqual(bays["PS-1"], {"port:Te1/1/9": "green"})
