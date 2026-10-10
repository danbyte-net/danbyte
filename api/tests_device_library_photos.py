"""Device-type bundles that carry their photos: export with
``include_photos``, import through the upload path, and the checks a carried
photo must pass.
"""
from __future__ import annotations

import base64
import shutil
import tempfile
from io import BytesIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import override_settings
from PIL import Image
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from . import device_library
from .models import DeviceType, Manufacturer

User = get_user_model()

CAL = {"left": 0.1, "right": 0.9, "span_mm": 440, "rail": 0.5}
IMAGE_PORTS = {
    "front": [{"kind": "interface", "name": "Gi1/0/1",
               "x": 0.1, "y": 0.5, "w": 0.03, "h": 0.4}],
    "rear": [],
    "view": {"front": {"cal": CAL}},
}
MEDIA = tempfile.mkdtemp(prefix="danbyte-test-media-")


def _png(color=(200, 30, 30), size=(64, 32)) -> bytes:
    img = Image.new("RGB", size, color)
    img.putpixel((3, 5), (1, 2, 3))  # a pixel the round trip must keep
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _fmt(fmt: str, **kw) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (40, 20), (10, 120, 10)).save(buf, format=fmt, **kw)
    return buf.getvalue()


def _entry(raw: bytes, mime="image/png", filename="front.png") -> dict:
    return {"mime": mime, "filename": filename,
            "data": base64.b64encode(raw).decode("ascii")}


@override_settings(MEDIA_ROOT=MEDIA)
class BundlePhotoTests(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco")
        self.front = _png()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=mfr, u_height=1,
            image_ports=IMAGE_PORTS,
        )
        self.dt.front_image.save("c9300.png", ContentFile(self.front), save=True)

    def _export(self, photos=True):
        url = f"/api/device-types/{self.dt.id}/library-export/"
        resp = self.client.get(url + ("?include_photos=1" if photos else ""))
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def _import(self, bundle, **params):
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return self.client.post(
            f"/api/device-types/import-bundle/{'?' + qs if qs else ''}",
            bundle, format="json",
        )

    def _fresh(self, bundle):
        self.dt.delete()
        return self._import(bundle)

    @staticmethod
    def _pixels(field):
        with field.open("rb") as fh, Image.open(fh) as img:
            return img.convert("RGB").tobytes()

    # ── export ───────────────────────────────────────────────────────────────

    def test_plain_export_references_photos_as_before(self):
        b = self._export(photos=False)
        self.assertEqual(b["images"], {"front": True, "rear": False})

    def test_export_with_photos_carries_the_file(self):
        b = self._export()
        front = b["images"]["front"]
        self.assertEqual(front["mime"], "image/png")
        self.assertTrue(front["filename"].endswith(".png"))
        self.assertEqual(base64.b64decode(front["data"]), self.front)
        self.assertIs(b["images"]["rear"], False)
        self.assertEqual(b[device_library.BUNDLE_KEY], 1)

    def test_export_leaves_an_oversized_photo_as_a_reference(self):
        with mock.patch.object(device_library, "PHOTO_MAX_BYTES", 10):
            b = self._export()
        self.assertIs(b["images"]["front"], True)

    def test_export_of_another_tenants_type_is_not_found(self):
        other = Tenant.objects.create(
            org=Organization.objects.create(name="Evil", slug="evil"),
            name="Evil", slug="evil",
        )
        theirs = DeviceType.objects.create(tenant=other, name="Secret box")
        theirs.front_image.save("secret.png", ContentFile(_png()), save=True)
        resp = self.client.get(
            f"/api/device-types/{theirs.id}/library-export/?include_photos=1"
        )
        self.assertEqual(resp.status_code, 404)

    # ── import ───────────────────────────────────────────────────────────────

    def test_round_trip_keeps_pixels_and_calibration(self):
        bundle = self._export()
        resp = self._fresh(bundle)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["images"], ["front"])
        self.assertEqual(body["missing_images"], [])
        dt = DeviceType.objects.get(tenant=self.tenant, name="C9300-48P")
        self.assertTrue(dt.front_image.name.endswith(".png"))
        self.assertEqual(self._pixels(dt.front_image),
                         Image.open(BytesIO(self.front)).convert("RGB").tobytes())
        self.assertFalse(dt.rear_image)
        self.assertEqual(dt.image_ports["view"]["front"]["cal"], CAL)
        self.assertEqual(dt.image_ports["front"], IMAGE_PORTS["front"])

    def test_import_strips_metadata_like_an_upload(self):
        exif = Image.Exif()
        exif[0x010F] = "PhoneMaker"  # camera make
        exif[0x8825] = {2: (55.0, 40.0, 0.0)}  # GPS latitude
        raw = _fmt("JPEG", exif=exif.tobytes())
        self.assertTrue(Image.open(BytesIO(raw)).getexif())
        bundle = self._export()
        bundle["images"]["front"] = _entry(raw, "image/jpeg", "photo.jpg")
        resp = self._fresh(bundle)
        self.assertEqual(resp.status_code, 200, resp.content)
        dt = DeviceType.objects.get(tenant=self.tenant)
        with dt.front_image.open("rb") as fh, Image.open(fh) as img:
            self.assertEqual(img.format, "JPEG")
            self.assertFalse(img.getexif())

    def test_import_keeps_an_animation(self):
        frames = [Image.new("RGB", (20, 20), (i * 80, 0, 0)) for i in range(3)]
        buf = BytesIO()
        frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:],
                       duration=[100, 200, 300], loop=0, comment=b"made by me")
        bundle = self._export()
        bundle["images"]["front"] = _entry(buf.getvalue(), "image/gif", "anim.gif")
        resp = self._fresh(bundle)
        self.assertEqual(resp.status_code, 200, resp.content)
        dt = DeviceType.objects.get(tenant=self.tenant)
        with dt.front_image.open("rb") as fh, Image.open(fh) as img:
            self.assertEqual(img.n_frames, 3)
            self.assertNotIn("comment", img.info)

    def test_dry_run_checks_photos_and_writes_nothing(self):
        bundle = self._export()
        self.dt.delete()
        resp = self._import(bundle, dry_run=1)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["images"], ["front"])
        self.assertFalse(DeviceType.objects.exists())

        bundle["images"]["front"] = _entry(b"not an image")
        resp = self._import(bundle, dry_run=1)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("front photo", resp.json()["detail"])

    def test_replace_with_photos_replaces_them(self):
        bundle = self._export()
        new = _png(color=(0, 0, 250))
        bundle["images"]["front"] = _entry(new)
        bundle["images"]["rear"] = _entry(_png(color=(9, 9, 9)), filename="rear.png")
        resp = self._import(bundle, replace=1)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.dt.refresh_from_db()
        self.assertEqual(self._pixels(self.dt.front_image),
                         Image.open(BytesIO(new)).convert("RGB").tobytes())
        self.assertTrue(self.dt.rear_image)
        self.assertEqual(self.dt.image_ports["view"]["front"]["cal"], CAL)

    def test_replace_without_photos_keeps_the_stored_ones(self):
        bundle = self._export(photos=False)
        bundle["u_height"] = 2
        before = self.dt.front_image.name
        resp = self._import(bundle, replace=1)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.u_height, 2)
        self.assertEqual(self.dt.front_image.name, before)
        self.assertEqual(self._pixels(self.dt.front_image),
                         Image.open(BytesIO(self.front)).convert("RGB").tobytes())

    def test_a_new_photo_without_photo_ports_drops_the_old_calibration(self):
        bundle = self._export()
        bundle["image_ports"] = None
        bundle["images"]["front"] = _entry(_png(color=(0, 250, 0)))
        resp = self._import(bundle, replace=1)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.dt.refresh_from_db()
        self.assertNotIn("view", self.dt.image_ports)
        self.assertEqual(self.dt.image_ports["front"], IMAGE_PORTS["front"])

    def test_a_bundle_from_0_17_imports_as_before(self):
        bundle = {
            "danbyte_device_type": 1, "manufacturer": "Cisco", "name": "Old one",
            "u_height": 1, "components": {}, "faceplate": None,
            "image_ports": IMAGE_PORTS, "sensors": [],
            "images": {"front": True, "rear": False},
        }
        resp = self._import(bundle)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["images"], [])
        self.assertEqual(body["missing_images"], ["front"])
        dt = DeviceType.objects.get(tenant=self.tenant, name="Old one")
        self.assertFalse(dt.front_image)
        del bundle["images"]
        bundle["name"] = "Older one"
        self.assertEqual(self._import(bundle).status_code, 200)

    def test_import_lands_in_the_active_tenant_only(self):
        other = Tenant.objects.create(
            org=Organization.objects.create(name="Evil", slug="evil"),
            name="Evil", slug="evil",
        )
        bundle = self._export()
        bundle["name"] = "Imported"
        self.assertEqual(self._import(bundle).status_code, 200)
        self.assertTrue(
            DeviceType.objects.get(tenant=self.tenant, name="Imported").front_image
        )
        self.assertFalse(DeviceType.objects.filter(tenant=other).exists())

    # ── refusals ─────────────────────────────────────────────────────────────

    def _refused(self, entry, side="front", **patches):
        bundle = self._export()
        bundle["name"] = "Refused"
        bundle["images"][side] = entry
        with mock.patch.multiple(device_library, **patches) if patches else _noop():
            resp = self._import(bundle)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertFalse(DeviceType.objects.filter(name="Refused").exists())
        return resp.json()["detail"]

    def test_per_photo_cap(self):
        msg = self._refused(_entry(self.front), PHOTO_MAX_BYTES=100)
        self.assertIn("front photo", msg)
        self.assertIn("MB", msg)

    def test_per_bundle_cap(self):
        bundle = self._export()
        bundle["name"] = "Refused"
        bundle["images"]["rear"] = _entry(_png(), filename="rear.png")
        with mock.patch.object(device_library, "BUNDLE_PHOTOS_MAX_BYTES",
                               len(self.front) + 10):
            resp = self._import(bundle)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertIn("bundle's photos", resp.json()["detail"])
        self.assertFalse(DeviceType.objects.filter(name="Refused").exists())

    def test_bytes_that_are_no_image(self):
        self.assertIn("front photo", self._refused(_entry(b"<svg></svg>")))
        self.assertIn("rear photo", self._refused(
            _entry(b"GIF89a" + b"\0" * 20, "image/gif"), side="rear"))

    def test_a_format_that_is_not_allowed(self):
        bmp = _fmt("BMP")
        self.assertIn("front photo", self._refused(_entry(bmp, "image/png")))

    def test_mime_that_disagrees_with_the_bytes(self):
        msg = self._refused(_entry(self.front, "image/jpeg"))
        self.assertIn("image/png", msg)

    def test_invalid_base64(self):
        self.assertIn("base64", self._refused(
            {"mime": "image/png", "filename": "x.png", "data": "!!not base64!!"}))

    def test_an_entry_without_data(self):
        self.assertIn("front photo", self._refused({"mime": "image/png"}))
        self.assertIn("front photo", self._refused("front.png"))

    def test_images_must_be_an_object(self):
        bundle = self._export()
        bundle["images"] = ["front"]
        self.assertEqual(self._import(bundle, replace=1).status_code, 400)

    def test_a_hostile_filename_is_cleaned(self):
        bundle = self._export()
        bundle["name"] = "Clean name"
        bundle["images"]["front"]["filename"] = "../../etc/passwd.sh"
        self.assertEqual(self._import(bundle).status_code, 200)
        dt = DeviceType.objects.get(name="Clean name")
        self.assertTrue(dt.front_image.name.startswith("device-type-images/"))
        self.assertNotIn("..", dt.front_image.name)
        self.assertTrue(dt.front_image.name.endswith(".png"))


class _noop:
    def __enter__(self):
        return None

    def __exit__(self, *exc):
        return False
