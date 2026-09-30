"""Addresses listed on another row follow the caller's IP view scope.

An interface's ``ip_addresses``, a VM interface's, and a tunnel end's
``outside_ip`` are IP rows: a viewer limited to Site A sees the Site A address
on a Site A port, never the Site B address bound to the same port. Another
tenant's address pointing at the port is nobody's row. Pages stay flat.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIRequestFactory, APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Cluster,
    ClusterType,
    Device,
    Interface,
    IPAddress,
    Prefix,
    Site,
    Tunnel,
    TunnelTermination,
    VirtualMachine,
    VMInterface,
)
from .serializers import InterfaceSerializer

User = get_user_model()

TYPES = [
    "device", "interface", "ipaddress", "virtualmachine", "vminterface",
    "tunnel", "tunneltermination",
]


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=t, name="A")
        self.site_b = Site.objects.create(tenant=t, name="B")
        self.prefix = Prefix.objects.create(tenant=t, cidr="10.0.0.0/24")
        self.dev = Device.objects.create(tenant=t, name="sw1", site=self.site_a)
        self.eth0 = Interface.objects.create(device=self.dev, name="eth0")
        self.ip_a = self._ip("10.0.0.10", self.site_a, assigned_interface=self.eth0)
        self.ip_b = self._ip("10.0.0.9", self.site_b, assigned_interface=self.eth0)
        other_org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        IPAddress.objects.create(
            tenant=other, ip_address="10.9.0.1",
            prefix=Prefix.objects.create(tenant=other, cidr="10.9.0.0/24"),
            assigned_interface=self.eth0,
        )
        ctype = ClusterType.objects.create(tenant=t, name="kvm", slug="kvm")
        cluster = Cluster.objects.create(tenant=t, name="c1", type=ctype)
        self.vm = VirtualMachine.objects.create(
            tenant=t, name="vm1", cluster=cluster, site=self.site_a
        )
        self.vmi = VMInterface.objects.create(vm=self.vm, name="eth0")
        self.vm_ip_a = self._ip(
            "10.0.0.20", self.site_a, assigned_vm_interface=self.vmi
        )
        self._ip("10.0.0.21", self.site_b, assigned_vm_interface=self.vmi)
        self.tunnel = Tunnel.objects.create(tenant=t, name="vpn1")
        TunnelTermination.objects.create(
            tunnel=self.tunnel, interface=self.eth0, outside_ip=self.ip_b
        )
        TunnelTermination.objects.create(
            tunnel=self.tunnel, vm_interface=self.vmi, outside_ip=self.vm_ip_a
        )

    def _ip(self, addr, site, **assigned):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address=addr, site=site,
            **assigned,
        )

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _user(self, types, sites=()):
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"p{user.pk}", object_types=types, actions=["view"]
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        return user

    def _get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _addrs(self, row):
        return [ip["ip_address"] for ip in row["ip_addresses"]]

    def _eth0_rows(self):
        """eth0 as the detail, the list and the device's Interfaces tab."""
        detail = self._get(f"/api/interfaces/{self.eth0.id}/")
        (listed,) = self._get(f"/api/interfaces/?device={self.dev.id}")["results"]
        (tab,) = self._get(f"/api/devices/{self.dev.id}/interfaces/")["results"]
        return detail, listed, tab


class InterfaceAddressTests(_Base):
    def test_superuser_sees_every_address_in_the_tenant(self):
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        for row in self._eth0_rows():
            self.assertEqual(self._addrs(row), ["10.0.0.9", "10.0.0.10"])
        (vmi,) = self._get(f"/api/vm-interfaces/?vm={self.vm.id}")["results"]
        self.assertEqual(self._addrs(vmi), ["10.0.0.20", "10.0.0.21"])

    def test_an_unscoped_grant_sees_every_address_in_the_tenant(self):
        self._login(self._user(["*"]))
        for row in self._eth0_rows():
            self.assertEqual(self._addrs(row), ["10.0.0.9", "10.0.0.10"])

    def test_a_site_scoped_viewer_sees_only_its_sites_addresses(self):
        self._login(self._user(TYPES, [self.site_a]))
        for row in self._eth0_rows():
            self.assertEqual(self._addrs(row), ["10.0.0.10"])
        (vmi,) = self._get(f"/api/vm-interfaces/?vm={self.vm.id}")["results"]
        self.assertEqual(self._addrs(vmi), ["10.0.0.20"])

    def test_no_ip_grant_lists_no_addresses(self):
        self._login(self._user(["device", "interface", "virtualmachine", "vminterface"]))
        for row in self._eth0_rows():
            self.assertEqual(row["ip_addresses"], [])
        (vmi,) = self._get(f"/api/vm-interfaces/?vm={self.vm.id}")["results"]
        self.assertEqual(vmi["ip_addresses"], [])

    def test_a_row_the_viewset_did_not_prefetch_is_cut_the_same(self):
        # A create's response serializes the saved row without the prefetch.
        user = self._user(TYPES, [self.site_a])
        request = APIRequestFactory().get("/")
        request.user = user
        request.session = {"current_tenant_id": str(self.tenant.id)}
        data = InterfaceSerializer(
            Interface.objects.get(pk=self.eth0.pk), context={"request": request}
        ).data
        self.assertEqual(self._addrs(data), ["10.0.0.10"])
        self.assertEqual(
            InterfaceSerializer(Interface.objects.get(pk=self.eth0.pk)).data[
                "ip_addresses"
            ],
            [],
        )


class TunnelOutsideAddressTests(_Base):
    def _outside(self, url):
        body = self._get(url)
        rows = body["terminations"] if "terminations" in body else body["results"]
        return {
            ("iface" if t["interface"] else "vm"): (
                t["outside_ip"]["ip_address"] if t["outside_ip"] else None
            )
            for t in rows
        }

    def test_superuser_sees_both_outside_addresses(self):
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        want = {"iface": "10.0.0.9", "vm": "10.0.0.20"}
        self.assertEqual(self._outside(f"/api/tunnels/{self.tunnel.id}/"), want)
        self.assertEqual(
            self._outside(f"/api/tunnel-terminations/?tunnel={self.tunnel.id}"), want
        )

    def test_a_site_scoped_viewer_does_not_see_another_sites_outside_address(self):
        self._login(self._user(TYPES, [self.site_a]))
        want = {"iface": None, "vm": "10.0.0.20"}
        self.assertEqual(self._outside(f"/api/tunnels/{self.tunnel.id}/"), want)
        (row,) = [
            r for r in self._get("/api/tunnels/")["results"]
            if r["id"] == str(self.tunnel.id)
        ]
        self.assertEqual(
            {t["outside_ip"]["ip_address"] if t["outside_ip"] else None
             for t in row["terminations"]},
            {None, "10.0.0.20"},
        )
        self.assertEqual(
            self._outside(f"/api/tunnel-terminations/?tunnel={self.tunnel.id}"), want
        )


class NestedAddressQueryCountTests(_Base):
    """A bigger page costs the same, scoped or not."""

    def _grow(self, n):
        for i in range(n):
            port = Interface.objects.create(device=self.dev, name=f"xe{i}")
            self._ip(f"10.0.0.{100 + i}", self.site_a, assigned_interface=port)
            self._ip(f"10.0.0.{150 + i}", self.site_b, assigned_interface=port)
            vmi = VMInterface.objects.create(vm=self.vm, name=f"net{i}")
            self._ip(f"10.0.0.{200 + i}", self.site_a, assigned_vm_interface=vmi)
            tun = Tunnel.objects.create(tenant=self.tenant, name=f"t{i}")
            TunnelTermination.objects.create(
                tunnel=tun, interface=port, outside_ip=self.ip_b
            )
            TunnelTermination.objects.create(
                tunnel=tun, vm_interface=vmi, outside_ip=self.vm_ip_a
            )

    def _count(self, url):
        self.client.get(url)  # the first request pays one-off lookups
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries)

    def _assert_flat(self):
        urls = (
            "/api/interfaces/?page_size=50",
            "/api/vm-interfaces/?page_size=50",
            "/api/tunnels/?page_size=50",
            f"/api/devices/{self.dev.id}/interfaces/",
        )
        before = {u: self._count(u) for u in urls}
        self._grow(6)
        after = {u: self._count(u) for u in urls}
        self.assertEqual(before, after, "more rows must not cost more queries")

    def test_superuser_pages_are_flat(self):
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        self._assert_flat()

    def test_site_scoped_pages_are_flat(self):
        self._login(self._user(TYPES, [self.site_a]))
        self._assert_flat()
        rows = self._get("/api/interfaces/?page_size=50")["results"]
        self.assertEqual(
            {addr for row in rows for addr in self._addrs(row)},
            {"10.0.0.10", *(f"10.0.0.{100 + i}" for i in range(6))},
        )
