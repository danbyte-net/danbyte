"""DHCP sync engine: mapping, idempotency, adoption, drift, pruning."""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from api.models import IPAddress, IPRange, Prefix
from core.models import Organization, Tenant
from integrations import dhcp_sync
from integrations.models import (
    DhcpExclusion,
    DhcpLease,
    DhcpReservation,
    DhcpScope,
    WindowsServerConnection,
)


def payload(**over):
    base = {
        "scopes": [{
            "scope_id": "10.77.0.0", "Name": "Lab", "Description": "Test scope",
            "state": "Active", "start": "10.77.0.50", "end": "10.77.0.200",
            "mask": "255.255.255.0", "lease_duration": "8.00:00:00",
        }],
        "exclusions": [{
            "scope_id": "10.77.0.0", "start": "10.77.0.100", "end": "10.77.0.119",
        }],
        "reservations": [{
            "scope_id": "10.77.0.0", "ip": "10.77.0.60",
            "mac": "aa-bb-cc-00-11-22", "Name": "printer-1",
            "Description": "Test printer",
        }],
        "options": [{
            "scope_id": "10.77.0.0", "OptionId": 3, "Name": "Router",
            "value": ["10.77.0.1"],
        }],
        "leases": [],
    }
    base.update(over)
    return base


class DhcpSyncTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dhcp_enabled=True,
        )

    def sync(self, data):
        with mock.patch.object(dhcp_sync, "run_json", return_value=data):
            return dhcp_sync.sync_dhcp(self.conn)

    def test_full_sync_maps_all_objects(self):
        counts = self.sync(payload())
        self.assertEqual(counts["scopes"], 1)
        self.assertEqual(counts["prefixes_created"], 1)

        prefix = Prefix.objects.get(tenant=self.tenant, cidr="10.77.0.0/24")
        scope = DhcpScope.objects.get(connection=self.conn, scope_id="10.77.0.0")
        self.assertEqual(scope.prefix, prefix)
        self.assertEqual(scope.options[0]["name"], "Router")

        rng = IPRange.objects.get(tenant=self.tenant, start_address="10.77.0.100")
        self.assertEqual(rng.end_address, "10.77.0.119")

        ip = IPAddress.objects.get(tenant=self.tenant, ip_address="10.77.0.60")
        self.assertEqual(ip.mac_address, "aa:bb:cc:00:11:22")
        # DHCP reservations surface via the DHCP badge, not the operator's own
        # `reservation_note` marker - sync must leave that field alone.
        self.assertFalse(ip.reservation_note)
        res = DhcpReservation.objects.get(scope=scope, ip="10.77.0.60")
        self.assertFalse(res.managed)
        self.assertEqual(res.ip_address, ip)

        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_sync_status, "ok")

    def test_sync_is_idempotent(self):
        self.sync(payload())
        self.sync(payload())
        self.assertEqual(Prefix.objects.count(), 1)
        self.assertEqual(IPRange.objects.count(), 1)
        self.assertEqual(IPAddress.objects.count(), 1)
        self.assertEqual(DhcpScope.objects.count(), 1)
        self.assertEqual(DhcpReservation.objects.count(), 1)

    def test_existing_prefix_and_ip_adopted_not_clobbered(self):
        mine = Prefix.objects.create(
            tenant=self.tenant, cidr="10.77.0.0/24", description="mine"
        )
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.77.0.60", prefix=mine,
            mac_address="11:11:11:11:11:11", description="operator says",
        )
        counts = self.sync(payload())
        self.assertEqual(counts["prefixes_created"], 0)
        self.assertEqual(Prefix.objects.count(), 1)
        self.assertEqual(
            Prefix.objects.get().description, "mine"
        )
        ip = IPAddress.objects.get(ip_address="10.77.0.60")
        self.assertEqual(ip.mac_address, "11:11:11:11:11:11")  # blank-fill only
        self.assertEqual(ip.description, "operator says")

    def test_managed_reservation_drift_flagged_not_overwritten(self):
        self.sync(payload())
        res = DhcpReservation.objects.get()
        res.managed = True
        res.save(update_fields=["managed"])
        data = payload()
        data["reservations"][0]["Name"] = "renamed-on-server"
        counts = self.sync(data)
        res.refresh_from_db()
        self.assertEqual(res.drift, "modified")
        self.assertEqual(res.name, "printer-1")  # ours kept
        self.assertEqual(
            res.drift_detail["name"],
            {"danbyte": "printer-1", "server": "renamed-on-server"},
        )
        self.assertEqual(counts["drift"], 1)

    def test_unmanaged_reservation_mirrors_server(self):
        self.sync(payload())
        data = payload()
        data["reservations"][0]["Name"] = "renamed-on-server"
        self.sync(data)
        res = DhcpReservation.objects.get()
        self.assertEqual(res.name, "renamed-on-server")
        self.assertEqual(res.drift, "")

    def test_missing_on_server_managed_vs_unmanaged(self):
        self.sync(payload())
        res = DhcpReservation.objects.get()
        res.managed = True
        res.save(update_fields=["managed"])
        self.sync(payload(reservations=[]))
        res.refresh_from_db()
        self.assertEqual(res.drift, "missing")

        res.managed = False
        res.drift = ""
        res.save()
        self.sync(payload(reservations=[]))
        self.assertEqual(DhcpReservation.objects.count(), 0)

    def test_removed_exclusion_prunes_its_range(self):
        self.sync(payload())
        self.assertEqual(IPRange.objects.count(), 1)
        self.sync(payload(exclusions=[]))
        self.assertEqual(IPRange.objects.count(), 0)
        self.assertEqual(DhcpExclusion.objects.count(), 0)

    def test_scope_prefix_moved_into_a_vrf_is_adopted_not_duplicated(self):
        """Moving a scope's prefix into a VRF must not mint a Global twin.

        The sync looks up the scope's prefix in the Global VRF. When an operator
        moves it into a real VRF that lookup misses, and the sync used to create
        a second prefix with the same CIDR and re-point the scope at it -
        inventing address space it had been told not to invent.
        """
        from api.models import VRF

        self.sync(payload())
        prefix = Prefix.objects.get(cidr="10.77.0.0/24")
        vrf = VRF.objects.create(tenant=self.tenant, name="prod")
        prefix.vrf = vrf
        prefix.save(update_fields=["vrf"])

        counts = self.sync(payload())

        self.assertEqual(Prefix.objects.count(), 1, "a duplicate prefix was minted")
        self.assertEqual(counts["prefixes_created"], 0)
        scope = DhcpScope.objects.get()
        self.assertEqual(scope.prefix_id, prefix.id)
        # …and everything hanging off the scope follows the prefix's VRF.
        self.assertEqual(IPAddress.objects.get(ip_address="10.77.0.60").vrf_id, vrf.id)
        self.assertEqual(IPRange.objects.get().vrf_id, vrf.id)

    def test_exclusion_range_takes_its_prefixs_vrf(self):
        """IPRange.vrf is denormalised from the prefix - including via the ORM.

        Only the serializer used to apply that rule, so exclusion ranges the
        sync creates directly sat in the Global VRF under a VRF'd prefix.
        """
        from api.models import VRF

        vrf = VRF.objects.create(tenant=self.tenant, name="prod")
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24", vrf=vrf)
        self.sync(payload())
        rng = IPRange.objects.get(start_address="10.77.0.100")
        self.assertEqual(rng.vrf_id, vrf.id)
        self.assertEqual(rng.vrf_id, rng.prefix.vrf_id)

    def test_removed_scope_keeps_prefix(self):
        self.sync(payload())
        self.sync({"scopes": [], "exclusions": [], "reservations": [],
                   "options": [], "leases": []})
        self.assertEqual(DhcpScope.objects.count(), 0)
        self.assertEqual(Prefix.objects.count(), 1)  # IPAM data stays

    def test_lease_sync_opt_in_create_and_prune(self):
        self.sync(payload())
        scope = DhcpScope.objects.get()
        lease = {
            "scope_id": "10.77.0.0", "ip": "10.77.0.150",
            "mac": "aa-bb-cc-99-88-77", "HostName": "laptop-9",
            "state": "Active", "expires": "2026-08-20T10:00:00Z",
        }
        # Not opted in: leases are ignored.
        counts = self.sync(payload(leases=[lease]))
        self.assertEqual(counts["leases"], 0)
        self.assertEqual(DhcpLease.objects.count(), 0)

        scope.lease_sync = True
        scope.save(update_fields=["lease_sync"])
        counts = self.sync(payload(leases=[lease]))
        self.assertEqual(counts["leases"], 1)
        row = DhcpLease.objects.get()
        self.assertTrue(row.created_ip)
        ip = IPAddress.objects.get(ip_address="10.77.0.150")
        self.assertEqual(ip.dns_name, "laptop-9")
        self.assertIsNotNone(row.expires_at)

        # Lease gone → mirror and the IP we minted go too.
        self.sync(payload(leases=[]))
        self.assertEqual(DhcpLease.objects.count(), 0)
        self.assertFalse(
            IPAddress.objects.filter(ip_address="10.77.0.150").exists()
        )

    def test_a_non_mac_client_id_does_not_abort_the_scope(self):
        """#115: a ClientId that isn't a 48-bit MAC - an RFC 4361 client-id, a
        DUID, an Infiniband GUID - used to be assigned to IPAddress.mac_address
        (varchar 17) and take the whole scope's sync down with a database
        error. One odd client must not cost the other 200 addresses."""
        self.sync(payload())
        scope = DhcpScope.objects.get()
        scope.lease_sync = True
        scope.save(update_fields=["lease_sync"])
        duid = "00-01-00-01-2d-4e-1f-3a-00-15-5d-01-2a-0b"  # 14 bytes
        leases = [
            {
                "scope_id": "10.77.0.0", "ip": "10.77.0.151",
                "mac": duid, "HostName": "odd-client",
                "state": "Active", "expires": "2026-08-20T10:00:00Z",
            },
            {
                "scope_id": "10.77.0.0", "ip": "10.77.0.152",
                "mac": "aa-bb-cc-99-88-77", "HostName": "laptop-9",
                "state": "Active", "expires": "2026-08-20T10:00:00Z",
            },
        ]
        counts = self.sync(payload(leases=leases))

        self.assertEqual(counts["leases"], 2)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_sync_status, "ok")

        # The identifier is kept on the lease verbatim (it has room, and only
        # a real MAC gets reformatted to colons)...
        odd = DhcpLease.objects.get(ip="10.77.0.151")
        self.assertEqual(odd.mac, duid)
        # ...but never copied onto the address, which only holds a MAC.
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.151").mac_address, ""
        )
        # And the normal client in the same scope is unaffected.
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.152").mac_address,
            "aa:bb:cc:99:88:77",
        )

    def test_a_non_mac_reservation_client_id_is_also_survivable(self):
        """The reservation path adopts addresses through the same helper."""
        res = {
            "scope_id": "10.77.0.0", "ip": "10.77.0.61",
            "mac": "00-01-00-01-2d-4e-1f-3a-00-15-5d-01-2a-0b",
            "Name": "odd", "Description": "",
        }
        counts = self.sync(payload(reservations=[res]))
        self.assertEqual(counts["reservations"], 1)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_sync_status, "ok")
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.61").mac_address, ""
        )

    def test_lease_never_deletes_operator_ip(self):
        self.sync(payload())
        scope = DhcpScope.objects.get()
        scope.lease_sync = True
        scope.save(update_fields=["lease_sync"])
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.77.0.150", prefix=scope.prefix
        )
        lease = {"scope_id": "10.77.0.0", "ip": "10.77.0.150", "mac": "",
                 "HostName": "", "state": "Active", "expires": None}
        self.sync(payload(leases=[lease]))
        self.assertFalse(DhcpLease.objects.get().created_ip)
        self.sync(payload(leases=[]))
        self.assertTrue(
            IPAddress.objects.filter(ip_address="10.77.0.150").exists()
        )

    def test_reservation_wins_over_lease_on_same_ip(self):
        self.sync(payload())
        scope = DhcpScope.objects.get()
        scope.lease_sync = True
        scope.save(update_fields=["lease_sync"])
        lease = {"scope_id": "10.77.0.0", "ip": "10.77.0.60", "mac": "",
                 "HostName": "", "state": "ActiveReservation", "expires": None}
        counts = self.sync(payload(leases=[lease]))
        self.assertEqual(counts["leases"], 0)
        self.assertEqual(DhcpLease.objects.count(), 0)

    def test_single_element_json_collapse_handled(self):
        """ConvertTo-Json collapses 1-element arrays - _as_list covers it."""
        data = payload()
        data["scopes"] = data["scopes"][0]
        data["reservations"] = data["reservations"][0]
        counts = self.sync(data)
        self.assertEqual(counts["scopes"], 1)
        self.assertEqual(counts["reservations"], 1)
