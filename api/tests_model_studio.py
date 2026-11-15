"""Images generated from 3D models (api.model_studio): the frame, the
pending token, the reference configuration's checks, storing a rendered set
with the never-overwrite rule, RBAC on the studio endpoints and the
migration's fields. The projection maths: frontend lib/model-studio.test.ts."""
from __future__ import annotations

import io
import json

from django.contrib.auth.models import User
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

from auth_api.models import ObjectPermission, UserProfile

from . import model_studio
from .models import Device, DeviceType, ModuleType
from .tests_model_anchors import _Base, chassis, module_glb


def _img(fmt="WEBP", size=(200, 18)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, (40, 40, 40, 255)).save(buf, fmt)
    return buf.getvalue()


def _file(name, fmt="WEBP"):
    ext = "png" if fmt == "PNG" else "webp"
    return SimpleUploadedFile(f"{name}.{ext}", _img(fmt), content_type=f"image/{ext}")


PORTS = {"front": [{"kind": "interface", "name": "Te1/0/1",
                    "x": 0.1, "y": 0.5, "w": 0.03, "h": 0.2}], "rear": []}
LEDS = {"front": [{"kind": "led", "name": "SYS", "source": "device.status",
                   "x": 0.05, "y": 0.4, "w": 0.01, "h": 0.05}],
        "rear": [{"kind": "led", "name": "PS_OK", "bay": "PS-0",
                  "x": 0.3, "y": 0.5, "w": 0.01, "h": 0.05}]}


class _Studio(_Base):
    def setUp(self):
        super().setUp()
        self.url = f"/api/device-types/{self.dt.id}/studio/"
        self.assertEqual(self._upload(f"/api/device-types/{self.dt.id}/model/",
                                      chassis()).status_code, 200)
        self.assertEqual(self._upload(f"/api/module-types/{self.mt.id}/model/",
                                      module_glb()).status_code, 200)
        self.dt.refresh_from_db()
        self.mt.refresh_from_db()

    def _post(self, token=None, overwrite="", ports=PORTS, leds=LEDS, **files):
        body = {"token": token if token is not None else self._token(),
                "overwrite": overwrite}
        if ports is not None:
            body["image_ports"] = json.dumps(ports)
        if leds is not None:
            body["image_leds"] = json.dumps(leds)
        if not files:
            files = {f"{f}_image": _file(f) for f in model_studio.FACES}
        return self.client.post(self.url, {**body, **files}, format="multipart")

    def _token(self):
        return self.client.get(self.url).json()["token"]


class FrameAndTokenTests(_Studio):
    def test_frame_is_the_rack_face(self):
        self.assertEqual(model_studio.frame_mm(self.dt), [482.6, 44.45])
        self.dt.rack_width = "half"
        self.dt.u_height = 2
        self.assertEqual(model_studio.frame_mm(self.dt), [241.3, 88.9])
        self.dt.width_mm = 440
        self.assertEqual(model_studio.frame_mm(self.dt)[0], 440.0)
        self.dt.u_height = 0
        self.dt.height_mm = None
        self.assertIsNone(model_studio.frame_mm(self.dt)[1])

    def test_a_new_model_is_pending_until_generated(self):
        self.assertTrue(model_studio.pending(self.dt))
        r = self.client.get(f"/api/device-types/{self.dt.id}/")
        self.assertTrue(r.json()["images_pending"])
        self.assertEqual(self._post().status_code, 200)
        self.dt.refresh_from_db()
        self.assertFalse(model_studio.pending(self.dt))
        # A reference module changes what the images show: pending again.
        self.dt.model_reference = {"PS-0": str(self.mt.id)}
        self.dt.save()
        self.assertTrue(model_studio.pending(self.dt))

    def test_no_model_is_never_pending(self):
        other = DeviceType.objects.create(tenant=self.tenant, name="Plain")
        self.assertFalse(model_studio.pending(other))
        self.assertEqual(model_studio.token(other), "")

    def test_payload_lists_bays_ports_and_leds(self):
        self.dt.model_reference = {"FAN 1": str(self.mt.id)}
        self.dt.model_leds = {"SYS": {"source": "device.status"}}
        self.dt.save()
        self.mt.model_leds = {"STATUS": {"source": "module.status"}}
        self.mt.save()
        p = self.client.get(self.url).json()
        self.assertEqual(p["frame_mm"], [482.6, 44.45])
        bays = {b["name"]: b for b in p["bays"]}
        self.assertTrue(bays["FAN 1"]["installed"])
        self.assertIn("/api/module-types/", bays["FAN 1"]["part"]["url"])
        self.assertEqual(bays["FAN 1"]["leds"], {"STATUS": {"source": "module.status"}})
        self.assertIsNone(bays["PS-0"]["part"])
        # Chassis templates plus the module's, {module} resolved per bay.
        self.assertEqual(p["ports"]["Te1/0/1"][0], "interface")
        self.assertIn("Te1/1/1", p["ports"])
        self.assertEqual(p["leds"], {"SYS": {"source": "device.status"}})


class ReferenceTests(_Studio):
    def _patch(self, ref):
        return self.client.patch(f"/api/device-types/{self.dt.id}/",
                                 {"model_reference": ref}, format="json")

    def test_valid_reference_saves(self):
        r = self._patch({"PS-0": str(self.mt.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.model_reference, {"PS-0": str(self.mt.id)})
        self.assertEqual(self._patch({}).status_code, 200)
        self.dt.refresh_from_db()
        self.assertIsNone(self.dt.model_reference)

    def test_unknown_bay_refused(self):
        r = self._patch({"PS-9": str(self.mt.id)})
        self.assertEqual(r.status_code, 400)
        self.assertIn("PS-9", json.dumps(r.json()))

    def test_bay_the_model_lacks_refused(self):
        # PS-1 is a module bay of the type but the chassis model has no bay:PS-1.
        r = self._patch({"PS-1": str(self.mt.id)})
        self.assertEqual(r.status_code, 400)

    def test_module_type_of_another_tenant_refused(self):
        theirs = ModuleType.objects.create(tenant=self.other, name="Theirs")
        theirs.model_3d.save("m.glb", ContentFile(module_glb()), save=True)
        r = self._patch({"PS-0": str(theirs.id)})
        self.assertEqual(r.status_code, 400)
        self.assertIn("No such module type", json.dumps(r.json()))

    def test_module_type_without_model_refused(self):
        bare = ModuleType.objects.create(tenant=self.tenant, name="Bare")
        r = self._patch({"PS-0": str(bare.id)})
        self.assertEqual(r.status_code, 400)
        self.assertIn("no 3D model", json.dumps(r.json()))

    def test_garbage_refused(self):
        self.assertEqual(self._patch(["PS-0"]).status_code, 400)
        self.assertEqual(self._patch({"PS-0": "not-a-uuid"}).status_code, 400)
        self.assertEqual(self._patch({"PS-0": 7}).status_code, 400)

    def test_module_type_the_editor_cannot_view_refused(self):
        editor = User.objects.create_user("ed", password="x")
        UserProfile.objects.create(user=editor).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="dt", object_types=["devicetype"],
                                                actions=["view", "change"])
        grant.users.add(editor)
        grant.tenants.add(self.tenant)
        self._login(editor)
        r = self._patch({"PS-0": str(self.mt.id)})
        self.assertEqual(r.status_code, 400)


class StoreTests(_Studio):
    def test_stores_the_set_and_records_it(self):
        r = self._post()
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()
        self.assertEqual(out["written"],
                         ["front", "rear", "iso", "image_ports", "image_leds"])
        self.assertEqual(out["kept"], [])
        self.dt.refresh_from_db()
        self.assertTrue(self.dt.iso_image.name.endswith(".webp"))
        self.assertEqual(self.dt.image_ports["front"][0]["name"], "Te1/0/1")
        self.assertEqual(self.dt.image_leds["rear"][0]["bay"], "PS-0")
        self.assertEqual(set(self.dt.images_generated),
                         {"front", "rear", "iso", "image_ports", "image_leds"})
        self.assertTrue(out["device_type"]["iso_image"].startswith("/media/"))

    def test_spec_sheet_and_report_show_the_3d_image(self):
        from .spec_sheets import faceplates

        self._post()
        self.dt.refresh_from_db()
        caps = [f["caption"].split(" · ")[0] for f in faceplates(self.dt)]
        self.assertEqual(caps, ["Front", "Rear", "3D"])
        self.assertTrue(faceplates(self.dt)[2]["src"].startswith("data:image/webp;base64,"))

    def test_regenerating_replaces_its_own_images(self):
        self._post()
        self.dt.refresh_from_db()
        before = self.dt.front_image.name
        self.assertEqual(self._post().status_code, 200)
        self.dt.refresh_from_db()
        self.assertNotEqual(self.dt.front_image.name, before)
        self.assertFalse(self.dt.front_image.storage.exists(before))

    def test_hand_uploaded_face_is_kept_unless_confirmed(self):
        r = self.client.post(f"/api/device-types/{self.dt.id}/images/",
                             {"front_image": _file("hand", "PNG")}, format="multipart")
        self.assertEqual(r.status_code, 200)
        self.dt.refresh_from_db()
        hand = self.dt.front_image.name
        self.assertIn("front", self.client.get(self.url).json()["hand_made"])
        out = self._post().json()
        self.assertIn("front", out["kept"])
        # Markers on the front would point at the hand-made photo: kept too.
        self.assertIn("image_ports", out["kept"])
        self.assertIn("rear", out["written"])
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.front_image.name, hand)
        out = self._post(overwrite="front").json()
        self.assertIn("front", out["written"])
        self.assertIn("image_ports", out["written"])
        self.dt.refresh_from_db()
        self.assertNotEqual(self.dt.front_image.name, hand)

    def test_hand_made_port_map_is_kept_unless_confirmed(self):
        hand = {"front": [{"kind": "interface", "name": "Te1/0/2",
                           "x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1}], "rear": []}
        r = self.client.patch(f"/api/device-types/{self.dt.id}/",
                              {"image_ports": hand}, format="json")
        self.assertEqual(r.status_code, 200)
        out = self._post().json()
        self.assertIn("image_ports", out["kept"])
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.image_ports["front"][0]["name"], "Te1/0/2")
        out = self._post(overwrite="image_ports").json()
        self.assertIn("image_ports", out["written"])

    def test_editing_generated_markers_makes_them_hand_made(self):
        self._post()
        self.dt.refresh_from_db()
        doc = dict(self.dt.image_ports)
        # Only the zoom: still generated.
        doc["view"] = {"front": {"scale": 1}}
        self.client.patch(f"/api/device-types/{self.dt.id}/", {"image_ports": doc},
                          format="json")
        self.dt.refresh_from_db()
        self.assertIn("image_ports", self.dt.images_generated)
        doc["front"] = [{**doc["front"][0], "x": 0.2}]
        self.client.patch(f"/api/device-types/{self.dt.id}/", {"image_ports": doc},
                          format="json")
        self.dt.refresh_from_db()
        self.assertNotIn("image_ports", self.dt.images_generated)

    def test_hand_upload_over_a_generated_face_forgets_it(self):
        self._post()
        self.client.post(f"/api/device-types/{self.dt.id}/images/",
                         {"iso_image": _file("hand")}, format="multipart")
        self.dt.refresh_from_db()
        self.assertNotIn("iso", self.dt.images_generated)
        self.client.post(f"/api/device-types/{self.dt.id}/images/",
                         {"clear_iso": "1"}, format="multipart")
        self.dt.refresh_from_db()
        self.assertFalse(self.dt.iso_image)

    def test_stale_token_refused(self):
        r = self._post(token="0123456789abcdef")
        self.assertEqual(r.status_code, 400)
        self.assertIn("token", r.json())

    def test_not_an_image_refused(self):
        bad = SimpleUploadedFile("front.webp", b"nope", content_type="image/webp")
        r = self._post(front_image=bad)
        self.assertEqual(r.status_code, 400)
        jpeg = SimpleUploadedFile("front.jpg", _jpeg(), content_type="image/jpeg")
        self.assertEqual(self._post(front_image=jpeg).status_code, 400)

    def test_bad_leds_refused(self):
        r = self._post(leds={"front": [{"kind": "led", "name": "X", "x": 2,
                                        "y": 0, "w": 0, "h": 0}]})
        self.assertEqual(r.status_code, 400)
        r = self._post(leds={"front": [{"kind": "port", "name": "X"}]})
        self.assertEqual(r.status_code, 400)

    def test_type_without_model_refused(self):
        plain = DeviceType.objects.create(tenant=self.tenant, name="Plain")
        r = self.client.post(f"/api/device-types/{plain.id}/studio/",
                             {"token": ""}, format="multipart")
        self.assertEqual(r.status_code, 400)


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (20, 20)).save(buf, "JPEG")
    return buf.getvalue()


class RbacTests(_Studio):
    def _user(self, actions):
        u = User.objects.create_user("u" + "".join(actions), password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="g" + "".join(actions),
                                                object_types=["devicetype", "device"],
                                                actions=actions)
        grant.users.add(u)
        grant.tenants.add(self.tenant)
        return u

    def test_viewer_reads_but_cannot_store(self):
        token = self._token()
        self._login(self._user(["view"]))
        self.assertEqual(self.client.get(self.url).status_code, 200)
        self.assertEqual(self._post(token=token).status_code, 403)
        r = self.client.post(f"/api/device-types/{self.dt.id}/images/",
                             {"iso_image": _file("x")}, format="multipart")
        self.assertEqual(r.status_code, 403)

    def test_editor_stores(self):
        token = self._token()
        self._login(self._user(["view", "change"]))
        self.assertEqual(self._post(token=token).status_code, 200)

    def test_no_access_and_other_tenant(self):
        nobody = User.objects.create_user("n", password="x")
        UserProfile.objects.create(user=nobody).tenants.add(self.tenant)
        self._login(nobody)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self._login(self.admin, tenant=self.other)
        self.assertEqual(self.client.get(self.url).status_code, 404)

    def test_device_payload(self):
        dev, _ = self._device()
        r = self.client.get(f"/api/devices/{dev.id}/studio/")
        self.assertEqual(r.status_code, 200)
        p = r.json()
        self.assertEqual(p["frame_mm"], [482.6, 44.45])
        self.assertFalse(p["own_image_ports"])
        self._login(self._user(["view"]))
        self.assertEqual(self.client.get(f"/api/devices/{dev.id}/studio/").status_code, 200)
        self.assertTrue(Device.objects.filter(pk=dev.pk).exists())

