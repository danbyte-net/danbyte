"""The floor plan's detail panels (``api.floor_plan_panels``): the cable
panel names both ends in full and an end on a device the reader may not view
as Hidden (#453); a cable the reader may not view, or another tenant's, is a
404. A device tile's panel carries its facts, monitoring and port summary, a
rack tile's its devices; a tile whose object the reader may not view reads
Hidden."""
from django.contrib.auth import get_user_model

from auth_api.api import assemble_site_role
from core.models import Organization, Tenant

from .models import VLAN, Cable, Interface, IPAddress, Prefix
from .tests_floorplan_cables import SECRETS, _Fixture

User = get_user_model()


class _Panels(_Fixture):
    def cable_panel(self, cable, expect=200):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/cable-panel/{cable.id}/")
        self.assertEqual(r.status_code, expect, r.content)
        return r

    def tile_panel(self, tile, expect=200):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/tile-panel/{tile.id}/")
        self.assertEqual(r.status_code, expect, r.content)
        return r


class CablePanelTests(_Panels):
    def setUp(self):
        super().setUp()
        self.login(User.objects.create_superuser("admin", "a@example.com", "x"))

    def test_both_ends_in_full(self):
        iface = Interface.objects.get(device__name="sw-a1", name="e1")
        vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="users")
        iface.vlan = vlan
        iface.speed = "1G"
        iface.description = "uplink"
        iface.save()
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=prefix,
            assigned_interface=iface,
        )
        body = self.cable_panel(self.local).json()
        self.assertEqual(body["label"], "L-1")
        (a,) = body["ends"]["A"]
        (b,) = body["ends"]["B"]
        self.assertEqual(a["device"]["name"], "sw-a1")
        self.assertEqual(a["device"]["rack"]["name"], "R1")
        self.assertEqual(a["device"]["site"]["name"], "SiteA")
        self.assertEqual(a["port"]["name"], "e1")
        self.assertEqual(a["port"]["kind"], "interface")
        self.assertEqual(a["port"]["speed"], "1G")
        self.assertEqual(a["port"]["description"], "uplink")
        self.assertTrue(a["port"]["enabled"])
        self.assertEqual(a["port"]["vlan"]["vlan_id"], 20)
        self.assertEqual(
            [ip["ip_address"] for ip in a["port"]["ip_addresses"]], ["10.0.0.5"]
        )
        self.assertIsNone(a["port"]["observed"])
        self.assertEqual(b["device"]["name"], "sw-a2")

    def test_other_tenant_cable_is_404(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        cable = Cable.objects.create(tenant=other, label="theirs")
        self.cable_panel(cable, expect=404)

    def test_device_tile_panel(self):
        body = self.tile_panel(self.far_tile).json()
        self.assertEqual(body["kind"], "device")
        self.assertEqual(body["device"]["name"], "far-b")
        self.assertEqual(body["ports"]["total"], 1)
        self.assertEqual(body["ports"]["connected"], 1)
        self.assertIsNone(body["monitoring"]["status"])

    def test_rack_tile_panel(self):
        body = self.tile_panel(self.rack_tile).json()
        self.assertEqual(body["kind"], "rack")
        self.assertEqual(body["rack"]["name"], "R1")
        self.assertEqual({d["name"] for d in body["devices"]}, {"sw-a1", "sw-a2"})
        self.assertEqual(body["hidden_count"], 0)

    def test_tile_of_another_plan_is_404(self):
        from .models import FloorPlan, FloorPlanTile, FloorTileType

        other = FloorPlan.objects.create(tenant=self.tenant, location=self.loc, name="B")
        tile = FloorPlanTile.objects.create(
            floor_plan=other, x=0, y=0, tile_type=FloorTileType.objects.get(slug="rack"),
        )
        self.tile_panel(tile, expect=404)


class HiddenEndPanelTests(_Panels):
    """A site-A viewer with a cable grant: the cable to site B is theirs to
    see, the device at its far end is not."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.grant(["cable"])
        self.login()

    def test_far_end_reads_hidden(self):
        r = self.cable_panel(self.cross)
        body = r.json()
        self.assertEqual(body["ends"]["B"], [{"hidden": True}])
        self.assertEqual(body["ends"]["A"][0]["device"]["name"], "sw-a1")
        text = r.content.decode()
        for secret in ("far-b", "eth-secret", str(self.far.pk)):
            self.assertNotIn(secret, text)

    def test_hidden_device_tile(self):
        r = self.tile_panel(self.far_tile)
        self.assertEqual(r.json(), {"kind": "device", "hidden": True})
        self.assertNotIn("far-b", r.content.decode())

    def test_rack_lists_viewable_devices(self):
        body = self.tile_panel(self.rack_tile).json()
        self.assertEqual({d["name"] for d in body["devices"]}, {"sw-a1", "sw-a2"})


class CableNotViewableTests(_Panels):
    """A site-A viewer without a cable grant to site B's run."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.login()

    def test_cable_is_404(self):
        r = self.cable_panel(self.cross, expect=404)
        for secret in SECRETS:
            self.assertNotIn(secret, r.content.decode())
