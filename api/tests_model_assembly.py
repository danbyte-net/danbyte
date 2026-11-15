"""Modular 3D models put together (api.model_3d.installed_parts,
api.model_anchors.port_doc, api.model_ports.anchored_model_ports): each
device's installed modules in one batch and their scope, the bays a device's
effective model lists, and ports placed by the chassis' and modules'
anchors."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from auth_api.models import ObjectPermission, UserProfile

from .model_anchors import port_doc, scan
from .models import Device, FloorPlan, FloorPlanTile, Module
from .tests_model_anchors import _Base, chassis, module_glb


class PortDocTests(SimpleTestCase):
    class Owner:
        model_3d_up = "y"
        model_3d_front = "+z"

    def test_chassis_and_module_ports_in_the_upright_frame(self):
        from .model_3d import validate_glb

        owner = self.Owner()
        owner.model_anchors, _ = scan(validate_glb(chassis()))
        mod, _ = scan(validate_glb(module_glb()))
        doc = port_doc(owner, [("PS-0", lambda n: n.replace("{module}", "2"), mod)])
        ports = {p["name"]: p for p in doc["ports"]}
        self.assertEqual(set(ports), {"Te1/0/1", "Te1/0/2", "Te1/2/1"})
        self.assertEqual([round(b, 4) for b in doc["bounds"]], [0.44, 0.044, 0.45])
        # Front +z turns to -Z: the front face is z = 0 of the 0..1 box.
        self.assertEqual(ports["Te1/0/1"]["p"][2], 0.0)
        self.assertEqual(ports["Te1/0/1"]["n"], [0.0, 0.0, -1.0])
        # The module sits in a rear bay turned half round: its port is on
        # the back (z = 1), facing +Z, mirrored in x.
        back = ports["Te1/2/1"]
        self.assertEqual(back["p"][2], 1.0)
        self.assertEqual(back["n"], [0.0, 0.0, 1.0])
        self.assertAlmostEqual(back["p"][0], (0.22 - 0.17 + 0.01) / 0.44, places=4)

    def test_nothing_without_ports(self):
        owner = self.Owner()
        owner.model_anchors = {"box": [[0, 0, 0], [1, 1, 1]], "ports": {}}
        self.assertIsNone(port_doc(owner, []))


class InstalledPartsTests(_Base):
    def setUp(self):
        super().setUp()
        self._upload(f"/api/device-types/{self.dt.id}/model/", chassis())
        self._upload(f"/api/module-types/{self.mt.id}/model/", module_glb())
        self.dev, self.bays = self._device()
        self.module = Module.objects.create(device=self.dev, module_bay=self.bays["PS-0"],
                                            module_type=self.mt)

    def test_effective_lists_the_bays(self):
        eff = self.client.get(f"/api/devices/{self.dev.id}/").json()["model_3d_effective"]
        bays = {b["name"]: b for b in eff["bays"]}
        self.assertEqual(list(bays), ["FAN 1", "PS-0", "PS-1"])
        self.assertTrue(bays["PS-0"]["installed"])
        self.assertTrue(bays["PS-0"]["part"]["url"].startswith(
            f"/api/module-types/{self.mt.id}/model/"))
        self.assertIsNone(bays["PS-1"]["part"])
        self.assertFalse(bays["PS-1"]["installed"])
        self.assertEqual(eff["empty_mode"], "filler")

    def test_ports_come_from_anchors_with_the_module_substituted(self):
        from .model_ports import effective_model_ports

        doc = effective_model_ports(Device.objects.get(pk=self.dev.pk))
        names = sorted(p["name"] for p in doc["ports"])
        # In bay PS-0 (position "0") Te1/{module}/1 renders as Te1/0/1, a
        # name the chassis already has: the chassis' own port wins.
        self.assertEqual(names, ["Te1/0/1", "Te1/0/2"])
        # Bay FAN 1 (position "1"); PS-1 has no bay: node, so nothing posed
        # there would count.
        self.module.module_bay = self.bays["FAN 1"]
        self.module.save()
        doc = effective_model_ports(Device.objects.get(pk=self.dev.pk))
        names = sorted(p["name"] for p in doc["ports"])
        self.assertEqual(names, ["Te1/0/1", "Te1/0/2", "Te1/1/1"])

    def test_hand_mapped_ports_give_way_to_anchors(self):
        from .model_ports import effective_model_ports

        self.dt.refresh_from_db()
        self.dt.model_ports = {"bounds": [1, 1, 1], "ports": [
            {"kind": "interface", "name": "Te1/0/3", "p": [0, 0, 0], "n": [0, 0, -1]}]}
        self.dt.save()
        doc = effective_model_ports(Device.objects.get(pk=self.dev.pk))
        self.assertNotIn("Te1/0/3", {p["name"] for p in doc["ports"]})
        self.assertEqual(self.client.get(f"/api/devices/{self.dev.id}/model-ports/")
                         .json()["source"], "anchors")

    def test_reader_without_module_type_view_gets_the_device_url(self):
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="d", object_types=["device", "devicetype", "module", "modulebay"],
            actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)
        eff = self.client.get(f"/api/devices/{self.dev.id}/").json()["model_3d_effective"]
        part = next(b for b in eff["bays"] if b["name"] == "PS-0")["part"]
        base = f"/api/devices/{self.dev.id}/module-model/{self.module.id}/"
        self.assertTrue(part["url"].startswith(base), part)
        got = self.client.get(base)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(b"".join(got.streaming_content), module_glb())
        self.assertEqual(self.client.get(f"/api/module-types/{self.mt.id}/model/")
                         .status_code, 403)

    def test_reader_without_module_view_sees_empty_bays(self):
        user = User.objects.create_user("u2", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="d", object_types=["device", "devicetype", "modulebay"], actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)
        eff = self.client.get(f"/api/devices/{self.dev.id}/").json()["model_3d_effective"]
        self.assertFalse(any(b["installed"] for b in eff["bays"]))
        url = f"/api/devices/{self.dev.id}/module-model/{self.module.id}/"
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_other_tenant_module_url_refused(self):
        self._login(self.admin, self.other)
        url = f"/api/devices/{self.dev.id}/module-model/{self.module.id}/"
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_scene_batches_the_parts(self):
        plan = FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="Hall")
        FloorPlanTile.objects.create(floor_plan=plan, x=1, y=1, device=self.dev,
                                     link_kind="device")

        def count():
            with CaptureQueriesContext(connection) as ctx:
                body = self.client.get(f"/api/floor-plans/{plan.id}/scene/").json()
            return len(ctx.captured_queries), body

        one, body = count()
        dev = body["tiles"][0]["device"]
        self.assertTrue(any(b["installed"] for b in dev["model"]["bays"]))
        self.assertIn("Te1/0/1", {p["name"] for p in dev["model_ports"]["ports"]})
        for i in range(2, 6):
            d, bays = self._device(f"sw{i}")
            Module.objects.create(device=d, module_bay=bays["PS-1"], module_type=self.mt)
            FloorPlanTile.objects.create(floor_plan=plan, x=i * 3, y=1, device=d,
                                         link_kind="device")
        many, body = count()
        self.assertEqual(len(body["tiles"]), 5)
        self.assertLessEqual(many, one + 2, "parts are loaded per device")
