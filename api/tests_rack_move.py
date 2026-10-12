"""Moving a rack to another site together with its devices (#394).

``POST /api/racks/<id>/move/`` moves the rack and everything racked in it in
one transaction, keeping each device's position and face. ``?dry_run=1``
reports the same plan and writes nothing. Anything still tied to the old site
blocks the move and is listed; a floor-plan placement at the old site is
cleared. Permission: change on the rack and every device, at both sites."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tag, Tenant

from .models import (
    VLAN,
    Cable,
    CableTermination,
    Device,
    DeviceBay,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    Interface,
    IPAddress,
    Location,
    PortReservation,
    PowerFeed,
    PowerPanel,
    Prefix,
    Rack,
    Site,
)
from .test_utils import status_for


class _Case(APITestCase):
    def tile_type(self):
        return FloorTileType.objects.get_or_create(
            tenant=self.tenant, slug="rack", defaults={"name": "Rack"})[0]

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        status_for(self.tenant)
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.loc_a = Location.objects.create(
            tenant=self.tenant, site=self.site_a, name="Hall A", slug="hall-a")
        self.loc_b = Location.objects.create(
            tenant=self.tenant, site=self.site_b, name="Hall B", slug="hall-b")
        self.rack = Rack.objects.create(
            tenant=self.tenant, site=self.site_a, location=self.loc_a, name="R1")
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="1u", u_height=1)
        self.zero_u = DeviceType.objects.create(tenant=self.tenant, name="pdu", u_height=0)
        self.srv = Device.objects.create(
            tenant=self.tenant, name="srv1", site=self.site_a, location=self.loc_a,
            rack=self.rack, position=10, face="rear", device_type=self.dt)
        self.pdu = Device.objects.create(
            tenant=self.tenant, name="pdu1", site=self.site_a, rack=self.rack,
            mount="side_left", device_type=self.zero_u)
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def move(self, site=None, location=None, dry_run=False, rack=None):
        body = {"site_id": str((site or self.site_b).id)}
        if location is not None:
            body["location_id"] = str(location.id)
        url = f"/api/racks/{(rack or self.rack).id}/move/"
        if dry_run:
            url += "?dry_run=1"
        return self.client.post(url, body, format="json")

    def codes(self, r):
        return sorted({b["code"] for b in r.json()["blockers"]})

    def assert_unmoved(self):
        self.rack.refresh_from_db()
        self.srv.refresh_from_db()
        self.assertEqual(self.rack.site_id, self.site_a.id)
        self.assertEqual(self.srv.site_id, self.site_a.id)


class MoveTests(_Case):
    def test_moves_the_rack_and_its_devices_keeping_position_and_face(self):
        r = self.move(location=self.loc_b)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["moved"])
        self.rack.refresh_from_db()
        self.srv.refresh_from_db()
        self.pdu.refresh_from_db()
        self.assertEqual((self.rack.site_id, self.rack.location_id),
                         (self.site_b.id, self.loc_b.id))
        self.assertEqual((self.srv.site_id, self.srv.location_id),
                         (self.site_b.id, self.loc_b.id))
        self.assertEqual((self.srv.rack_id, self.srv.position, self.srv.face),
                         (self.rack.id, 10, "rear"))
        self.assertEqual((self.pdu.site_id, self.pdu.mount),
                         (self.site_b.id, "side_left"))

    def test_without_a_location_the_old_one_is_cleared(self):
        self.assertEqual(self.move().status_code, 200)
        self.rack.refresh_from_db()
        self.srv.refresh_from_db()
        self.assertIsNone(self.rack.location_id)
        self.assertIsNone(self.srv.location_id)

    def test_dry_run_reports_and_writes_nothing(self):
        r = self.move(dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["moved"])
        self.assertTrue(body["can_move"])
        self.assertEqual(body["blockers"], [])
        self.assertEqual(body["to_site"]["id"], str(self.site_b.id))
        self.assertEqual(sorted(d["name"] for d in body["devices"]), ["pdu1", "srv1"])
        self.assert_unmoved()

    def test_every_moved_object_is_in_the_change_log(self):
        before = ChangeLogEntry.objects.count()
        self.assertEqual(self.move().status_code, 200)
        ids = set(ChangeLogEntry.objects.order_by("timestamp")[before:]
                  .values_list("object_id", flat=True))
        self.assertTrue({str(self.rack.id), str(self.srv.id), str(self.pdu.id)} <= ids)

    def test_a_location_of_another_site_is_refused(self):
        r = self.move(location=self.loc_a)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("location_id", r.json())
        self.assert_unmoved()

    def test_the_same_site_is_refused(self):
        r = self.move(site=self.site_a)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("site_id", r.json())

    def test_a_site_of_another_tenant_is_refused(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        foreign = Site.objects.create(tenant=other, name="Far")
        r = self.move(site=foreign)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("site_id", r.json())
        self.assert_unmoved()

    def test_an_empty_rack_moves(self):
        empty = Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R2")
        self.assertEqual(self.move(rack=empty).status_code, 200)
        empty.refresh_from_db()
        self.assertEqual(empty.site_id, self.site_b.id)

    def test_the_plain_edit_still_refuses_a_site_change(self):
        r = self.client.patch(f"/api/racks/{self.rack.id}/",
                              {"site_id": str(self.site_b.id)}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_child_device_in_a_bay_moves_with_its_parent(self):
        child = Device.objects.create(tenant=self.tenant, name="blade",
                                      site=self.site_a, device_type=self.dt)
        DeviceBay.objects.create(device=self.srv, name="b1", installed_device=child)
        r = self.move(dry_run=True)
        self.assertIn("blade", [d["name"] for d in r.json()["devices"]])
        self.assertEqual(self.move().status_code, 200)
        child.refresh_from_db()
        self.assertEqual(child.site_id, self.site_b.id)

    def test_a_device_in_a_bay_of_a_device_outside_the_rack_blocks(self):
        outside = Device.objects.create(tenant=self.tenant, name="chassis",
                                        site=self.site_a, device_type=self.dt)
        DeviceBay.objects.create(device=outside, name="b1", installed_device=self.srv)
        r = self.move()
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(self.codes(r), ["bay"])
        self.assert_unmoved()


class BlockerTests(_Case):
    def _ip(self, addr, site=None, prefix_site=None):
        pfx = Prefix.objects.create(tenant=self.tenant, cidr=addr.rsplit(".", 1)[0] + ".0/24",
                                    site=prefix_site, status=status_for(self.tenant))
        return IPAddress.objects.create(tenant=self.tenant, ip_address=addr, prefix=pfx,
                                        site=site, assigned_device=self.srv)

    def _cable(self, a, b):
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=a)
        CableTermination.objects.create(cable=cable, end="B", interface=b)
        return cable

    def test_a_cable_leaving_the_rack_blocks(self):
        other = Device.objects.create(tenant=self.tenant, name="sw9", site=self.site_a)
        self._cable(Interface.objects.create(device=self.srv, name="eth0"),
                    Interface.objects.create(device=other, name="ge1"))
        r = self.move()
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(self.codes(r), ["cable"])
        self.assertFalse(r.json()["moved"])
        self.assert_unmoved()
        # The far end is not named: the caller may not see that device.
        self.assertNotIn("sw9", str(r.json()["blockers"]))

    def test_a_cable_inside_the_rack_moves_along(self):
        self._cable(Interface.objects.create(device=self.srv, name="eth0"),
                    Interface.objects.create(device=self.pdu, name="mgmt"))
        self.assertEqual(self.move().status_code, 200)

    def test_a_cable_to_a_power_feed_blocks(self):
        from .models import PowerPort
        panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site_a, name="P")
        feed = PowerFeed.objects.create(tenant=self.tenant, power_panel=panel, name="F")
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(
            cable=cable, end="A", power_port=PowerPort.objects.create(device=self.pdu, name="in"))
        CableTermination.objects.create(cable=cable, end="B", power_feed=feed)
        self.assertIn("cable", self.codes(self.move(dry_run=True)))

    def test_a_power_feed_delivered_to_the_rack_blocks(self):
        panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site_a, name="P")
        PowerFeed.objects.create(tenant=self.tenant, power_panel=panel, name="F",
                                 rack=self.rack)
        r = self.move(dry_run=True)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["can_move"])
        self.assertEqual(self.codes(r), ["power_feed"])

    def test_a_vlan_of_the_old_site_blocks_and_a_shared_one_does_not(self):
        iface = Interface.objects.create(device=self.srv, name="eth0")
        shared = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="Shared")
        iface.tagged_vlans.add(shared)
        self.assertEqual(self.codes(self.move(dry_run=True)), [])
        local = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="Users",
                                    site=self.site_a)
        iface.vlan = local
        iface.save()
        self.assertEqual(self.codes(self.move(dry_run=True)), ["vlan"])

    def test_an_ip_of_the_old_site_blocks(self):
        self._ip("10.0.0.5", site=self.site_a)
        self.assertEqual(self.codes(self.move(dry_run=True)), ["ip"])

    def test_an_ip_with_no_site_does_not_block(self):
        self._ip("10.0.0.6")
        self.assertEqual(self.codes(self.move(dry_run=True)), [])

    def test_an_ip_in_a_prefix_of_the_old_site_blocks(self):
        self._ip("10.0.1.6", prefix_site=self.site_a)
        self.assertEqual(self.codes(self.move(dry_run=True)), ["ip"])

    def test_a_rack_of_the_same_name_at_the_new_site_blocks(self):
        Rack.objects.create(tenant=self.tenant, site=self.site_b, name="R1")
        self.assertEqual(self.codes(self.move(dry_run=True)), ["name"])

    def test_every_blocker_is_listed(self):
        Rack.objects.create(tenant=self.tenant, site=self.site_b, name="R1")
        self._ip("10.0.0.5", site=self.site_a)
        r = self.move()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.codes(r), ["ip", "name"])
        self.assertTrue(r.json()["detail"])


class CatalogLocalityTests(_Case):
    def _separation(self, on):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = on
        dep.save()

    def test_a_device_type_local_to_the_old_site_blocks_under_separation(self):
        self._separation(True)
        self.dt.owning_site = self.site_a
        self.dt.save()
        self.assertEqual(self.codes(self.move(dry_run=True)), ["catalog"])

    def test_a_local_tag_on_the_rack_blocks_under_separation(self):
        self._separation(True)
        tag = Tag.objects.create(tenant=self.tenant, name="a-only", slug="a-only",
                                 owning_site=self.site_a)
        self.rack.tags.add(tag)
        self.assertEqual(self.codes(self.move(dry_run=True)), ["catalog"])

    def test_locality_is_ignored_with_separation_off(self):
        self._separation(False)
        self.dt.owning_site = self.site_a
        self.dt.save()
        self.assertEqual(self.codes(self.move(dry_run=True)), [])


class ClearedTests(_Case):
    def test_a_floor_plan_placement_at_the_old_site_is_cleared(self):
        plan = FloorPlan.objects.create(tenant=self.tenant, location=self.loc_a, name="F")
        tile = FloorPlanTile.objects.create(
            floor_plan=plan, x=1, y=1, tile_type=self.tile_type(),
            link_kind="rack", rack=self.rack)
        r = self.move(dry_run=True)
        self.assertEqual(r.json()["cleared"]["floor_plan_tiles"], 1)
        self.assertEqual(self.move().status_code, 200)
        tile.refresh_from_db()
        self.assertIsNone(tile.rack_id)
        self.assertEqual(tile.link_kind, "")

    def test_a_port_reservation_follows_its_device(self):
        iface = Interface.objects.create(device=self.srv, name="eth1")
        hold = PortReservation.objects.create(tenant=self.tenant, interface=iface)
        self.assertEqual(hold.site_id, self.site_a.id)
        self.assertEqual(self.move().status_code, 200)
        hold.refresh_from_db()
        self.assertEqual(hold.site_id, self.site_b.id)


class PermissionTests(_Case):
    def setUp(self):
        super().setUp()
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def grant(self, types, sites, actions=("view", "change")):
        perm = ObjectPermission.objects.create(
            name="g" + "-".join(types) + str(len(sites)),
            object_types=list(types), actions=list(actions))
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.set(sites)
        return perm

    def test_both_sites_lets_the_move_through(self):
        self.grant(["rack", "device"], [self.site_a, self.site_b])
        self.login(self.user)
        r = self.move()
        self.assertEqual(r.status_code, 200, r.content)

    def test_old_site_only_is_refused(self):
        self.grant(["rack", "device"], [self.site_a])
        self.login(self.user)
        r = self.move()
        self.assertEqual(r.status_code, 403, r.content)
        self.assert_unmoved()

    def test_dry_run_is_refused_too(self):
        self.grant(["rack", "device"], [self.site_a])
        self.login(self.user)
        self.assertEqual(self.move(dry_run=True).status_code, 403)

    def test_rack_change_without_device_change_is_refused(self):
        self.grant(["rack"], [self.site_a, self.site_b])
        self.grant(["device"], [self.site_a, self.site_b], actions=("view",))
        self.login(self.user)
        self.assertEqual(self.move().status_code, 403)
        self.assert_unmoved()

    def test_no_rack_change_is_refused(self):
        self.grant(["rack", "device"], [self.site_a, self.site_b], actions=("view",))
        self.login(self.user)
        self.assertIn(self.move().status_code, (403, 404))
        self.assert_unmoved()

    def test_a_cleared_floor_plan_needs_change_on_it(self):
        plan = FloorPlan.objects.create(tenant=self.tenant, location=self.loc_a, name="F")
        FloorPlanTile.objects.create(
            floor_plan=plan, x=1, y=1, tile_type=self.tile_type(),
            link_kind="rack", rack=self.rack)
        self.grant(["rack", "device"], [self.site_a, self.site_b])
        self.login(self.user)
        self.assertEqual(self.move().status_code, 403)
        self.assert_unmoved()
        self.grant(["floorplantile"], [self.site_a])
        self.assertEqual(self.move().status_code, 200)
