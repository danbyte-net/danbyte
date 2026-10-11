"""A device type's change keeps the rack rules for its racked devices (#390):
a new height, depth or width that would put one of them over another device
or past the top of its rack is refused, naming the devices, through the type
API and a bundle import that replaces the type. A change that only meets
conflicts stored before the rules existed is not refused for them."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .device_library import export_bundle
from .models import Device, DeviceType, Rack, Site
from .test_utils import status_for


class _Case(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        status_for(self.tenant)
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1",
                                        u_height=10)
        self.t = DeviceType.objects.create(tenant=self.tenant, name="T1", u_height=1,
                                           is_full_depth=False)
        self.other = DeviceType.objects.create(tenant=self.tenant, name="other",
                                               u_height=1, is_full_depth=False)
        admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=admin).tenants.add(self.tenant)
        self.client.force_login(admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def dev(self, name, position, face="front", dt=None, **extra):
        return Device.objects.create(
            tenant=self.tenant, name=name, device_type=dt or self.t, site=self.site,
            rack=self.rack, position=position, face=face, **extra,
        )

    def change(self, **fields):
        return self.client.patch(f"/api/device-types/{self.t.id}/", fields, format="json")

    def assert_unchanged(self, **fields):
        self.t.refresh_from_db()
        for f, v in fields.items():
            self.assertEqual(getattr(self.t, f), v)


class FullDepthChangeTests(_Case):
    def test_full_depth_over_a_device_on_the_far_face_refused(self):
        self.dev("front", 5, "front")
        self.dev("rear", 5, "rear")
        r = self.change(is_full_depth=True)
        self.assertEqual(r.status_code, 400, r.content)
        msg = str(r.json()["is_full_depth"])
        self.assertIn("front at U5 in R1 would overlap rear", msg)
        self.assert_unchanged(is_full_depth=False)
        # The rear device can still go back to its own unit.
        rear = Device.objects.get(name="rear")
        self.assertEqual(self.client.patch(f"/api/devices/{rear.id}/", {"position": 6},
                                           format="json").status_code, 200)
        self.assertEqual(self.client.patch(f"/api/devices/{rear.id}/", {"position": 5},
                                           format="json").status_code, 200)

    def test_full_depth_over_another_types_device_refused(self):
        self.dev("mine", 5, "front")
        self.dev("theirs", 5, "rear", dt=self.other)
        r = self.change(is_full_depth=True)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("mine at U5 in R1 would overlap theirs", str(r.json()))

    def test_full_depth_with_nothing_behind_allowed(self):
        self.dev("front", 5, "front")
        self.dev("rear", 6, "rear", dt=self.other)
        r = self.change(is_full_depth=True)
        self.assertEqual(r.status_code, 200, r.content)

    def test_unracked_devices_do_not_count(self):
        Device.objects.create(tenant=self.tenant, name="loose", device_type=self.t,
                              site=self.site)
        self.dev("rear", 5, "rear", dt=self.other)
        self.assertEqual(self.change(is_full_depth=True).status_code, 200)


class HeightChangeTests(_Case):
    def test_growing_past_the_top_of_the_rack_refused(self):
        self.dev("top", 10)
        r = self.change(u_height=4)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("top at U10 in R1 would run past U10", str(r.json()["u_height"]))
        self.assert_unchanged(u_height=1)

    def test_growing_into_the_device_above_refused(self):
        self.dev("low", 5)
        self.dev("high", 6, dt=self.other)
        r = self.change(u_height=2)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("low at U5 in R1 would overlap high", str(r.json()))

    def test_two_devices_of_the_type_growing_into_each_other_refused(self):
        self.dev("a", 5)
        self.dev("b", 6)
        r = self.change(u_height=2)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("a at U5 in R1 would overlap b", str(r.json()))

    def test_growing_into_free_units_allowed(self):
        self.dev("a", 5)
        self.dev("b", 1)
        r = self.change(u_height=4)
        self.assertEqual(r.status_code, 200, r.content)

    def test_shrinking_allowed(self):
        DeviceType.objects.filter(pk=self.t.pk).update(u_height=4)
        self.dev("a", 7)
        self.assertEqual(self.change(u_height=2).status_code, 200)

    def test_the_message_counts_past_the_first_three(self):
        for i in range(5):
            rack = Rack.objects.create(tenant=self.tenant, site=self.site, name=f"S{i}",
                                       u_height=2)
            Device.objects.create(tenant=self.tenant, name=f"x{i}", device_type=self.t,
                                  site=self.site, rack=rack, position=2, face="front")
        r = self.change(u_height=3)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("and 2 more", str(r.json()["u_height"]))

    def test_zero_u_strips_cannot_become_rack_units(self):
        DeviceType.objects.filter(pk=self.t.pk).update(u_height=0)
        Device.objects.create(tenant=self.tenant, name="pdu", device_type=self.t,
                              site=self.site, rack=self.rack, mount="left")
        r = self.change(u_height=1)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("pdu", str(r.json()["u_height"]))


class WidthChangeTests(_Case):
    def test_half_width_pair_becoming_full_width_refused(self):
        DeviceType.objects.filter(pk=self.t.pk).update(rack_width="half")
        self.dev("left", 5, rack_side="left")
        self.dev("right", 5, rack_side="right")
        r = self.change(rack_width="full")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("would overlap", str(r.json()["rack_width"]))
        self.assert_unchanged(rack_width="half")

    def test_full_width_becoming_half_allowed(self):
        self.dev("a", 5)
        self.assertEqual(self.change(rack_width="half").status_code, 200)


class UnchangedAndLegacyTests(_Case):
    def test_form_with_unchanged_dimensions_is_not_judged(self):
        self.dev("front", 5, "front")
        self.dev("rear", 5, "rear")
        DeviceType.objects.filter(pk=self.t.pk).update(is_full_depth=True)
        r = self.change(name="T1", u_height=1, is_full_depth=True, rack_width="full",
                        description="x")
        self.assertEqual(r.status_code, 200, r.content)

    def test_conflicts_stored_before_the_change_do_not_block_it(self):
        # Two full-depth devices stacked front and rear before the rule; a
        # height change that adds no new conflict is allowed.
        DeviceType.objects.filter(pk=self.t.pk).update(is_full_depth=True)
        self.dev("front", 5, "front")
        self.dev("rear", 5, "rear")
        self.assertEqual(self.change(u_height=2).status_code, 200)


class BundleReplaceTests(_Case):
    def bundle(self, **fields):
        payload = export_bundle(self.t)
        payload.update(fields)
        return payload

    def test_replace_that_grows_a_racked_device_past_the_top_refused(self):
        self.dev("top", 10)
        for dry in ("1", "0"):
            r = self.client.post(
                f"/api/device-types/import-bundle/?replace=1&dry_run={dry}",
                self.bundle(u_height=4), format="json")
            self.assertEqual(r.status_code, 400, r.content)
            self.assertIn("would run past U10", str(r.json()))
        self.assert_unchanged(u_height=1)

    def test_replace_that_fits_is_applied(self):
        self.dev("a", 5)
        r = self.client.post("/api/device-types/import-bundle/?replace=1",
                             self.bundle(u_height=2), format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assert_unchanged(u_height=2)
