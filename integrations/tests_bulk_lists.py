"""Bulk edit, safe bulk delete and export of the selection on the DHCP, DNS
and connection lists.

A scope or reservation the Windows server refuses to remove stays, named with
the single delete's message, while the rest go; a synced DNS zone is kept for
the reason its single delete gives; leases export but take no write; the
synced scopes and zones - which carry no tenant of their own - export too; and
another tenant's rows fall out of every action."""
from __future__ import annotations

import json
from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Prefix
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations.dhcp_sync import WinRMError
from integrations.models import (
    DhcpLease,
    DhcpReservation,
    DhcpScope,
    DnsRecord,
    DnsZone,
    IntegrationSettings,
    VirtGuest,
    VirtualizationSource,
    WindowsServerConnection,
)

SCOPES = "/api/dhcp-scopes/"
RESERVATIONS = "/api/dhcp-reservations/"
LEASES = "/api/dhcp-leases/"
ZONES = "/api/dns-zones/"
SERVERS = "/api/windows-connections/"
SOURCES = "/api/virtualization-sources/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other_org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        for t in (self.tenant, self.other):
            IntegrationSettings.objects.create(
                tenant=t, dhcp_sync_enabled=True, dns_sync_enabled=True,
                virt_proxmox_enabled=True,
            )
        self.conn = self.server(self.tenant, "dc1")
        self.their_conn = self.server(self.other, "dc1")
        self.login(User.objects.create_superuser("root", "r@a.c", "pw"))

    @staticmethod
    def server(tenant, name):
        return WindowsServerConnection.objects.create(
            tenant=tenant, name=name, host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dhcp_enabled=True, dns_enabled=True,
        )

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def member(self, slugs, actions):
        user = User.objects.create_user("member", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="p", object_types=list(slugs),
                                               actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)

    def delete(self, url, ids, dry_run=False):
        return self.client.post(f"{url}bulk-delete/",
                                {"ids": [str(i) for i in ids], "dry_run": dry_run},
                                format="json")

    def update(self, url, ids, fields):
        return self.client.post(f"{url}bulk-update/",
                                {"ids": [str(i) for i in ids], "fields": fields},
                                format="json")

    def export(self, slug, ids):
        r = self.client.post(f"/api/io/{slug}/export/",
                             {"fmt": "json", "ids": [str(i) for i in ids]}, format="json")
        self.assertEqual(r.status_code, 200)
        return json.loads(b"".join(r.streaming_content))

    def fields(self, url):
        r = self.client.get(f"{url}bulk-edit-fields/")
        self.assertEqual(r.status_code, 200, r.content)
        return [f["key"] for f in r.json()["fields"]]

    def logged(self, action, obj):
        return ChangeLogEntry.objects.filter(action=action, object_id=str(obj.pk)).exists()


class DhcpScopeBulkTests(_Base):
    def setUp(self):
        super().setUp()
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.synced = DhcpScope.objects.create(connection=self.conn, scope_id="10.77.0.0",
                                               prefix=prefix)
        self.second = DhcpScope.objects.create(connection=self.conn, scope_id="10.78.0.0")
        self.local = DhcpScope.objects.create(tenant=self.tenant, scope_id="10.79.0.0")
        self.theirs = DhcpScope.objects.create(connection=self.their_conn,
                                               scope_id="10.77.0.0")
        DhcpReservation.objects.create(scope=self.synced, ip="10.77.0.5", mac="aa")
        DhcpLease.objects.create(scope=self.synced, ip="10.77.0.6", mac="bb")

    def test_dry_run_counts_what_goes_with_the_scopes_and_asks_no_server(self):
        with mock.patch("integrations.dhcp_api.remove_scope") as remove:
            r = self.delete(SCOPES, [self.synced.id, self.local.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["deleted"], 2)
        self.assertEqual(body["impact"], [{"label": "DHCP leases", "count": 1},
                                          {"label": "DHCP reservations", "count": 1}])
        remove.assert_not_called()
        self.assertEqual(DhcpScope.objects.count(), 4)

    def test_a_refusing_server_keeps_its_scope_and_the_rest_go(self):
        def refuse(conn, scope_id):
            if scope_id == "10.78.0.0":
                raise WinRMError("scope busy")

        with mock.patch("integrations.dhcp_api.remove_scope", side_effect=refuse) as remove:
            r = self.delete(SCOPES, [self.synced.id, self.second.id, self.local.id,
                                     self.theirs.id])
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(sorted(body["deleted_ids"]),
                         sorted([str(self.synced.id), str(self.local.id)]))
        self.assertEqual(body["deleted"], 2)
        self.assertEqual(body["skipped"], [{
            "id": str(self.second.id), "name": str(self.second),
            "reason": "The DHCP server refused: scope busy",
        }])
        # The local scope has no server to ask.
        self.assertEqual(remove.call_count, 2)
        self.assertEqual(set(DhcpScope.objects.values_list("pk", flat=True)),
                         {self.second.pk, self.theirs.pk})
        self.assertTrue(self.logged(ChangeAction.DELETE, self.synced))

    def test_edit_sets_lease_sync_only(self):
        self.assertEqual(self.fields(SCOPES), ["lease_sync"])
        r = self.update(SCOPES, [self.synced.id, self.local.id, self.theirs.id],
                        {"lease_sync": True})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.theirs.refresh_from_db()
        self.assertFalse(self.theirs.lease_sync)
        self.assertEqual(self.update(SCOPES, [self.synced.id], {"name": "x"}).status_code, 400)
        self.assertTrue(self.logged(ChangeAction.UPDATE, self.synced))

    def test_export_takes_synced_and_local_scopes_of_the_tenant_only(self):
        rows = self.export("dhcpscope", [self.synced.id, self.local.id, self.theirs.id])
        self.assertEqual({r["id"] for r in rows}, {str(self.synced.id), str(self.local.id)})

    def test_the_grants(self):
        self.member(["dhcpscope"], ["view", "change"])
        self.assertEqual(self.delete(SCOPES, [self.local.id]).status_code, 403)
        self.assertEqual(self.update(SCOPES, [self.local.id], {"lease_sync": True}).status_code,
                         200)


class DhcpReservationBulkTests(_Base):
    def setUp(self):
        super().setUp()
        scope = DhcpScope.objects.create(connection=self.conn, scope_id="10.77.0.0")
        local = DhcpScope.objects.create(tenant=self.tenant, scope_id="10.79.0.0")
        their_scope = DhcpScope.objects.create(connection=self.their_conn, scope_id="10.77.0.0")
        self.a = DhcpReservation.objects.create(scope=scope, ip="10.77.0.5", mac="aa")
        self.b = DhcpReservation.objects.create(scope=scope, ip="10.77.0.6", mac="bb")
        self.c = DhcpReservation.objects.create(scope=local, ip="10.79.0.5", mac="cc")
        self.theirs = DhcpReservation.objects.create(scope=their_scope, ip="10.77.0.5")

    def test_dry_run_asks_no_server(self):
        with mock.patch("integrations.dhcp_api.remove_reservation") as remove:
            r = self.delete(RESERVATIONS, [self.a.id, self.c.id], dry_run=True)
        self.assertEqual(r.json()["deleted"], 2)
        remove.assert_not_called()
        self.assertEqual(DhcpReservation.objects.count(), 4)

    def test_a_refused_reservation_stays_with_the_servers_message(self):
        def refuse(conn, scope, ip):
            if ip == "10.77.0.6":
                raise WinRMError("access denied")

        with mock.patch("integrations.dhcp_api.remove_reservation", side_effect=refuse):
            r = self.delete(RESERVATIONS, [self.a.id, self.b.id, self.c.id, self.theirs.id])
        body = r.json()
        self.assertEqual(body["deleted"], 2)
        self.assertEqual([s["reason"] for s in body["skipped"]],
                         ["The DHCP server refused: access denied"])
        self.assertEqual(set(DhcpReservation.objects.values_list("pk", flat=True)),
                         {self.b.pk, self.theirs.pk})

    def test_no_bulk_edit(self):
        r = self.update(RESERVATIONS, [self.a.id], {"description": "x"})
        self.assertIn(r.status_code, (404, 405), r.content)
        self.a.refresh_from_db()
        self.assertEqual(self.a.description, "")

    def test_export_of_the_selection_stays_in_the_tenant(self):
        rows = self.export("dhcpreservation", [self.a.id, self.c.id, self.theirs.id])
        self.assertEqual({r["id"] for r in rows}, {str(self.a.id), str(self.c.id)})

    def test_needs_the_delete_grant(self):
        self.member(["dhcpreservation"], ["view", "change"])
        self.assertEqual(self.delete(RESERVATIONS, [self.a.id]).status_code, 403)


class DhcpLeaseExportTests(_Base):
    def setUp(self):
        super().setUp()
        scope = DhcpScope.objects.create(connection=self.conn, scope_id="10.77.0.0")
        their_scope = DhcpScope.objects.create(connection=self.their_conn, scope_id="10.77.0.0")
        self.lease = DhcpLease.objects.create(scope=scope, ip="10.77.0.9", mac="aa",
                                              hostname="pc-9")
        self.theirs = DhcpLease.objects.create(scope=their_scope, ip="10.77.0.9")

    def test_export_of_the_selection(self):
        rows = self.export("dhcplease", [self.lease.id, self.theirs.id])
        self.assertEqual([r["id"] for r in rows], [str(self.lease.id)])
        self.assertEqual(rows[0]["hostname"], "pc-9")

    def test_leases_take_no_bulk_write(self):
        self.assertIn(self.delete(LEASES, [self.lease.id]).status_code, (404, 405))
        self.assertIn(self.update(LEASES, [self.lease.id], {"hostname": "x"}).status_code,
                      (404, 405))
        self.assertTrue(DhcpLease.objects.filter(pk=self.lease.pk).exists())

    def test_export_needs_the_view_grant(self):
        self.member(["dhcpscope"], ["view"])
        r = self.client.post("/api/io/dhcplease/export/",
                             {"fmt": "json", "ids": [str(self.lease.id)]}, format="json")
        self.assertEqual(r.status_code, 403, r.content)

    def test_leases_are_export_only(self):
        types = {t["slug"]: t for t in self.client.get("/api/io/types/").json()["object_types"]}
        self.assertFalse(types["dhcplease"]["importable"])
        self.assertFalse(types["dhcpreservation"]["importable"])


class DnsZoneBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.synced = DnsZone.objects.create(connection=self.conn, name="corp.lan")
        self.managed = DnsZone.objects.create(connection=self.conn, name="own.lan",
                                              managed=True)
        self.local = DnsZone.objects.create(tenant=self.tenant, name="lab.lan", managed=True)
        self.theirs = DnsZone.objects.create(connection=self.their_conn, name="own.lan",
                                             managed=True)
        DnsRecord.objects.create(zone=self.managed, name="a.own.lan", record_type="A",
                                 data="10.0.0.1")

    def test_dry_run_keeps_the_mirrored_zone_with_the_single_delete_reason(self):
        r = self.delete(ZONES, [self.synced.id, self.managed.id, self.local.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(sorted(body["deleted_ids"]),
                         sorted([str(self.managed.id), str(self.local.id)]))
        self.assertEqual(body["skipped"], [{
            "id": str(self.synced.id), "name": "corp.lan",
            "reason": "Only zones authored in Danbyte can be deleted; this one is "
                      "mirrored from the server.",
        }])
        self.assertEqual(body["impact"], [{"label": "DNS records", "count": 1}])
        single = self.client.delete(f"{ZONES}{self.synced.id}/")
        self.assertEqual(single.json()["detail"], body["skipped"][0]["reason"])

    def test_delete_takes_the_authored_zones_of_the_tenant_only(self):
        r = self.delete(ZONES, [self.synced.id, self.managed.id, self.local.id,
                                self.theirs.id])
        self.assertEqual(r.json()["deleted"], 2)
        self.assertEqual(set(DnsZone.objects.values_list("pk", flat=True)),
                         {self.synced.pk, self.theirs.pk})
        self.assertTrue(self.logged(ChangeAction.DELETE, self.local))

    def test_edit_sets_the_two_opt_ins(self):
        self.assertEqual(self.fields(ZONES), ["sync", "auto_create"])
        r = self.update(ZONES, [self.synced.id, self.theirs.id], {"sync": True,
                                                                   "auto_create": True})
        self.assertEqual(r.json()["updated"], 1)
        self.synced.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual((self.synced.sync, self.synced.auto_create), (True, True))
        self.assertFalse(self.theirs.sync)
        self.assertEqual(self.update(ZONES, [self.synced.id], {"managed": True}).status_code, 400)

    def test_export_takes_synced_and_local_zones(self):
        rows = self.export("dnszone", [self.synced.id, self.local.id, self.theirs.id])
        self.assertEqual({r["id"] for r in rows}, {str(self.synced.id), str(self.local.id)})

    def test_needs_the_delete_grant(self):
        self.member(["dnszone"], ["view", "change"])
        self.assertEqual(self.delete(ZONES, [self.local.id]).status_code, 403)


class WindowsServerBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.second = self.server(self.tenant, "dc2")
        DhcpScope.objects.create(connection=self.conn, scope_id="10.77.0.0")
        DnsZone.objects.create(connection=self.conn, name="corp.lan")

    def test_dry_run_counts_the_synced_rows(self):
        r = self.delete(SERVERS, [self.conn.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["impact"], [{"label": "DHCP scopes", "count": 1},
                                              {"label": "DNS zones", "count": 1}])
        self.assertTrue(WindowsServerConnection.objects.filter(pk=self.conn.pk).exists())

    def test_delete_stays_in_the_tenant(self):
        r = self.delete(SERVERS, [self.conn.id, self.their_conn.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertFalse(WindowsServerConnection.objects.filter(pk=self.conn.pk).exists())
        self.assertTrue(WindowsServerConnection.objects.filter(pk=self.their_conn.pk).exists())

    def test_edit_writes_the_switches_and_never_the_password(self):
        self.assertEqual(self.fields(SERVERS),
                         ["enabled", "dhcp_enabled", "dns_enabled", "poll_interval_minutes"])
        r = self.update(SERVERS, [self.conn.id, self.second.id, self.their_conn.id],
                        {"enabled": False, "poll_interval_minutes": 15})
        self.assertEqual(r.json()["updated"], 2)
        self.conn.refresh_from_db()
        self.their_conn.refresh_from_db()
        self.assertEqual((self.conn.enabled, self.conn.poll_interval_minutes), (False, 15))
        self.assertEqual(self.conn.credentials, {"password": "pw"})
        self.assertTrue(self.their_conn.enabled)
        for key in ("password", "host", "credentials"):
            self.assertEqual(self.update(SERVERS, [self.conn.id], {key: "x"}).status_code, 400)

    def test_export_has_no_credentials(self):
        rows = self.export("windowsserverconnection", [self.conn.id, self.their_conn.id])
        self.assertEqual([r["id"] for r in rows], [str(self.conn.id)])
        self.assertNotIn("credentials", rows[0])
        self.assertNotIn("pw", rows[0].values())

    def test_view_only_may_not_edit(self):
        self.member(["windowsserverconnection"], ["view"])
        self.assertEqual(self.update(SERVERS, [self.conn.id], {"enabled": False}).status_code,
                         403)


class VirtualizationSourceBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = self.source(self.tenant, "pve1")
        self.b = self.source(self.tenant, "pve2")
        self.theirs = self.source(self.other, "pve1")
        VirtGuest.objects.create(source=self.a, vmid=101)

    @staticmethod
    def source(tenant, name):
        return VirtualizationSource.objects.create(
            tenant=tenant, name=name, host="192.0.2.20",
            credentials={"token_id": "a@pam!x", "secret": "tok"},
        )

    def test_dry_run_counts_the_sync_state(self):
        r = self.delete(SOURCES, [self.a.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([i["count"] for i in r.json()["impact"]], [1])
        self.assertTrue(VirtualizationSource.objects.filter(pk=self.a.pk).exists())

    def test_delete_stays_in_the_tenant(self):
        r = self.delete(SOURCES, [self.a.id, self.b.id, self.theirs.id])
        self.assertEqual(r.json()["deleted"], 2)
        self.assertTrue(VirtualizationSource.objects.filter(pk=self.theirs.pk).exists())
        self.assertTrue(self.logged(ChangeAction.DELETE, self.a))

    def test_edit_writes_mode_and_interval_and_checks_the_choice(self):
        self.assertEqual(self.fields(SOURCES), ["enabled", "sync_mode", "poll_interval_minutes"])
        r = self.update(SOURCES, [self.a.id, self.b.id], {"sync_mode": "manual",
                                                          "poll_interval_minutes": 30})
        self.assertEqual(r.status_code, 200, r.content)
        self.a.refresh_from_db()
        self.assertEqual((self.a.sync_mode, self.a.poll_interval_minutes), ("manual", 30))
        self.assertEqual(self.a.credentials["secret"], "tok")
        self.assertEqual(self.update(SOURCES, [self.a.id], {"sync_mode": "wild"}).status_code,
                         400)
        self.assertEqual(self.update(SOURCES, [self.a.id], {"secret": "x"}).status_code, 400)

    def test_export_has_no_credentials(self):
        rows = self.export("virtualizationsource", [self.a.id])
        self.assertNotIn("credentials", rows[0])
        self.assertNotIn("tok", str(rows[0]))

    def test_needs_the_delete_grant(self):
        self.member(["virtualizationsource"], ["view", "change"])
        self.assertEqual(self.delete(SOURCES, [self.a.id]).status_code, 403)
