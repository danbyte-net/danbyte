"""Bulk update validates each value as the edit form's PATCH does (#350):
an invalid choice, an over-long text or an out-of-range number is a 400 with
a field error, and nothing in the request is written."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant

from .models import (
    VLAN,
    ConsoleServerPort,
    Device,
    DeviceType,
    Interface,
    InterfaceTemplate,
    InventoryItem,
    IPAddress,
    Location,
    Prefix,
    RearPort,
    Region,
    Site,
    Status,
    VirtualChassis,
)

User = get_user_model()

LONG = "x" * 300
HUGE = 10 ** 12


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ", location="old")
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="SW")
        self.dev = Device.objects.create(tenant=self.tenant, name="sw1", device_type=self.dt)
        self.if1 = Interface.objects.create(device=self.dev, name="eth0", description="d")
        self.if2 = Interface.objects.create(device=self.dev, name="eth1", description="d")
        self.client.force_login(User.objects.create_superuser("admin", "a@example.com", "x"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def bulk(self, path, ids, fields):
        return self.client.post(f"/api/{path}/bulk-update/", {
            "ids": [str(i) for i in ids], "fields": fields}, format="json")

    def assert_refused(self, r, field):
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn(field, r.json())


class SiteTests(_Base):
    def test_invalid_choice_is_refused_and_not_stored(self):
        r = self.bulk("sites", [self.site.id], {"gateway_policy": "bogus"})
        self.assert_refused(r, "gateway_policy")
        self.site.refresh_from_db()
        self.assertNotEqual(self.site.gateway_policy, "bogus")

    def test_patch_refuses_the_same_choice(self):
        r = self.client.patch(
            f"/api/sites/{self.site.id}/", {"gateway_policy": "bogus"}, format="json")
        self.assert_refused(r, "gateway_policy")

    def test_over_long_location_is_a_400_not_a_500(self):
        r = self.bulk("sites", [self.site.id], {"location": LONG})
        self.assert_refused(r, "location")
        self.site.refresh_from_db()
        self.assertEqual(self.site.location, "old")

    def test_one_bad_field_writes_nothing(self):
        r = self.bulk("sites", [self.site.id], {"location": "new", "gateway_policy": "bogus"})
        self.assertEqual(r.status_code, 400, r.content)
        self.site.refresh_from_db()
        self.assertEqual(self.site.location, "old")
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_id=str(self.site.id), action="update").exists())

    def test_valid_values_still_write_and_log(self):
        r = self.bulk("sites", [self.site.id], {"location": "  Room 4  "})
        self.assertEqual(r.status_code, 200, r.content)
        self.site.refresh_from_db()
        # Trimmed, as a PATCH stores it.
        self.assertEqual(self.site.location, "Room 4")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(self.site.id), action="update").exists())


class InterfaceTests(_Base):
    def test_out_of_range_mtu_is_a_400(self):
        r = self.bulk("interfaces", [self.if1.id, self.if2.id], {"mtu": HUGE})
        self.assert_refused(r, "mtu")
        self.assertEqual(
            set(Interface.objects.filter(device=self.dev).values_list("mtu", flat=True)), {None})

    def test_patch_refuses_the_same_values(self):
        r = self.client.patch(
            f"/api/interfaces/{self.if1.id}/", {"mtu": HUGE, "description": LONG}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("mtu", r.json())
        self.assertIn("description", r.json())

    def test_over_long_description_is_a_400(self):
        r = self.bulk("interfaces", [self.if1.id], {"description": LONG})
        self.assert_refused(r, "description")
        self.if1.refresh_from_db()
        self.assertEqual(self.if1.description, "d")

    def test_a_bool_is_not_an_integer(self):
        r = self.bulk("interfaces", [self.if1.id], {"mtu": True})
        self.assert_refused(r, "mtu")

    def test_mixed_valid_and_invalid_writes_nothing(self):
        r = self.bulk("interfaces", [self.if1.id, self.if2.id],
                      {"enabled": False, "description": LONG})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Interface.objects.filter(enabled=False).count(), 0)

    def test_malformed_relation_id_is_a_400(self):
        r = self.bulk("interfaces", [self.if1.id], {"vlan_id": "not-a-uuid"})
        self.assert_refused(r, "vlan_id")

    def test_foreign_tenant_vlan_is_refused(self):
        theirs = VLAN.objects.create(tenant=self.other, vlan_id=99, name="v99")
        r = self.bulk("interfaces", [self.if1.id], {"vlan_id": str(theirs.id)})
        self.assert_refused(r, "vlan_id")
        self.if1.refresh_from_db()
        self.assertIsNone(self.if1.vlan_id)

    def test_row_rule_bundle_settings_need_a_lag(self):
        # The serializer refuses bundle settings on a non-LAG interface; so
        # does a bulk edit, naming the row.
        lag = Interface.objects.create(device=self.dev, name="bond0", type="lag")
        r = self.bulk("interfaces", [lag.id, self.if1.id], {"lag_protocol": "lacp"})
        self.assert_refused(r, "lag_protocol")
        self.assertIn("eth0", str(r.json()["lag_protocol"]))
        lag.refresh_from_db()
        self.assertEqual(lag.lag_protocol or "", "")
        r = self.bulk("interfaces", [lag.id], {"lag_protocol": "lacp"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_valid_bulk_update_is_logged_per_row(self):
        r = self.bulk("interfaces", [self.if1.id, self.if2.id], {"mtu": 9000, "description": "up"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            set(Interface.objects.filter(device=self.dev).values_list("mtu", flat=True)), {9000})
        self.assertEqual(ChangeLogEntry.objects.filter(
            object_id__in=[str(self.if1.id), str(self.if2.id)], action="update").count(), 2)


class ComponentTests(_Base):
    def test_rear_port_positions_out_of_range(self):
        rp = RearPort.objects.create(device=self.dev, name="r1")
        r = self.bulk("rear-ports", [rp.id], {"positions": 40000})
        self.assert_refused(r, "positions")

    def test_console_server_port_speed_out_of_range(self):
        csp = ConsoleServerPort.objects.create(device=self.dev, name="c1")
        r = self.bulk("console-server-ports", [csp.id], {"speed": HUGE})
        self.assert_refused(r, "speed")

    def test_inventory_item_long_serial_and_negative_capacity(self):
        item = InventoryItem.objects.create(device=self.dev, name="psu")
        self.assert_refused(
            self.bulk("inventory-items", [item.id], {"serial_number": LONG}), "serial_number")
        self.assert_refused(
            self.bulk("inventory-items", [item.id], {"capacity_bytes": -1}), "capacity_bytes")

    def test_template_description_too_long(self):
        t = InterfaceTemplate.objects.create(device_type=self.dt, name="eth0")
        r = self.bulk("interface-templates", [t.id], {"description": LONG})
        self.assert_refused(r, "description")


class OtherEndpointTests(_Base):
    def test_prefix_and_ip_malformed_status_is_a_400(self):
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.5", prefix=p)
        self.assert_refused(self.bulk("prefixes", [p.id], {"status_id": "nope"}), "status_id")
        self.assert_refused(self.bulk("ips", [ip.id], {"status_id": "nope"}), "status_id")

    def test_prefix_foreign_status_is_refused(self):
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        theirs = Status.objects.create(tenant=self.other, name="Gone", slug="gone")
        self.assert_refused(
            self.bulk("prefixes", [p.id], {"status_id": str(theirs.id)}), "status_id")

    def test_vlan_malformed_site_is_a_400(self):
        v = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="v10")
        self.assert_refused(self.bulk("vlans", [v.id], {"site_id": "nope"}), "site_id")

    def test_tenant_is_active_reads_like_a_patch(self):
        r = self.bulk("tenants", [self.other.id], {"is_active": "false"})
        self.assertEqual(r.status_code, 200, r.content)
        self.other.refresh_from_db()
        self.assertFalse(self.other.is_active)
        self.assert_refused(self.bulk("tenants", [self.other.id], {"is_active": "maybe"}),
                            "is_active")

    def test_virtual_chassis_domain_too_long(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        self.assert_refused(self.bulk("virtual-chassis", [vc.id], {"domain": LONG}), "domain")

    def test_region_malformed_parent_is_a_400(self):
        reg = Region.objects.create(tenant=self.tenant, name="DK", slug="dk")
        self.assert_refused(self.bulk("regions", [reg.id], {"parent_id": "nope"}), "parent_id")

    def test_location_colour_is_still_checked(self):
        loc = Location.objects.create(tenant=self.tenant, site=self.site, name="Room")
        self.assert_refused(self.bulk("locations", [loc.id], {"color": "red"}), "color")
        r = self.bulk("locations", [loc.id], {"color": "#10b981", "icon": "box"})
        self.assertEqual(r.status_code, 200, r.content)
