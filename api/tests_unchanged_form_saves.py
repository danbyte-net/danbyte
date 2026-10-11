"""Edit forms send every field back (#389). A rule added after a row was
stored is judged again only when a value it depends on changes, so a legacy
row that breaks it still saves from its form - and a change to the part the
rule is about is still refused.

Each case stores a violating row directly (as an older release left it), then
PATCHes it with the full form body: once unchanged, once changing the field
the rule depends on."""
from __future__ import annotations

from decimal import Decimal

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .models import (
    RIR,
    VLAN,
    VRF,
    Aggregate,
    Cabinet,
    Cable,
    CableTermination,
    Device,
    DeviceType,
    DinRail,
    Interface,
    IPAddress,
    IPRange,
    Location,
    PowerOutlet,
    PowerPanel,
    Prefix,
    Rack,
    Site,
    VLANGroup,
)
from .test_utils import status_for


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        self.active = status_for(self.tenant)
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")

    def patch(self, path, body):
        return self.client.patch(path, body, format="json")


class IPRangeFormTests(_Base):
    def setUp(self):
        super().setUp()
        self.vrf = VRF.objects.create(tenant=self.tenant, name="V")
        self.p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24",
                                       vrf=self.vrf, status=self.active)
        IPRange.objects.create(tenant=self.tenant, prefix=self.p, vrf=self.vrf,
                               start_address="10.0.0.10", end_address="10.0.0.20")
        self.b = IPRange.objects.create(tenant=self.tenant, prefix=self.p, vrf=self.vrf,
                                        start_address="10.0.0.15", end_address="10.0.0.30")

    def form(self, **over):
        return {"start_address": "10.0.0.15", "end_address": "10.0.0.30",
                "prefix_id": str(self.p.id), "vrf_id": str(self.vrf.id),
                "status_id": str(self.active.id), "role_id": None,
                "description": "typo fixed", "tag_ids": [], **over}

    def test_unchanged_overlapping_range_saves(self):
        r = self.patch(f"/api/ip-ranges/{self.b.id}/", self.form())
        self.assertEqual(r.status_code, 200, r.content)
        self.b.refresh_from_db()
        self.assertEqual(self.b.description, "typo fixed")

    def test_changing_the_span_is_still_judged(self):
        r = self.patch(f"/api/ip-ranges/{self.b.id}/", self.form(end_address="10.0.0.31"))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("overlaps", str(r.json()))

    def test_range_stranded_outside_its_prefix_saves(self):
        out = IPRange.objects.create(tenant=self.tenant, prefix=self.p, vrf=self.vrf,
                                     start_address="10.0.1.10", end_address="10.0.1.20")
        r = self.patch(f"/api/ip-ranges/{out.id}/", self.form(
            start_address="10.0.1.10", end_address="10.0.1.20"))
        self.assertEqual(r.status_code, 200, r.content)

    def test_ipv6_in_another_spelling_is_unchanged(self):
        p6 = Prefix.objects.create(tenant=self.tenant, cidr="2001:db8::/64",
                                   vrf=self.vrf, status=self.active)
        IPRange.objects.create(tenant=self.tenant, prefix=p6, vrf=self.vrf,
                               start_address="2001:db8::10", end_address="2001:db8::20")
        b6 = IPRange.objects.create(tenant=self.tenant, prefix=p6, vrf=self.vrf,
                                    start_address="2001:db8::15", end_address="2001:db8::30")
        r = self.patch(f"/api/ip-ranges/{b6.id}/", self.form(
            start_address="2001:DB8:0::15", end_address="2001:0db8::30",
            prefix_id=str(p6.id)))
        self.assertEqual(r.status_code, 200, r.content)


class VLANGroupFormTests(_Base):
    def setUp(self):
        super().setUp()
        self.group = VLANGroup.objects.create(tenant=self.tenant, name="G2", slug="g",
                                              min_vid=1, max_vid=4094)
        self.vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=250, name="v",
                                        group=self.group)
        VLANGroup.objects.filter(pk=self.group.pk).update(min_vid=100, max_vid=199)

    def form(self, **over):
        return {"name": "G2", "slug": "g", "min_vid": 100, "max_vid": 199,
                "site_id": None, "cluster_id": None, "description": "x", **over}

    def test_unchanged_group_saves(self):
        r = self.patch(f"/api/vlan-groups/{self.group.id}/", self.form())
        self.assertEqual(r.status_code, 200, r.content)

    def test_changing_the_bounds_is_still_judged(self):
        VLAN.objects.create(tenant=self.tenant, vlan_id=150, name="w", group=self.group)
        r = self.patch(f"/api/vlan-groups/{self.group.id}/", self.form(max_vid=140))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("VLAN 150 outside", str(r.json()))
        # A VLAN already outside the old bounds is not what the change strands.
        r = self.patch(f"/api/vlan-groups/{self.group.id}/", self.form(max_vid=200))
        self.assertEqual(r.status_code, 200, r.content)

    def test_stranded_vlan_saves_from_its_form(self):
        r = self.patch(f"/api/vlans/{self.vlan.id}/", {
            "vlan_id": 250, "name": "v", "group_id": str(self.group.id),
            "site_id": None, "description": "x",
        })
        self.assertEqual(r.status_code, 200, r.content)

    def test_stranded_vlan_moving_to_another_vid_outside_is_refused(self):
        r = self.patch(f"/api/vlans/{self.vlan.id}/", {
            "vlan_id": 251, "name": "v", "group_id": str(self.group.id),
        })
        self.assertEqual(r.status_code, 400, r.content)


class CableFormTests(_Base):
    def setUp(self):
        super().setUp()
        dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        sw = Device.objects.create(tenant=self.tenant, name="sw1", device_type=dt,
                                   site=self.site)
        pdu = Device.objects.create(tenant=self.tenant, name="pdu1", device_type=dt,
                                    site=self.site)
        self.gi1 = Interface.objects.create(device=sw, name="Gi1")
        self.gi2 = Interface.objects.create(device=sw, name="Gi2")
        self.out1 = PowerOutlet.objects.create(device=pdu, name="Out1")
        self.out2 = PowerOutlet.objects.create(device=pdu, name="Out2")
        self.cable = Cable.objects.create(tenant=self.tenant, type="cat6")
        CableTermination.objects.create(cable=self.cable, end="A", interface=self.gi1)
        CableTermination.objects.create(cable=self.cable, end="A", interface=self.gi2)
        CableTermination.objects.create(cable=self.cable, end="B", power_outlet=self.out1)

    def ends(self, a, b):
        return {"a": [{"kind": k, "id": str(o.id)} for k, o in a],
                "b": [{"kind": k, "id": str(o.id)} for k, o in b]}

    def test_unchanged_incompatible_ends_save(self):
        r = self.patch(f"/api/cables/{self.cable.id}/", {
            "label": "check", "type": "cat6",
            **self.ends([("interface", self.gi2), ("interface", self.gi1)],
                        [("power_outlet", self.out1)]),
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["label"], "check")
        self.assertEqual(len(r.json()["a_terminations"]), 2)

    def test_changing_an_end_is_still_judged(self):
        r = self.patch(f"/api/cables/{self.cable.id}/", {
            "label": "check",
            **self.ends([("interface", self.gi1), ("interface", self.gi2)],
                        [("power_outlet", self.out2)]),
        })
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("can't be cabled", str(r.json()))


class AggregateFormTests(_Base):
    def setUp(self):
        super().setUp()
        self.rir = RIR.objects.create(tenant=self.tenant, name="R", slug="r")
        # Two spellings of one block, as migration 0204 leaves them.
        self.a = Aggregate.objects.create(tenant=self.tenant, rir=self.rir,
                                          prefix="2001:db8::/32")
        self.b = Aggregate.objects.create(tenant=self.tenant, rir=self.rir,
                                          prefix="2001:DB8::/32")

    def form(self, prefix, **over):
        return {"prefix": prefix, "rir_id": str(self.rir.id), "date_added": None,
                "description": "merge me", "tag_ids": [], **over}

    def test_unchanged_legacy_spelling_saves(self):
        r = self.patch(f"/api/aggregates/{self.b.id}/", self.form("2001:DB8::/32"))
        self.assertEqual(r.status_code, 200, r.content)
        self.b.refresh_from_db()
        self.assertEqual(self.b.prefix, "2001:DB8::/32")
        self.assertEqual(self.b.description, "merge me")

    def test_canonical_twin_saves(self):
        r = self.patch(f"/api/aggregates/{self.a.id}/", self.form("2001:db8::/32"))
        self.assertEqual(r.status_code, 200, r.content)

    def test_another_spelling_of_its_own_block_keeps_the_stored_one(self):
        # The canonical form is the twin's; the row keeps its own spelling.
        r = self.patch(f"/api/aggregates/{self.b.id}/", self.form("2001:0DB8::/32"))
        self.assertEqual(r.status_code, 200, r.content)
        self.b.refresh_from_db()
        self.assertEqual(self.b.prefix, "2001:DB8::/32")

    def test_moving_onto_another_block_is_still_judged(self):
        Aggregate.objects.create(tenant=self.tenant, rir=self.rir, prefix="10.0.0.0/8")
        r = self.patch(f"/api/aggregates/{self.b.id}/", self.form("10.1.2.3/8"))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("already exists", str(r.json()["prefix"]))


class IPAddressFormTests(_Base):
    def setUp(self):
        super().setUp()
        self.p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24",
                                       status=self.active)

    def stranded(self, addr):
        ip = IPAddress.objects.create(tenant=self.tenant, prefix=self.p,
                                      ip_address="10.0.0.5", status=self.active)
        IPAddress.objects.filter(pk=ip.pk).update(ip_address=addr)
        return ip

    def form(self, addr, **over):
        return {"ip_address": addr, "prefix_id": str(self.p.id),
                "status_id": str(self.active.id), "description": "x", **over}

    def test_stranded_address_saves_from_its_form(self):
        ip = self.stranded("10.9.9.9")
        r = self.patch(f"/api/ips/{ip.id}/", self.form("10.9.9.9"))
        self.assertEqual(r.status_code, 200, r.content)

    def test_moving_a_stranded_address_is_still_judged(self):
        ip = self.stranded("10.9.9.9")
        r = self.patch(f"/api/ips/{ip.id}/", self.form("10.9.9.10"))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("not inside the prefix", str(r.json()))

    def test_address_outside_the_ranges_saves_from_its_form(self):
        ip = IPAddress.objects.create(tenant=self.tenant, prefix=self.p,
                                      ip_address="10.0.0.5", status=self.active)
        IPRange.objects.create(tenant=self.tenant, prefix=self.p,
                               start_address="10.0.0.100", end_address="10.0.0.200")
        Prefix.objects.filter(pk=self.p.pk).update(allocate_from_ranges=True)
        r = self.patch(f"/api/ips/{ip.id}/", self.form("10.0.0.5"))
        self.assertEqual(r.status_code, 200, r.content)
        r = self.patch(f"/api/ips/{ip.id}/", self.form("10.0.0.6"))
        self.assertEqual(r.status_code, 400, r.content)


class DeviceFormTests(_Base):
    def setUp(self):
        super().setUp()
        self.rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1",
                                        u_height=10)
        self.full = DeviceType.objects.create(tenant=self.tenant, name="fd", u_height=1,
                                              is_full_depth=True)

    def form(self, dev, **over):
        return {"name": dev.name, "device_type_id": str(dev.device_type_id),
                "site_id": str(dev.site_id), "location_id": None,
                "rack_id": str(dev.rack_id) if dev.rack_id else None,
                "position": dev.position, "face": dev.face, "rack_side": dev.rack_side,
                "status_id": str(self.active.id), "description": "x", **over}

    def test_stacked_full_depth_devices_save_from_their_form(self):
        Device.objects.create(tenant=self.tenant, name="a", device_type=self.full,
                              site=self.site, rack=self.rack, position=5, face="front")
        b = Device.objects.create(tenant=self.tenant, name="b", device_type=self.full,
                                  site=self.site, rack=self.rack, position=5, face="rear")
        r = self.patch(f"/api/devices/{b.id}/", self.form(b))
        self.assertEqual(r.status_code, 200, r.content)
        r = self.patch(f"/api/devices/{b.id}/", self.form(b, position=4))
        self.assertEqual(r.status_code, 200, r.content)
        r = self.patch(f"/api/devices/{b.id}/", self.form(b, position=5))
        self.assertEqual(r.status_code, 400, r.content)

    def test_device_past_the_top_of_its_rack_saves_from_its_form(self):
        tall = DeviceType.objects.create(tenant=self.tenant, name="4u", u_height=4)
        d = Device.objects.create(tenant=self.tenant, name="t", device_type=tall,
                                  site=self.site, rack=self.rack, position=9, face="front")
        r = self.patch(f"/api/devices/{d.id}/", self.form(d))
        self.assertEqual(r.status_code, 200, r.content)

    def test_overlapping_din_devices_save_from_their_form(self):
        cab = Cabinet.objects.create(tenant=self.tenant, site=self.site, name="K1",
                                     inner_width_mm=500, inner_height_mm=600)
        rail = DinRail.objects.create(cabinet=cab, label="R1", profile="ts35",
                                      x_mm=0, y_mm=100, length_mm=400)
        relay = DeviceType.objects.create(tenant=self.tenant, name="Relay", width_mm=18,
                                          height_mm=80, din_profiles=["ts35", "ts15"])
        Device.objects.create(tenant=self.tenant, name="r1", device_type=relay,
                              site=self.site, cabinet=cab, din_rail=rail,
                              din_offset_mm=Decimal("0"))
        d = Device.objects.create(tenant=self.tenant, name="r2", device_type=relay,
                                  site=self.site, cabinet=cab, din_rail=rail,
                                  din_offset_mm=Decimal("10"))
        body = {"name": "r2", "device_type_id": str(relay.id), "site_id": str(self.site.id),
                "cabinet_id": str(cab.id), "din_rail_id": str(rail.id),
                "din_offset_mm": 10, "rack_id": None, "position": None,
                "description": "x"}
        r = self.patch(f"/api/devices/{d.id}/", body)
        self.assertEqual(r.status_code, 200, r.content)
        r = self.patch(f"/api/devices/{d.id}/", {**body, "din_offset_mm": 12})
        self.assertEqual(r.status_code, 400, r.content)
        # The type's form: unchanged width and profiles, sent in another order.
        r = self.patch(f"/api/device-types/{relay.id}/", {
            "name": "Relay", "width_mm": 18, "height_mm": 80,
            "din_profiles": ["ts15", "ts35"], "description": "x",
        })
        self.assertEqual(r.status_code, 200, r.content)
        r = self.patch(f"/api/device-types/{relay.id}/", {"width_mm": 19})
        self.assertEqual(r.status_code, 400, r.content)


class PowerPanelFormTests(_Base):
    def test_panel_whose_location_moved_site_saves_from_its_form(self):
        other = Site.objects.create(tenant=self.tenant, name="dc2")
        loc = Location.objects.create(tenant=self.tenant, site=self.site, name="Hall", slug="hall")
        panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site,
                                          location=loc, name="P1")
        Location.objects.filter(pk=loc.pk).update(site=other)
        body = {"name": "P1", "site_id": str(self.site.id), "location_id": str(loc.id),
                "comments": "x"}
        r = self.patch(f"/api/power-panels/{panel.id}/", body)
        self.assertEqual(r.status_code, 200, r.content)
        hall2 = Location.objects.create(tenant=self.tenant, site=other, name="Hall 2", slug="hall-2")
        r = self.patch(f"/api/power-panels/{panel.id}/", {**body,
                                                          "location_id": str(hall2.id)})
        self.assertEqual(r.status_code, 400, r.content)
