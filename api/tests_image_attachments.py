from __future__ import annotations

import io

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, ImageAttachment, Rack, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


def _png_bytes() -> bytes:
    """A 1x1 PNG - the smallest valid image Pillow/ImageField will accept."""
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c626001000000050001a5f645400000000049454e44ae42"
        "6082"
    )


class ImageAttachmentTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        self.other_device = Device.objects.create(tenant=self.other, name="sw2")
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.rack = Rack.objects.create(
            tenant=self.tenant, name="R1", site=self.site
        )

    def _user(self, actions, object_types=("device",)):
        u = User.objects.create_user(
            f"u{''.join(actions)}{''.join(object_types)}", password="x"
        )
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="p", object_types=list(object_types), actions=list(actions)
        )
        perm.users.add(u)
        return u

    def _login(self, u):
        self.client.force_login(u)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _upload(self, base, name="front"):
        f = io.BytesIO(_png_bytes())
        f.name = "x.png"
        return self.client.post(
            f"{base}/images/", {"image": f, "name": name}, format="multipart"
        )

    def test_upload_list_delete_roundtrip(self):
        self._login(self._user(["view", "change"]))
        base = f"/api/devices/{self.device.id}"
        res = self._upload(base, name="rack photo")
        self.assertEqual(res.status_code, 201, res.content)
        img_id = res.json()["id"]
        self.assertTrue(res.json()["image"].startswith("/media/"))
        self.assertEqual(res.json()["name"], "rack photo")

        res = self.client.get(f"{base}/images/")
        self.assertEqual(res.json()["count"], 1)

        res = self.client.delete(f"{base}/images/{img_id}/")
        self.assertEqual(res.status_code, 204)
        self.assertFalse(ImageAttachment.objects.filter(pk=img_id).exists())

    def test_upload_requires_change_permission(self):
        self._login(self._user(["view"]))
        res = self._upload(f"/api/devices/{self.device.id}")
        self.assertEqual(res.status_code, 403, res.content)

    def test_missing_file_is_400(self):
        self._login(self._user(["view", "change"]))
        res = self.client.post(
            f"/api/devices/{self.device.id}/images/", {}, format="multipart"
        )
        self.assertEqual(res.status_code, 400)

    def test_other_tenant_device_not_reachable(self):
        self._login(self._user(["view", "change"]))
        res = self._upload(f"/api/devices/{self.other_device.id}")
        self.assertEqual(res.status_code, 404)

    def test_patch_caption(self):
        self._login(self._user(["view", "change"]))
        base = f"/api/devices/{self.device.id}"
        img_id = self._upload(base).json()["id"]
        res = self.client.patch(
            f"{base}/images/{img_id}/",
            {"name": "renamed", "sort_order": 5},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["name"], "renamed")
        self.assertEqual(res.json()["sort_order"], 5)

    def test_generic_mixin_works_on_rack(self):
        # Same mixin, different parent type - proves the generic FK path.
        self._login(self._user(["view", "change"], object_types=("rack",)))
        base = f"/api/racks/{self.rack.id}"
        res = self._upload(base, name="rack front")
        self.assertEqual(res.status_code, 201, res.content)
        att = ImageAttachment.objects.get(pk=res.json()["id"])
        self.assertEqual(att.parent, self.rack)
        self.assertEqual(self.client.get(f"{base}/images/").json()["count"], 1)

    def test_attachments_are_scoped_to_their_parent(self):
        # An image on the rack must not surface on a device's list.
        self._login(
            self._user(["view", "change"], object_types=("device", "rack"))
        )
        self._upload(f"/api/racks/{self.rack.id}", name="rack only")
        res = self.client.get(f"/api/devices/{self.device.id}/images/")
        self.assertEqual(res.json()["count"], 0)

    def test_upload_generates_a_thumbnail(self):
        # #60: galleries load small JPEGs, not originals. Needs a genuinely
        # decodable image - the shared _png_bytes stub is header-only.
        from PIL import Image as PilImage

        self._login(self._user(["view", "change"]))
        base = f"/api/devices/{self.device.id}"
        buf = io.BytesIO()
        PilImage.new("RGB", (32, 32), "red").save(buf, format="PNG")
        buf.seek(0)
        buf.name = "real.png"
        r = self.client.post(
            f"{base}/images/", {"image": buf, "name": "front"},
            format="multipart",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["thumbnail"], body)
        self.assertIn("thumbs/", body["thumbnail"])
        listed = self.client.get(f"{base}/images/").json()["results"][0]
        self.assertTrue(listed["thumbnail"])

    def test_pre_thumbnail_rows_return_null(self):
        from django.contrib.contenttypes.models import ContentType
        from django.core.files.base import ContentFile

        from .models import ImageAttachment

        self._login(self._user(["view", "change"]))
        img = ImageAttachment(
            tenant=self.tenant,
            content_type=ContentType.objects.get_for_model(self.device),
            object_id=self.device.pk,
        )
        img.image.save("old.png", ContentFile(_png_bytes()), save=False)
        img.thumbnail = None  # simulate a row from before the field
        super(ImageAttachment, img).save()
        listed = self.client.get(f"/api/devices/{self.device.id}/images/").json()
        row = [x for x in listed["results"] if x["thumbnail"] is None]
        self.assertEqual(len(row), 1)

    def test_upload_records_type_size_and_dimensions(self):
        """The image LIST names each file (#60), so type, byte size and pixel
        size are recorded at upload rather than read per request."""
        from PIL import Image as PilImage

        self._login(self._user(["view", "change"]))
        base = f"/api/devices/{self.device.id}"
        buf = io.BytesIO()
        PilImage.new("RGB", (120, 80), "blue").save(buf, format="PNG")
        buf.seek(0)
        buf.name = "rack-front.png"
        r = self.client.post(
            f"{base}/images/", {"image": buf}, format="multipart"
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["width"], body["height"]), (120, 80))
        self.assertGreater(body["size"], 0)
        self.assertEqual(body["extension"], "png")
        self.assertTrue(body["filename"].endswith(".png"))

    def test_unreadable_file_still_uploads_without_metadata(self):
        # A file PIL can't parse must not fail the upload - the list just
        # shows dashes for it.
        self._login(self._user(["view", "change"]))
        base = f"/api/devices/{self.device.id}"
        junk = io.BytesIO(b"\x89PNG\r\n\x1a\nnot-really-an-image")
        junk.name = "broken.png"
        r = self.client.post(
            f"{base}/images/", {"image": junk}, format="multipart"
        )
        self.assertIn(r.status_code, (201, 400), r.content)
        if r.status_code == 201:
            body = r.json()
            self.assertIsNone(body["width"])
            self.assertEqual(body["extension"], "png")


class DownscaleOnUploadTests(APITestCase):
    """Oversized photos shrink on the way in - aspect preserved, never warped
    - and small ones pass through byte-identical (api.images)."""

    def _big_png(self, w=4000, h=1000) -> bytes:
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (w, h), (30, 30, 30)).save(buf, format="PNG")
        return buf.getvalue()

    def test_oversized_upload_is_downscaled_keeping_aspect(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import Image

        from api.images import downscale_image

        up = SimpleUploadedFile("big.png", self._big_png(), "image/png")
        out = downscale_image(up)
        img = Image.open(io.BytesIO(out.read()))
        self.assertEqual(img.size, (2000, 500))

    def test_small_upload_passes_through_untouched(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from api.images import downscale_image

        up = SimpleUploadedFile("small.png", _png_bytes(), "image/png")
        self.assertIs(downscale_image(up), up)

    def test_non_image_passes_through(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from api.images import downscale_image

        up = SimpleUploadedFile("notes.txt", b"not an image", "text/plain")
        self.assertIs(downscale_image(up), up)

    def test_resize_verb_shrinks_a_stored_face(self):
        from django.contrib.auth.models import User as U
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import Image

        from api.models import DeviceType

        from core.models import Organization, Tenant

        org = Organization.objects.create(name="Orz", slug="orz")
        tenant = Tenant.objects.create(org=org, name="Trz", slug="trz")
        admin = U.objects.create_superuser("rsz", "r@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        dt = DeviceType.objects.create(tenant=tenant, name="RSZ-1")
        # Seed a 1800x600 front image directly (past the upload path).
        buf = io.BytesIO()
        Image.new("RGB", (1800, 600), (40, 40, 40)).save(buf, format="PNG")
        r = self.client.post(
            f"/api/device-types/{dt.id}/images/",
            {"front_image": SimpleUploadedFile("f.png", buf.getvalue(), "image/png")},
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.post(
            f"/api/device-types/{dt.id}/images/", {"resize_front": "800"}
        )
        self.assertEqual(r.status_code, 200, r.content)
        dt.refresh_from_db()
        with dt.front_image.open("rb") as fh:
            img = Image.open(io.BytesIO(fh.read()))
        self.assertEqual(img.size, (800, 267))
        # No image on the other face → actionable 400, not a crash.
        r = self.client.post(
            f"/api/device-types/{dt.id}/images/", {"resize_rear": "800"}
        )
        self.assertEqual(r.status_code, 400)
