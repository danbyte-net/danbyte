"""Live interface traffic: ``monitoring.iface_live`` and its endpoint.

Rates come from the newest two stored SNMP samples of each port, mapped to
interfaces by the observed name as drift does; the endpoint is tenant- and
interface-view scoped and costs a fixed number of queries per batch.
"""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Interface, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from monitoring.iface_live import live_rates
from monitoring.models import DeviceSnmp, MonitoringSettings, SnmpInterfaceSample

User = get_user_model()
URL = "/api/monitoring/interfaces/live/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="hq")
        self.now = timezone.now()
        self.sw = self.switch("sw1", self.site)
        self.gi1 = Interface.objects.create(device=self.sw, name="Gi1/0/1")
        self.gi2 = Interface.objects.create(device=self.sw, name="Gi1/0/2")
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def switch(self, name, site, tenant=None):
        tenant = tenant or self.tenant
        dev = Device.objects.create(tenant=tenant, name=name, site=site)
        DeviceSnmp.objects.create(
            tenant=tenant, device=dev, polled_at=self.now,
            interfaces=[
                {"if_index": "1", "name": "Gi1/0/1", "descr": "GigabitEthernet1/0/1"},
                {"if_index": "2", "name": "Gi1/0/2", "descr": "GigabitEthernet1/0/2"},
            ],
        )
        return dev

    def sample(self, dev, idx, minutes_ago, in_oct, out_oct, speed=1000, tenant=None):
        SnmpInterfaceSample.objects.create(
            tenant=tenant or self.tenant, device=dev, if_index=idx,
            in_octets=in_oct, out_octets=out_oct, speed_mbps=speed,
            sampled_at=self.now - timedelta(minutes=minutes_ago),
        )

    def user_with(self, types, sites=()):
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"p{user.pk}", object_types=list(types), actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        return user

    def get(self, *ifaces):
        return self.client.get(URL, {"ids": ",".join(str(i.id) for i in ifaces)})


class ResolverTests(_Base):
    def rates(self, *ifaces):
        qs = Interface.objects.filter(pk__in=[i.pk for i in ifaces]).select_related("device")
        return live_rates(self.tenant, qs, now=self.now)

    def test_rate_is_the_last_two_samples_difference(self):
        # 300 s apart: 37.5 MB in = 1 Mbit/s; 75 MB out = 2 Mbit/s.
        self.sample(self.sw, "1", 20, 0, 0)  # older, ignored
        self.sample(self.sw, "1", 10, 1_000_000, 2_000_000)
        self.sample(self.sw, "1", 5, 38_500_000, 77_000_000)
        r = self.rates(self.gi1)[self.gi1.id]
        self.assertEqual(r["in_bps"], 1_000_000)
        self.assertEqual(r["out_bps"], 2_000_000)
        self.assertEqual(r["speed_mbps"], 1000)
        self.assertEqual(r["interval_s"], 300)

    def test_one_sample_is_no_rate(self):
        self.sample(self.sw, "1", 5, 10, 10)
        self.assertIsNone(self.rates(self.gi1)[self.gi1.id])

    def test_a_stale_rate_is_no_rate(self):
        self.sample(self.sw, "1", 200, 0, 0)
        self.sample(self.sw, "1", 190, 100, 100)
        self.assertIsNone(self.rates(self.gi1)[self.gi1.id])

    def test_a_long_poll_interval_stretches_the_staleness_window(self):
        MonitoringSettings.objects.create(tenant=self.tenant, snmp_poll_interval_minutes=60)
        self.sample(self.sw, "1", 200, 0, 0)
        self.sample(self.sw, "1", 150, 100, 100)
        self.assertIsNotNone(self.rates(self.gi1)[self.gi1.id])

    def test_a_counter_reset_drops_only_that_direction(self):
        self.sample(self.sw, "1", 10, 5_000_000, 0)
        self.sample(self.sw, "1", 5, 1_000, 3_750_000)
        r = self.rates(self.gi1)[self.gi1.id]
        self.assertIsNone(r["in_bps"])
        self.assertEqual(r["out_bps"], 100_000)

    def test_an_unobserved_interface_has_no_rate(self):
        ghost = Interface.objects.create(device=self.sw, name="Te1/1/1")
        self.sample(self.sw, "1", 10, 0, 0)
        self.sample(self.sw, "1", 5, 10, 10)
        self.assertIsNone(self.rates(ghost)[ghost.id])

    def test_an_snmp_name_link_maps_the_port(self):
        linked = Interface.objects.create(device=self.sw, name="uplink", snmp_name="Gi1/0/2")
        Interface.objects.filter(pk=self.gi2.pk).delete()
        self.sample(self.sw, "2", 10, 0, 0)
        self.sample(self.sw, "2", 5, 0, 3_750_000)
        self.assertEqual(self.rates(linked)[linked.id]["out_bps"], 100_000)


class EndpointTests(_Base):
    def test_batch_answer_with_as_of(self):
        for idx in ("1", "2"):
            self.sample(self.sw, idx, 10, 0, 0)
            self.sample(self.sw, idx, 5, 3_750_000, 0)
        r = self.get(self.gi1, self.gi2)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["interfaces"][str(self.gi1.id)]["in_bps"], 100_000)
        self.assertEqual(body["interfaces"][str(self.gi2.id)]["in_bps"], 100_000)
        self.assertIsNotNone(body["as_of"])

    def test_queries_do_not_grow_with_the_batch(self):
        def count(n):
            devs = [self.switch(f"x{n}-{i}", self.site) for i in range(n)]
            ifaces = []
            for d in devs:
                i = Interface.objects.create(device=d, name="Gi1/0/1")
                self.sample(d, "1", 10, 0, 0)
                self.sample(d, "1", 5, 100, 100)
                ifaces.append(i)
            with CaptureQueriesContext(connection) as ctx:
                r = self.get(*ifaces)
            self.assertEqual(r.status_code, 200)
            return len(ctx.captured_queries)

        self.assertEqual(count(2), count(8))

    def test_bad_ids_are_a_400(self):
        self.assertEqual(self.client.get(URL, {"ids": "nope"}).status_code, 400)
        many = ",".join(str(self.gi1.id) for _ in range(501))
        self.assertEqual(self.client.get(URL, {"ids": many}).status_code, 400)

    def test_another_tenants_interface_is_absent(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = self.switch("theirs", Site.objects.create(tenant=other, name="s"), tenant=other)
        port = Interface.objects.create(device=theirs, name="Gi1/0/1")
        self.sample(theirs, "1", 10, 0, 0, tenant=other)
        self.sample(theirs, "1", 5, 100, 100, tenant=other)
        r = self.get(port)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["interfaces"], {})

    def test_site_scoped_viewer_sees_only_their_sites_ports(self):
        branch = Site.objects.create(tenant=self.tenant, name="branch")
        far = self.switch("far", branch)
        far_port = Interface.objects.create(device=far, name="Gi1/0/1")
        for dev in (self.sw, far):
            self.sample(dev, "1", 10, 0, 0)
            self.sample(dev, "1", 5, 100, 100)
        self.login(self.user_with(["interface", "device"], sites=[self.site]))
        body = self.get(self.gi1, far_port).json()
        self.assertIn(str(self.gi1.id), body["interfaces"])
        self.assertNotIn(str(far_port.id), body["interfaces"])

    def test_without_interface_view_nothing_is_answered(self):
        self.sample(self.sw, "1", 10, 0, 0)
        self.sample(self.sw, "1", 5, 100, 100)
        self.login(self.user_with(["device"]))
        r = self.get(self.gi1)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["interfaces"], {})

    def test_anonymous_is_refused(self):
        self.client.logout()
        self.assertIn(self.get(self.gi1).status_code, (401, 403))
