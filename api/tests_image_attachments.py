from __future__ import annotations

import io
from unittest import mock

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


def _image_bytes(fmt, frames=1, mode="RGB", size=(40, 10), **save_kwargs) -> bytes:
    """``frames`` generated frames saved as ``fmt``. Frame 0 is the report's
    (10, 200, 30) and every frame differs, so none merge on a re-save."""
    from PIL import Image

    ims = []
    for i in range(frames):
        if mode == "RGBA":
            color = (10 + 7 * i, 200, 30 + i, 255 - 40 * i)
        elif mode == "RGB":
            color = (10 + 7 * i, 200, 30 + i)
        else:
            color = 10 * i
        ims.append(Image.new(mode, size, color))
    if frames > 1:
        save_kwargs.update(save_all=True, append_images=ims[1:])
    buf = io.BytesIO()
    ims[0].save(buf, format=fmt, **save_kwargs)
    return buf.getvalue()


def _frames(data):
    """Every frame of ``data`` as (RGBA pixels, duration, disposal), and the
    loop count."""
    from PIL import Image, ImageSequence

    img = Image.open(io.BytesIO(data))
    rows = []
    for frame in ImageSequence.Iterator(img):
        frame.load()
        rows.append((frame.convert("RGBA").tobytes(), frame.info.get("duration"),
                     getattr(frame, "disposal_method", frame.info.get("disposal"))))
    return rows, img.info.get("loop")


def _carries(data) -> bool:
    from PIL import Image

    from api.images import carries_metadata

    img = Image.open(io.BytesIO(data))
    img.load()
    return carries_metadata(img, data)


def _exif():
    from PIL import ExifTags, Image

    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "PhoneMaker"
    return exif


def _clean_images() -> dict:
    """Clean images of every supported format, static and animated: the
    report's table (#309) and its neighbours. None carries metadata."""
    from PIL import ImageCms

    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    return {
        "panel.jpg": _image_bytes("JPEG"),
        "progressive.jpg": _image_bytes("JPEG", progressive=True),
        "icc.jpg": _image_bytes("JPEG", icc_profile=icc),
        "dpi.jpg": _image_bytes("JPEG", dpi=(300, 300)),
        "rgb.png": _image_bytes("PNG"),
        "rgba.png": _image_bytes("PNG", mode="RGBA"),
        "palette.png": _image_bytes("PNG", mode="P", transparency=0),
        "dpi.png": _image_bytes("PNG", dpi=(300, 300)),
        "icc.png": _image_bytes("PNG", icc_profile=icc),
        "anim.png": _image_bytes("PNG", frames=3, duration=[100, 200, 300], loop=0),
        "static.gif": _image_bytes("GIF"),
        "transparent.gif": _image_bytes("GIF", mode="P", transparency=0),
        "anim.gif": _image_bytes("GIF", frames=3),
        "loop.gif": _image_bytes("GIF", frames=3, duration=[100, 200, 300], loop=0, disposal=2),
        "lossy.webp": _image_bytes("WEBP"),
        "lossless.webp": _image_bytes("WEBP", lossless=True),
        "alpha.webp": _image_bytes("WEBP", mode="RGBA", lossless=True),
        "icc.webp": _image_bytes("WEBP", icc_profile=icc),
        "anim.webp": _image_bytes("WEBP", frames=3, duration=[100, 200, 300], loop=0),
        "anim-lossless.webp": _image_bytes("WEBP", frames=3, duration=100, loop=0, lossless=True),
    }


def _metadata_images() -> dict:
    """Images that carry metadata in every way a photo can: EXIF, XMP, a
    comment or text chunk, in static and animated files."""
    from PIL import PngImagePlugin

    exif = _exif()
    text = PngImagePlugin.PngInfo()
    text.add_text("Comment", "desk 4")
    xmp = PngImagePlugin.PngInfo()
    xmp.add_itxt("XML:com.adobe.xmp", "<x:xmpmeta/>")
    anim_gif = _image_bytes("GIF", frames=3, duration=100, loop=0)
    assert anim_gif.endswith(b";")
    return {
        "exif.jpg": _image_bytes("JPEG", exif=exif),
        "xmp.jpg": _image_bytes("JPEG", xmp=b"<x:xmpmeta/>"),
        "comment.jpg": _image_bytes("JPEG", comment=b"desk 4"),
        "exif.png": _image_bytes("PNG", exif=exif),
        "text.png": _image_bytes("PNG", pnginfo=text),
        "xmp.png": _image_bytes("PNG", pnginfo=xmp),
        "anim-exif.png": _image_bytes("PNG", frames=3, duration=100, exif=exif),
        "comment.gif": _image_bytes("GIF", comment=b"desk 4"),
        "anim-comment.gif": _image_bytes("GIF", frames=3, duration=100, loop=0, comment=b"desk 4"),
        # A comment after the last frame and an XMP application extension sit
        # past the first frame, where Pillow does not look.
        "trailing-comment.gif": anim_gif[:-1] + b"!\xfe\x06desk 4\x00;",
        "xmp.gif": anim_gif[:-1] + b"!\xff\x0bXMP DataXMP\x0c<x:xmpmeta/>\x00;",
        "exif.webp": _image_bytes("WEBP", exif=exif),
        "xmp.webp": _image_bytes("WEBP", xmp=b"<x:xmpmeta/>"),
        "anim-exif.webp": _image_bytes("WEBP", frames=3, duration=100, loop=0, exif=exif),
    }


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


class DeviceTypePhotoUploadTests(APITestCase):
    """The report's table (#309), through POST /api/device-types/<id>/images/:
    GIFs and WebPs without metadata are stored as uploaded."""

    def setUp(self):
        import shutil
        import tempfile

        from django.test import override_settings

        from api.models import DeviceType

        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, True)
        settings = override_settings(MEDIA_ROOT=media)
        settings.enable()
        self.addCleanup(settings.disable)
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.client.force_login(User.objects.create_superuser("adm", "a@b.c", "x"))
        sess = self.client.session
        sess["current_tenant_id"] = str(tenant.id)
        sess.save()
        self.dt = DeviceType.objects.create(tenant=tenant, name="Panel")

    def _upload(self, name, data) -> bytes:
        from django.core.files.uploadedfile import SimpleUploadedFile

        r = self.client.post(f"/api/device-types/{self.dt.id}/images/",
                             {"front_image": SimpleUploadedFile(name, data)})
        self.assertEqual(r.status_code, 200, r.content)
        self.dt.refresh_from_db()
        with self.dt.front_image.open("rb") as fh:
            return fh.read()

    def test_report_rows_are_stored_as_uploaded(self):
        rows = {
            "anim.gif": _image_bytes("GIF", frames=3),
            "static.gif": _image_bytes("GIF"),
            "anim.webp": _image_bytes("WEBP", frames=3),
            "lossless.webp": _image_bytes("WEBP", lossless=True),
        }
        for name, data in rows.items():
            with self.subTest(name=name):
                stored = self._upload(name, data)
                self.assertEqual(stored, data)
                self.assertEqual(len(_frames(stored)[0]), len(_frames(data)[0]))

    def test_lossless_webp_keeps_its_exact_pixel(self):
        from PIL import Image

        stored = self._upload("lossless.webp", _image_bytes("WEBP", lossless=True))
        self.assertEqual(Image.open(io.BytesIO(stored)).convert("RGB").getpixel((0, 0)),
                         (10, 200, 30))

    def test_metadata_is_still_stripped_through_the_endpoint(self):
        from PIL import Image

        for name, data in (
            ("exif.webp", _image_bytes("WEBP", frames=3, duration=100, loop=0,
                                       lossless=True, exif=_exif())),
            ("comment.gif", _image_bytes("GIF", frames=3, duration=100, loop=0,
                                         comment=b"desk 4")),
        ):
            with self.subTest(name=name):
                stored = self._upload(name, data)
                self.assertNotEqual(stored, data)
                self.assertFalse(_carries(stored))
                self.assertEqual(Image.open(io.BytesIO(stored)).n_frames, 3)
                self.assertEqual([p for p, _, _ in _frames(stored)[0]],
                                 [p for p, _, _ in _frames(data)[0]])


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
        from PIL import ImageFile

        from api.images import downscale_image

        # A small image Pillow decodes, also with truncated loading on as
        # WeasyPrint leaves it once a PDF export has run in the process.
        for truncated in (False, True):
            with self.subTest(truncated=truncated), \
                    mock.patch.object(ImageFile, "LOAD_TRUNCATED_IMAGES", truncated):
                up = SimpleUploadedFile("small.png", self._big_png(40, 10), "image/png")
                self.assertIs(downscale_image(up), up)

    def test_a_small_photo_loses_its_location_and_other_metadata(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import ExifTags, Image, ImageCms, PngImagePlugin

        from api.images import carries_metadata, downscale_image

        exif = Image.Exif()
        exif[ExifTags.Base.Make] = "PhoneMaker"
        exif[ExifTags.IFD.GPSInfo] = {
            ExifTags.GPS.GPSLatitudeRef: "N", ExifTags.GPS.GPSLatitude: (52.0, 22.0, 12.5),
        }
        icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        jpeg = io.BytesIO()
        Image.new("RGB", (1200, 800), (30, 30, 30)).save(
            jpeg, format="JPEG", exif=exif, comment=b"desk 4", icc_profile=icc
        )
        text = PngImagePlugin.PngInfo()
        text.add_text("Comment", "desk 4")
        text.add_itxt("XML:com.adobe.xmp", "<x:xmpmeta/>")
        png = io.BytesIO()
        Image.new("RGBA", (40, 10)).save(png, format="PNG", pnginfo=text, exif=exif)
        for name, data, mime in (("panel.jpg", jpeg.getvalue(), "image/jpeg"),
                                 ("panel.png", png.getvalue(), "image/png")):
            with self.subTest(name=name):
                up = SimpleUploadedFile(name, data, mime)
                out = downscale_image(up)
                self.assertIsNot(out, up)
                img = Image.open(io.BytesIO(out.read()))
                img.load()
                self.assertFalse(carries_metadata(img), img.info.keys())
                self.assertEqual(dict(img.getexif()), {})
                self.assertEqual(img.size, (1200, 800) if name.endswith("jpg") else (40, 10))
                if name.endswith("jpg"):
                    # The colour profile is no metadata: it stays.
                    self.assertEqual(img.info.get("icc_profile"), icc)

    def test_a_small_rotated_photo_is_turned_upright(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import ExifTags, Image

        from api.images import downscale_image

        buf = io.BytesIO()
        exif = Image.Exif()
        exif[ExifTags.Base.Orientation] = 6
        Image.new("RGB", (40, 10), (30, 30, 30)).save(buf, format="JPEG", exif=exif)
        up = SimpleUploadedFile("turned.jpg", buf.getvalue(), "image/jpeg")
        out = downscale_image(up)
        self.assertIsNot(out, up)
        self.assertEqual(Image.open(io.BytesIO(out.read())).size, (10, 40))

    def test_non_image_passes_through(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from api.images import downscale_image

        up = SimpleUploadedFile("notes.txt", b"not an image", "text/plain")
        self.assertIs(downscale_image(up), up)

    def test_clean_files_of_every_format_pass_through_byte_identical(self):
        """Pillow's own bookkeeping keys - a GIF's version and loop extension,
        a WebP's timestamp, an APNG's frame box - are no metadata (#309)."""
        from django.core.files.uploadedfile import SimpleUploadedFile

        from api.images import downscale_image

        for name, data in _clean_images().items():
            with self.subTest(name=name):
                self.assertFalse(_carries(data))
                up = SimpleUploadedFile(name, data)
                self.assertIs(downscale_image(up), up)
                self.assertEqual(up.read(), data)

    def test_metadata_carriers_are_detected_and_stripped(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import Image

        from api.images import downscale_image

        for name, data in _metadata_images().items():
            with self.subTest(name=name):
                self.assertTrue(_carries(data))
                frames = getattr(Image.open(io.BytesIO(data)), "n_frames", 1)
                up = SimpleUploadedFile(name, data)
                out = downscale_image(up)
                self.assertIsNot(out, up)
                stored = out.read()
                self.assertFalse(_carries(stored))
                img = Image.open(io.BytesIO(stored))
                self.assertEqual(dict(img.getexif()), {})
                self.assertEqual(getattr(img, "n_frames", 1), frames)

    def test_re_saved_animations_keep_frames_timing_loop_and_disposal(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from api.images import downscale_image

        exif = _exif()
        sources = {
            "turn.gif": _image_bytes("GIF", frames=3, duration=[100, 200, 300], loop=2,
                                     disposal=[1, 2, 1], comment=b"desk 4"),
            "fade.gif": _image_bytes("GIF", frames=3, mode="RGBA", duration=[100, 200, 300],
                                     loop=0, disposal=2, comment=b"desk 4"),
            "turn.webp": _image_bytes("WEBP", frames=3, duration=[100, 200, 300], loop=3,
                                      lossless=True, exif=exif),
            "turn.png": _image_bytes("PNG", frames=3, duration=[100, 200, 300], loop=4,
                                     disposal=[0, 1, 0], exif=exif),
        }
        for name, data in sources.items():
            with self.subTest(name=name):
                out = downscale_image(SimpleUploadedFile(name, data))
                stored = out.read()
                self.assertFalse(_carries(stored))
                before, loop = _frames(data)
                after, loop_after = _frames(stored)
                self.assertEqual(len(after), 3)
                self.assertEqual(loop_after, loop)
                for (pixels, duration, disposal), (p2, d2, x2) in zip(before, after, strict=True):
                    self.assertEqual(p2, pixels)
                    self.assertEqual(d2, duration)
                    self.assertEqual(x2, disposal)

    def test_a_lossless_webp_stays_lossless_and_a_lossy_one_lossy(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import Image

        from api.images import downscale_image

        exif = _exif()
        cases = {
            "lossless.webp": (_image_bytes("WEBP", lossless=True, exif=exif), True),
            "alpha.webp": (_image_bytes("WEBP", mode="RGBA", lossless=True, exif=exif), True),
            "anim.webp": (_image_bytes("WEBP", frames=2, lossless=True, exif=exif), True),
            "lossy.webp": (_image_bytes("WEBP", exif=exif), False),
        }
        for name, (data, lossless) in cases.items():
            with self.subTest(name=name):
                stored = downscale_image(SimpleUploadedFile(name, data)).read()
                self.assertFalse(_carries(stored))
                self.assertEqual(b"VP8L" in stored, lossless)
                self.assertEqual(b"VP8 " in stored, not lossless)
                if lossless:
                    img = Image.open(io.BytesIO(stored))
                    self.assertEqual(img.convert("RGBA").getpixel((0, 0))[:3], (10, 200, 30))

    def test_an_oversized_animation_shrinks_with_all_its_frames(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import Image

        from api.images import downscale_image

        sources = {
            "big.gif": _image_bytes("GIF", frames=3, duration=[100, 200, 300], loop=0),
            "big.webp": _image_bytes("WEBP", frames=3, duration=[100, 200, 300], loop=0),
            "big.png": _image_bytes("PNG", frames=3, duration=[100, 200, 300], loop=0),
        }
        for name, data in sources.items():
            with self.subTest(name=name):
                stored = downscale_image(SimpleUploadedFile(name, data), max_edge=20).read()
                self.assertEqual(Image.open(io.BytesIO(stored)).size, (20, 5))
                rows, loop = _frames(stored)
                self.assertEqual([d for _, d, _ in rows], [100, 200, 300])
                self.assertEqual(loop, 0)
                self.assertFalse(_carries(stored))

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


class StripPhotoMetadataCommandTests(APITestCase):
    """``manage.py strip_photo_metadata`` (#291): photos stored with their
    metadata are re-saved without it; the rest stay as they are."""

    def setUp(self):
        import shutil
        import tempfile

        from django.test import override_settings

        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, True)
        settings = override_settings(MEDIA_ROOT=media)
        settings.enable()
        self.addCleanup(settings.disable)
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _jpeg(self, gps):
        from PIL import ExifTags, Image

        extra = {}
        if gps:
            exif = Image.Exif()
            exif[ExifTags.IFD.GPSInfo] = {ExifTags.GPS.GPSLatitudeRef: "N"}
            extra["exif"] = exif
        buf = io.BytesIO()
        Image.new("RGB", (60, 20), (40, 40, 40)).save(buf, format="JPEG", **extra)
        return buf.getvalue()

    def test_stored_photos_lose_their_metadata_once(self):
        from django.core.files.base import ContentFile
        from django.core.management import call_command
        from PIL import Image

        from api.images import carries_metadata
        from api.models import DeviceType

        dt = DeviceType.objects.create(tenant=self.tenant, name="Panel 1")
        dt.front_image.save("front.jpg", ContentFile(self._jpeg(gps=True)), save=True)
        dt.rear_image.save("rear.jpg", ContentFile(self._jpeg(gps=False)), save=True)
        rear = dt.rear_image.name

        def run(*args):
            out = io.StringIO()
            call_command("strip_photo_metadata", *args, stdout=out)
            return out.getvalue()

        def front():
            dt.refresh_from_db()
            with dt.front_image.open("rb") as fh:
                img = Image.open(io.BytesIO(fh.read()))
                img.load()
            return dt.front_image.name, carries_metadata(img)

        before, _ = front()
        self.assertIn("1 photo(s) carry metadata", run("--dry-run"))
        self.assertEqual(front(), (before, True))
        self.assertIn("1 photo(s) carried metadata", run())
        name, dirty = front()
        self.assertFalse(dirty)
        if name != before:
            self.assertFalse(dt.front_image.storage.exists(before))
        self.assertEqual(dt.rear_image.name, rear)
        self.assertIn("0 photo(s)", run())

    def _run(self, *args):
        from django.core.management import call_command

        out, err = io.StringIO(), io.StringIO()
        call_command("strip_photo_metadata", *args, stdout=out, stderr=err)
        return out.getvalue(), err.getvalue()

    def _attachment(self, name, data):
        from django.contrib.contenttypes.models import ContentType
        from django.core.files.base import ContentFile

        device = Device.objects.create(tenant=self.tenant, name=name)
        return ImageAttachment.objects.create(
            tenant=self.tenant, content_type=ContentType.objects.get_for_model(device),
            object_id=device.pk, image=ContentFile(data, name=name),
        )

    def _stored(self, field) -> bytes:
        with field.open("rb") as fh:
            return fh.read()

    def test_clean_animated_and_lossless_photos_are_left_alone(self):
        """A GIF or WebP without metadata is not "stripped" for the keys
        Pillow always reads (#309)."""
        from django.core.files.base import ContentFile

        from api.models import DeviceType

        gif = _image_bytes("GIF", frames=3, duration=[100, 200, 300], loop=0)
        webp = _image_bytes("WEBP", lossless=True)
        anim = _image_bytes("WEBP", frames=3, duration=100, loop=0)
        dt = DeviceType.objects.create(tenant=self.tenant, name="Panel 2")
        dt.front_image.save("front.gif", ContentFile(gif), save=True)
        dt.rear_image.save("rear.webp", ContentFile(webp), save=True)
        att = self._attachment("anim.webp", anim)
        names = (dt.front_image.name, dt.rear_image.name, att.image.name)

        self.assertIn("0 photo(s) carry metadata", self._run("--dry-run")[0])
        self.assertIn("0 photo(s) carried metadata", self._run()[0])
        dt.refresh_from_db()
        att.refresh_from_db()
        self.assertEqual((dt.front_image.name, dt.rear_image.name, att.image.name), names)
        self.assertEqual(self._stored(dt.front_image), gif)
        self.assertEqual(self._stored(dt.rear_image), webp)
        self.assertEqual(self._stored(att.image), anim)

    def test_an_animated_photo_with_metadata_keeps_its_frames(self):
        data = _image_bytes("GIF", frames=3, duration=[100, 200, 300], loop=0, comment=b"desk 4")
        att = self._attachment("anim.gif", data)
        old = att.image.name

        out, err = self._run()
        self.assertIn("1 photo(s) carried metadata", out)
        self.assertEqual(err, "")
        att.refresh_from_db()
        self.assertNotEqual(att.image.name, old)
        self.assertFalse(att.image.storage.exists(old))
        stored = self._stored(att.image)
        self.assertFalse(_carries(stored))
        rows, loop = _frames(stored)
        self.assertEqual([d for _, d, _ in rows], [100, 200, 300])
        self.assertEqual(loop, 0)
        self.assertEqual([p for p, _, _ in rows], [p for p, _, _ in _frames(data)[0]])
        self.assertIn("0 photo(s) carried metadata", self._run()[0])

    def test_identical_neighbour_frames_merge_without_counting_as_lost(self):
        """The writers fold a repeated frame into the one before it, so fewer
        frames with the same running time verify; fewer frames and less time
        do not."""
        from django.core.files.base import ContentFile

        data = _image_bytes("GIF", frames=3, duration=100, loop=0, comment=b"desk 4")
        cases = {
            "merged": (_image_bytes("GIF", frames=2, duration=[200, 100], loop=0), ""),
            "dropped": (_image_bytes("GIF", frames=2, duration=100, loop=0), "lost frames"),
        }
        for case, (replacement, problem) in cases.items():
            with self.subTest(case=case), mock.patch(
                "api.images.downscale_image",
                return_value=ContentFile(replacement, name="rep.gif"),
            ):
                att = self._attachment(f"rep-{case}.gif", data)
                out, err = self._run()
                att.refresh_from_db()
                if problem:
                    self.assertIn(problem, err)
                    self.assertEqual(self._stored(att.image), data)
                else:
                    self.assertEqual(err, "")
                    self.assertEqual(self._stored(att.image), replacement)
                att.delete()

    def test_the_original_stays_when_the_replacement_does_not_verify(self):
        """The old file goes only once the new one is read back clean and
        still animated; otherwise it is kept and the command says so."""
        import os

        from django.conf import settings
        from django.core.files.base import ContentFile

        data = _image_bytes("GIF", frames=3, duration=100, loop=0, comment=b"desk 4")
        att = self._attachment("anim.gif", data)
        old = att.image.name
        folder = os.path.join(settings.MEDIA_ROOT, os.path.dirname(old))
        replacements = {
            "not readable": b"junk",
            "lost frames": _image_bytes("GIF"),
            "still carries metadata": data,
        }
        for problem, bad in replacements.items():
            with self.subTest(problem=problem), mock.patch(
                "api.images.downscale_image", return_value=ContentFile(bad, name="anim.gif")
            ):
                out, err = self._run()
                self.assertIn(f"kept {old}: {problem}", err)
                self.assertIn("1 photo(s) carried metadata", out)
                self.assertIn("1 kept as stored", out)
                att.refresh_from_db()
                self.assertEqual(att.image.name, old)
                self.assertEqual(self._stored(att.image), data)
                files = [f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))]
                self.assertEqual(files, [os.path.basename(old)])
