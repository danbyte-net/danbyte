"""The addresses a device or VM uses (api/ip_usage.py): ``?device=`` /
``?virtual_machine=`` on /api/ips/ and ``ip_count`` agree, and count the
addresses on the object, on its interfaces and in its address slots."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cluster,
    ClusterType,
    Device,
    Interface,
    IPAddress,
    Prefix,
    VirtualMachine,
    VMInterface,
)

User = get_user_model()


class AddressUsageTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        t = self.tenant
        p = Prefix.objects.create(tenant=t, cidr="10.0.0.0/24")
        self.core = Device.objects.create(tenant=t, name="core1")
        self.prox = Device.objects.create(tenant=t, name="prox1")
        eth0 = Interface.objects.create(device=self.core, name="eth0")

        def ip(addr, **kw):
            return IPAddress.objects.create(tenant=t, ip_address=addr, prefix=p, **kw)

        self.direct = ip("10.0.0.1", assigned_device=self.core)
        self.on_iface = ip("10.0.0.2", assigned_interface=eth0)
        # Assigned to prox1, used as core1's primary.
        self.elsewhere = ip("10.0.0.3", assigned_device=self.prox)
        ip("10.0.0.4")  # unrelated
        self.core.primary_ip = self.elsewhere
        self.core.oob_ip = self.direct  # in a slot and assigned: counted once
        self.core.save()

        # Another tenant's device, addressed the same way.
        op = Prefix.objects.create(tenant=self.other, cidr="10.0.0.0/24")
        self.foreign = Device.objects.create(tenant=self.other, name="core1")
        IPAddress.objects.create(
            tenant=self.other, ip_address="10.0.0.1", prefix=op,
            assigned_device=self.foreign,
        )

        ctype = ClusterType.objects.create(tenant=t, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=t, name="cl1", type=ctype)
        self.vm = VirtualMachine.objects.create(tenant=t, name="vm1", cluster=cluster)
        vif = VMInterface.objects.create(vm=self.vm, name="net0")
        ip("10.0.0.20", assigned_vm=self.vm)
        ip("10.0.0.21", assigned_vm_interface=vif)
        self.vm.primary_ip = self.elsewhere
        self.vm.save()

    def _addresses(self, query):
        r = self.client.get(f"/api/ips/?{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(row["ip_address"] for row in r.json()["results"])

    def test_device_filter_and_count_agree(self):
        want = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
        self.assertEqual(self._addresses(f"device={self.core.id}"), want)
        detail = self.client.get(f"/api/devices/{self.core.id}/").json()
        self.assertEqual(detail["ip_count"], 3)
        rows = {
            r["name"]: r for r in self.client.get("/api/devices/").json()["results"]
        }
        self.assertEqual(rows["core1"]["ip_count"], 3)
        self.assertEqual(rows["prox1"]["ip_count"], 1)
        ips = self.client.get(f"/api/devices/{self.core.id}/ips/").json()
        self.assertEqual(ips["count"], 3)

    def test_vm_filter_and_count_agree(self):
        want = ["10.0.0.20", "10.0.0.21", "10.0.0.3"]
        self.assertEqual(self._addresses(f"virtual_machine={self.vm.id}"), want)
        self.assertEqual(
            self.client.get(f"/api/virtual-machines/{self.vm.id}/").json()["ip_count"], 3
        )
        self.assertEqual(self._addresses(f"assigned_vm={self.vm.id}"), ["10.0.0.20"])

    def test_other_tenant_device_is_not_resolved(self):
        self.assertEqual(self._addresses(f"device={self.foreign.id}"), [])
        self.assertEqual(self._addresses("device=not-a-uuid"), [])

    def test_count_costs_no_query_per_row(self):
        def cost(n):
            with CaptureQueriesContext(connection) as ctx:
                self.client.get(f"/api/devices/?page_size={n}")
            return len(ctx.captured_queries)

        for i in range(4):
            Device.objects.create(tenant=self.tenant, name=f"extra-{i}")
        # Warm the one-off lookups (content types, settings rows) first.
        cost(1), cost(6)
        self.assertEqual(cost(1), cost(6))

    def test_list_counts_match_the_detail(self):
        # The list counts its page in one query (#455); the numbers are the
        # detail's, slots and other tenants included.
        Device.objects.filter(pk=self.prox.pk).update(
            primary_ip=IPAddress.objects.get(tenant=self.other)
        )
        rows = {r["name"]: r for r in self.client.get("/api/devices/").json()["results"]}
        for name, dev in (("core1", self.core), ("prox1", self.prox)):
            detail = self.client.get(f"/api/devices/{dev.id}/").json()
            self.assertEqual(rows[name]["ip_count"], detail["ip_count"], name)
        # Another tenant's address in a slot does not count.
        self.assertEqual(rows["prox1"]["ip_count"], 1)
        vms = self.client.get("/api/virtual-machines/").json()["results"]
        self.assertEqual({r["name"]: r["ip_count"] for r in vms}, {"vm1": 3})

    def test_list_cost_does_not_follow_the_tenant_addresses(self):
        # The rows query carries no address subquery and the page's count
        # reads the page's ids, so the tenant's other addresses never enter
        # either (#455). A subquery per row read every address of the tenant.
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/16")
        IPAddress.objects.bulk_create(
            IPAddress(tenant=self.tenant, ip_address=f"10.9.{i // 250}.{i % 250 + 1}", prefix=p)
            for i in range(500)
        )
        for url, table in (("/api/devices/?page_size=50", "api_device"),
                           ("/api/virtual-machines/?page_size=50", "api_virtualmachine")):
            self.client.get(url)
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(url)
            self.assertEqual(r.status_code, 200)
            sqls = [q["sql"] for q in ctx.captured_queries]
            rows = [s for s in sqls if s.startswith("SELECT") and f'FROM "{table}"' in s
                    and "LIMIT" in s]
            self.assertTrue(rows, url)
            self.assertFalse(any('FROM "api_ipaddress"' in s for s in rows), url)
            counting = [s for s in sqls if " UNION " in s and '"api_ipaddress"' in s]
            self.assertEqual(len(counting), 1, url)
