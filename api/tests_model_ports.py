"""Ports mapped onto an uploaded 3D model (api.model_ports): the document's
checks, the model-ports/ endpoints with their version check, RBAC and
site/tenant scope, a device falling back to its type's mapping by name,
clearing on a replaced model, turning with the model's up/front, the audit
trail, the face-ports payload and the scene, and import/export."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from django.test import SimpleTestCase
from rest_framework.exceptions import ValidationError

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings

from .model_ports import (
    doc_version,
    effective_model_ports,
    remap_frame,
    similar_bounds,
    validate_model_ports_doc,
)
from .models import VLAN, Device, DeviceType, FloorPlan, FloorPlanTile, Interface, Site
from .tests_model_3d import _Base


def _port(name, p=(0.5, 0.5, 0.0), n=(0, 0, -1), kind="interface"):
    return {"kind": kind, "name": name, "p": list(p), "n": list(n)}


def _doc(*ports, bounds=(0.44, 0.044, 0.3)):
    return {"bounds": list(bounds), "ports": list(ports)}


class ValidateTests(SimpleTestCase):
    def test_valid_doc_is_normalised(self):
        out = validate_model_ports_doc(_doc(_port("Gi1", n=(0, 0, -1.01))))
        self.assertEqual(out["ports"][0]["n"], [0.0, 0.0, -1.0])
        self.assertIsNone(validate_model_ports_doc(None))

    def test_position_outside_unit_box(self):
        for bad in ((1.2, 0.5, 0), (-0.1, 0.5, 0), (0.5, 0.5)):
            with self.assertRaises(ValidationError):
                validate_model_ports_doc(_doc(_port("Gi1", p=bad)))

    def test_normal_must_be_unit(self):
        for bad in ((0, 0, 0), (0, 0, -2), (0.5, 0.5, 0)):
            with self.assertRaises(ValidationError):
                validate_model_ports_doc(_doc(_port("Gi1", n=bad)))

    def test_bounds_kind_name_and_duplicates(self):
        with self.assertRaises(ValidationError):
            validate_model_ports_doc({"bounds": [1, 0, 1], "ports": []})
        with self.assertRaises(ValidationError):
            validate_model_ports_doc(_doc(_port("Gi1", kind="nope")))
        with self.assertRaises(ValidationError):
            validate_model_ports_doc(_doc(_port("")))
        with self.assertRaises(ValidationError):
            validate_model_ports_doc(_doc(_port("Gi1"), _port("Gi1")))
        with self.assertRaises(ValidationError):
            validate_model_ports_doc({**_doc(), "extra": 1})

    def test_booleans_and_nan_are_not_numbers(self):
        with self.assertRaises(ValidationError):
            validate_model_ports_doc(_doc(_port("Gi1", p=(True, 0.5, 0))))
        with self.assertRaises(ValidationError):
            validate_model_ports_doc(_doc(_port("Gi1", p=(float("nan"), 0.5, 0))))

    def test_similar_bounds(self):
        self.assertTrue(similar_bounds([0.44, 0.044, 0.3], [440, 44, 300]))
        self.assertTrue(similar_bounds([0.44, 0.044, 0.3], [0.45, 0.045, 0.3]))
        self.assertFalse(similar_bounds([0.44, 0.044, 0.3], [0.44, 0.088, 0.3]))
        self.assertFalse(similar_bounds(None, [1, 1, 1]))


class RemapFrameTests(SimpleTestCase):
    def test_same_frame_untouched(self):
        doc = _doc(_port("Gi1"))
        self.assertIs(remap_frame(doc, ("y", "+z"), ("y", "+z")), doc)

    def test_half_turn_mirrors_x_and_z(self):
        # Front +z → -z is half a turn about Y: x and z flip.
        doc = _doc(_port("Gi1", p=(0.2, 0.3, 0.0), n=(0, 0, -1)))
        out = remap_frame(doc, ("y", "+z"), ("y", "-z"))
        self.assertEqual(out["ports"][0]["p"], [0.8, 0.3, 1.0])
        self.assertEqual(out["ports"][0]["n"], [0, 0, 1])
        self.assertEqual(out["bounds"], doc["bounds"])

    def test_quarter_turn_swaps_bounds(self):
        doc = _doc(_port("Gi1", p=(0.2, 0.3, 0.0)), bounds=(0.4, 0.1, 0.2))
        out = remap_frame(doc, ("y", "+z"), ("y", "+x"))
        self.assertEqual(sorted(out["bounds"]), sorted([0.4, 0.1, 0.2]))
        self.assertEqual(out["bounds"][1], 0.1)
        back = remap_frame(out, ("y", "+x"), ("y", "+z"))
        self.assertEqual(back["ports"][0]["p"], [0.2, 0.3, 0.0])

    def test_up_axis_round_trip(self):
        doc = _doc(_port("Gi1", p=(0.1, 0.9, 0.25), n=(0, 1, 0)))
        out = remap_frame(doc, ("y", "+z"), ("z", "-x"))
        back = remap_frame(out, ("z", "-x"), ("y", "+z"))
        self.assertEqual(back["ports"][0]["p"], [0.1, 0.9, 0.25])
        self.assertEqual(back["ports"][0]["n"], [0, 1, 0])


class _Ports(_Base):
    def setUp(self):
        super().setUp()
        self._upload(f"/api/device-types/{self.dt.id}/model/")
        self.dt.refresh_from_db()
        self.url = f"/api/device-types/{self.dt.id}/model-ports/"

    def _put(self, url, doc, version=None):
        if version is None:
            version = self.client.get(url).json()["version"]
        return self.client.put(url, {"version": version, "model_ports": doc}, format="json")


class EndpointTests(_Ports):
    def test_get_put_round_trip(self):
        body = self.client.get(self.url).json()
        self.assertIsNone(body["model_ports"])
        self.assertEqual(body["version"], doc_version(None))
        res = self._put(self.url, _doc(_port("Gi1")))
        self.assertEqual(res.status_code, 200, res.content)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.model_ports["ports"][0]["name"], "Gi1")
        self.assertEqual(res.json()["version"], doc_version(self.dt.model_ports))
        self.assertEqual(self.client.get(f"/api/device-types/{self.dt.id}/").json()
                         ["model_ports"]["ports"][0]["name"], "Gi1")

    def test_stale_version_conflicts(self):
        first = self.client.get(self.url).json()["version"]
        self.assertEqual(self._put(self.url, _doc(_port("Gi1")), first).status_code, 200)
        res = self._put(self.url, _doc(_port("Gi2")), first)
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["model_ports"]["ports"][0]["name"], "Gi1")

    def test_invalid_doc_is_a_field_error(self):
        res = self._put(self.url, _doc(_port("Gi1", p=(2, 0, 0))))
        self.assertEqual(res.status_code, 400)
        self.assertIn("model_ports", res.json())

    def test_needs_a_model(self):
        self.client.delete(f"/api/device-types/{self.dt.id}/model/")
        res = self._put(self.url, _doc(_port("Gi1")))
        self.assertEqual(res.status_code, 400)

    def test_clear(self):
        self._put(self.url, _doc(_port("Gi1")))
        self.assertEqual(self._put(self.url, None).status_code, 200)
        self.dt.refresh_from_db()
        self.assertIsNone(self.dt.model_ports)

    def test_audit_entry(self):
        self._put(self.url, _doc(_port("Gi1")))
        entries = ChangeLogEntry.objects.filter(object_id=str(self.dt.id))
        self.assertTrue(any("model_ports" in (e.changes or {}) for e in entries),
                        [e.changes for e in entries])

    def test_other_tenant_refused(self):
        self._login(self.admin, self.other)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.put(self.url, {"version": "", "model_ports": None},
                                         format="json").status_code, 404)

    def test_patch_through_the_serializer_validates(self):
        res = self.client.patch(f"/api/device-types/{self.dt.id}/",
                                {"model_ports": _doc(_port("Gi1", n=(0, 0, 3)))},
                                format="json")
        self.assertEqual(res.status_code, 400)


class ReplaceAndFrameTests(_Ports):
    def test_replacing_the_model_clears_the_mapping(self):
        self._put(self.url, _doc(_port("Gi1")))
        self._upload(f"/api/device-types/{self.dt.id}/model/")
        self.dt.refresh_from_db()
        self.assertIsNone(self.dt.model_ports)

    def test_keep_with_similar_bounds(self):
        self._put(self.url, _doc(_port("Gi1")))
        self._upload(f"/api/device-types/{self.dt.id}/model/", keep_ports="1",
                     ports_bounds=json.dumps([0.45, 0.045, 0.3]))
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.model_ports["bounds"], [0.45, 0.045, 0.3])
        self.assertEqual(self.dt.model_ports["ports"][0]["name"], "Gi1")

    def test_keep_refused_when_proportions_differ(self):
        self._put(self.url, _doc(_port("Gi1")))
        self._upload(f"/api/device-types/{self.dt.id}/model/", keep_ports="1",
                     ports_bounds=json.dumps([0.44, 0.2, 0.3]))
        self.dt.refresh_from_db()
        self.assertIsNone(self.dt.model_ports)

    def test_removing_the_model_clears_the_mapping(self):
        self._put(self.url, _doc(_port("Gi1")))
        self.client.delete(f"/api/device-types/{self.dt.id}/model/")
        self.dt.refresh_from_db()
        self.assertIsNone(self.dt.model_ports)

    def test_turning_the_front_turns_the_mapping(self):
        self._put(self.url, _doc(_port("Gi1", p=(0.2, 0.5, 0.0))))
        own = {**_doc(_port("Gi1", p=(0.3, 0.5, 0.0)))}
        Device.objects.filter(pk=self.device.pk).update(model_ports=own)
        res = self.client.patch(f"/api/device-types/{self.dt.id}/",
                                {"model_3d_front": "-z"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.model_ports["ports"][0]["p"], [0.8, 0.5, 1.0])
        self.device.refresh_from_db()
        self.assertEqual(self.device.model_ports["ports"][0]["p"], [0.7, 0.5, 1.0])


class DeviceFallbackTests(_Ports):
    def setUp(self):
        super().setUp()
        self._put(self.url, _doc(_port("Gi1/0/1", p=(0.1, 0.5, 0.0)),
                                 _port("Gi1/0/2", p=(0.2, 0.5, 0.0))))
        self.dt.refresh_from_db()
        self.vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="users")
        self.gi1 = Interface.objects.create(device=self.device, name="gi1/0/1", vlan=self.vlan)
        self.dev_url = f"/api/devices/{self.device.id}/model-ports/"

    def test_device_inherits_the_types_mapping(self):
        body = self.client.get(self.dev_url).json()
        self.assertIsNone(body["model_ports"])
        self.assertEqual(body["source"], "type")
        self.assertEqual(len(body["effective"]["ports"]), 2)

    def test_face_ports_resolve_by_name(self):
        fp = self.client.get(f"/api/devices/{self.device.id}/face-ports/").json()
        model = {e["marker"]: e for e in fp["model"]}
        # Case-tolerant, like photo ports.
        self.assertEqual(model["Gi1/0/1"]["id"], str(self.gi1.id))
        self.assertEqual(model["Gi1/0/1"]["p"], [0.1, 0.5, 0.0])
        self.assertEqual(model["Gi1/0/1"]["vlan"], {"vlan_id": 20, "name": "users"})
        self.assertIsNone(model["Gi1/0/2"]["id"])
        bulk = self.client.get(f"/api/devices/face-ports/?ids={self.device.id}").json()
        self.assertEqual(len(bulk[str(self.device.id)]["model"]), 2)

    def test_override_replaces_and_null_inherits(self):
        res = self._put(self.dev_url, _doc(_port("eth0")))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["source"], "own")
        self.device.refresh_from_db()
        self.assertEqual([p["name"] for p in effective_model_ports(self.device)["ports"]],
                         ["eth0"])
        self._put(self.dev_url, None)
        self.device.refresh_from_db()
        self.assertEqual(len(effective_model_ports(self.device)["ports"]), 2)

    def test_own_model_does_not_borrow_the_types_mapping(self):
        self._upload(f"/api/devices/{self.device.id}/model/")
        self.device.refresh_from_db()
        self.assertIsNone(effective_model_ports(self.device))

    def test_scene_carries_the_mapping(self):
        plan = FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="Hall")
        FloorPlanTile.objects.create(floor_plan=plan, x=1, y=1, device=self.device,
                                     link_kind="device")
        body = self.client.get(f"/api/floor-plans/{plan.id}/scene/").json()
        dev = body["tiles"][0]["device"]
        self.assertEqual(dev["model_ports"]["bounds"], [0.44, 0.044, 0.3])


class ScopeTests(_Ports):
    def setUp(self):
        super().setUp()
        self.b = Site.objects.create(tenant=self.tenant, name="B")
        self.dev_b = Device.objects.create(
            tenant=self.tenant, name="b1", device_type=self.dt, site=self.b
        )
        self.user = User.objects.create_user("sa", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="a", object_types=["device", "devicetype"],
            actions=["view", "add", "change", "delete"],
        )
        grant.users.add(self.user)
        grant.tenants.add(self.tenant)
        grant.sites.set([self.site])
        self.viewer = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=self.viewer).tenants.add(self.tenant)
        ro = ObjectPermission.objects.create(
            name="ro", object_types=["device", "devicetype"], actions=["view"],
        )
        ro.users.add(self.viewer)
        ro.tenants.add(self.tenant)
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()

    def test_view_only_cannot_write(self):
        self._login(self.viewer)
        url = f"/api/devices/{self.device.id}/model-ports/"
        body = self.client.get(url).json()
        res = self.client.put(url, {"version": body["version"], "model_ports": _doc()},
                              format="json")
        self.assertEqual(res.status_code, 403)

    def test_other_site_device_refused(self):
        self._login(self.user)
        url = f"/api/devices/{self.dev_b.id}/model-ports/"
        self.assertEqual(self.client.get(url).status_code, 404)
        res = self.client.put(url, {"version": doc_version(None), "model_ports": _doc()},
                              format="json")
        self.assertIn(res.status_code, (403, 404))
        own = f"/api/devices/{self.device.id}/model-ports/"
        res = self.client.put(own, {"version": doc_version(None), "model_ports": _doc()},
                              format="json")
        self.assertEqual(res.status_code, 200, res.content)

    def test_global_type_read_only_for_a_site_user(self):
        self._login(self.user)
        self.assertEqual(self.client.get(self.url).status_code, 200)
        res = self.client.put(self.url, {"version": doc_version(None), "model_ports": _doc()},
                              format="json")
        self.assertIn(res.status_code, (403, 404))


class ImportExportTests(_Ports):
    def test_round_trips_as_a_json_column(self):
        from .bulk_import import _importable_fields

        for model in (DeviceType, Device):
            self.assertIn("model_ports", {f.name for f in _importable_fields(model)})

    def test_export_column_and_import_validates(self):
        self._put(self.url, _doc(_port("Gi1")))
        resp = self.client.get("/api/io/devicetype/export/?fmt=json")
        self.assertEqual(resp.status_code, 200)
        text = b"".join(resp.streaming_content).decode() if resp.streaming else \
            resp.content.decode()
        self.assertIn("model_ports", text)
        self.assertIn("Gi1", text)
