"""Addresses listed on another row follow the caller's IP view scope.

An interface's ``ip_addresses``, a VM interface's, and a tunnel end's
``outside_ip`` are IP rows: a viewer limited to Site A sees the Site A address
on a Site A port, never the Site B address bound to the same port. Another
tenant's address pointing at the port is nobody's row. Pages stay flat, and a
write's response shows the saved addresses, not the ones fetched before it.

The MAC registry (``/api/macs/``) gathers ports, IPs and MAC objects that
share an address; each is cut to the caller's scope for its own type.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIRequestFactory, APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from monitoring.models import DeviceSnmp

from .models import (
    Cluster,
    ClusterType,
    Device,
    Interface,
    IPAddress,
    MACAddress,
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
        self._grant(user, types, ["view"], sites)
        return user

    def _grant(self, user, types, actions, sites=()):
        perm = ObjectPermission.objects.create(
            name=f"p{user.pk}-{ObjectPermission.objects.count()}",
            object_types=types, actions=actions,
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)

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


class WriteResponseTests(_Base):
    """An update answers with the saved addresses. DRF drops a row's prefetch
    cache after the save but not a ``to_attr`` list, which would otherwise
    answer with the addresses fetched before it."""

    def _iface_end(self):
        return TunnelTermination.objects.get(tunnel=self.tunnel, interface=self.eth0)

    def _patch_outside(self, end, ip):
        r = self.client.patch(
            f"/api/tunnel-terminations/{end.id}/",
            {"outside_ip_id": str(ip.id) if ip else None},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()["outside_ip"]
        return out["ip_address"] if out else None

    def test_a_new_outside_address_shows_in_the_response(self):
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        end = self._iface_end()
        new = self._ip("10.0.0.77", self.site_a)
        self.assertEqual(self._patch_outside(end, new), "10.0.0.77")
        self.assertEqual(self._patch_outside(end, None), None)
        self.assertEqual(self._patch_outside(end, self.ip_b), "10.0.0.9")

    def test_an_address_the_writer_may_not_view_answers_null(self):
        user = self._user(TYPES, [self.site_a])
        self._grant(user, ["tunneltermination"], ["change"], [self.site_a])
        self._login(user)
        end = self._iface_end()
        TunnelTermination.objects.filter(pk=end.pk).update(outside_ip=None)
        self.assertEqual(self._patch_outside(end, self.ip_a), "10.0.0.10")
        # Site B is outside the writer's IP view scope: saved, never shown.
        self.assertEqual(self._patch_outside(end, self.ip_b), None)
        end.refresh_from_db()
        self.assertEqual(end.outside_ip_id, self.ip_b.id)

    def test_an_interface_update_keeps_its_addresses_cut(self):
        user = self._user(TYPES, [self.site_a])
        self._grant(user, ["interface", "vminterface"], ["change"], [self.site_a])
        self._login(user)
        r = self.client.patch(
            f"/api/interfaces/{self.eth0.id}/", {"description": "x"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._addrs(r.json()), ["10.0.0.10"])
        r = self.client.patch(
            f"/api/vm-interfaces/{self.vmi.id}/", {"description": "x"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._addrs(r.json()), ["10.0.0.20"])


class MacRegistryVisibilityTests(_Base):
    """``/api/macs/`` and ``/api/macs/<mac>/`` list each port, IP, MAC object
    and SNMP sighting only when the caller may view that row."""

    MAC = "aa:bb:cc:00:00:01"
    B_ONLY = "aa:bb:cc:00:00:02"

    def setUp(self):
        super().setUp()
        m = self.MAC
        self.dev_b = Device.objects.create(tenant=self.tenant, name="sw2", site=self.site_b)
        self.ge0 = Interface.objects.create(device=self.dev_b, name="ge0", mac_address=m)
        Interface.objects.filter(pk=self.eth0.pk).update(mac_address=m)
        IPAddress.objects.filter(pk__in=[self.ip_a.pk, self.ip_b.pk]).update(mac_address=m)
        # A Site A address on a Site B port: the address shows, the port doesn't.
        self._ip("10.0.0.30", self.site_a, assigned_interface=self.ge0, mac_address=m)
        self._ip("10.0.0.40", self.site_b, mac_address=self.B_ONLY)
        MACAddress.objects.create(tenant=self.tenant, mac_address=m, assigned_interface=self.eth0)
        MACAddress.objects.create(
            tenant=self.tenant, mac_address=m, assigned_interface=self.ge0,
            description="site b object",
        )
        VMInterface.objects.filter(pk=self.vmi.pk).update(mac_address=m)
        vm_b = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm2", cluster=self.vm.cluster, site=self.site_b
        )
        VMInterface.objects.create(vm=vm_b, name="eth0", mac_address=m)
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.dev, fdb=[{"mac": m, "if_index": 1}]
        )
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.dev_b, arp=[{"mac": m, "ip": "10.0.0.9"}]
        )
        DeviceSnmp.objects.create(
            tenant=self.tenant, vm=vm_b, arp=[{"mac": m, "ip": "10.0.0.9"}]
        )

    def _row(self, mac):
        rows = [r for r in self._get("/api/macs/")["results"] if r["mac"] == mac]
        return rows[0] if rows else None

    def _shape(self, body):
        return {
            "interfaces": sorted(
                f'{i["device"]["name"]}/{i["name"]}' for i in body["interfaces"]
            ),
            "vm_interfaces": sorted(
                f'{i["vm"]["name"]}/{i["name"]}' for i in body["vm_interfaces"]
            ),
            "ips": sorted(
                (ip["ip_address"], ip["device"]["name"] if ip["device"] else None)
                for ip in body["ips"]
            ),
            "objects": sorted(
                o["assigned_interface"]["device"]["name"] for o in body["objects"]
            ),
        }

    def test_superuser_sees_every_source(self):
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        want = {
            "interfaces": ["sw1/eth0", "sw2/ge0"],
            "vm_interfaces": ["vm1/eth0", "vm2/eth0"],
            "ips": [("10.0.0.10", "sw1"), ("10.0.0.30", "sw2"), ("10.0.0.9", "sw1")],
            "objects": ["sw1", "sw2"],
        }
        self.assertEqual(self._shape(self._row(self.MAC)), want)
        detail = self._get(f"/api/macs/{self.MAC}/")
        self.assertEqual(self._shape(detail), want)
        self.assertEqual(
            sorted((s.get("device") or s.get("vm"))["name"] for s in detail["seen"]),
            ["sw1", "sw2", "vm2"],
        )
        self.assertIsNotNone(self._row(self.B_ONLY))

    def test_a_site_scoped_viewer_sees_only_its_sites_rows(self):
        self._login(self._user([*TYPES, "macaddress"], [self.site_a]))
        want = {
            "interfaces": ["sw1/eth0"],
            "vm_interfaces": ["vm1/eth0"],
            "ips": [("10.0.0.10", "sw1"), ("10.0.0.30", None)],
            "objects": ["sw1"],
        }
        self.assertEqual(self._shape(self._row(self.MAC)), want)
        detail = self._get(f"/api/macs/{self.MAC}/")
        self.assertEqual(self._shape(detail), want)
        (on_b,) = [ip for ip in detail["ips"] if ip["ip_address"] == "10.0.0.30"]
        self.assertIsNone(on_b["interface"])
        self.assertEqual(
            [(s.get("device") or s.get("vm"))["name"] for s in detail["seen"]], ["sw1"]
        )
        # A MAC only Site B rows carry is not there at all.
        self.assertIsNone(self._row(self.B_ONLY))
        r = self.client.get(f"/api/macs/{self.B_ONLY}/")
        self.assertEqual(r.status_code, 404)

    def test_a_mac_grant_alone_lists_only_mac_objects(self):
        self._login(self._user(["macaddress"]))
        body = self._get(f"/api/macs/{self.MAC}/")
        self.assertEqual(
            self._shape(body),
            {"interfaces": [], "vm_interfaces": [], "ips": [], "objects": ["sw1", "sw2"]},
        )
        self.assertEqual(body["seen"], [])
        self.assertIsNone(self._row(self.B_ONLY))


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
