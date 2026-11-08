"""Cables with one end on a floor plan: ``cable-paths`` lists the end off
the plan in ``a_far`` / ``b_far`` - the device and port, the floor of the
plan's stack it stands on, and what to place to bring it here when it is
on the plan's site - and a Hidden end (#453) reads nothing more.
``placeable/?ids=`` keeps only the objects named."""
from django.contrib.auth import get_user_model

from auth_api.models import ObjectPermission, UserProfile

from .models import Device, FloorPlan, FloorPlanTile, Rack, Site
from .tests_floorplan_cable_paths import _Plan

User = get_user_model()


class CableFarEndTests(_Plan):
    def setUp(self):
        super().setUp()
        # sw-b's rack leaves this plan: C-1 has one end here.
        self.tile_b.delete()

    def test_far_end_named_with_what_to_place(self):
        row = self.cable_paths()[str(self.cable.id)]
        self.assertEqual(row["a_tiles"], [str(self.tile_a.id)])
        self.assertEqual(row["b_tiles"], [])
        self.assertEqual(row["a_far"], [])
        (far,) = row["b_far"]
        self.assertEqual(far["device"], str(self.dev_b.id))
        self.assertEqual(far["device_name"], "sw-b")
        self.assertEqual(far["port"], "e1")
        self.assertIsNone(far["floor_plan"])
        # In a rack: the rack is what is placed.
        self.assertEqual(far["place"], {"kind": "rack", "id": str(self.rack_b.id)})

    def test_far_end_on_another_floor_of_the_stack(self):
        upper = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="First floor",
            stack=self.plan.stack, floor_order=1, grid_width=10, grid_height=10,
        )
        FloorPlanTile.objects.create(
            floor_plan=upper, tile_type=self.tt, x=1, y=1, rack=self.rack_b,
            link_kind="rack",
        )
        (far,) = self.cable_paths()[str(self.cable.id)]["b_far"]
        self.assertEqual(far["floor_plan"], {"id": str(upper.id), "name": "First floor"})

    def test_far_end_on_another_site_is_not_placeable(self):
        other = Site.objects.create(tenant=self.tenant, name="AAL")
        fw = Device.objects.create(
            tenant=self.tenant, name="aalborg-fw1", site=other, device_type=self.dtype
        )
        cable = self._cable("C-2", self.dev_a, fw)
        (far,) = self.cable_paths()[str(cable.id)]["b_far"]
        self.assertEqual(far["device_name"], "aalborg-fw1")
        self.assertIsNone(far["place"])

    def test_hidden_far_end_reads_hidden(self):
        viewer = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=viewer).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile", "cable", "rack"],
            actions=["view"],
        )
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        self.login(viewer)
        row = self.cable_paths()[str(self.cable.id)]
        self.assertEqual(row["b_far"], [{"device": None, "port": None, "hidden": True}])
        self.assertNotIn("sw-b", str(row))
        self.assertNotIn(str(self.rack_b.id), str(row["b_far"]))

    def test_placeable_ids_filter(self):
        Rack.objects.create(tenant=self.tenant, site=self.site, name="RC")
        url = f"/api/floor-plans/{self.plan.id}/placeable/"
        r = self.client.get(url, {"ids": str(self.rack_b.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([x["id"] for x in r.json()["results"]], [str(self.rack_b.id)])
        self.assertEqual(self.client.get(url, {"ids": "nope"}).status_code, 400)
