"""Uploaded 3D models on device types and devices (api.model_3d): the GLB
checks, the model/ endpoints and their scope, inheritance, the audit trail
and the floor plan scene's placed devices."""
from __future__ import annotations

import json
import shutil
import struct
import tempfile

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .model_3d import validate_glb
from .models import Device, DeviceType, FloorPlan, FloorPlanTile, Site


def glb(doc: dict | None = None, *, version: int = 2, bin_data: bytes = b"\0" * 12,
        length_delta: int = 0) -> bytes:
    """A minimal binary glTF: header, JSON chunk and an optional BIN chunk."""
    if doc is None:
        doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(bin_data)}]}
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js
    if bin_data:
        bd = bin_data + b"\0" * (-len(bin_data) % 4)
        body += struct.pack("<II", len(bd), 0x004E4942) + bd
    total = 12 + len(body)
    return b"glTF" + struct.pack("<II", version, total + length_delta) + body


class ValidateGlbTests(SimpleTestCase):
    def test_valid(self):
        self.assertEqual(validate_glb(glb())["asset"]["version"], "2.0")

    def test_data_uri_image_allowed(self):
        doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 12}],
               "images": [{"uri": "data:image/png;base64,AAAA"}]}
        validate_glb(glb(doc))

    def test_wrong_magic(self):
        data = b"GLTF" + glb()[4:]
        with self.assertRaisesMessage(ValidationError, "Not a binary glTF"):
            validate_glb(data)

    def test_version_1(self):
        with self.assertRaisesMessage(ValidationError, "version 1"):
            validate_glb(glb(version=1))

    def test_declared_length(self):
        with self.assertRaisesMessage(ValidationError, "declared length"):
            validate_glb(glb(length_delta=4))

    @override_settings(DEVICE_MODEL_MAX_BYTES=64)
    def test_oversize(self):
        with self.assertRaisesMessage(ValidationError, "larger than"):
            validate_glb(glb(bin_data=b"\0" * 200))

    def test_external_buffer(self):
        doc = {"asset": {"version": "2.0"}, "buffers": [{"uri": "https://x/y.bin"}]}
        with self.assertRaisesMessage(ValidationError, "external files"):
            validate_glb(glb(doc, bin_data=b""))

    def test_external_image(self):
        doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 12}],
               "images": [{"uri": "texture.png"}]}
        with self.assertRaisesMessage(ValidationError, "external files"):
            validate_glb(glb(doc))

    def test_unknown_required_extension(self):
        doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 12}],
               "extensionsRequired": ["KHR_draco_mesh_compression"]}
        with self.assertRaisesMessage(ValidationError, "KHR_draco_mesh_compression"):
            validate_glb(glb(doc))

    def test_known_required_extension(self):
        doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 12}],
               "extensionsRequired": ["KHR_texture_transform", "EXT_meshopt_compression"]}
        validate_glb(glb(doc))

    def test_bad_json(self):
        data = bytearray(glb())
        data[20] = 0xFF
        with self.assertRaises(ValidationError):
            validate_glb(bytes(data))


class _Base(APITestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="Switch", u_height=1)
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt, site=self.site
        )
        self.admin = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=self.admin, role="admin").tenants.add(
            self.tenant, self.other
        )
        self._login(self.admin)

    def tearDown(self):
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def _upload(self, path, data=None, **extra):
        f = SimpleUploadedFile("m.glb", data if data is not None else glb(),
                               content_type="model/gltf-binary")
        return self.client.post(path, {"file": f, **extra}, format="multipart")


class DeviceTypeModelTests(_Base):
    def test_upload_download_delete(self):
        url = f"/api/device-types/{self.dt.id}/model/"
        res = self._upload(url, fit="native", up="z", front="-x")
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertTrue(body["model_3d"].startswith(f"/api/device-types/{self.dt.id}/model/?v="))
        self.assertNotIn("device-models", body["model_3d"])
        self.assertEqual(
            (body["model_3d_fit"], body["model_3d_up"], body["model_3d_front"]),
            ("native", "z", "-x"),
        )
        got = self.client.get(url)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got["Content-Type"], "model/gltf-binary")
        self.assertEqual(got["X-Content-Type-Options"], "nosniff")
        self.assertIn("attachment", got["Content-Disposition"])
        self.assertEqual(b"".join(got.streaming_content), glb())
        # Never through /media/.
        self.dt.refresh_from_db()
        self.assertEqual(self.client.get(f"/media/{self.dt.model_3d.name}").status_code, 404)

        self.assertEqual(self.client.delete(url).status_code, 204)
        self.dt.refresh_from_db()
        self.assertFalse(self.dt.model_3d)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertIsNone(self.client.get(f"/api/device-types/{self.dt.id}/").json()["model_3d"])

    def test_refusals(self):
        url = f"/api/device-types/{self.dt.id}/model/"
        bad = {
            "magic": b"nope" + glb()[4:],
            "v1": glb(version=1),
            "external": glb({"asset": {"version": "2.0"},
                             "buffers": [{"uri": "http://evil/b.bin"}]}, bin_data=b""),
        }
        for name, data in bad.items():
            res = self._upload(url, data)
            self.assertEqual(res.status_code, 400, name)
            self.assertIn("file", res.json(), name)
        with override_settings(DEVICE_MODEL_MAX_BYTES=64):
            self.assertEqual(self._upload(url, glb(bin_data=b"\0" * 200)).status_code, 400)
        self.assertEqual(self._upload(url, front="up").status_code, 400)
        self.dt.refresh_from_db()
        self.assertFalse(self.dt.model_3d)

    def test_replace_removes_old_file(self):
        url = f"/api/device-types/{self.dt.id}/model/"
        self._upload(url)
        self.dt.refresh_from_db()
        first = self.dt.model_3d.name
        self._upload(url)
        self.dt.refresh_from_db()
        self.assertNotEqual(first, self.dt.model_3d.name)
        self.assertFalse(self.dt.model_3d.storage.exists(first))

    def test_audit_entry(self):
        # UUID ids carry no order: take the entries the upload added.
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        self._upload(f"/api/device-types/{self.dt.id}/model/")
        entries = ChangeLogEntry.objects.exclude(id__in=before)
        self.assertTrue(any("model_3d" in json.dumps(e.changes or {}, default=str)
                            for e in entries), [e.changes for e in entries])

    def test_metadata_is_patchable(self):
        res = self.client.patch(f"/api/device-types/{self.dt.id}/",
                                {"model_3d_up": "z"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["model_3d_up"], "z")

    def test_other_tenant_refused(self):
        url = f"/api/device-types/{self.dt.id}/model/"
        self._upload(url)
        self._login(self.admin, self.other)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self._upload(url).status_code, 404)
        self.assertEqual(self.client.delete(url).status_code, 404)


class SiteScopeTests(_Base):
    def setUp(self):
        super().setUp()
        self.b = Site.objects.create(tenant=self.tenant, name="B")
        self.dt_b = DeviceType.objects.create(
            tenant=self.tenant, name="B-only", owning_site=self.b
        )
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

    def test_other_site_device_refused(self):
        self._upload(f"/api/devices/{self.dev_b.id}/model/")
        self._login(self.user)
        url = f"/api/devices/{self.dev_b.id}/model/"
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertIn(self._upload(url).status_code, (403, 404))
        self.assertEqual(self._upload(f"/api/devices/{self.device.id}/model/").status_code, 200)

    def test_other_site_catalog_refused(self):
        self._login(self.user)
        self.assertIn(self._upload(f"/api/device-types/{self.dt_b.id}/model/").status_code,
                      (403, 404))
        # A global entry is read-only for a site-scoped user.
        self.assertIn(self._upload(f"/api/device-types/{self.dt.id}/model/").status_code,
                      (403, 404))

    def test_view_only_cannot_write(self):
        self._upload(f"/api/devices/{self.device.id}/model/")
        self._login(self.viewer)
        url = f"/api/devices/{self.device.id}/model/"
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self._upload(url).status_code, 403)
        self.assertEqual(self.client.delete(url).status_code, 403)


class DeviceModelTests(_Base):
    def test_device_inherits_then_overrides(self):
        self._upload(f"/api/device-types/{self.dt.id}/model/", up="z")
        body = self.client.get(f"/api/devices/{self.device.id}/").json()
        self.assertIsNone(body["model_3d"])
        eff = body["model_3d_effective"]
        self.assertEqual((eff["source"], eff["up"]), ("type", "z"))
        self.assertTrue(eff["url"].startswith(f"/api/devices/{self.device.id}/model/"))
        own = glb(bin_data=b"\1" * 16)
        res = self._upload(f"/api/devices/{self.device.id}/model/", own, front="+x")
        self.assertEqual(res.status_code, 200, res.content)
        eff = res.json()["model_3d_effective"]
        self.assertEqual((eff["source"], eff["up"], eff["front"]), ("device", "y", "+x"))
        got = self.client.get(f"/api/devices/{self.device.id}/model/")
        self.assertEqual(b"".join(got.streaming_content), own)
        # Removing the override falls back to the type's.
        self.assertEqual(self.client.delete(f"/api/devices/{self.device.id}/model/").status_code,
                         204)
        got = self.client.get(f"/api/devices/{self.device.id}/model/")
        self.assertEqual(b"".join(got.streaming_content), glb())

    def test_no_model(self):
        self.assertEqual(self.client.get(f"/api/devices/{self.device.id}/model/").status_code,
                         404)
        self.assertIsNone(
            self.client.get(f"/api/devices/{self.device.id}/").json()["model_3d_effective"]
        )

    def test_export_carries_options_not_the_file(self):
        from .bulk_import import _importable_fields

        names = {f.name for f in _importable_fields(DeviceType)}
        self.assertIn("model_3d_up", names)
        self.assertNotIn("model_3d", names)
        names = {f.name for f in _importable_fields(Device)}
        self.assertIn("model_3d_front", names)
        self.assertNotIn("model_3d", names)


class SceneTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="Hall")
        FloorPlanTile.objects.create(floor_plan=self.plan, x=1, y=1, device=self.device,
                                     link_kind="device")

    def _tile(self):
        body = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        return body["tiles"][0]

    def test_placed_device_geometry(self):
        self.dt.depth_mm = 400
        self.dt.save()
        dev = self._tile()["device"]
        self.assertEqual(dev["id"], str(self.device.id))
        self.assertEqual(dev["u_height"], 1)
        self.assertEqual(dev["depth_mm"], 400.0)
        self.assertIsNone(dev["model"])

    def test_inherited_model_uses_the_type_url(self):
        self._upload(f"/api/device-types/{self.dt.id}/model/")
        model = self._tile()["device"]["model"]
        self.assertEqual(model["source"], "type")
        self.assertTrue(model["url"].startswith(f"/api/device-types/{self.dt.id}/model/"))

    def test_device_override_wins(self):
        self._upload(f"/api/device-types/{self.dt.id}/model/")
        self._upload(f"/api/devices/{self.device.id}/model/", front="-z")
        model = self._tile()["device"]["model"]
        self.assertEqual((model["source"], model["front"]), ("device", "-z"))
        self.assertTrue(model["url"].startswith(f"/api/devices/{self.device.id}/model/"))
