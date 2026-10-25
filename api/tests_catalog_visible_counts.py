"""Catalog counts count what the reader may view (#438).

A Site viewer of site A got tenant-wide numbers on platforms, device types,
roles and the other catalogs, while the lists those numbers link to showed
site A only - the count above a tab disagreed with the table under it, and
told the viewer what other sites run. The count is the linked list's count.
"""
from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext

from api.models import (
    VLAN,
    VRF,
    AuxPort,
    Circuit,
    CircuitTermination,
    Cluster,
    ClusterType,
    ConsolePort,
    ConsoleServerPort,
    Contact,
    ContactAssignment,
    ContactRole,
    Device,
    DeviceBay,
    DeviceRole,
    DeviceType,
    FrontPort,
    Interface,
    InventoryItem,
    IPAddress,
    L2VPN,
    Manufacturer,
    ModuleBay,
    Platform,
    PowerFeed,
    PowerOutlet,
    PowerPanel,
    PowerPort,
    Prefix,
    Provider,
    ProviderNetwork,
    Rack,
    RackRole,
    RearPort,
    Region,
    Site,
    VirtualMachine,
    VirtualMachineGroup,
    VMInterface,
)
from api.test_utils import status_for
from api.tests_site_scope_gaps import _TwoSites
from auth_api.api import assemble_site_role
from auth_api.models import ObjectPermission
from core.models import DeploymentSettings, Tag, Tenant, TenantGroup
from customization.models import CustomField, CustomFieldGroup
from routing.models import VTEP, VTEPMembership


class CatalogVisibleCountTests(_TwoSites):
    def setUp(self):
        super().setUp()
        t = self.tenant
        self.status = status_for(t)
        self.region = Region.objects.create(tenant=t, name="EU", slug="eu")
        for site in (self.site_a, self.site_b):
            site.region = self.region
            site.save()
        self.mfr = Manufacturer.objects.create(tenant=t, name="Cisco", slug="cisco")
        self.platform = Platform.objects.create(tenant=t, name="IOS-XE", slug="ios-xe")
        self.dtype = DeviceType.objects.create(tenant=t, name="C9300", manufacturer=self.mfr)
        self.role = DeviceRole.objects.create(tenant=t, name="Access", slug="access")
        self.rack_role = RackRole.objects.create(tenant=t, name="Net", slug="net")
        self.ctype = ClusterType.objects.create(tenant=t, name="PVE", slug="pve")
        # The issue's numbers: 1 device + 1 VM at A, 2 devices + 3 VMs at B.
        for site, devices, vms in ((self.site_a, 1, 1), (self.site_b, 2, 3)):
            for i in range(devices):
                Device.objects.create(
                    tenant=t, name=f"{site.name}-sw{i}", site=site, platform=self.platform,
                    device_type=self.dtype, role=self.role, status=self.status,
                )
            cluster = Cluster.objects.create(
                tenant=t, name=f"{site.name}-c", type=self.ctype, site=site,
            )
            for i in range(vms):
                VirtualMachine.objects.create(
                    tenant=t, name=f"{site.name}-vm{i}", cluster=cluster, site=site,
                    platform=self.platform, role=self.role, status=self.status,
                )
            Rack.objects.create(tenant=t, name=f"{site.name}-r1", site=site, role=self.rack_role)
        assemble_site_role(t, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def _detail(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _row(self, url, obj):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        rows = body["results"] if isinstance(body, dict) else body
        return next(row for row in rows if str(row["id"]) == str(obj.id))

    def _count(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["count"]

    def _list(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        return body["results"] if isinstance(body, dict) else body

    def _separate(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()

    def _allow(self, slug, **constraints):
        """A tenant-wide view grant on ``slug``, narrowed by ``constraints``."""
        perm = ObjectPermission.objects.create(
            name=f"view {slug}", object_types=[slug], actions=["view"],
            constraints=constraints or None,
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)

    def _as_admin(self):
        self.user = User.objects.create_superuser("root", "r@example.com", "x")
        self._login()

    def _expect(self, url, obj, **counts):
        for where, data in (
            ("detail", self._detail(f"{url}{obj.id}/")),
            ("list", self._row(url, obj)),
        ):
            for field, n in counts.items():
                with self.subTest(url=url, where=where, field=field):
                    self.assertEqual(data[field], n)

    def test_platform_counts_match_its_tabs(self):
        self._expect("/api/platforms/", self.platform, device_count=1, vm_count=1)
        self.assertEqual(self._count(f"/api/devices/?platform={self.platform.id}"), 1)
        self.assertEqual(self._count(f"/api/virtual-machines/?platform={self.platform.id}"), 1)

    def test_device_type_role_and_other_catalogs(self):
        self._expect("/api/device-types/", self.dtype, device_count=1)
        self._expect("/api/device-roles/", self.role, device_count=1, vm_count=1)
        self._expect("/api/rack-roles/", self.rack_role, rack_count=1)
        self._expect("/api/cluster-types/", self.ctype, cluster_count=1)
        # Regions are no part of the site role; with a tenant-wide grant on
        # them, a region still counts only the sites the viewer can open.
        self._grant(["region"], sites=[])
        self._expect("/api/regions/", self.region, site_count=1)
        # One device and one VM at A carry the status (plus their cluster
        # and rack, which have none).
        self.assertEqual(self._detail(f"/api/statuses/{self.status.id}/")["usage_count"], 2)

    def test_manufacturer_counts_local_device_types_of_own_sites(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        DeviceType.objects.create(
            tenant=self.tenant, name="B-only", manufacturer=self.mfr, owning_site=self.site_b,
        )
        DeviceType.objects.create(
            tenant=self.tenant, name="A-only", manufacturer=self.mfr, owning_site=self.site_a,
        )
        # The global type and A's local one; B's local type is not A's to see.
        self._expect("/api/manufacturers/", self.mfr, device_type_count=2)

    def test_an_administrator_counts_everything(self):
        admin = User.objects.create_superuser("root", "r@example.com", "x")
        self.user = admin
        self._login()
        self._expect("/api/platforms/", self.platform, device_count=3, vm_count=4)
        self._expect("/api/device-types/", self.dtype, device_count=3)
        self._expect("/api/device-roles/", self.role, device_count=3, vm_count=4)
        self._expect("/api/rack-roles/", self.rack_role, rack_count=2)
        self._expect("/api/regions/", self.region, site_count=2)

    def test_contact_and_role_count_the_assignments_the_reader_may_view(self):
        t = self.tenant
        role = ContactRole.objects.create(tenant=t, name="NOC", slug="noc")
        contact = Contact.objects.create(tenant=t, name="Ann")
        for site in (self.site_a, self.site_b):
            ContactAssignment.objects.create(
                tenant=t, contact=contact, role=role, object_type="api.site",
                object_id=str(site.id),
            )
        self._grant(["contact", "contactrole"], sites=[])
        # Assignments are no part of the site role: none listed, none counted.
        self._expect("/api/contacts/", contact, assignment_count=0)
        self._expect("/api/contact-roles/", role, assignment_count=0)
        self._allow("contactassignment", object_id=str(self.site_a.id))
        self._expect("/api/contacts/", contact, assignment_count=1)
        self._expect("/api/contact-roles/", role, assignment_count=1)
        self.assertEqual(len(self._list(f"/api/contact-assignments/?contact={contact.id}")), 1)
        self._as_admin()
        self._expect("/api/contacts/", contact, assignment_count=2)
        self._expect("/api/contact-roles/", role, assignment_count=2)

    def test_custom_field_group_counts_global_and_own_site_fields(self):
        self._separate()
        t = self.tenant
        group = CustomFieldGroup.objects.create(tenant=t, name="Ops", slug="ops")
        CustomField.objects.create(tenant=t, key="shared", label="Shared", group=group)
        for site in (self.site_a, self.site_b):
            CustomField.objects.create(
                tenant=t, key=f"local_{site.name}", label=site.name, group=group,
                owning_site=site,
            )
        self._grant(["customfieldgroup"], sites=[])
        self._expect("/api/custom-field-groups/", group, field_count=2)
        self.assertEqual(len(self._list(f"/api/custom-fields/?group={group.id}")), 2)
        self._as_admin()
        self._expect("/api/custom-field-groups/", group, field_count=3)

    def test_provider_network_counts_the_circuits_its_tab_lists(self):
        t = self.tenant
        provider = Provider.objects.create(tenant=t, name="Telia", slug="telia")
        net = ProviderNetwork.objects.create(tenant=t, provider=provider, name="MPLS")
        for cid in ("C1", "C2"):
            circuit = Circuit.objects.create(tenant=t, cid=cid, provider=provider)
            CircuitTermination.objects.create(circuit=circuit, term_side="A", provider_network=net)
        self._grant(["providernetwork"], sites=[])
        # Circuits are no part of the site role: the tab lists none.
        self._expect("/api/provider-networks/", net, circuit_count=0)
        self._allow("circuit", cid="C1")
        self._expect("/api/provider-networks/", net, circuit_count=1)
        self.assertEqual(len(self._list(f"/api/circuits/?provider_network={net.id}")), 1)
        self._as_admin()
        self._expect("/api/provider-networks/", net, circuit_count=2)

    def test_tag_usage_counts_the_tagged_objects_the_reader_may_view(self):
        t = self.tenant
        tag = Tag.objects.create(tenant=t, name="Core", slug="core")
        for device in Device.objects.filter(tenant=t):  # one at A, two at B
            device.tags.add(tag)
        Prefix.objects.create(
            tenant=t, cidr="10.2.0.0/24", site=self.site_b, status=self.status
        ).tags.add(tag)
        # A VRF is no site's: it counts for every reader of the tag.
        VRF.objects.create(tenant=t, name="blue").tags.add(tag)
        self._expect("/api/tags/", tag, usage_count=2)
        self.assertEqual(self._detail(f"/api/tags/{tag.id}/usage/")["count"], 2)
        # Under separation a VRF local to site B is site B's.
        self._separate()
        VRF.objects.create(tenant=t, name="b-only", owning_site=self.site_b).tags.add(tag)
        self._expect("/api/tags/", tag, usage_count=2)
        self._as_admin()
        self._expect("/api/tags/", tag, usage_count=6)

    def test_cluster_and_vm_group_count_the_vms_the_reader_may_view(self):
        t = self.tenant
        cluster = Cluster.objects.get(name="SiteA-c")
        group = VirtualMachineGroup.objects.create(tenant=t, cluster=cluster, name="vapp")
        VirtualMachine.objects.filter(cluster=cluster).update(group=group)
        # A's cluster also runs a VM placed at site B.
        VirtualMachine.objects.create(
            tenant=t, name="stray", cluster=cluster, group=group, site=self.site_b,
            status=self.status,
        )
        self._expect("/api/clusters/", cluster, vm_count=1)
        self._expect("/api/vm-groups/", group, vm_count=1)
        self._as_admin()
        self._expect("/api/clusters/", cluster, vm_count=2)
        self._expect("/api/vm-groups/", group, vm_count=2)

    def test_l2vpn_counts_the_vteps_the_reader_may_view(self):
        t = self.tenant
        l2vpn = L2VPN.objects.create(
            tenant=t, name="SERVERS", slug="servers", type="vxlan-evpn", identifier=10100
        )
        for device in Device.objects.filter(name__in=["SiteA-sw0", "SiteB-sw0"]):
            vtep = VTEP.objects.create(tenant=t, device=device)
            VTEPMembership.objects.create(vtep=vtep, l2vpn=l2vpn)
        self._grant(["l2vpn"], sites=[])
        self._expect("/api/l2vpns/", l2vpn, vtep_count=1)
        self._as_admin()
        self._expect("/api/l2vpns/", l2vpn, vtep_count=2)


def _tag_one_of_each(tenant, site, tags, octet):
    """One object at ``site`` of each of ~20 site-scoped taggable types,
    every one carrying ``tags``. Returns how many were made."""
    ctype, _ = ClusterType.objects.get_or_create(tenant=tenant, name="KVM", slug="kvm")
    device = Device.objects.create(tenant=tenant, name=f"{site.name}-tagged", site=site)
    cluster = Cluster.objects.create(
        tenant=tenant, name=f"{site.name}-tc", type=ctype, site=site
    )
    vm = VirtualMachine.objects.create(
        tenant=tenant, name=f"{site.name}-tvm", cluster=cluster, site=site
    )
    panel = PowerPanel.objects.create(tenant=tenant, site=site, name=f"{site.name}-pp")
    prefix = Prefix.objects.create(tenant=tenant, cidr=f"10.{octet}.0.0/24", site=site)
    rear = RearPort.objects.create(device=device, name="rp")
    objs = [
        site, device, cluster, vm, panel, prefix, rear,
        Rack.objects.create(tenant=tenant, name=f"{site.name}-tr", site=site),
        VLAN.objects.create(tenant=tenant, site=site, vlan_id=300, name="tagged"),
        IPAddress.objects.create(
            tenant=tenant, ip_address=f"10.{octet}.0.5", prefix=prefix, site=site
        ),
        Interface.objects.create(device=device, name="eth0"),
        ConsolePort.objects.create(device=device, name="con"),
        ConsoleServerPort.objects.create(device=device, name="cs"),
        PowerPort.objects.create(device=device, name="psu"),
        PowerOutlet.objects.create(device=device, name="out"),
        AuxPort.objects.create(device=device, name="aux"),
        FrontPort.objects.create(device=device, name="fp", rear_port=rear),
        DeviceBay.objects.create(device=device, name="bay"),
        ModuleBay.objects.create(device=device, name="slot"),
        InventoryItem.objects.create(device=device, name="fan"),
        VMInterface.objects.create(vm=vm, name="eth0"),
        VirtualMachineGroup.objects.create(tenant=tenant, cluster=cluster, name="tg"),
        PowerFeed.objects.create(tenant=tenant, power_panel=panel, name="feed"),
    ]
    for obj in objs:
        obj.tags.add(*tags)
    return len(objs)


class TagUsageCostTests(_TwoSites):
    """A site viewer's tag usage count narrows every site-scoped type it
    meets, and still costs the same for a page of one tag as for five."""

    def setUp(self):
        super().setUp()
        t = self.tenant
        self.tags = [Tag.objects.create(tenant=t, name=f"t{i}", slug=f"t{i}") for i in range(5)]
        self.per_site = {
            site.pk: _tag_one_of_each(t, site, self.tags, octet)
            for site, octet in ((self.site_a, 3), (self.site_b, 4))
        }
        assemble_site_role(t, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def _queries(self, url):
        self.client.get(url)  # one-off lookups: content types, settings rows
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()["results"]

    def test_counts_site_a_only_at_a_flat_cost(self):
        small, _ = self._queries("/api/tags/?page_size=1")
        big, rows = self._queries("/api/tags/?page_size=5")
        self.assertEqual(small, big, "a bigger page of tags costs more queries")
        self.assertEqual(len(rows), 5)
        self.assertGreaterEqual(self.per_site[self.site_a.pk], 20)
        self.assertEqual({r["usage_count"] for r in rows}, {self.per_site[self.site_a.pk]})


class RollupVisibleCountTests(_TwoSites):
    """The tenant, cluster, tag and prefix counts count what the reader may
    view too (#448). The issue's setup: site A holds one prefix, IP and VLAN,
    site B three of each, under a shared 10.0.0.0/8; cluster C1 runs one VM
    at A and three at B, each tagged "zz"; the user views site A only."""

    def setUp(self):
        super().setUp()
        t = self.tenant
        status = status_for(t)
        self.container = Prefix.objects.create(tenant=t, cidr="10.0.0.0/8", status=status)
        ctype = ClusterType.objects.create(tenant=t, name="PVE", slug="pve")
        self.cluster = Cluster.objects.create(tenant=t, name="C1", type=ctype)
        self.tag = Tag.objects.create(tenant=t, name="zz", slug="zz")
        for site, n, octet in ((self.site_a, 1, 1), (self.site_b, 3, 2)):
            for i in range(n):
                prefix = Prefix.objects.create(
                    tenant=t, cidr=f"10.{octet}.{i}.0/24", site=site, status=status
                )
                IPAddress.objects.create(
                    tenant=t, ip_address=f"10.{octet}.{i}.5", prefix=prefix, site=site
                )
                VLAN.objects.create(tenant=t, site=site, vlan_id=octet * 10 + i, name=f"v{i}")
                VirtualMachine.objects.create(
                    tenant=t, name=f"{site.name}-vm{i}", cluster=self.cluster, site=site,
                    status=status,
                ).tags.add(self.tag)
        assemble_site_role(t, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def _get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _rows(self, url):
        body = self._get(url)
        return body["results"] if isinstance(body, dict) and "results" in body else body

    def _expect(self, url, obj, **counts):
        row = next(r for r in self._rows(url) if str(r["id"]) == str(obj.id))
        for where, data in (("detail", self._get(f"{url}{obj.id}/")), ("list", row)):
            for field, n in counts.items():
                with self.subTest(url=url, where=where, field=field):
                    self.assertEqual(data[field], n)

    def _as_admin(self):
        self.user = User.objects.create_superuser("root", "r@example.com", "x")
        self._login()

    def _separated(self):
        """Yield with enhanced site separation off, then on."""
        for on in (False, True):
            dep = DeploymentSettings.load()
            dep.enhanced_site_separation = on
            dep.save()
            yield on

    def test_tenant_counts_match_the_lists(self):
        for on in self._separated():
            with self.subTest(separation=on):
                self._expect(
                    "/api/tenants/", self.tenant,
                    site_count=1, prefix_count=2, vlan_count=1, ip_count=1,
                )
                self.assertEqual(len(self._rows("/api/sites/")), 1)
                self.assertEqual(len(self._rows("/api/prefixes/")), 2)
                self.assertEqual(len(self._rows("/api/vlans/")), 1)
                self.assertEqual(len(self._rows("/api/ips/")), 1)
        self._as_admin()
        self._expect(
            "/api/tenants/", self.tenant,
            site_count=2, prefix_count=5, vlan_count=4, ip_count=4,
        )

    def test_each_tenant_counts_through_its_own_grants(self):
        # A second tenant the user reads in full, a third where it holds no
        # grant: each counts by the user's grants there, not the active one's.
        org = self.tenant.org
        wide = Tenant.objects.create(org=org, name="Wide", slug="wide")
        bare = Tenant.objects.create(org=org, name="Bare", slug="bare")
        for tenant in (wide, bare):
            self.user.profile.tenants.add(tenant)
            for name in ("W1", "W2"):
                Site.objects.create(tenant=tenant, name=name)
        perm = ObjectPermission.objects.create(
            name="wide", object_types=["site"], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(wide)
        rows = {r["slug"]: r for r in self._rows("/api/tenants/")}
        self.assertEqual(rows["t"]["site_count"], 1)
        self.assertEqual(rows["wide"]["site_count"], 2)
        self.assertEqual(rows["bare"]["site_count"], 0)
        self.assertEqual(self._get(f"/api/tenants/{wide.id}/")["site_count"], 2)

    def test_tenant_list_costs_the_same_for_more_tenants(self):
        def queries():
            self.client.get("/api/tenants/")
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get("/api/tenants/")
            self.assertEqual(r.status_code, 200, r.content)
            return len(ctx.captured_queries)

        def add_tenant(slug):
            tenant = Tenant.objects.create(org=self.tenant.org, name=slug, slug=slug)
            self.user.profile.tenants.add(tenant)

        add_tenant("x0")
        small = queries()
        for i in range(1, 4):
            add_tenant(f"x{i}")
        self.assertEqual(queries(), small, "each tenant on the page costs more queries")

    def test_tenant_group_counts_the_tenants_the_reader_may_open(self):
        group = TenantGroup.objects.create(org=self.tenant.org, name="G", slug="g")
        self.tenant.group = group
        self.tenant.save()
        Tenant.objects.create(org=self.tenant.org, name="Other", slug="other", group=group)
        self._expect("/api/tenant-groups/", group, tenant_count=1)
        self._as_admin()
        self._expect("/api/tenant-groups/", group, tenant_count=2)

    def test_cluster_vm_and_tag_counts(self):
        for on in self._separated():
            with self.subTest(separation=on):
                self._expect("/api/clusters/", self.cluster, vm_count=1)
                self._expect("/api/tags/", self.tag, usage_count=1)
        self._as_admin()
        self._expect("/api/clusters/", self.cluster, vm_count=4)
        self._expect("/api/tags/", self.tag, usage_count=4)

    def test_prefix_child_and_ip_counts(self):
        # Two addresses straight in the container: a shared one, and one
        # placed at site B.
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.1", prefix=self.container
        )
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.2", prefix=self.container,
            site=self.site_b,
        )
        url = f"/api/prefixes/{self.container.id}/"
        for on in self._separated():
            with self.subTest(separation=on):
                self._expect("/api/prefixes/", self.container, child_count=1, ip_count=1)
                self.assertTrue(self._get(url)["has_descendants"])
                self.assertEqual(
                    len(self._rows(f"/api/ips/?prefix={self.container.id}")), 1
                )
        self._as_admin()
        self._expect("/api/prefixes/", self.container, child_count=4, ip_count=2)
