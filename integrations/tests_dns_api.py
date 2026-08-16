"""DNS API: zone opt-in, drift resolution, toggle gating."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant
from integrations.models import (
    DnsDrift,
    DnsRecord,
    DnsZone,
    IntegrationSettings,
    WindowsServerConnection,
)


class DnsApiTests(APITestCase):
    def setUp(self):
        from auth_api.models import ObjectPermission, UserProfile

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.create(tenant=self.tenant, dns_sync_enabled=True)
        self.conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dns_enabled=True,
        )
        self.zone = DnsZone.objects.create(
            connection=self.conn, name="danbyte.lan", zone_type="Primary"
        )
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.77.0.60", prefix=prefix,
            dns_name="mine.danbyte.lan",
        )
        self.user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="dns-op", object_types=["dnszone", "dnsdrift", "dnsrecord"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.user)
        p.tenants.set([self.tenant])
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def drift(self, **over):
        base = dict(
            zone=self.zone, kind="mismatch", record_type="A", ip="10.77.0.60",
            ip_address=self.ip, danbyte_name="mine.danbyte.lan",
            server_name="theirs.danbyte.lan",
        )
        base.update(over)
        return DnsDrift.objects.create(**base)

    def test_zone_patch_only_sync_flag(self):
        res = self.client.patch(
            f"/api/dns-zones/{self.zone.id}/",
            {"sync": True, "name": "hijack.lan"}, format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.zone.refresh_from_db()
        self.assertTrue(self.zone.sync)
        self.assertEqual(self.zone.name, "danbyte.lan")

    def test_resolve_accept_mismatch_takes_server_name(self):
        d = self.drift()
        res = self.client.post(
            f"/api/dns-drifts/{d.id}/resolve/", {"strategy": "accept"},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "theirs.danbyte.lan")
        self.assertEqual(DnsDrift.objects.count(), 0)

    def test_resolve_accept_missing_record_clears_name(self):
        d = self.drift(kind="missing_record", server_name="")
        self.client.post(
            f"/api/dns-drifts/{d.id}/resolve/", {"strategy": "accept"},
            format="json",
        )
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "")

    def test_resolve_push_calls_server_and_clears(self):
        d = self.drift()
        with mock.patch("integrations.dns_sync.push_record") as push:
            res = self.client.post(
                f"/api/dns-drifts/{d.id}/resolve/", {"strategy": "push"},
                format="json",
            )
        self.assertEqual(res.status_code, 200, res.content)
        push.assert_called_once()
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "mine.danbyte.lan")
        self.assertEqual(DnsDrift.objects.count(), 0)

    def test_endpoints_404_without_toggle(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(
            dns_sync_enabled=False
        )
        self.assertEqual(self.client.get("/api/dns-zones/").status_code, 404)
        self.assertEqual(self.client.get("/api/dns-drifts/").status_code, 404)

    def test_records_endpoint_filters(self):
        self.zone.sync = True
        self.zone.save(update_fields=["sync"])
        other_prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        other_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.5", prefix=other_prefix
        )
        DnsRecord.objects.create(
            zone=self.zone, name="a.danbyte.lan", record_type="A",
            data="10.77.0.60", ip="10.77.0.60", ip_address=self.ip,
        )
        DnsRecord.objects.create(
            zone=self.zone, name="b.danbyte.lan", record_type="A",
            data="10.9.0.5", ip="10.9.0.5", ip_address=other_ip,
        )
        # All records
        res = self.client.get("/api/dns-records/")
        self.assertEqual(res.json()["count"], 2)
        # By prefix — only the record whose IP is in that prefix
        res = self.client.get(f"/api/dns-records/?prefix={self.ip.prefix_id}")
        self.assertEqual(res.json()["count"], 1)
        self.assertEqual(res.json()["results"][0]["name"], "a.danbyte.lan")
        # By ip
        res = self.client.get("/api/dns-records/?ip=10.9.0.5")
        self.assertEqual(res.json()["count"], 1)
        # Search
        res = self.client.get("/api/dns-records/?search=b.danbyte")
        self.assertEqual(res.json()["count"], 1)

    def test_records_404_without_toggle(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(
            dns_sync_enabled=False
        )
        self.assertEqual(self.client.get("/api/dns-records/").status_code, 404)
