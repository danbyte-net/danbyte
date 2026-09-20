"""List pages answer in a fixed number of queries: what a page costs must not
grow with the rows on it (#179, #180, #181). Each test asks for a small page
and a bigger page of the same list and expects the same query count, then
checks the batched figures against the per-object ones."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import RIR, VLAN, Aggregate, Device, IPAddress, Prefix, Site, VirtualMachine

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _queries(self, url) -> tuple[int, dict]:
        # The first request of a test pays one-off lookups (content types,
        # settings rows, the tenant's local engine); count the second.
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()


class PrefixListTests(_Base):
    def setUp(self):
        super().setUp()
        self.agg = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16")
        for i in range(30):
            p = Prefix.objects.create(tenant=self.tenant, cidr=f"10.0.{i}.0/24")
            for h in range(1, 4):
                IPAddress.objects.create(tenant=self.tenant, ip_address=f"10.0.{i}.{h}", prefix=p)

    def test_page_cost_is_flat_and_figures_match(self):
        small, body = self._queries("/api/prefixes/?page_size=5")
        big, body_big = self._queries("/api/prefixes/?page_size=30")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["cidr"]: r for r in body_big["results"]}
        agg = rows["10.0.0.0/16"]
        self.assertEqual(agg["child_count"], 30)
        self.assertTrue(agg["has_descendants"])
        leaf = rows["10.0.1.0/24"]
        self.assertEqual(leaf["child_count"], 0)
        self.assertFalse(leaf["has_descendants"])
        self.assertEqual(leaf["ip_count"], 3)
        self.assertEqual(leaf["utilisation_pct"], Prefix.objects.get(cidr="10.0.1.0/24").utilisation_pct)
        self.assertEqual(leaf["monitoring_engine"]["is_local"], True)


class VlanListTests(_Base):
    def test_page_cost_is_flat_and_counts_match(self):
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        for i in range(1, 31):
            v = VLAN.objects.create(tenant=self.tenant, site=site, vlan_id=i, name=f"v{i}")
            for k in range(i % 3):
                Prefix.objects.create(tenant=self.tenant, cidr=f"10.{i}.{k}.0/24", vlan=v)
        small, _ = self._queries("/api/vlans/?page_size=5")
        big, body = self._queries("/api/vlans/?page_size=30")
        self.assertEqual(small, big)
        counts = {r["vlan_id"]: r["prefix_count"] for r in body["results"]}
        self.assertEqual(counts[2], 2)
        self.assertEqual(counts[3], 0)


class SiteListTests(_Base):
    def test_page_cost_is_flat_and_counts_match(self):
        from .models import Cluster, ClusterType

        ct = ClusterType.objects.create(tenant=self.tenant, name="t", slug="t")
        cl = Cluster.objects.create(tenant=self.tenant, name="c", type=ct)
        for i in range(30):
            s = Site.objects.create(tenant=self.tenant, name=f"site-{i:02d}")
            for k in range(i % 3):
                Prefix.objects.create(tenant=self.tenant, cidr=f"10.{i}.{k}.0/24", site=s)
                VLAN.objects.create(tenant=self.tenant, site=s, vlan_id=k + 1, name=f"v{k}")
                Device.objects.create(tenant=self.tenant, name=f"d-{i}-{k}", site=s)
                VirtualMachine.objects.create(tenant=self.tenant, name=f"vm-{i}-{k}", cluster=cl, site=s)
        small, _ = self._queries("/api/sites/?page_size=5")
        big, body = self._queries("/api/sites/?page_size=30")
        self.assertEqual(small, big)
        rows = {r["name"]: r for r in body["results"]}
        for key in ("prefix_count", "vlan_count", "device_count", "vm_count"):
            self.assertEqual(rows["site-02"][key], 2, key)
            self.assertEqual(rows["site-03"][key], 0, key)
        # The tab counts stay on the site page.
        detail = self.client.get(f"/api/sites/{Site.objects.get(name='site-02').id}/").json()
        self.assertEqual(detail["device_count"], 2)


class AggregateListTests(_Base):
    def test_page_cost_is_flat_and_utilisation_matches(self):
        rir = RIR.objects.create(tenant=self.tenant, name="RIPE", slug="ripe")
        aggs = [
            Aggregate.objects.create(tenant=self.tenant, rir=rir, prefix=f"10.{i}.0.0/16")
            for i in range(30)
        ]
        for i in range(30):
            for k in range(i % 4):
                Prefix.objects.create(tenant=self.tenant, cidr=f"10.{i}.{k}.0/24")
        Prefix.objects.create(tenant=self.tenant, cidr="10.5.0.0/17")  # half of one aggregate
        small, _ = self._queries("/api/aggregates/?page_size=5")
        big, body = self._queries("/api/aggregates/?page_size=30")
        self.assertEqual(small, big)
        rows = {r["prefix"]: r["utilisation_pct"] for r in body["results"]}
        for a in aggs:
            self.assertEqual(rows[a.prefix], a.utilisation_pct, a.prefix)
        self.assertGreaterEqual(rows["10.5.0.0/16"], 50)


class RackListTests(_Base):
    """Every figure on a rack row (devices, units, weight, power, documents)
    comes from the page's prefetches (#188)."""

    def test_page_cost_is_flat_and_figures_match(self):
        from .models import Rack

        site = Site.objects.create(tenant=self.tenant, name="HQ")
        for i in range(6):
            r = Rack.objects.create(tenant=self.tenant, site=site, name=f"r{i}")
            for k in range(8):
                Device.objects.create(
                    tenant=self.tenant, name=f"d-{i}-{k}", site=site, rack=r, position=k + 1
                )
        small, _ = self._queries("/api/racks/?page_size=2")
        big, body = self._queries("/api/racks/?page_size=6")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        row = body["results"][0]
        self.assertEqual(row["device_count"], 8)
        self.assertEqual(row["used_units"], 8)
        self.assertEqual(row["document_count"], 0)
        self.assertEqual(row["power"]["allocated_w"], 0)


class IpListTests(_Base):
    """DHCP state on an address row is a per-row EXISTS, not a grouped join
    over every DHCP table (#187)."""

    def test_no_grouping_and_states_hold(self):
        from integrations.models import DhcpExclusion, DhcpReservation, DhcpScope

        p = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        ips = {
            h: IPAddress.objects.create(tenant=self.tenant, ip_address=f"10.77.0.{h}", prefix=p)
            for h in (5, 50, 60, 200)
        }
        scope = DhcpScope.objects.create(
            tenant=self.tenant, scope_id="10.77.0.0", name="Lab", prefix=p,
            start_range="10.77.0.10", end_range="10.77.0.100",
        )
        DhcpExclusion.objects.create(
            scope=scope, start_address="10.77.0.55", end_address="10.77.0.65"
        )
        DhcpReservation.objects.create(scope=scope, ip="10.77.0.50", ip_address=ips[50])
        self.client.get("/api/ips/")
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get("/api/ips/?page_size=10")
        self.assertEqual(r.status_code, 200, r.content)
        for q in ctx.captured_queries:
            if "api_ipaddress" in q["sql"] and "SELECT" in q["sql"]:
                self.assertNotIn("GROUP BY", q["sql"])
        state = {row["ip_address"]: row["dhcp"] for row in r.json()["results"]}
        self.assertIsNone(state["10.77.0.5"])
        self.assertEqual(state["10.77.0.50"], "leased")
        self.assertEqual(state["10.77.0.60"], "exclusion")
        self.assertEqual(state["10.77.0.200"], None)
        self.assertEqual(
            {k: v for k, v in state.items() if v == "scope"}, {}
        )


class VrfListTests(_Base):
    """The prefix, VLAN and address counts per VRF come with the page (#196)."""

    def test_page_cost_is_flat_and_counts_match(self):
        from .models import VRF

        site = Site.objects.create(tenant=self.tenant, name="HQ")
        for i in range(12):
            v = VRF.objects.create(tenant=self.tenant, name=f"vrf-{i:02d}")
            for k in range(i % 3):
                p = Prefix.objects.create(tenant=self.tenant, cidr=f"10.{i}.{k}.0/24", vrf=v)
                IPAddress.objects.create(tenant=self.tenant, ip_address=f"10.{i}.{k}.1", prefix=p)
            if i % 2:
                VLAN.objects.create(tenant=self.tenant, site=site, vlan_id=i + 1, name=f"v{i}", vrf=v)
        small, _ = self._queries("/api/vrfs/?page_size=2")
        big, body = self._queries("/api/vrfs/?page_size=12")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["name"]: r for r in body["results"]}
        self.assertEqual(rows["vrf-02"]["prefix_count"], 2)
        self.assertEqual(rows["vrf-02"]["ip_count"], 2)
        self.assertEqual(rows["vrf-02"]["vlan_count"], 0)
        self.assertEqual(rows["vrf-03"]["vlan_count"], 1)
        self.assertEqual(rows["vrf-03"]["prefix_count"], 0)


class VirtualMachineListTests(_Base):
    """The VM list serialises cluster, site, host, primary IP, disks and now
    the VM group inline. Every one of those is a chance to fire a query per
    row on a page of a few thousand machines."""

    def _seed(self):
        from .models import (
            Cluster,
            ClusterType,
            VirtualMachineGroup,
        )

        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Cloud Director", slug="cd"
        )
        cluster = Cluster.objects.create(
            tenant=self.tenant, name="VDC", type=ctype
        )
        groups = [
            VirtualMachineGroup.objects.create(
                tenant=self.tenant, cluster=cluster, name=f"vapp-{i}",
                kind="vapp",
            )
            for i in range(5)
        ]
        for i in range(20):
            VirtualMachine.objects.create(
                tenant=self.tenant, name=f"vm-{i:02d}", cluster=cluster,
                group=groups[i % 5],
            )

    def test_page_cost_is_flat_with_groups_on_every_row(self):
        self._seed()
        small, _ = self._queries("/api/virtual-machines/?page_size=5")
        big, body = self._queries("/api/virtual-machines/?page_size=20")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["name"]: r for r in body["results"]}
        self.assertEqual(rows["vm-03"]["group"]["name"], "vapp-3")
        self.assertEqual(rows["vm-07"]["group"]["name"], "vapp-2")


class DeviceListTests(_Base):
    """The device list's counts are correlated subqueries, and the active
    tenant is resolved once per request - not once per row's permissions."""

    def _seed(self):
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        from .models import Interface

        for i in range(20):
            d = Device.objects.create(tenant=self.tenant, name=f"sw-{i:02d}", site=site)
            for k in range(i % 4):
                Interface.objects.create(device=d, name=f"eth{k}")
            if i % 2:
                p = Prefix.objects.create(tenant=self.tenant, cidr=f"10.{i}.0.0/24")
                IPAddress.objects.create(
                    tenant=self.tenant, ip_address=f"10.{i}.0.1", prefix=p, assigned_device=d
                )

    def test_page_cost_is_flat_and_counts_match(self):
        self._seed()
        small, _ = self._queries("/api/devices/?page_size=5")
        big, body = self._queries("/api/devices/?page_size=20")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["name"]: r for r in body["results"]}
        self.assertEqual(rows["sw-03"]["interface_count"], 3)
        self.assertEqual(rows["sw-03"]["ip_count"], 1)
        self.assertEqual(rows["sw-04"]["interface_count"], 0)
        self.assertEqual(rows["sw-04"]["ip_count"], 0)

    def test_a_granted_user_pays_one_tenant_lookup_per_request(self):
        from auth_api.models import ObjectPermission, UserProfile

        self._seed()
        user = User.objects.create_user("reader", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="devices", object_types=["device"], actions=["view", "change"]
        )
        perm.users.add(user)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        # The grant lookups touch the tenant table a fixed few times per
        # request; what must not happen is one more per row.
        lookups = {}
        for size in (5, 20):
            self.client.get(f"/api/devices/?page_size={size}")
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(f"/api/devices/?page_size={size}")
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(len(r.json()["results"]), size)
            lookups[size] = sum(1 for q in ctx.captured_queries if "core_tenant" in q["sql"])
        self.assertEqual(lookups[5], lookups[20])
        self.assertLess(lookups[20], 20)
