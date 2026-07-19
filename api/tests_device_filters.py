"""API filter tests for the reusable DevicePicker's advanced search
(/api/devices/ ?location= / ?region= / ?tag=). See GitHub issue #135.

Region is a plain adjacency-list tree (no MPTT), so ?region= must include
devices in descendant regions' sites — that's the interesting case here.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from .models import Device, Location, Region, Site, VirtualChassis

User = get_user_model()


class DeviceFilterTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        # Region tree: europe → nl → ams  (plus an unrelated us region).
        self.europe = Region.objects.create(
            tenant=self.tenant, name="Europe", slug="europe"
        )
        self.nl = Region.objects.create(
            tenant=self.tenant, name="Netherlands", slug="nl", parent=self.europe
        )
        self.ams = Region.objects.create(
            tenant=self.tenant, name="Amsterdam", slug="ams", parent=self.nl
        )
        self.us = Region.objects.create(
            tenant=self.tenant, name="US", slug="us"
        )

        self.site_ams = Site.objects.create(
            tenant=self.tenant, name="ams-dc1", region=self.ams
        )
        self.site_us = Site.objects.create(
            tenant=self.tenant, name="us-dc1", region=self.us
        )
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site_ams, name="Hall 1", slug="hall-1"
        )

        # d_ams sits deep in europe's subtree (europe → nl → ams → site_ams).
        self.d_ams = Device.objects.create(
            tenant=self.tenant, name="ams-sw1", site=self.site_ams,
            location=self.loc,
        )
        self.d_us = Device.objects.create(
            tenant=self.tenant, name="us-sw1", site=self.site_us,
        )
        self.d_ams.tags.add("prod")
        self.d_us.tags.add("lab")

    def _names(self, query):
        data = self.client.get(f"/api/devices/?{query}").json()
        return {d["name"] for d in data["results"]}

    def test_region_includes_descendants(self):
        # Filtering by the top region must pull in the device three levels down.
        self.assertEqual(self._names("region=%s" % self.europe.id), {"ams-sw1"})
        # The intermediate region works too.
        self.assertEqual(self._names("region=%s" % self.nl.id), {"ams-sw1"})
        # A sibling region excludes it.
        self.assertEqual(self._names("region=%s" % self.us.id), {"us-sw1"})

    def test_location_filter(self):
        self.assertEqual(self._names("location=%s" % self.loc.id), {"ams-sw1"})

    def test_tag_filter(self):
        self.assertEqual(self._names("tag=prod"), {"ams-sw1"})
        self.assertEqual(self._names("tag=lab"), {"us-sw1"})

    def test_unknown_region_matches_nothing(self):
        # A stale/unknown region id must not fall through to "match all".
        import uuid

        self.assertEqual(self._names("region=%s" % uuid.uuid4()), set())

    def test_with_vc_picker_carries_virtual_chassis(self):
        # The DevicePicker ghosts switches already in a stack — the picker
        # response must tell it which those are.
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="core-1")
        self.d_ams.virtual_chassis = vc
        self.d_ams.vc_position = 1
        self.d_ams.save()

        data = self.client.get("/api/devices/?picker=1&with_vc=1").json()
        by_name = {d["name"]: d for d in data["results"]}
        self.assertEqual(by_name["ams-sw1"]["virtual_chassis"]["name"], "core-1")
        self.assertIsNone(by_name["us-sw1"]["virtual_chassis"])
        # The plain picker stays lean — no virtual_chassis field.
        plain = self.client.get("/api/devices/?picker=1").json()
        self.assertNotIn("virtual_chassis", plain["results"][0])

    def test_rack_location_fk_and_filter(self):
        # Racks can live in a location; it must belong to the rack's site.
        resp = self.client.post(
            "/api/racks/",
            {"name": "r1", "site_id": str(self.site_ams.id),
             "location_id": str(self.loc.id), "u_height": 12},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        rack_id = resp.json()["id"]
        self.assertEqual(resp.json()["location"]["name"], "Hall 1")
        # Filter by location.
        data = self.client.get(f"/api/racks/?location={self.loc.id}").json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["results"][0]["id"], rack_id)
        # Cross-site location rejected.
        resp = self.client.post(
            "/api/racks/",
            {"name": "r2", "site_id": str(self.site_us.id),
             "location_id": str(self.loc.id), "u_height": 12},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("within the rack", str(resp.content))

    def test_rack_weight_budget(self):
        from decimal import Decimal
        from .models import DeviceType, Rack

        # 2× 10 lb devices in a 10 kg-budget rack → 9.07 kg used, under.
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="1U-server", model="1U-server",
            weight=Decimal("10"), weight_unit="lb",
        )
        rack = Rack.objects.create(
            tenant=self.tenant, site=self.site_ams, name="r-w",
            max_weight=Decimal("10"), max_weight_unit="kg",
        )
        for i, d in enumerate((self.d_ams, self.d_us)):
            d.device_type = dt
            d.rack = rack
            d.position = 1 + i
            d.save()

        data = self.client.get(f"/api/racks/{rack.id}/").json()
        self.assertEqual(data["total_weight_kg"], 9.07)
        self.assertEqual(data["max_weight_kg"], 10.0)

    def test_embedded_table_filters(self):
        # Filters the inline detail-page tables rely on.
        from .models import (
            Cluster, ClusterType, ClusterGroup, IPAddress, IPRole, Prefix,
            Rack, RackRole, Status,
        )
        role = IPRole.objects.create(tenant=self.tenant, name="loop", slug="loop")
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24",
                                    site=self.site_ams)
        IPAddress.objects.create(tenant=self.tenant, ip_address="10.9.0.5",
                                 prefix=pfx, role=role)
        data = self.client.get(f"/api/ips/?role={role.id}").json()
        self.assertEqual(data["count"], 1)

        rr = RackRole.objects.create(tenant=self.tenant, name="net", slug="net")
        Rack.objects.create(tenant=self.tenant, site=self.site_ams,
                            name="rk", role=rr)
        self.assertEqual(
            self.client.get(f"/api/racks/?role={rr.id}").json()["count"], 1
        )

        ct = ClusterType.objects.create(tenant=self.tenant, name="esx", slug="esx")
        cg = ClusterGroup.objects.create(tenant=self.tenant, name="g", slug="g")
        Cluster.objects.create(tenant=self.tenant, name="c1", type=ct, group=cg)
        self.assertEqual(
            self.client.get(f"/api/clusters/?type={ct.id}").json()["count"], 1
        )
        self.assertEqual(
            self.client.get(f"/api/clusters/?group={cg.id}").json()["count"], 1
        )

    def test_rack_power_rollup(self):
        from .models import PowerFeed, PowerPanel, PowerPort, Rack

        rack = Rack.objects.create(
            tenant=self.tenant, site=self.site_ams, name="r-p"
        )
        panel = PowerPanel.objects.create(
            tenant=self.tenant, site=self.site_ams, name="pp1"
        )
        # Supply: 230 V × 16 A × 80% = 2944 W. A redundant feed adds nothing.
        PowerFeed.objects.create(
            tenant=self.tenant, power_panel=panel, rack=rack, name="feed-a",
            voltage=230, amperage=16, max_utilization=80,
        )
        PowerFeed.objects.create(
            tenant=self.tenant, power_panel=panel, rack=rack, name="feed-b",
            voltage=230, amperage=16, max_utilization=80, type="redundant",
        )
        # Demand: two PSU inlets on a racked device.
        self.d_ams.rack = rack
        self.d_ams.position = 1
        self.d_ams.save()
        PowerPort.objects.create(device=self.d_ams, name="psu1",
                                 maximum_draw=750, allocated_draw=350)
        PowerPort.objects.create(device=self.d_ams, name="psu2",
                                 maximum_draw=750, allocated_draw=350)

        power = self.client.get(f"/api/racks/{rack.id}/").json()["power"]
        self.assertEqual(power["available_w"], 2944)
        self.assertEqual(power["allocated_w"], 700)
        self.assertEqual(power["maximum_w"], 1500)
