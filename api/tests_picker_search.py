"""The pickers of long lists search the server (#534): each endpoint a
server-searched picker reads narrows to ``?search=`` within the active tenant
and the reader's scope, one page at a time."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from auth_api.api import assemble_site_role
from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .models import (
    VLAN,
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    IPRange,
    Prefix,
    Rack,
    Site,
    VirtualMachine,
)

User = get_user_model()


class PickerSearchTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=t, name="A")
        self.site_b = Site.objects.create(tenant=t, name="B")
        ct = ClusterType.objects.create(tenant=t, name="pve", slug="pve")
        cl = Cluster.objects.create(tenant=t, name="c", type=ct)
        for site, tag in ((self.site_a, "alpha"), (self.site_b, "bravo")):
            for i in range(3):
                Device.objects.create(tenant=t, name=f"{tag}-sw{i}", site=site)
                VLAN.objects.create(tenant=t, site=site, vlan_id=100 + i, name=f"{tag}-v{i}")
                Rack.objects.create(tenant=t, site=site, name=f"{tag}-r{i}")
                VirtualMachine.objects.create(tenant=t, name=f"{tag}-vm{i}", cluster=cl,
                                              site=site)
        pa = Prefix.objects.create(tenant=t, cidr="10.1.0.0/24", site=self.site_a,
                                   description="alpha net")
        pb = Prefix.objects.create(tenant=t, cidr="10.2.0.0/24", site=self.site_b,
                                   description="bravo net")
        for p, site in ((pa, self.site_a), (pb, self.site_b)):
            for h in (1, 2):
                IPAddress.objects.create(tenant=t, ip_address=f"{p.cidr[:-4]}{h}",
                                         prefix=p, site=site)
        IPRange.objects.create(tenant=t, start_address="10.1.0.10", end_address="10.1.0.20",
                               prefix=pa, description="alpha pool")
        IPRange.objects.create(tenant=t, start_address="10.2.0.10", end_address="10.2.0.20",
                               prefix=pb, description="bravo pool")
        theirs = Prefix.objects.create(tenant=other, cidr="10.1.0.0/24", description="alpha")
        Device.objects.create(tenant=other, name="alpha-theirs")
        IPAddress.objects.create(tenant=other, ip_address="10.1.0.1", prefix=theirs)
        self.user = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login()

    def _login(self):
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    #: (picker endpoint, search, the label key, what it must find)
    CASES = [
        ("/api/devices/?picker=1", "alpha", "name", {"alpha-sw0", "alpha-sw1", "alpha-sw2"}),
        ("/api/vlans/?picker=1", "alpha", "name", {"alpha-v0", "alpha-v1", "alpha-v2"}),
        ("/api/racks/?picker=1", "alpha", "name", {"alpha-r0", "alpha-r1", "alpha-r2"}),
        ("/api/virtual-machines/?picker=1", "alpha", "name",
         {"alpha-vm0", "alpha-vm1", "alpha-vm2"}),
        ("/api/prefixes/", "10.1.", "cidr", {"10.1.0.0/24"}),
        ("/api/ips/", "10.1.0", "ip_address", {"10.1.0.1", "10.1.0.2"}),
        ("/api/ip-ranges/", "alpha", "start_address", {"10.1.0.10"}),
    ]

    def _found(self, url, term, key):
        r = self.client.get(f"{url}&search={term}&page_size=50" if "?" in url
                            else f"{url}?search={term}&page_size=50")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertIn("results", body, "a server-searched picker reads a page")
        return {str(row[key]).split("/")[0] if key != "cidr" else row[key]
                for row in body["results"]}

    def test_each_picker_endpoint_searches_the_tenant(self):
        for url, term, key, want in self.CASES:
            with self.subTest(url=url):
                self.assertEqual(self._found(url, term, key), want)

    def test_a_site_reader_finds_only_their_sites_rows(self):
        self.user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "viewer", [self.site_b], user_ids=[self.user.id])
        self._login()
        for url, term, key, _want in self.CASES:
            with self.subTest(url=url):
                self.assertEqual(self._found(url, term, key), set())
