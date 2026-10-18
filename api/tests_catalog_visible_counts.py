"""Catalog counts count what the reader may view (#438).

A Site viewer of site A got tenant-wide numbers on platforms, device types,
roles and the other catalogs, while the lists those numbers link to showed
site A only - the count above a tab disagreed with the table under it, and
told the viewer what other sites run. The count is the linked list's count.
"""
from django.contrib.auth.models import User

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    Manufacturer,
    Platform,
    Rack,
    RackRole,
    Region,
    VirtualMachine,
)
from api.test_utils import status_for
from api.tests_site_scope_gaps import _TwoSites
from auth_api.api import assemble_site_role
from core.models import DeploymentSettings


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
        return next(row for row in rows if row["id"] == str(obj.id))

    def _count(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["count"]

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
