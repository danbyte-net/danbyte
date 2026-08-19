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
            name="dns-op",
            object_types=["dnszone", "dnsdrift", "dnsrecord", "ipaddress"],
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

    def test_import_no_prefix_returns_reason_and_suggestion(self):
        rec = DnsRecord.objects.create(
            zone=self.zone, name="v6.danbyte.lan", record_type="AAAA",
            data="2a09:5e41:b04:40:9d4:1166:767:5034",
            ip="2a09:5e41:b04:40:9d4:1166:767:5034",
        )
        res = self.client.post(f"/api/dns-records/{rec.id}/import/", {},
                               format="json")
        self.assertEqual(res.status_code, 400, res.content)
        body = res.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["reason"], "no_prefix")
        self.assertEqual(body["suggested_prefix"], "2a09:5e41:b04:40::/64")
        # Create the suggested prefix, then the retry succeeds.
        Prefix.objects.create(tenant=self.tenant, cidr="2a09:5e41:b04:40::/64")
        res2 = self.client.post(f"/api/dns-records/{rec.id}/import/", {},
                                format="json")
        self.assertEqual(res2.status_code, 200, res2.content)
        rec.refresh_from_db()
        self.assertIsNotNone(rec.ip_address_id)

    def test_create_managed_record(self):
        res = self.client.post(
            "/api/dns-records/",
            {"zone": str(self.zone.id), "name": "www.danbyte.lan",
             "record_type": "A", "data": "10.77.0.20", "ttl": "3600"},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        rec = DnsRecord.objects.get(name="www.danbyte.lan")
        self.assertTrue(rec.managed)
        self.assertEqual(rec.ip, "10.77.0.20")

    def test_create_cname_and_txt(self):
        for name, rtype, data in [
            ("alias.danbyte.lan", "CNAME", "www.danbyte.lan"),
            ("danbyte.lan", "TXT", "v=spf1 -all"),
            ("danbyte.lan", "MX", "10 mail.danbyte.lan"),
        ]:
            res = self.client.post(
                "/api/dns-records/",
                {"zone": str(self.zone.id), "name": name,
                 "record_type": rtype, "data": data},
                format="json",
            )
            self.assertEqual(res.status_code, 201, res.content)

    def test_invalid_values_rejected(self):
        for rtype, data in [("A", "not-an-ip"), ("AAAA", "10.0.0.1"),
                            ("MX", "mail-without-priority")]:
            res = self.client.post(
                "/api/dns-records/",
                {"zone": str(self.zone.id), "name": "x.danbyte.lan",
                 "record_type": rtype, "data": data},
                format="json",
            )
            self.assertEqual(res.status_code, 400, (rtype, res.content))

    def test_managed_editable_synced_readonly(self):
        mine = DnsRecord.objects.create(
            zone=self.zone, name="edit.danbyte.lan", record_type="A",
            data="10.77.0.21", ip="10.77.0.21", managed=True,
        )
        synced = DnsRecord.objects.create(
            zone=self.zone, name="synced.danbyte.lan", record_type="A",
            data="10.77.0.22", ip="10.77.0.22", managed=False,
        )
        r1 = self.client.patch(
            f"/api/dns-records/{mine.id}/", {"data": "10.77.0.99"},
            format="json",
        )
        self.assertEqual(r1.status_code, 200, r1.content)
        r2 = self.client.patch(
            f"/api/dns-records/{synced.id}/", {"data": "10.77.0.99"},
            format="json",
        )
        self.assertEqual(r2.status_code, 403)
        self.assertEqual(
            self.client.delete(f"/api/dns-records/{mine.id}/").status_code, 204
        )

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
        # By prefix - only the record whose IP is in that prefix
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

    def test_import_record_creates_ip(self):
        self.zone.sync = True
        self.zone.save(update_fields=["sync"])
        rec = DnsRecord.objects.create(
            zone=self.zone, name="new.danbyte.lan", record_type="A",
            data="10.77.0.88", ip="10.77.0.88",
        )
        res = self.client.post(f"/api/dns-records/{rec.id}/import/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["ok"])
        rec.refresh_from_db()
        self.assertIsNotNone(rec.ip_address)
        self.assertEqual(rec.ip_address.dns_name, "new.danbyte.lan")

    def test_import_no_prefix_reports_error(self):
        self.zone.sync = True
        self.zone.save(update_fields=["sync"])
        rec = DnsRecord.objects.create(
            zone=self.zone, name="off.danbyte.lan", record_type="A",
            data="203.0.113.5", ip="203.0.113.5",
        )
        res = self.client.post(f"/api/dns-records/{rec.id}/import/")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.json()["ok"])

    def test_import_requires_ipaddress_add(self):
        from django.contrib.auth.models import User

        from auth_api.models import ObjectPermission, UserProfile

        viewer = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=viewer).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="dns-view", object_types=["dnszone", "dnsrecord"],
            actions=["view"],
        )
        p.users.add(viewer)
        p.tenants.set([self.tenant])
        self.zone.sync = True
        self.zone.save(update_fields=["sync"])
        rec = DnsRecord.objects.create(
            zone=self.zone, name="x.danbyte.lan", record_type="A",
            data="10.77.0.88", ip="10.77.0.88",
        )
        self.client.force_login(viewer)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        res = self.client.post(f"/api/dns-records/{rec.id}/import/")
        self.assertEqual(res.status_code, 403)

    def test_import_unmatched_bulk(self):
        self.zone.sync = True
        self.zone.save(update_fields=["sync"])
        for i, ip in enumerate(["10.77.0.91", "10.77.0.92", "203.0.113.9"]):
            DnsRecord.objects.create(
                zone=self.zone, name=f"h{i}.danbyte.lan", record_type="A",
                data=ip, ip=ip,
            )
        res = self.client.post(
            "/api/dns-records/import_unmatched/", {"zone": str(self.zone.id)},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["created"], 2)
        self.assertEqual(res.json()["skipped"], 1)  # 203.0.113.9 has no prefix

    def test_zone_auto_create_is_writable(self):
        res = self.client.patch(
            f"/api/dns-zones/{self.zone.id}/", {"auto_create": True},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.zone.refresh_from_db()
        self.assertTrue(self.zone.auto_create)

    def test_create_managed_zone(self):
        res = self.client.post("/api/dns-zones/", {
            "connection": str(self.conn.id), "name": "lab.example.com",
        }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        z = DnsZone.objects.get(name="lab.example.com")
        self.assertTrue(z.managed)

    def test_create_zone_normalises_and_dedupes(self):
        res = self.client.post("/api/dns-zones/", {
            "connection": str(self.conn.id), "name": "DANBYTE.LAN.",
        }, format="json")
        self.assertEqual(res.status_code, 400, res.content)  # collides with self.zone

    def test_delete_managed_zone(self):
        z = DnsZone.objects.create(
            connection=self.conn, name="own.lan", managed=True
        )
        res = self.client.delete(f"/api/dns-zones/{z.id}/")
        self.assertEqual(res.status_code, 204, res.content)
        self.assertFalse(DnsZone.objects.filter(id=z.id).exists())

    def test_cannot_delete_synced_zone(self):
        res = self.client.delete(f"/api/dns-zones/{self.zone.id}/")
        self.assertEqual(res.status_code, 400, res.content)
        self.assertTrue(DnsZone.objects.filter(id=self.zone.id).exists())
