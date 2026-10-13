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


class BulkStatusQueryTests(APITestCase):
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
