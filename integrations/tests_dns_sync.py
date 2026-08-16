"""DNS sync engine: zone listing, reconciliation, drift, push scripts."""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant
from integrations import dns_sync
from integrations.models import (
    DnsDrift,
    DnsRecord,
    DnsZone,
    WindowsServerConnection,
)

ZONES = [
    {"ZoneName": "danbyte.lan", "zone_type": "Primary",
     "IsReverseLookupZone": False},
    {"ZoneName": "0.77.10.in-addr.arpa", "zone_type": "Primary",
     "IsReverseLookupZone": True},
    {"ZoneName": "TrustAnchors", "zone_type": "Primary",
     "IsReverseLookupZone": False},
]


def records(rows):
    return {
        "records": rows,
        "counts": [{"zone": "danbyte.lan", "n": len(rows)}],
    }


class DnsSyncTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dns_enabled=True,
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def ip(self, addr, dns_name=""):
        return IPAddress.objects.create(
            tenant=self.tenant, ip_address=addr, prefix=self.prefix,
            dns_name=dns_name,
        )

    def sync(self, zone_payload=None, record_payload=None):
        payloads = [zone_payload if zone_payload is not None else ZONES]
        if DnsZone.objects.filter(connection=self.conn, sync=True).exists():
            payloads.append(record_payload or records([]))
        with mock.patch.object(dns_sync, "run_json", side_effect=payloads):
            return dns_sync.sync_dns(self.conn)

    def test_zone_listing_skips_system_zones(self):
        counts = self.sync()
        self.assertEqual(counts["zones"], 2)
        names = set(DnsZone.objects.values_list("name", flat=True))
        self.assertEqual(names, {"danbyte.lan", "0.77.10.in-addr.arpa"})

    def test_blank_dns_name_filled_from_a_record(self):
        row = self.ip("10.77.0.60")
        self.sync()
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)
        counts = self.sync(record_payload=records([
            {"zone": "danbyte.lan", "HostName": "printer-1", "rtype": "A",
             "data": "10.77.0.60"},
        ]))
        row.refresh_from_db()
        self.assertEqual(row.dns_name, "printer-1.danbyte.lan")
        self.assertEqual(counts["filled"], 1)
        self.assertEqual(counts["drift"], 0)

    def test_mismatch_becomes_drift_not_overwrite(self):
        row = self.ip("10.77.0.60", dns_name="mine.danbyte.lan")
        self.sync()
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)
        counts = self.sync(record_payload=records([
            {"zone": "danbyte.lan", "HostName": "theirs", "rtype": "A",
             "data": "10.77.0.60"},
        ]))
        row.refresh_from_db()
        self.assertEqual(row.dns_name, "mine.danbyte.lan")  # untouched
        d = DnsDrift.objects.get()
        self.assertEqual(d.kind, "mismatch")
        self.assertEqual(d.server_name, "theirs.danbyte.lan")
        self.assertEqual(counts["drift"], 1)

    def test_missing_record_detected_for_zone_names(self):
        self.ip("10.77.0.61", dns_name="ghost.danbyte.lan")
        self.sync()
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)
        self.sync(record_payload=records([]))
        d = DnsDrift.objects.get()
        self.assertEqual(d.kind, "missing_record")
        self.assertEqual(d.record_type, "A")
        self.assertEqual(d.danbyte_name, "ghost.danbyte.lan")

    def test_settled_drift_rows_pruned(self):
        row = self.ip("10.77.0.60", dns_name="mine.danbyte.lan")
        self.sync()
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)
        mismatch = records([
            {"zone": "danbyte.lan", "HostName": "theirs", "rtype": "A",
             "data": "10.77.0.60"},
        ])
        self.sync(record_payload=mismatch)
        self.assertEqual(DnsDrift.objects.count(), 1)
        row.dns_name = "theirs.danbyte.lan"  # operator settled it by hand
        row.save(update_fields=["dns_name"])
        self.sync(record_payload=mismatch)
        self.assertEqual(DnsDrift.objects.count(), 0)

    def test_ptr_reconciles_against_dns_name(self):
        self.ip("10.77.0.60", dns_name="mine.danbyte.lan")
        self.sync()
        DnsZone.objects.filter(name="0.77.10.in-addr.arpa").update(sync=True)
        self.sync(record_payload={
            "records": [{"zone": "0.77.10.in-addr.arpa", "HostName": "60",
                         "rtype": "PTR", "data": "theirs.danbyte.lan."}],
            "counts": [{"zone": "0.77.10.in-addr.arpa", "n": 1}],
        })
        d = DnsDrift.objects.get()
        self.assertEqual(d.record_type, "PTR")
        self.assertEqual(d.ip, "10.77.0.60")
        self.assertEqual(d.server_name, "theirs.danbyte.lan")

    def test_ip_with_multiple_names_matches_any(self):
        """AD apex + ForestDnsZones both point at the DC — matching the apex
        is in sync, not drift."""
        row = self.ip("10.0.0.45", dns_name="danbyte.lan")
        self.sync()
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)
        counts = self.sync(record_payload=records([
            {"zone": "danbyte.lan", "HostName": "@", "rtype": "A",
             "data": "10.0.0.45"},
            {"zone": "danbyte.lan", "HostName": "ForestDnsZones", "rtype": "A",
             "data": "10.0.0.45"},
            {"zone": "danbyte.lan", "HostName": "DomainDnsZones", "rtype": "A",
             "data": "10.0.0.45"},
        ]))
        row.refresh_from_db()
        self.assertEqual(row.dns_name, "danbyte.lan")
        self.assertEqual(counts["drift"], 0)
        self.assertEqual(DnsDrift.objects.count(), 0)

    def test_blank_fill_prefers_real_host_over_ad_helpers(self):
        row = self.ip("10.0.0.45")
        self.sync()
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)
        self.sync(record_payload=records([
            {"zone": "danbyte.lan", "HostName": "ForestDnsZones", "rtype": "A",
             "data": "10.0.0.45"},
            {"zone": "danbyte.lan", "HostName": "db-dc", "rtype": "A",
             "data": "10.0.0.45"},
            {"zone": "danbyte.lan", "HostName": "@", "rtype": "A",
             "data": "10.0.0.45"},
        ]))
        row.refresh_from_db()
        self.assertEqual(row.dns_name, "db-dc.danbyte.lan")

    def test_mismatch_only_when_no_server_name_matches(self):
        row = self.ip("10.0.0.45", dns_name="wrong.danbyte.lan")
        self.sync()
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)
        counts = self.sync(record_payload=records([
            {"zone": "danbyte.lan", "HostName": "db-dc", "rtype": "A",
             "data": "10.0.0.45"},
            {"zone": "danbyte.lan", "HostName": "@", "rtype": "A",
             "data": "10.0.0.45"},
        ]))
        self.assertEqual(counts["drift"], 1)
        d = DnsDrift.objects.get()
        self.assertIn("db-dc.danbyte.lan", d.server_name)
        self.assertIn("danbyte.lan", d.server_name)

    def test_push_script_for_mismatch_rewrites_record(self):
        zone = DnsZone.objects.create(
            connection=self.conn, name="danbyte.lan", sync=True
        )
        row = self.ip("10.77.0.60", dns_name="mine.danbyte.lan")
        drift = DnsDrift.objects.create(
            zone=zone, kind="mismatch", record_type="A", ip="10.77.0.60",
            ip_address=row, danbyte_name="mine.danbyte.lan",
            server_name="theirs.danbyte.lan",
        )
        with mock.patch.object(dns_sync, "run_ps") as run:
            dns_sync.push_record(self.conn, zone, drift)
        script = run.call_args[0][1]
        self.assertIn("Remove-DnsServerResourceRecord", script)
        self.assertIn("-Name 'theirs'", script)
        self.assertIn("Add-DnsServerResourceRecordA", script)
        self.assertIn("-Name 'mine'", script)
        self.assertIn("-IPv4Address '10.77.0.60'", script)

    def test_push_refuses_name_outside_zone(self):
        zone = DnsZone.objects.create(
            connection=self.conn, name="danbyte.lan", sync=True
        )
        row = self.ip("10.77.0.60", dns_name="mine.other.zone")
        drift = DnsDrift.objects.create(
            zone=zone, kind="missing_record", record_type="A", ip="10.77.0.60",
            ip_address=row, danbyte_name="mine.other.zone",
        )
        with self.assertRaises(ValueError):
            dns_sync.push_record(self.conn, zone, drift)

    def test_push_ptr_uses_zone_relative_name(self):
        zone = DnsZone.objects.create(
            connection=self.conn, name="0.77.10.in-addr.arpa", sync=True,
            is_reverse=True,
        )
        row = self.ip("10.77.0.60", dns_name="mine.danbyte.lan")
        drift = DnsDrift.objects.create(
            zone=zone, kind="mismatch", record_type="PTR", ip="10.77.0.60",
            ip_address=row, danbyte_name="mine.danbyte.lan",
            server_name="theirs.danbyte.lan",
        )
        with mock.patch.object(dns_sync, "run_ps") as run:
            dns_sync.push_record(self.conn, zone, drift)
        script = run.call_args[0][1]
        self.assertIn("Add-DnsServerResourceRecordPtr", script)
        self.assertIn("-Name '60'", script)
        self.assertIn("-PtrDomainName 'mine.danbyte.lan.'", script)

    def test_zone_gone_on_server_removed(self):
        self.sync()
        self.assertEqual(DnsZone.objects.count(), 2)
        self.sync(zone_payload=[ZONES[0]])
        names = set(DnsZone.objects.values_list("name", flat=True))
        self.assertEqual(names, {"danbyte.lan"})


class DnsRecordStoreTests(TestCase):
    """A/AAAA/PTR records are persisted for reconciled zones and linked to IPs."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dns_enabled=True,
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def ip(self, addr, dns_name=""):
        return IPAddress.objects.create(
            tenant=self.tenant, ip_address=addr, prefix=self.prefix,
            dns_name=dns_name,
        )

    def sync(self, record_payload):
        zones = [{"ZoneName": "danbyte.lan", "zone_type": "Primary",
                  "IsReverseLookupZone": False}]
        with mock.patch.object(dns_sync, "run_json", side_effect=[zones, record_payload]):
            return dns_sync.sync_dns(self.conn)

    def _enable(self):
        # First pass lists the zone; enable reconcile, then records land.
        with mock.patch.object(
            dns_sync, "run_json",
            return_value=[{"ZoneName": "danbyte.lan", "zone_type": "Primary",
                           "IsReverseLookupZone": False}],
        ):
            dns_sync.sync_dns(self.conn)
        DnsZone.objects.filter(name="danbyte.lan").update(sync=True)

    def test_records_persisted_and_linked(self):
        row = self.ip("10.77.0.60")
        self._enable()
        self.sync({
            "records": [
                {"zone": "danbyte.lan", "HostName": "printer-1", "rtype": "A",
                 "data": "10.77.0.60"},
                {"zone": "danbyte.lan", "HostName": "unknown", "rtype": "A",
                 "data": "10.77.0.250"},
            ],
            "counts": [{"zone": "danbyte.lan", "n": 2}],
        })
        recs = DnsRecord.objects.order_by("name")
        self.assertEqual(recs.count(), 2)
        linked = DnsRecord.objects.get(name="printer-1.danbyte.lan")
        self.assertEqual(linked.ip, "10.77.0.60")
        self.assertEqual(linked.ip_address, row)
        # A record for an address not in IPAM is stored but unlinked.
        unlinked = DnsRecord.objects.get(name="unknown.danbyte.lan")
        self.assertIsNone(unlinked.ip_address)

    def test_records_pruned_when_gone(self):
        self._enable()
        payload_two = {
            "records": [
                {"zone": "danbyte.lan", "HostName": "a", "rtype": "A",
                 "data": "10.77.0.1"},
                {"zone": "danbyte.lan", "HostName": "b", "rtype": "A",
                 "data": "10.77.0.2"},
            ],
            "counts": [{"zone": "danbyte.lan", "n": 2}],
        }
        self.sync(payload_two)
        self.assertEqual(DnsRecord.objects.count(), 2)
        # b removed on the server → pruned locally.
        self.sync({
            "records": [{"zone": "danbyte.lan", "HostName": "a", "rtype": "A",
                         "data": "10.77.0.1"}],
            "counts": [{"zone": "danbyte.lan", "n": 1}],
        })
        self.assertEqual(DnsRecord.objects.count(), 1)
        self.assertEqual(DnsRecord.objects.get().name, "a.danbyte.lan")

    def test_records_cleared_when_reconcile_disabled(self):
        self._enable()
        self.sync({
            "records": [{"zone": "danbyte.lan", "HostName": "a", "rtype": "A",
                         "data": "10.77.0.1"}],
            "counts": [{"zone": "danbyte.lan", "n": 1}],
        })
        self.assertEqual(DnsRecord.objects.count(), 1)
        DnsZone.objects.filter(name="danbyte.lan").update(sync=False)
        with mock.patch.object(
            dns_sync, "run_json",
            return_value=[{"ZoneName": "danbyte.lan", "zone_type": "Primary",
                           "IsReverseLookupZone": False}],
        ):
            dns_sync.sync_dns(self.conn)
        self.assertEqual(DnsRecord.objects.count(), 0)


class DnsImportTests(TestCase):
    """Manual import + opt-in auto-create of untracked DNS addresses."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dns_enabled=True,
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.zone = DnsZone.objects.create(
            connection=self.conn, name="danbyte.lan", sync=True
        )

    def _record(self, ip, name="host.danbyte.lan", rtype="A"):
        return DnsRecord.objects.create(
            zone=self.zone, name=name, record_type=rtype, data=ip, ip=ip,
        )

    def test_import_creates_and_links_ip(self):
        rec = self._record("10.77.0.80")
        row = dns_sync.import_record(rec)
        self.assertEqual(row.ip_address, "10.77.0.80")
        self.assertEqual(row.dns_name, "host.danbyte.lan")
        self.assertEqual(row.prefix, self.prefix)
        rec.refresh_from_db()
        self.assertEqual(rec.ip_address, row)

    def test_import_without_prefix_raises(self):
        rec = self._record("192.0.99.5")  # no containing prefix
        with self.assertRaises(dns_sync.DnsImportError):
            dns_sync.import_record(rec)

    def test_import_adopts_existing_ip(self):
        existing = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.77.0.80", prefix=self.prefix
        )
        rec = self._record("10.77.0.80")
        row = dns_sync.import_record(rec)
        self.assertEqual(row, existing)
        self.assertEqual(IPAddress.objects.filter(ip_address="10.77.0.80").count(), 1)
        row.refresh_from_db()
        self.assertEqual(row.dns_name, "host.danbyte.lan")  # blank-filled

    def test_auto_create_on_reconcile(self):
        self.zone.auto_create = True
        self.zone.save(update_fields=["auto_create"])
        with mock.patch.object(
            dns_sync, "run_json",
            side_effect=[
                [{"ZoneName": "danbyte.lan", "zone_type": "Primary",
                  "IsReverseLookupZone": False}],
                {"records": [
                    {"zone": "danbyte.lan", "HostName": "new-host", "rtype": "A",
                     "data": "10.77.0.90"},
                    {"zone": "danbyte.lan", "HostName": "off-net", "rtype": "A",
                     "data": "192.0.99.9"},  # no prefix → stays unlinked
                ], "counts": [{"zone": "danbyte.lan", "n": 2}]},
            ],
        ):
            dns_sync.sync_dns(self.conn)
        self.assertTrue(
            IPAddress.objects.filter(ip_address="10.77.0.90").exists()
        )
        self.assertFalse(
            IPAddress.objects.filter(ip_address="192.0.99.9").exists()
        )
        linked = DnsRecord.objects.get(data="10.77.0.90")
        self.assertIsNotNone(linked.ip_address)
        unlinked = DnsRecord.objects.get(data="192.0.99.9")
        self.assertIsNone(unlinked.ip_address)
