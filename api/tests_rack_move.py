"""Moving a rack to another site together with its devices (#394).

``POST /api/racks/<id>/move/`` moves the rack and everything racked in it in
one transaction, keeping each device's position and face. ``?dry_run=1``
reports the same plan and writes nothing. Anything still tied to the old site
blocks the move and is listed; a floor-plan placement at the old site is
cleared. Permission: change on the rack and every device, at both sites."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tag, Tenant
from customization.models import CustomField
from routing.models import BGPInstance, BGPSession, OSPFInstance, StaticRoute

from . import rack_move
from .models import (
    ASN,
    VLAN,
    VRF,
    Cabinet,
    Cable,
    CableTermination,
    Cluster,
    ClusterType,
    ConsolePort,
    Device,
    DeviceBay,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    Interface,
    InventoryItem,
    IPAddress,
    IPRole,
    Location,
    MACAddress,
    Manufacturer,
    PortReservation,
    PowerFeed,
    PowerPanel,
    PowerPort,
    Prefix,
    Rack,
    Site,
    Status,
    VirtualChassis,
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


class PlacementTests(_Case):
    """A device that goes along must not keep a placement at the old site
    (#403)."""

    def _cabinet(self, site=None, name="CabA"):
        return Cabinet.objects.create(tenant=self.tenant, site=site or self.site_a,
                                      name=name, inner_width_mm=500, inner_height_mm=600)

    def test_a_bay_child_in_a_din_cabinet_blocks(self):
        cab = self._cabinet()
        child = Device.objects.create(tenant=self.tenant, name="blade",
                                      site=self.site_a, cabinet=cab, device_type=self.dt)
        r = self.client.post("/api/device-bays/", {
            "device_id": str(self.srv.id), "name": "b1",
            "installed_device_id": str(child.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.move()
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(self.codes(r), ["bay"])
        self.assertIn("blade sits in a bay of srv1 but is mounted in cabinet CabA.",
                      [b["message"] for b in r.json()["blockers"]])
        self.assertNotIn("blade", [d["name"] for d in r.json()["devices"]])
        self.assert_unmoved()
        child.refresh_from_db()
        self.assertEqual((child.site_id, child.cabinet_id), (self.site_a.id, cab.id))

    def test_a_grandchild_under_a_cabinet_child_is_not_taken(self):
        cab = self._cabinet()
        child = Device.objects.create(tenant=self.tenant, name="blade",
                                      site=self.site_a, cabinet=cab, device_type=self.dt)
        grand = Device.objects.create(tenant=self.tenant, name="card",
                                      site=self.site_a, device_type=self.dt)
        DeviceBay.objects.create(device=self.srv, name="b1", installed_device=child)
        DeviceBay.objects.create(device=child, name="c1", installed_device=grand)
        names = [d["name"] for d in self.move(dry_run=True).json()["devices"]]
        self.assertNotIn("card", names)

    def test_a_virtual_chassis_split_by_the_move_blocks(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack1")
        Device.objects.filter(pk=self.srv.pk).update(virtual_chassis=vc, vc_position=1)
        other = Device.objects.create(tenant=self.tenant, name="sw2", site=self.site_a,
                                      device_type=self.dt)
        Device.objects.filter(pk=other.pk).update(virtual_chassis=vc, vc_position=2)
        r = self.move()
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(self.codes(r), ["virtual_chassis"])
        self.assert_unmoved()

    def test_a_virtual_chassis_wholly_in_the_rack_moves(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack1")
        Device.objects.filter(pk=self.srv.pk).update(virtual_chassis=vc, vc_position=1)
        Device.objects.filter(pk=self.pdu.pk).update(virtual_chassis=vc, vc_position=2)
        self.assertEqual(self.move().status_code, 200)


class NamingTests(_Case):
    """A reason names an object only when the caller may view it (#404)."""

    def setUp(self):
        super().setUp()
        self.site_c = Site.objects.create(tenant=self.tenant, name="SiteC")
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        self.perm = ObjectPermission.objects.create(
            name="ab", object_types=["rack", "device", "site", "cluster", "cable",
                                     "interface", "vlan", "cabinet"],
            actions=["view", "change"])
        self.perm.users.add(self.user)
        self.perm.tenants.add(self.tenant)
        self.perm.sites.set([self.site_a, self.site_b])

    def messages(self, r):
        self.assertEqual(r.status_code, 200, r.content)
        return " ".join(b["message"] for b in r.json()["blockers"])

    def cluster(self, name, site):
        ctype = ClusterType.objects.create(tenant=self.tenant, name=name, slug=name)
        return Cluster.objects.create(tenant=self.tenant, name=name, type=ctype, site=site)

    def test_a_bay_parent_the_caller_cannot_view_is_not_named(self):
        chassis = Device.objects.create(tenant=self.tenant, name="secret-chassis-x",
                                        site=self.site_c, device_type=self.dt)
        DeviceBay.objects.create(device=chassis, name="b1", installed_device=self.srv)
        self.login(self.user)
        self.assertEqual(self.client.get(f"/api/devices/{chassis.id}/").status_code, 404)
        text = self.messages(self.move(dry_run=True))
        self.assertNotIn("secret-chassis-x", text)
        self.assertIn("srv1 sits in a bay of a device, outside the rack.", text)
        r = self.move()
        self.assertEqual(r.status_code, 409)
        self.assertNotIn("secret-chassis-x", str(r.json()))

    def test_a_bay_parent_the_caller_can_view_is_named(self):
        chassis = Device.objects.create(tenant=self.tenant, name="chassis",
                                        site=self.site_a, device_type=self.dt)
        DeviceBay.objects.create(device=chassis, name="b1", installed_device=self.srv)
        self.login(self.user)
        self.assertIn("a bay of chassis,", self.messages(self.move(dry_run=True)))

    def test_a_child_and_rack_the_caller_cannot_view_are_not_named(self):
        far = Rack.objects.create(tenant=self.tenant, site=self.site_c, name="secret-rack")
        child = Device.objects.create(tenant=self.tenant, name="secret-blade",
                                      site=self.site_c, rack=far, device_type=self.dt)
        DeviceBay.objects.create(device=self.srv, name="b1", installed_device=child)
        self.login(self.user)
        text = self.messages(self.move(dry_run=True))
        self.assertNotIn("secret", text)
        self.assertIn("A device sits in a bay of srv1 but is racked in another rack.", text)

    def test_a_cabinet_the_caller_cannot_view_is_not_named(self):
        cab = Cabinet.objects.create(tenant=self.tenant, site=self.site_c, name="secret-cab",
                                     inner_width_mm=500, inner_height_mm=600)
        child = Device.objects.create(tenant=self.tenant, name="blade", site=self.site_a,
                                      device_type=self.dt)
        Device.objects.filter(pk=child.pk).update(cabinet=cab)
        DeviceBay.objects.create(device=self.srv, name="b1", installed_device=child)
        self.login(self.user)
        text = self.messages(self.move(dry_run=True))
        self.assertNotIn("secret-cab", text)
        self.assertIn("blade sits in a bay of srv1 but is mounted in a cabinet.", text)

    def test_a_cluster_and_site_the_caller_cannot_view_are_not_named(self):
        cl = self.cluster("secret-cluster", self.site_c)
        Device.objects.filter(pk=self.srv.pk).update(cluster=cl)
        self.login(self.user)
        text = self.messages(self.move(dry_run=True))
        self.assertNotIn("secret-cluster", text)
        self.assertNotIn("SiteC", text)
        self.assertIn("srv1: its cluster is at another site.", text)

    def test_a_site_the_caller_can_view_is_named(self):
        cl = self.cluster("c1", self.site_a)
        Device.objects.filter(pk=self.srv.pk).update(cluster=cl)
        self.login(self.user)
        self.assertIn("srv1: cluster c1 is at SiteA.", self.messages(self.move(dry_run=True)))

    def test_vlan_ip_and_power_feed_sites_follow_the_same_rule(self):
        iface = Interface.objects.create(device=self.srv, name="eth0")
        iface.vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="V",
                                         site=self.site_c)
        iface.save()
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24",
                                    site=self.site_c, status=status_for(self.tenant))
        IPAddress.objects.create(tenant=self.tenant, ip_address="10.9.0.5", prefix=pfx,
                                 assigned_device=self.srv)
        panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site_c, name="P")
        PowerFeed.objects.create(tenant=self.tenant, power_panel=panel, name="F",
                                 rack=self.rack)
        self.login(self.user)
        text = self.messages(self.move(dry_run=True))
        self.assertNotIn("SiteC", text)
        self.assertIn("srv1 eth0 carries a VLAN of another site.", text)
        self.assertIn("srv1: 1 IP address of another site.", text)
        self.assertIn("1 power feed from another site delivers to this rack.", text)

    def test_a_cable_the_caller_cannot_view_is_not_named(self):
        other = Device.objects.create(tenant=self.tenant, name="sw9", site=self.site_a)
        cable = Cable.objects.create(tenant=self.tenant, label="secret-cable")
        CableTermination.objects.create(
            cable=cable, end="A", interface=Interface.objects.create(device=self.srv,
                                                                     name="eth0"))
        CableTermination.objects.create(
            cable=cable, end="B", interface=Interface.objects.create(device=other,
                                                                     name="ge1"))
        self.perm.object_types = [t for t in self.perm.object_types if t != "cable"]
        self.perm.save()
        self.login(self.user)
        text = self.messages(self.move(dry_run=True))
        self.assertNotIn("secret-cable", text)
        self.assertIn("A cable on srv1 eth0 leaves the rack.", text)

    def test_the_superuser_sees_every_name(self):
        cl = self.cluster("c9", self.site_c)
        Device.objects.filter(pk=self.srv.pk).update(cluster=cl)
        self.assertIn("srv1: cluster c9 is at SiteC.", self.messages(self.move(dry_run=True)))


class ComponentCatalogTests(_Case):
    """Under enhanced site separation, site-local catalog entries on the
    devices' components, IP and MAC addresses block too (#407)."""

    def setUp(self):
        super().setUp()
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        self.eth0 = Interface.objects.create(device=self.srv, name="eth0")
        self.a_tag = Tag.objects.create(tenant=self.tenant, name="a-only", slug="a-only",
                                        owning_site=self.site_a)

    def messages(self, r):
        return [b["message"] for b in r.json()["blockers"]]

    def test_a_local_tag_on_an_interface_blocks(self):
        self.eth0.tags.add(self.a_tag)
        r = self.move()
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(self.codes(r), ["catalog"])
        self.assertIn("srv1 eth0: tag a-only is local to SiteA.", self.messages(r))
        self.assert_unmoved()

    def test_a_local_tag_on_a_device_still_blocks(self):
        self.srv.tags.add(self.a_tag)
        self.assertIn("srv1: tag a-only is local to SiteA.",
                      self.messages(self.move(dry_run=True)))

    def test_a_local_tag_on_other_components_blocks(self):
        PowerPort.objects.create(device=self.pdu, name="in").tags.add(self.a_tag)
        ConsolePort.objects.create(device=self.srv, name="con").tags.add(self.a_tag)
        InventoryItem.objects.create(device=self.srv, name="disk0").tags.add(self.a_tag)
        msgs = self.messages(self.move(dry_run=True))
        self.assertIn("pdu1 in: tag a-only is local to SiteA.", msgs)
        self.assertIn("srv1 con: tag a-only is local to SiteA.", msgs)
        self.assertIn("srv1 disk0: tag a-only is local to SiteA.", msgs)

    def test_a_global_tag_or_one_local_to_the_new_site_does_not_block(self):
        self.eth0.tags.add(Tag.objects.create(tenant=self.tenant, name="g", slug="g"))
        self.eth0.tags.add(Tag.objects.create(tenant=self.tenant, name="b", slug="b",
                                              owning_site=self.site_b))
        self.assertEqual(self.codes(self.move(dry_run=True)), [])

    def test_a_local_vrf_on_an_interface_blocks(self):
        self.eth0.vrf = VRF.objects.create(tenant=self.tenant, name="red",
                                           owning_site=self.site_a)
        self.eth0.save()
        self.assertIn("srv1 eth0: VRF red is local to SiteA.",
                      self.messages(self.move(dry_run=True)))

    def test_a_local_status_on_an_interface_blocks(self):
        self.eth0.status = Status.objects.create(tenant=self.tenant, name="Lab", slug="lab",
                                                 owning_site=self.site_a)
        self.eth0.save()
        self.assertIn("srv1 eth0: status Lab is local to SiteA.",
                      self.messages(self.move(dry_run=True)))

    def test_a_local_vrf_role_or_tag_on_an_ip_blocks(self):
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24",
                                    status=status_for(self.tenant))
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.7", prefix=pfx,
            assigned_interface=self.eth0,
            role=IPRole.objects.create(tenant=self.tenant, name="Lo", slug="lo",
                                       owning_site=self.site_a))
        IPAddress.objects.filter(pk=ip.pk).update(vrf=VRF.objects.create(
            tenant=self.tenant, name="blue", owning_site=self.site_a))
        ip.tags.add(self.a_tag)
        msgs = self.messages(self.move(dry_run=True))
        self.assertIn("srv1 10.0.0.7: IP role Lo is local to SiteA.", msgs)
        self.assertIn("srv1 10.0.0.7: VRF blue is local to SiteA.", msgs)
        self.assertIn("srv1 10.0.0.7: tag a-only is local to SiteA.", msgs)

    def test_a_local_tag_on_a_mac_address_blocks(self):
        mac = MACAddress.objects.create(tenant=self.tenant, mac_address="00:11:22:33:44:55",
                                        assigned_interface=self.eth0)
        mac.tags.add(self.a_tag)
        self.assertEqual(self.codes(self.move(dry_run=True)), ["catalog"])

    def test_a_value_of_a_local_custom_field_blocks(self):
        CustomField.objects.create(tenant=self.tenant, key="owner", label="Owner",
                                   applies_to=["interface", "device"],
                                   owning_site=self.site_a)
        Interface.objects.filter(pk=self.eth0.pk).update(custom_fields={"owner": "x"})
        self.assertIn("srv1 eth0: custom field Owner is local to SiteA.",
                      self.messages(self.move(dry_run=True)))
        Interface.objects.filter(pk=self.eth0.pk).update(custom_fields={"owner": ""})
        self.assertEqual(self.codes(self.move(dry_run=True)), [])

    def test_components_are_ignored_with_separation_off(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = False
        dep.save()
        self.eth0.tags.add(self.a_tag)
        self.assertEqual(self.codes(self.move(dry_run=True)), [])

    def test_a_local_entry_the_caller_cannot_view_is_not_named(self):
        self.eth0.tags.add(self.a_tag)
        user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="ab", object_types=["rack", "device", "interface", "site"],
            actions=["view", "change"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        self.assertIn("srv1 eth0: a tag is local to SiteA.",
                      self.messages(self.move(dry_run=True)))

    def test_the_query_count_does_not_grow_with_the_rows(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                rack_move.plan(self.rack, self.site_b, None,
                               user=self.admin, tenant=self.tenant)
            return len(ctx.captured_queries)

        self.eth0.tags.add(self.a_tag)
        one = count()
        for i in range(10):
            Interface.objects.create(device=self.srv, name=f"eth{i + 1}").tags.add(self.a_tag)
            Interface.objects.create(device=self.pdu, name=f"p{i}").tags.add(self.a_tag)
        self.assertEqual(count(), one)


class EveryCatalogTests(_Case):
    """Every site-local catalog a moving row can reference is checked, on
    every row that moves with the devices - components and routing rows
    alike (#409)."""

    def setUp(self):
        super().setUp()
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        self.a_tag = Tag.objects.create(tenant=self.tenant, name="a-only", slug="a-only",
                                        owning_site=self.site_a)

    def messages(self, r):
        return [b["message"] for b in r.json()["blockers"]]

    def maker(self, name="LocalCo", owner=None):
        return Manufacturer.objects.create(tenant=self.tenant, name=name, slug=name.lower(),
                                           owning_site=owner)

    def test_a_local_manufacturer_on_an_inventory_item_blocks(self):
        InventoryItem.objects.create(device=self.srv, name="psu0",
                                     manufacturer=self.maker(owner=self.site_a))
        r = self.move()
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(self.messages(r),
                         ["srv1 psu0: manufacturer LocalCo is local to SiteA."])
        self.assert_unmoved()

    def test_a_global_manufacturer_or_one_of_the_new_site_does_not_block(self):
        InventoryItem.objects.create(device=self.srv, name="g", manufacturer=self.maker("Glob"))
        InventoryItem.objects.create(device=self.srv, name="b",
                                     manufacturer=self.maker("BCo", self.site_b))
        self.assertEqual(self.codes(self.move(dry_run=True)), [])

    def test_a_local_status_on_an_inventory_item_blocks(self):
        InventoryItem.objects.create(
            device=self.srv, name="psu1",
            status=Status.objects.create(tenant=self.tenant, name="Lab", slug="lab",
                                         owning_site=self.site_a))
        self.assertIn("srv1 psu1: status Lab is local to SiteA.",
                      self.messages(self.move(dry_run=True)))

    def test_a_local_device_type_names_the_device(self):
        self.dt.owning_site = self.site_a
        self.dt.save()
        self.assertEqual(self.messages(self.move(dry_run=True)),
                         ["srv1: device type 1u is local to SiteA."])

    def test_a_manufacturer_the_caller_cannot_view_is_not_named(self):
        InventoryItem.objects.create(device=self.srv, name="psu0",
                                     manufacturer=self.maker(owner=self.site_a))
        user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="ab", object_types=["rack", "device", "inventoryitem", "site"],
            actions=["view", "change"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.messages(self.move(dry_run=True)),
                         ["srv1 psu0: a manufacturer is local to SiteA."])

    def test_a_local_vrf_or_status_on_a_static_route_blocks(self):
        StaticRoute.objects.create(
            tenant=self.tenant, device=self.srv, prefix="10.9.0.0/16", next_hop="10.0.0.1",
            vrf=VRF.objects.create(tenant=self.tenant, name="red", owning_site=self.site_a),
            next_hop_vrf=VRF.objects.create(tenant=self.tenant, name="leak",
                                            owning_site=self.site_a),
            status=Status.objects.create(tenant=self.tenant, name="Lab", slug="lab",
                                         owning_site=self.site_a))
        msgs = self.messages(self.move(dry_run=True))
        self.assertIn("srv1 static route 10.9.0.0/16: VRF red is local to SiteA.", msgs)
        self.assertIn("srv1 static route 10.9.0.0/16: VRF leak is local to SiteA.", msgs)
        self.assertIn("srv1 static route 10.9.0.0/16: status Lab is local to SiteA.", msgs)

    def test_a_local_entry_on_a_routing_instance_or_session_blocks(self):
        OSPFInstance.objects.create(tenant=self.tenant, device=self.srv,
                                    process_id="1").tags.add(self.a_tag)
        bgp = BGPInstance.objects.create(
            tenant=self.tenant, device=self.pdu,
            asn=ASN.objects.create(tenant=self.tenant, asn=65001),
            vrf=VRF.objects.create(tenant=self.tenant, name="red", owning_site=self.site_a))
        BGPSession.objects.create(tenant=self.tenant, instance=bgp, remote_address="10.0.0.2",
                                  remote_asn=65002).tags.add(self.a_tag)
        msgs = self.messages(self.move(dry_run=True))
        self.assertIn("srv1 OSPF 1: tag a-only is local to SiteA.", msgs)
        self.assertIn("pdu1 BGP AS65001: VRF red is local to SiteA.", msgs)
        self.assertIn("pdu1 BGP session 10.0.0.2: tag a-only is local to SiteA.", msgs)

    def test_a_value_of_a_local_custom_field_on_a_routing_row_blocks(self):
        CustomField.objects.create(tenant=self.tenant, key="owner", label="Owner",
                                   applies_to=["staticroute"], owning_site=self.site_a)
        StaticRoute.objects.create(tenant=self.tenant, device=self.srv, prefix="0.0.0.0/0",
                                   next_hop="10.0.0.1", custom_fields={"owner": "x"})
        self.assertEqual(
            self.messages(self.move(dry_run=True)),
            ["srv1 static route 0.0.0.0/0: custom field Owner is local to SiteA."])

    def test_routing_rows_are_ignored_with_separation_off(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = False
        dep.save()
        StaticRoute.objects.create(
            tenant=self.tenant, device=self.srv, prefix="10.9.0.0/16", next_hop="10.0.0.1",
            vrf=VRF.objects.create(tenant=self.tenant, name="red", owning_site=self.site_a))
        InventoryItem.objects.create(device=self.srv, name="psu0",
                                     manufacturer=self.maker(owner=self.site_a))
        self.assertEqual(self.codes(self.move(dry_run=True)), [])

    def test_every_catalog_reference_of_a_moving_row_is_checked(self):
        """A new local catalog, or a new foreign key to one on a row that
        moves, must not go unchecked: every such key is one the plan reads."""
        from django.apps import apps

        from auth_api.site_paths import CATALOG_SITE_PATHS

        local = {m for m in apps.get_models()
                 if CATALOG_SITE_PATHS.get(m._meta.model_name) == "owning_site"}
        p = rack_move.Plan(rack=self.rack, site=self.site_b, location=None,
                           devices=[self.srv])
        subjects = rack_move._subjects(p)
        checked = {(s.model, f) for s in subjects for f, _cat in s.fks}
        for model in {s.model for s in subjects}:
            for f in model._meta.get_fields():
                if f.many_to_one and f.concrete and f.related_model in local:
                    self.assertIn((model, f.name), checked, f"{model.__name__}.{f.name}")

    def test_every_row_that_follows_a_device_to_its_site_is_checked(self):
        """Whatever takes its site from a moving device moves with it, so
        every such type that carries tags, custom fields or a local catalog
        is a subject of the check."""
        from django.apps import apps

        from auth_api.site_paths import SITE_PATHS

        local_fk = {m for m in apps.get_models() if hasattr(m, "owning_site")}
        p = rack_move.Plan(rack=self.rack, site=self.site_b, location=None,
                           devices=[self.srv])
        subjects = {s.model for s in rack_move._subjects(p)}
        for model in apps.get_models():
            path = SITE_PATHS.get(model._meta.model_name, "")
            if not any(a.endswith("device__site") for a in path.split("|")):
                continue
            names = {f.name for f in model._meta.get_fields()}
            refs = ("tags" in names or "custom_fields" in names
                    or any(getattr(f, "related_model", None) in local_fk
                           for f in model._meta.get_fields() if f.many_to_one))
            if refs:
                self.assertIn(model, subjects, model.__name__)

    def test_the_query_count_does_not_grow_with_routing_rows(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                rack_move.plan(self.rack, self.site_b, None,
                               user=self.admin, tenant=self.tenant)
            return len(ctx.captured_queries)

        red = VRF.objects.create(tenant=self.tenant, name="red", owning_site=self.site_a)
        StaticRoute.objects.create(tenant=self.tenant, device=self.srv, prefix="10.0.0.0/8",
                                   next_hop="10.0.0.1", vrf=red)
        InventoryItem.objects.create(device=self.srv, name="i", manufacturer=self.maker(
            owner=self.site_a))
        one = count()
        for i in range(10):
            StaticRoute.objects.create(tenant=self.tenant, device=self.pdu,
                                       prefix=f"10.{i}.0.0/16", next_hop="10.0.0.1", vrf=red)
            InventoryItem.objects.create(device=self.srv, name=f"i{i}",
                                         manufacturer=self.maker(f"M{i}", self.site_a))
        self.assertEqual(count(), one)
