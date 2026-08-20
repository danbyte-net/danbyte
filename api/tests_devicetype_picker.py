"""Advanced search for the device-type picker (issue #40).

The add-device form used a plain dropdown over one unsearchable page. Once a
device-type library is imported that catalog runs to hundreds of rows, so a
type you own could be genuinely unreachable. These cover the filters the
picker's modal sends.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APITestCase

from core.models import Organization, Tag, Tenant

from .models import DeviceType, Manufacturer, Platform

User = get_user_model()

# A 1x1 GIF - enough to make an ImageField non-empty without pulling in Pillow
# work; the filters only ever ask "is this blank".
_GIF = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!"
    b"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02"
    b"\x02D\x01\x00;"
)


class DeviceTypePickerFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        self.cisco = Manufacturer.objects.create(
            tenant=self.tenant, name="Cisco", slug="cisco"
        )
        self.juniper = Manufacturer.objects.create(
            tenant=self.tenant, name="Juniper", slug="juniper"
        )
        self.ios = Platform.objects.create(
            tenant=self.tenant, name="IOS", slug="ios"
        )
        self.spine = Tag.objects.create(tenant=self.tenant, name="Spine", slug="spine")
        self.eol = Tag.objects.create(tenant=self.tenant, name="EOL", slug="eol")

        self.c2960 = DeviceType.objects.create(
            tenant=self.tenant, name="C2960", manufacturer=self.cisco,
            platform=self.ios, part_number="WS-C2960-24TT-L",
            front_image=SimpleUploadedFile("f.gif", _GIF, "image/gif"),
        )
        self.c2960.tags.add(self.spine)
        self.qfx = DeviceType.objects.create(
            tenant=self.tenant, name="QFX5100", manufacturer=self.juniper,
            model="QFX5100-48S",
            front_image=SimpleUploadedFile("f2.gif", _GIF, "image/gif"),
            rear_image=SimpleUploadedFile("r2.gif", _GIF, "image/gif"),
        )
        self.qfx.tags.add(self.spine, self.eol)
        self.blank = DeviceType.objects.create(
            tenant=self.tenant, name="Whitebox", manufacturer=self.cisco,
            faceplate={"rows": 1},
        )

    def _names(self, query=""):
        r = self.client.get(f"/api/device-types/?{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(x["name"] for x in r.json()["results"])

    def test_search_covers_name_model_and_part_number(self):
        """All three matter: operators paste whichever one they have."""
        self.assertEqual(self._names("search=C2960"), ["C2960"])
        self.assertEqual(self._names("search=WS-C2960"), ["C2960"])  # part number
        self.assertEqual(self._names("search=48S"), ["QFX5100"])     # model

    def test_manufacturer_and_platform(self):
        self.assertEqual(self._names(f"manufacturer={self.cisco.id}"),
                         ["C2960", "Whitebox"])
        self.assertEqual(self._names(f"platform={self.ios.id}"), ["C2960"])

    def test_tags_are_and_not_or(self):
        """Matching the rest of the app's tag rails - two tags narrows."""
        self.assertEqual(self._names("tag=spine"), ["C2960", "QFX5100"])
        self.assertEqual(self._names("tag=spine&tag=eol"), ["QFX5100"])

    def test_artwork_filter(self):
        """A rack elevation only draws for a type that has images, so which
        ones are drawable is a real question while picking."""
        self.assertEqual(self._names("imagery=front"), ["C2960", "QFX5100"])
        self.assertEqual(self._names("imagery=rear"), ["QFX5100"])
        self.assertEqual(self._names("imagery=both"), ["QFX5100"])
        self.assertEqual(self._names("imagery=none"), ["Whitebox"])
        self.assertEqual(self._names("imagery=faceplate"), ["Whitebox"])

    def test_an_unknown_artwork_value_does_not_silently_filter(self):
        """A typo must not look like 'no types exist'."""
        self.assertEqual(len(self._names("imagery=banana")), 3)

    def test_filters_combine(self):
        self.assertEqual(
            self._names(f"manufacturer={self.cisco.id}&imagery=front"), ["C2960"]
        )

    def test_picker_shape_still_carries_what_the_combobox_needs(self):
        r = self.client.get("/api/device-types/?picker=1")
        row = next(x for x in r.json()["results"] if x["name"] == "C2960")
        self.assertEqual(row["manufacturer"], "Cisco")
        self.assertIn("u_height", row)
