from __future__ import annotations

import io

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, ImageAttachment, Rack, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


def _png_bytes() -> bytes:
    """A 1x1 PNG — the smallest valid image Pillow/ImageField will accept."""
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
        # Same mixin, different parent type — proves the generic FK path.
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
