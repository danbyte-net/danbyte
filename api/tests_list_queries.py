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
        from .models import Rack, Region

        region = Region.objects.create(tenant=self.tenant, name="Nordics")
        site = Site.objects.create(tenant=self.tenant, name="HQ", region=region)
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
        self.assertEqual(row["site"]["region"]["name"], "Nordics")
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
            Region,
            VirtualMachineGroup,
        )

        region = Region.objects.create(tenant=self.tenant, name="Nordics")
        site = Site.objects.create(tenant=self.tenant, name="HQ", region=region)

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
                group=groups[i % 5], site=site if i % 2 else None,
            )

    def test_page_cost_is_flat_with_groups_on_every_row(self):
        self._seed()
        small, _ = self._queries("/api/virtual-machines/?page_size=5")
        big, body = self._queries("/api/virtual-machines/?page_size=20")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["name"]: r for r in body["results"]}
        self.assertEqual(rows["vm-03"]["group"]["name"], "vapp-3")
        self.assertEqual(rows["vm-07"]["group"]["name"], "vapp-2")
        self.assertEqual(rows["vm-07"]["site"]["region"]["name"], "Nordics")
        self.assertIsNone(rows["vm-08"]["site"])


class DeviceListTests(_Base):
    """The device list's counts are correlated subqueries, and the active
    tenant is resolved once per request - not once per row's permissions."""

    def _seed(self):
        from .models import DeviceRole, ExportTemplate, Interface, Platform, Region

        region = Region.objects.create(tenant=self.tenant, name="Nordics")
        site = Site.objects.create(tenant=self.tenant, name="HQ", region=region)
        # Templates bound at all three levels the row resolves through.
        tpl = {
            k: ExportTemplate.objects.create(
                tenant=self.tenant, name=f"{k}-tpl", object_type="api.device",
                template_code="x" * 2000,
            )
            for k in ("own", "role", "platform")
        }
        role = DeviceRole.objects.create(
            tenant=self.tenant, name="Access", slug="access", config_template=tpl["role"]
        )
        platform = Platform.objects.create(
            tenant=self.tenant, name="EOS", slug="eos", config_template=tpl["platform"]
        )
        for i in range(20):
            d = Device.objects.create(
                tenant=self.tenant, name=f"sw-{i:02d}", site=site,
                role=role if i % 3 == 1 else None,
                platform=platform if i % 3 == 2 else None,
                config_template=tpl["own"] if i % 3 == 0 else None,
            )
            for k in range(i % 4):
                Interface.objects.create(device=d, name=f"eth{k}")
            if i % 2:
                p = Prefix.objects.create(tenant=self.tenant, cidr=f"10.{i}.0.0/24")
                ips = [
                    IPAddress.objects.create(
                        tenant=self.tenant, ip_address=f"10.{i}.0.{h}", prefix=p,
                        assigned_device=d,
                    )
                    for h in (1, 2, 3)
                ]
                d.primary_ip, d.secondary_ip, d.oob_ip = ips
                d.save()

    def test_page_cost_is_flat_and_counts_match(self):
        self._seed()
        small, _ = self._queries("/api/devices/?page_size=5")
        big, body = self._queries("/api/devices/?page_size=20")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["name"]: r for r in body["results"]}
        self.assertEqual(rows["sw-03"]["interface_count"], 3)
        self.assertEqual(rows["sw-03"]["ip_count"], 3)
        self.assertEqual(rows["sw-03"]["site"]["region"]["name"], "Nordics")
        self.assertEqual(rows["sw-03"]["secondary_ip"]["ip_address"], "10.3.0.2")
        self.assertEqual(rows["sw-03"]["oob_ip"]["ip_address"], "10.3.0.3")
        resolved = {
            name: rows[name]["config_template"]["resolved"]["name"]
            for name in ("sw-03", "sw-04", "sw-05")
        }
        self.assertEqual(
            resolved, {"sw-03": "own-tpl", "sw-04": "role-tpl", "sw-05": "platform-tpl"}
        )
        # The template bodies stay in the database.
        with CaptureQueriesContext(connection) as ctx:
            self.client.get("/api/devices/?page_size=20")
        self.assertFalse(
            any("template_code" in q["sql"] for q in ctx.captured_queries)
        )
        self.assertEqual(rows["sw-04"]["interface_count"], 0)
        self.assertEqual(rows["sw-04"]["ip_count"], 0)

    def test_cabinet_and_rail_are_prefetched_not_joined(self):
        """Joined, the DIN cabinet and rail brought the list query back to 14
        LEFT JOINs and Postgres spent most of the request planning it (#288)."""
        from .models import Cabinet, DinRail

        site = Site.objects.create(tenant=self.tenant, name="HQ")
        cab = Cabinet.objects.create(
            tenant=self.tenant, site=site, name="K1", inner_width_mm=600, inner_height_mm=800
        )
        rail = DinRail.objects.create(cabinet=cab, label="R1", x_mm=10, y_mm=100, length_mm=500)
        for i in range(12):
            mounted = i % 3 == 0
            Device.objects.create(
                tenant=self.tenant, name=f"d-{i:02d}", site=site,
                cabinet=cab if mounted else None, din_rail=rail if mounted else None,
                din_offset_mm=10 * i if mounted else None,
            )
        small, _ = self._queries("/api/devices/?page_size=4")
        big, body = self._queries("/api/devices/?page_size=12")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["name"]: r for r in body["results"]}
        self.assertEqual(rows["d-03"]["cabinet"], {"id": str(cab.id), "name": "K1"})
        self.assertEqual(
            rows["d-03"]["din_rail"], {"id": str(rail.id), "label": "R1", "profile": "ts35"}
        )
        self.assertIsNone(rows["d-04"]["cabinet"])
        self.assertIsNone(rows["d-04"]["din_rail"])
        with CaptureQueriesContext(connection) as ctx:
            self.client.get("/api/devices/?page_size=12")
        page = [
            q["sql"] for q in ctx.captured_queries
            if q["sql"].startswith('SELECT "api_device"') and " LIMIT " in q["sql"]
        ]
        self.assertEqual(len(page), 1)
        self.assertNotIn('JOIN "api_cabinet"', page[0])
        self.assertNotIn('JOIN "api_dinrail"', page[0])

    def test_a_site_scoped_user_pays_one_permission_query_per_page(self):
        """A site-scoped grant always yields a Q, so the per-row lookup was
        the normal case for exactly those users: 2 queries per row (#218)."""
        from auth_api.models import ObjectPermission, UserProfile

        hq = Site.objects.create(tenant=self.tenant, name="HQ")
        branch = Site.objects.create(tenant=self.tenant, name="Branch")
        for i in range(12):
            Device.objects.create(
                tenant=self.tenant, name=f"d-{i:02d}",
                site=hq if i % 2 else branch,
            )
        user = User.objects.create_user("scoped", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        view = ObjectPermission.objects.create(
            name="see", object_types=["device"], actions=["view"]
        )
        view.users.add(user)
        edit = ObjectPermission.objects.create(
            name="edit-hq", object_types=["device"], actions=["change", "delete"]
        )
        edit.users.add(user)
        edit.sites.set([hq])
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        small, _ = self._queries("/api/devices/?page_size=4")
        big, body = self._queries("/api/devices/?page_size=12")

        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {r["name"]: r["permissions"] for r in body["results"]}
        self.assertEqual(len(rows), 12)
        for name, perms in rows.items():
            at_hq = int(name[2:]) % 2 == 1
            self.assertEqual(perms["change"], at_hq, name)
            self.assertEqual(perms["delete"], at_hq, name)
        # The detail view agrees with the list.
        one = Device.objects.get(name="d-01")
        detail = self.client.get(f"/api/devices/{one.id}/").json()
        self.assertTrue(detail["permissions"]["change"])
        other = Device.objects.get(name="d-02")
        detail = self.client.get(f"/api/devices/{other.id}/").json()
        self.assertFalse(detail["permissions"]["change"])

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


class InterfaceListTests(_Base):
    """A port's parent, LAG and bridge come with the page, not joined to every
    interface in the tenant before the page is taken (#298)."""

    def test_page_cost_is_flat_and_relations_are_prefetched(self):
        from .models import Interface

        site = Site.objects.create(tenant=self.tenant, name="HQ")
        for i in range(6):
            d = Device.objects.create(tenant=self.tenant, name=f"sw-{i}", site=site)
            ports = [Interface.objects.create(device=d, name=f"eth{k}") for k in range(4)]
            ae = Interface.objects.create(
                device=d, name="ae0", type="lag", lag_protocol="lacp", lacp_mode="active"
            )
            br = Interface.objects.create(device=d, name="br0", type="bridge")
            ports[0].lag = ae
            ports[1].bridge = br
            ports[3].parent = ports[2]
            for p in (ports[0], ports[1], ports[3]):
                p.save()
        # The first page is sw-0's six ports, so it already uses all three.
        small, _ = self._queries("/api/interfaces/?page_size=6")
        big, body = self._queries("/api/interfaces/?page_size=36")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        rows = {(r["device"]["name"], r["name"]): r for r in body["results"]}
        sw3 = Device.objects.get(name="sw-3")
        ae = Interface.objects.get(device=sw3, name="ae0")
        self.assertEqual(rows[("sw-3", "eth0")]["lag"], {
            "id": str(ae.id), "name": "ae0",
            "device": {"id": str(sw3.id), "name": "sw-3"},
            "lag_protocol": "lacp", "lacp_mode": "active",
        })
        self.assertEqual(rows[("sw-3", "eth1")]["bridge"]["name"], "br0")
        self.assertEqual(rows[("sw-3", "eth3")]["parent"]["name"], "eth2")
        self.assertEqual(rows[("sw-3", "eth3")]["parent"]["device"]["name"], "sw-3")
        self.assertIsNone(rows[("sw-3", "eth2")]["parent"])
        self.assertIsNone(rows[("sw-3", "eth2")]["lag"])
        self.assertEqual(rows[("sw-3", "ae0")]["lag_member_count"], 1)
        with CaptureQueriesContext(connection) as ctx:
            self.client.get("/api/interfaces/?page_size=36")
        page = [
            q["sql"] for q in ctx.captured_queries
            if q["sql"].startswith('SELECT "api_interface"') and " LIMIT " in q["sql"]
        ]
        self.assertEqual(len(page), 1)
        self.assertNotIn('JOIN "api_interface"', page[0])


class CircuitListTests(_Base):
    def test_page_cost_is_flat(self):
        from .models import Circuit, CircuitType, Provider, Status

        prov = Provider.objects.create(tenant=self.tenant, name="Prov", slug="prov")
        ctype = CircuitType.objects.create(tenant=self.tenant, name="Fibre", slug="fibre")
        status = Status.objects.create(tenant=self.tenant, name="Live", slug="live")
        for i in range(30):
            Circuit.objects.create(
                tenant=self.tenant, cid=f"C-{i:02}", provider=prov, type=ctype, status=status
            )
        small, _ = self._queries("/api/circuits/?page_size=5")
        big, body = self._queries("/api/circuits/?page_size=30")
        self.assertEqual(small, big, "a bigger page must not cost more queries (#341)")
        self.assertEqual(body["results"][0]["status"]["name"], "Live")


class MacListTests(_Base):
    def test_page_cost_is_flat_and_vendors_match(self):
        from .models import MACAddress, OuiPrefix
        from .oui import vendor_of_object

        OuiPrefix.objects.create(prefix="001b44", vendor="SanDisk", source="ieee")
        OuiPrefix.objects.create(tenant=self.tenant, prefix="0200aa", vendor="Lab", source="custom")
        for i in range(30):
            MACAddress.objects.create(
                tenant=self.tenant,
                mac_address=f"{('00:1b:44', '02:00:aa', '0c:00:00')[i % 3]}:00:00:{i:02x}",
                vendor_override="Hand-built" if i == 7 else "",
            )
        small, _ = self._queries("/api/mac-addresses/?page_size=5")
        big, body = self._queries("/api/mac-addresses/?page_size=30")
        self.assertEqual(small, big, "a bigger page must not cost more queries (#340)")
        for row in body["results"]:
            obj = MACAddress.objects.get(pk=row["id"])
            self.assertEqual(row["vendor"], vendor_of_object(obj), row["mac_address"])
        names = {(r["vendor"] or {}).get("name") for r in body["results"]}
        self.assertEqual(names, {"SanDisk", "Lab", "Hand-built", None})
