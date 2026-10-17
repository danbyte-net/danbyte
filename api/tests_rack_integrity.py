"""Rack placement rules that every write path keeps: a full-depth device
takes both faces of its units (#375), a rack cannot shrink under its devices
(#376), and a racked device is at its rack's site (#377).

Each rule is checked through the API create and update, the elevation's drag
(a PATCH of the position), the spreadsheet import and, for the rack height,
the rack's sync from its type."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .models import Device, DeviceType, Location, Rack, RackType, Site
from .test_utils import status_for


class _Case(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        status_for(self.tenant)
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.rack = Rack.objects.create(
            tenant=self.tenant, site=self.site_a, name="R1", u_height=42
        )
        self.full = DeviceType.objects.create(
            tenant=self.tenant, name="fd1u", u_height=1, is_full_depth=True
        )
        self.half_depth = DeviceType.objects.create(
            tenant=self.tenant, name="hd1u", u_height=1, is_full_depth=False
        )
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def put(self, name, dt, position, face, rack=None, site=None, **extra):
        return self.client.post("/api/devices/", {
            "name": name, "device_type_id": str(dt.id),
            "site_id": str((site or self.site_a).id),
            "rack_id": str((rack or self.rack).id),
            "position": position, "face": face, **extra,
        }, format="json")

    def load(self, slug, content):
        resp = self.client.post(f"/api/io/{slug}/import/", {
            "format": "csv", "content": content, "dry_run": False,
        }, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()


class FullDepthTests(_Case):
    """#375 - a full-depth device blocks both faces of its units."""

    def test_rear_device_refused_under_a_full_depth_front_device(self):
        self.assertEqual(self.put("srvA", self.full, 10, "front").status_code, 201)
        r = self.put("srvB", self.full, 10, "rear")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"position": ["Overlaps srvA at U10, which is full depth."]})
        self.assertFalse(Device.objects.filter(name="srvB").exists())

    def test_full_depth_device_refused_behind_a_shallow_one(self):
        self.assertEqual(self.put("panel", self.half_depth, 10, "front").status_code, 201)
        r = self.put("srv", self.full, 10, "rear")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"position": [
            "Overlaps panel at U10 on the front; this device is full depth."]})

    def test_overlap_in_part_of_a_taller_device(self):
        two_u = DeviceType.objects.create(tenant=self.tenant, name="fd2u", u_height=2)
        self.assertEqual(self.put("big", two_u, 10, "front").status_code, 201)
        self.assertEqual(self.put("x", self.half_depth, 11, "rear").status_code, 400)
        self.assertEqual(self.put("y", self.half_depth, 12, "rear").status_code, 201)

    def test_two_shallow_devices_share_a_unit_front_and_rear(self):
        self.assertEqual(self.put("p1", self.half_depth, 10, "front").status_code, 201)
        self.assertEqual(self.put("p2", self.half_depth, 10, "rear").status_code, 201)

    def test_same_face_still_refused(self):
        self.assertEqual(self.put("p1", self.half_depth, 10, "front").status_code, 201)
        r = self.put("p2", self.half_depth, 10, "front")
        self.assertEqual(r.json(), {"position": ["Overlaps p1 at U10."]})

    def test_half_width_devices_on_opposite_sides_still_share(self):
        half = DeviceType.objects.create(
            tenant=self.tenant, name="sn2010", u_height=1, rack_width="half"
        )
        self.assertEqual(
            self.put("l", half, 10, "front", rack_side="left").status_code, 201)
        self.assertEqual(
            self.put("r", half, 10, "rear", rack_side="right").status_code, 201)
        self.assertEqual(
            self.put("l2", half, 10, "rear", rack_side="left").status_code, 400)

    def test_typeless_device_counts_as_full_depth(self):
        r = self.client.post("/api/devices/", {
            "name": "bare", "site_id": str(self.site_a.id),
            "rack_id": str(self.rack.id), "position": 10, "face": "front",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.put("p", self.half_depth, 10, "rear").status_code, 400)

    def test_drag_onto_the_far_face_of_a_full_depth_device(self):
        self.assertEqual(self.put("srvA", self.full, 10, "front").status_code, 201)
        r = self.put("srvB", self.full, 20, "rear")
        dev = r.json()["id"]
        r = self.client.patch(f"/api/devices/{dev}/", {"position": 10}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Device.objects.get(pk=dev).position, 20)

    def test_flipping_the_face_onto_a_full_depth_device(self):
        self.assertEqual(self.put("srvA", self.full, 10, "front").status_code, 201)
        dev = self.put("p", self.half_depth, 11, "rear").json()["id"]
        r = self.client.patch(f"/api/devices/{dev}/", {"position": 10}, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_import_refuses_the_far_face(self):
        self.assertEqual(self.put("srvA", self.full, 10, "front").status_code, 201)
        res = self.load(
            "device",
            f"name,device_type,site,rack,position,face\nsrvB,{self.full.id},SiteA,"
            f"{self.rack.id},10,rear\n",
        )
        self.assertEqual(res["created"], 0, res)
        self.assertIn("full depth", str(res["errors"]))
        self.assertFalse(Device.objects.filter(name="srvB").exists())

    def test_existing_stacked_devices_stay_editable(self):
        # Rows stored before the rule: both still read and accept edits that
        # leave their placement alone.
        a = Device.objects.create(tenant=self.tenant, name="a", device_type=self.full,
                                  site=self.site_a, rack=self.rack, position=5, face="front")
        b = Device.objects.create(tenant=self.tenant, name="b", device_type=self.full,
                                  site=self.site_a, rack=self.rack, position=5, face="rear")
        self.assertEqual(self.client.get(f"/api/devices/{a.id}/").status_code, 200)
        r = self.client.patch(f"/api/devices/{b.id}/", {"description": "x"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)


class RackShrinkTests(_Case):
    """#376 - a rack's units cannot shrink or shift out from under devices."""

    def setUp(self):
        super().setUp()
        self.assertEqual(self.put("hi", self.half_depth, 40, "front").status_code, 201)

    def test_shrink_below_a_device_refused(self):
        r = self.client.patch(f"/api/racks/{self.rack.id}/", {"u_height": 10}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"u_height": [
            "Devices are installed outside U1–U10 (hi at U40). Move or remove them first."]})
        self.rack.refresh_from_db()
        self.assertEqual(self.rack.u_height, 42)

    def test_shrink_that_still_holds_the_devices_allowed(self):
        r = self.client.patch(f"/api/racks/{self.rack.id}/", {"u_height": 40}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_top_unit_of_a_tall_device_counts(self):
        two_u = DeviceType.objects.create(tenant=self.tenant, name="2u", u_height=2)
        self.assertEqual(self.put("tall", two_u, 30, "front").status_code, 201)
        Device.objects.filter(name="hi").delete()
        r = self.client.patch(f"/api/racks/{self.rack.id}/", {"u_height": 30}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("tall at U30", str(r.json()))

    def test_raising_the_starting_unit_refused(self):
        self.assertEqual(self.put("lo", self.half_depth, 1, "front").status_code, 201)
        r = self.client.patch(f"/api/racks/{self.rack.id}/", {"starting_unit": 2}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("starting_unit", r.json())

    def test_side_mounted_strips_do_not_block(self):
        Device.objects.filter(name="hi").delete()
        zero = DeviceType.objects.create(tenant=self.tenant, name="pdu", u_height=0)
        r = self.client.post("/api/devices/", {
            "name": "pdu", "device_type_id": str(zero.id), "site_id": str(self.site_a.id),
            "rack_id": str(self.rack.id), "mount": "side_left",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.patch(f"/api/racks/{self.rack.id}/", {"u_height": 10}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_import_refuses_the_shrink(self):
        res = self.load("rack", f"id,name,site,u_height\n{self.rack.id},R1,SiteA,10\n")
        self.assertEqual(res.get("updated", 0), 0, res)
        self.assertIn("hi at U40", str(res["errors"]))
        self.rack.refresh_from_db()
        self.assertEqual(self.rack.u_height, 42)

    def test_sync_from_type_keeps_the_rack_height(self):
        rt = RackType.objects.create(tenant=self.tenant, name="small", u_height=10)
        Rack.objects.filter(pk=self.rack.pk).update(rack_type=rt)
        r = self.client.post(f"/api/racks/{self.rack.id}/sync-from-type/",
                             {"apply": True, "accessories": False}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("hi at U40", str(r.json()))
        self.rack.refresh_from_db()
        self.assertEqual(self.rack.u_height, 42)


class RackSiteTests(_Case):
    """#377 - a racked device is at its rack's site."""

    def test_rack_in_another_site_refused(self):
        r = self.put("x", self.full, 5, "front", site=self.site_b)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"rack_id": ["Pick a rack in the device's site."]})

    def test_no_site_takes_the_racks(self):
        r = self.client.post("/api/devices/", {
            "name": "x", "device_type_id": str(self.full.id),
            "rack_id": str(self.rack.id), "position": 5, "face": "front",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Device.objects.get(name="x").site_id, self.site_a.id)

    def test_moving_a_racked_device_to_another_site_refused(self):
        dev = self.put("x", self.full, 5, "front").json()["id"]
        r = self.client.patch(f"/api/devices/{dev}/", {"site_id": str(self.site_b.id)},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"site_id": ["Pick a rack in the device's site."]})

    def test_moving_site_and_unracking_together_allowed(self):
        dev = self.put("x", self.full, 5, "front").json()["id"]
        r = self.client.patch(f"/api/devices/{dev}/", {
            "site_id": str(self.site_b.id), "rack_id": None, "position": None, "face": "",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_location_in_another_site_refused(self):
        loc = Location.objects.create(tenant=self.tenant, site=self.site_b, name="L",
                                      slug="l")
        r = self.client.post("/api/devices/", {
            "name": "x", "site_id": str(self.site_a.id), "location_id": str(loc.id),
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"location_id": ["Pick a location within the device's site."]})

    def test_import_refuses_the_foreign_rack(self):
        res = self.load(
            "device",
            f"name,device_type,site,rack,position,face\nx,{self.full.id},SiteB,"
            f"{self.rack.id},5,front\n",
        )
        self.assertEqual(res["created"], 0, res)
        self.assertIn("device's site", str(res["errors"]))

    def test_moving_a_rack_with_devices_to_another_site_refused(self):
        self.assertEqual(self.put("x", self.full, 5, "front").status_code, 201)
        r = self.client.patch(f"/api/racks/{self.rack.id}/", {"site_id": str(self.site_b.id)},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("site_id", r.json())

    def test_empty_rack_moves_site(self):
        r = self.client.patch(f"/api/racks/{self.rack.id}/", {"site_id": str(self.site_b.id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_existing_mismatched_device_stays_editable(self):
        dev = Device.objects.create(tenant=self.tenant, name="old", site=self.site_b,
                                    rack=self.rack, position=3, face="front")
        r = self.client.patch(f"/api/devices/{dev.id}/", {"description": "x"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)


class FindCommandTests(_Case):
    def test_lists_stored_violations_without_changing_them(self):
        from io import StringIO

        from django.core.management import call_command

        mk = Device.objects.create
        mk(tenant=self.tenant, name="a", device_type=self.full, site=self.site_a,
           rack=self.rack, position=5, face="front")
        mk(tenant=self.tenant, name="b", device_type=self.half_depth, site=self.site_a,
           rack=self.rack, position=5, face="rear")
        mk(tenant=self.tenant, name="p1", device_type=self.half_depth, site=self.site_a,
           rack=self.rack, position=8, face="front")
        mk(tenant=self.tenant, name="p2", device_type=self.half_depth, site=self.site_a,
           rack=self.rack, position=8, face="rear")
        mk(tenant=self.tenant, name="high", device_type=self.half_depth, site=self.site_a,
           rack=self.rack, position=50, face="front")
        mk(tenant=self.tenant, name="away", site=self.site_b, rack=self.rack)
        out = StringIO()
        call_command("check_dcim_integrity", stdout=out)
        text = out.getvalue()
        self.assertIn("device b: overlaps a in rack R1 at U5", text)
        self.assertNotIn("p2", text)
        self.assertIn("device high: at U50, outside rack R1", text)
        self.assertIn("device away: at SiteB, its rack R1 at SiteA", text)
        self.assertIn("3 problems found.", text)
        self.assertEqual(Device.objects.count(), 6)
