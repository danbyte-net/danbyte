"""The list-page monitoring roll-up answers in a fixed number of queries (#416).

``POST /api/monitoring/status/`` with every device or VM id on a list page used
to run one CheckState query per target. Each test rolls up a small and a bigger
set of the same targets and expects the same query count, then checks the
figures and the site scoping."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    Prefix,
    Site,
    VirtualMachine,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import CheckState, CheckTemplate


class _BulkStatusBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.7.0.0/16")
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp", rise=1, fall=1,
        )
        self.tcp = CheckTemplate.objects.create(
            tenant=self.tenant, name="ssh", slug="ssh", kind="tcp", params={"port": 22},
            rise=1, fall=1,
        )
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        self.now = timezone.now()
        self.devices: list[Device] = []
        self.vms: list[VirtualMachine] = []
        for i in range(12):
            site = self.site_a if i % 2 == 0 else self.site_b
            dev = Device.objects.create(tenant=self.tenant, name=f"sw{i}", site=site)
            self.devices.append(dev)
            up = self._ip(f"10.7.1.{i + 1}", site, assigned_device=dev)
            down = self._ip(f"10.7.2.{i + 1}", site, assigned_device=dev)
            self._state(up, self.ping, "up")
            self._state(up, self.tcp, "up")
            self._state(down, self.ping, "down")
            vm = VirtualMachine.objects.create(
                tenant=self.tenant, name=f"vm{i}", cluster=self.cluster, site=site,
            )
            self.vms.append(vm)
            vip = self._ip(f"10.7.3.{i + 1}", site, assigned_vm=vm)
            self._state(vip, self.ping, "up")
        # A device with an address but no checks rolls up to nothing.
        self.bare = Device.objects.create(tenant=self.tenant, name="bare", site=self.site_a)
        self._ip("10.7.9.1", self.site_a, assigned_device=self.bare)
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(admin)

    def _ip(self, addr, site, **kw):
        return IPAddress.objects.create(
            tenant=self.tenant, ip_address=addr, prefix=self.prefix, site=site, **kw,
        )

    def _state(self, ip, template, status):
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=template, kind=template.kind,
            status=status, since=self.now - timedelta(hours=1),
            next_run=self.now + timedelta(minutes=5),
        )

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, key, objs) -> tuple[int, dict]:
        body = {key: [str(o.id) for o in objs]}
        # The first call pays one-off lookups; count the second.
        self.client.post("/api/monitoring/status/", body, format="json")
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post("/api/monitoring/status/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()["statuses"]


class BulkStatusQueryTests(_BulkStatusBase):
    def test_device_rollup_cost_is_flat(self):
        small, _ = self._post("devices", self.devices[:2])
        big, out = self._post("devices", self.devices + [self.bare])
        self.assertEqual(small, big, "more devices must not cost more queries")
        self.assertEqual(len(out), 12)
        self.assertNotIn(str(self.bare.id), out)
        row = out[str(self.devices[0].id)]
        self.assertEqual(row["status"], "down")
        self.assertEqual(row["counts"], {"up": 2, "down": 1})
        self.assertEqual(row["monitored_ips"], 2)

    def test_vm_rollup_cost_is_flat(self):
        small, _ = self._post("vms", self.vms[:2])
        big, out = self._post("vms", self.vms)
        self.assertEqual(small, big, "more VMs must not cost more queries")
        self.assertEqual(len(out), 12)
        row = out[str(self.vms[3].id)]
        self.assertEqual(row["status"], "up")
        self.assertEqual(row["counts"], {"up": 1})
        self.assertEqual(row["monitored_ips"], 1)

    def test_site_scoped_member_rolls_up_only_their_site(self):
        user = User.objects.create_user("member", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="site-a", object_types=["device", "virtualmachine", "ipaddress"],
            actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)
        self._login(user)
        small, _ = self._post("devices", self.devices[:2])
        big, out = self._post("devices", self.devices)
        self.assertEqual(small, big)
        expected = {str(d.id) for d in self.devices if d.site_id == self.site_a.id}
        self.assertEqual(set(out), expected)
        _, vms = self._post("vms", self.vms)
        self.assertEqual(set(vms), {str(v.id) for v in self.vms if v.site_id == self.site_a.id})


class PrefixBulkStatusTests(_BulkStatusBase):
    """The prefix roll-up (#430): the list page posts every prefix id, and the
    roll-up used to read every IP of the tenant into Python per prefix, behind
    a 500-id cap that blanked the column on a bigger tenant."""

    def setUp(self):
        super().setUp()
        from api.models import VRF

        self.p1 = Prefix.objects.create(tenant=self.tenant, cidr="10.7.1.0/24")
        self.p2 = Prefix.objects.create(tenant=self.tenant, cidr="10.7.2.0/24")
        self.p9 = Prefix.objects.create(tenant=self.tenant, cidr="10.7.9.0/24")
        self.empty = Prefix.objects.create(tenant=self.tenant, cidr="10.8.0.0/24")
        self.v6 = Prefix.objects.create(tenant=self.tenant, cidr="2001:db8::/64")
        # The same space in a VRF holds other addresses.
        self.vrf = VRF.objects.create(tenant=self.tenant, name="red")
        self.vrf_p1 = Prefix.objects.create(
            tenant=self.tenant, cidr="10.7.1.0/24", vrf=self.vrf
        )
        vrf_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.7.1.1", vrf=self.vrf, site=self.site_a,
            prefix=self.vrf_p1,
        )
        self._state(vrf_ip, self.ping, "down")
        v6_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="2001:db8::5", site=self.site_a, prefix=self.v6,
        )
        self._state(v6_ip, self.ping, "up")
        # Many more prefixes to grow the request with.
        self.more = [
            Prefix.objects.create(tenant=self.tenant, cidr=f"10.7.{i}.0/28")
            for i in range(10, 40)
        ]

    def _all(self):
        return [self.prefix, self.p1, self.p2, self.p9, self.empty, self.v6,
                self.vrf_p1, *self.more]

    def test_prefix_rollup_cost_is_flat(self):
        small, _ = self._post("prefixes", [self.prefix, self.p1])
        big, out = self._post("prefixes", self._all())
        self.assertEqual(small, big, "more prefixes must not cost more queries")
        whole = out[str(self.prefix.id)]
        self.assertEqual(whole["status"], "down")
        self.assertEqual(whole["counts"], {"up": 36, "down": 12})
        # Only the addresses with a check count: 10.7.9.1 has none.
        self.assertEqual(whole["monitored_ips"], 36)
        self.assertEqual(out[str(self.p1.id)]["counts"], {"up": 24})
        self.assertEqual(out[str(self.p1.id)]["monitored_ips"], 12)
        self.assertEqual(out[str(self.p2.id)]["status"], "down")
        self.assertEqual(out[str(self.v6.id)]["counts"], {"up": 1})
        for bare in (self.p9, self.empty, *self.more):
            self.assertNotIn(str(bare.id), out)

    def test_vrf_keeps_its_own_addresses(self):
        _, out = self._post("prefixes", [self.p1, self.vrf_p1])
        self.assertEqual(out[str(self.vrf_p1.id)]["counts"], {"down": 1})
        self.assertEqual(out[str(self.vrf_p1.id)]["monitored_ips"], 1)
        self.assertEqual(out[str(self.p1.id)]["counts"], {"up": 24})

    def test_matches_the_prefix_page(self):
        _, out = self._post("prefixes", self._all())
        for p in self._all():
            page = self.client.get(f"/api/monitoring/prefixes/{p.id}/checks/").json()
            row = out.get(str(p.id))
            # The worst status and the monitored addresses agree: the list
            # counts what the page counts as monitored, not every child.
            self.assertEqual(row["status"] if row else None, page["rollup"]["status"], p.cidr)
            if row:
                self.assertEqual(row["monitored_ips"], page["rollup"]["monitored_ips"], p.cidr)

    def test_excluded_address_is_left_out(self):
        ip = IPAddress.objects.get(tenant=self.tenant, ip_address="10.7.2.1", vrf=None)
        IPAddress.objects.filter(pk=ip.pk).update(monitoring_excluded=True)
        _, out = self._post("prefixes", [self.p2])
        self.assertEqual(out[str(self.p2.id)]["counts"], {"down": 11})

    def test_address_stored_with_a_mask_still_counts(self):
        # A row from before the host-only field reads back bare; containment
        # must agree with it.
        from .views import _child_ip_ids

        ip = IPAddress.objects.get(tenant=self.tenant, ip_address="10.7.1.1", vrf=None)
        with connection.cursor() as c:
            c.execute(
                "UPDATE api_ipaddress SET ip_address = '10.7.1.1/16' WHERE id = %s", [ip.pk]
            )
        _, out = self._post("prefixes", [self.p1])
        self.assertEqual(out[str(self.p1.id)]["monitored_ips"], 12)
        self.assertIn(ip.pk, _child_ip_ids(self.p1, self.tenant))

    def test_site_scoped_member_rolls_up_only_their_addresses(self):
        user = User.objects.create_user("member-p", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        prefixes = ObjectPermission.objects.create(
            name="prefixes", object_types=["prefix"], actions=["view"],
        )
        ips = ObjectPermission.objects.create(
            name="site-a-ips", object_types=["ipaddress"], actions=["view"],
        )
        for perm in (prefixes, ips):
            perm.users.add(user)
            perm.tenants.add(self.tenant)
        ips.sites.add(self.site_a)
        self._login(user)
        small, _ = self._post("prefixes", [self.prefix])
        big, out = self._post("prefixes", self._all())
        self.assertEqual(small, big)
        whole = out[str(self.prefix.id)]
        self.assertEqual(whole["counts"], {"up": 18, "down": 6})
        self.assertEqual(whole["monitored_ips"], 18)  # 10.7.9.1 has no check

    def test_a_hidden_prefix_rolls_up_nothing(self):
        user = User.objects.create_user("member-q", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="ips", object_types=["ipaddress"], actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self._login(user)
        _, out = self._post("prefixes", self._all())
        self.assertEqual(out, {})

    def test_span_filter_is_not_correlated(self):
        # The candidate addresses run as a subquery of the check-state query.
        # A span test naming ``api_ipaddress`` bound to the outer query's join
        # there, and Postgres re-ran the subquery per check state (#437).
        body = {"prefixes": [str(p.id) for p in self._all()]}
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post("/api/monitoring/status/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        sqls = [q["sql"] for q in ctx.captured_queries]
        self.assertFalse([s for s in sqls if "host(api_ipaddress." in s])
        states = [s for s in sqls if 'FROM "monitoring_checkstate"' in s and "host(" in s]
        self.assertEqual(len(states), 1, sqls)
        self.assertRegex(states[0], r'host\(U\d+\."ip_address"\)::inet BETWEEN')


class BulkStatusDetailTests(_BulkStatusBase):
    """``detail`` lists the checks behind a device's or VM's roll-up for the
    monitoring bar on its page, worst first, from the same query."""

    def _detail(self, key, objs) -> tuple[int, dict]:
        body = {key: [str(o.id) for o in objs], "detail": True}
        self.client.post("/api/monitoring/status/", body, format="json")
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post("/api/monitoring/status/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()["statuses"]

    def test_device_items_worst_first(self):
        plain, _ = self._post("devices", self.devices[:1])
        cost, out = self._detail("devices", self.devices[:1])
        self.assertEqual(plain, cost, "detail must not cost another query")
        items = out[str(self.devices[0].id)]["items"]
        self.assertEqual(
            [(i["name"], i["address"], i["status"]) for i in items],
            [("ping", "10.7.2.1", "down"), ("ping", "10.7.1.1", "up"),
             ("ssh", "10.7.1.1", "up")],
        )
        self.assertTrue(all(i["since"] and i["ip_id"] and i["kind"] for i in items))

    def test_items_carry_the_last_error_when_not_up(self):
        CheckState.objects.filter(
            target_ip__assigned_device=self.devices[0],
        ).update(last_detail={"error": "timed\n out"})
        _, out = self._detail("devices", self.devices[:1])
        items = out[str(self.devices[0].id)]["items"]
        self.assertEqual(items[0]["status"], "down")
        self.assertEqual(items[0]["error"], "timed out")
        self.assertTrue(all("error" not in i for i in items[1:]))

    def test_vm_items(self):
        _, out = self._detail("vms", self.vms[:1])
        items = out[str(self.vms[0].id)]["items"]
        self.assertEqual([(i["name"], i["status"]) for i in items], [("ping", "up")])

    def test_no_items_without_detail_or_for_a_list(self):
        _, out = self._post("devices", self.devices[:1])
        self.assertNotIn("items", out[str(self.devices[0].id)])
        many = [*self.devices, *self.devices[:1] * 20]
        body = {"devices": [str(d.id) for d in many], "detail": True}
        r = self.client.post("/api/monitoring/status/", body, format="json")
        self.assertNotIn("items", r.json()["statuses"][str(self.devices[0].id)])

    def test_site_scoped_member_sees_only_their_addresses(self):
        user = User.objects.create_user("member-d", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        devices = ObjectPermission.objects.create(
            name="devices", object_types=["device"], actions=["view"],
        )
        ips = ObjectPermission.objects.create(
            name="site-b-ips", object_types=["ipaddress"], actions=["view"],
        )
        for perm in (devices, ips):
            perm.users.add(user)
            perm.tenants.add(self.tenant)
        ips.sites.add(self.site_b)
        self._login(user)
        _, out = self._detail("devices", self.devices[:2])
        self.assertNotIn(str(self.devices[0].id), out)
        items = out[str(self.devices[1].id)]["items"]
        self.assertTrue(all(i["address"].endswith(".2") for i in items))
