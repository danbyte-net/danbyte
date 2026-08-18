"""DHCP API: reservation push-through, drift resolution, scope opt-in."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Prefix
from core.models import Organization, Tenant
from integrations.models import (
    DhcpReservation,
    DhcpScope,
    IntegrationSettings,
    WindowsServerConnection,
)


class DhcpApiTests(APITestCase):
    def setUp(self):
        from auth_api.models import ObjectPermission, UserProfile

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.create(
            tenant=self.tenant, dhcp_sync_enabled=True
        )
        self.conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dhcp_enabled=True,
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.scope = DhcpScope.objects.create(
            connection=self.conn, scope_id="10.77.0.0", name="Lab",
            prefix=self.prefix,
        )
        self.user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="dhcp-op",
            object_types=["dhcpscope", "dhcpreservation", "dhcplease"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.user)
        p.tenants.set([self.tenant])
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_create_reservation_pushes_then_saves(self):
        with mock.patch("integrations.dhcp_api.push_reservation") as push:
            res = self.client.post("/api/dhcp-reservations/", {
                "scope": str(self.scope.id), "ip": "10.77.0.70",
                "mac": "AA-BB-CC-00-22-33", "name": "nas-1",
            }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        push.assert_called_once()
        row = DhcpReservation.objects.get()
        self.assertTrue(row.managed)
        self.assertEqual(row.mac, "aa:bb:cc:00:22:33")  # normalised
        self.assertIsNotNone(row.ip_address)
        self.assertEqual(row.ip_address.ip_address, "10.77.0.70")

    def test_push_refusal_saves_nothing(self):
        from integrations.dhcp_sync import WinRMError

        with mock.patch(
            "integrations.dhcp_api.push_reservation",
            side_effect=WinRMError("scope full"),
        ):
            res = self.client.post("/api/dhcp-reservations/", {
                "scope": str(self.scope.id), "ip": "10.77.0.70",
                "mac": "aa:bb:cc:00:22:33",
            }, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(DhcpReservation.objects.count(), 0)

    def test_delete_pushes_removal(self):
        row = DhcpReservation.objects.create(
            scope=self.scope, ip="10.77.0.70", mac="aa:bb:cc:00:22:33",
            managed=True,
        )
        with mock.patch("integrations.dhcp_api.remove_reservation") as rm:
            res = self.client.delete(f"/api/dhcp-reservations/{row.id}/")
        self.assertEqual(res.status_code, 204)
        rm.assert_called_once()
        self.assertEqual(DhcpReservation.objects.count(), 0)

    def test_resolve_accept_takes_server_values(self):
        row = DhcpReservation.objects.create(
            scope=self.scope, ip="10.77.0.70", mac="aa:bb:cc:00:22:33",
            name="ours", managed=True, drift="modified",
            drift_detail={"name": {"danbyte": "ours", "server": "theirs"}},
        )
        res = self.client.post(
            f"/api/dhcp-reservations/{row.id}/resolve/",
            {"strategy": "accept"}, format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        row.refresh_from_db()
        self.assertEqual(row.name, "theirs")
        self.assertEqual(row.drift, "")

    def test_resolve_push_repushes_ours(self):
        row = DhcpReservation.objects.create(
            scope=self.scope, ip="10.77.0.70", mac="aa:bb:cc:00:22:33",
            name="ours", managed=True, drift="modified",
            drift_detail={"name": {"danbyte": "ours", "server": "theirs"}},
        )
        with mock.patch("integrations.dhcp_api.push_reservation") as push:
            res = self.client.post(
                f"/api/dhcp-reservations/{row.id}/resolve/",
                {"strategy": "push"}, format="json",
            )
        self.assertEqual(res.status_code, 200, res.content)
        push.assert_called_once()
        row.refresh_from_db()
        self.assertEqual(row.name, "ours")
        self.assertEqual(row.drift, "")

    def test_reservation_cannot_move(self):
        row = DhcpReservation.objects.create(
            scope=self.scope, ip="10.77.0.70", mac="aa:bb:cc:00:22:33",
            managed=True,
        )
        res = self.client.patch(
            f"/api/dhcp-reservations/{row.id}/", {"ip": "10.77.0.71"},
            format="json",
        )
        self.assertEqual(res.status_code, 400)

    def test_scope_patch_only_lease_sync(self):
        res = self.client.patch(
            f"/api/dhcp-scopes/{self.scope.id}/",
            {"lease_sync": True, "name": "hijack"}, format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.scope.refresh_from_db()
        self.assertTrue(self.scope.lease_sync)
        self.assertEqual(self.scope.name, "Lab")  # read-only ignored

    def test_foreign_scope_rejected_on_create(self):
        other = Tenant.objects.create(
            org=self.tenant.org, name="T2", slug="t2"
        )
        conn2 = WindowsServerConnection.objects.create(
            tenant=other, name="dc2", host="192.0.2.11", username="svc",
        )
        scope2 = DhcpScope.objects.create(connection=conn2, scope_id="10.9.0.0")
        with mock.patch("integrations.dhcp_api.push_reservation"):
            res = self.client.post("/api/dhcp-reservations/", {
                "scope": str(scope2.id), "ip": "10.9.0.5",
                "mac": "aa:bb:cc:00:22:33",
            }, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(DhcpReservation.objects.count(), 0)

    def test_create_scope_pushes_then_saves(self):
        with mock.patch("integrations.dhcp_api.push_scope") as push:
            res = self.client.post("/api/dhcp-scopes/", {
                "connection": str(self.conn.id), "name": "New scope",
                "subnet": "10.88.0.0/24", "start_range": "10.88.0.50",
                "end_range": "10.88.0.200", "description": "test",
            }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        push.assert_called_once()
        row = DhcpScope.objects.get(scope_id="10.88.0.0")
        self.assertEqual(row.subnet_mask, "255.255.255.0")
        self.assertEqual(row.name, "New scope")
        self.assertIsNotNone(row.prefix)

    def test_create_scope_rejects_range_outside_subnet(self):
        with mock.patch("integrations.dhcp_api.push_scope") as push:
            res = self.client.post("/api/dhcp-scopes/", {
                "connection": str(self.conn.id), "name": "Bad",
                "subnet": "10.88.0.0/24", "start_range": "10.99.0.1",
                "end_range": "10.99.0.9",
            }, format="json")
        self.assertEqual(res.status_code, 400, res.content)
        push.assert_not_called()

    def test_create_scope_winrm_failure_saves_nothing(self):
        from integrations.dhcp_sync import WinRMError

        with mock.patch("integrations.dhcp_api.push_scope",
                        side_effect=WinRMError("refused")):
            res = self.client.post("/api/dhcp-scopes/", {
                "connection": str(self.conn.id), "name": "X",
                "subnet": "10.88.0.0/24", "start_range": "10.88.0.50",
                "end_range": "10.88.0.60",
            }, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(DhcpScope.objects.filter(scope_id="10.88.0.0").exists())

    def test_delete_scope_removes_on_server(self):
        with mock.patch("integrations.dhcp_api.remove_scope") as rm:
            res = self.client.delete(f"/api/dhcp-scopes/{self.scope.id}/")
        self.assertEqual(res.status_code, 204, res.content)
        rm.assert_called_once()
        self.assertFalse(DhcpScope.objects.filter(id=self.scope.id).exists())

    def test_ip_dhcp_state_leased_exclusion_scope(self):
        """Serializer `dhcp`: leased > exclusion > scope > None."""
        from api.models import IPAddress
        from api.serializers import IPAddressSerializer
        from api.viewsets import annotate_dhcp
        from integrations.models import DhcpExclusion

        self.scope.start_range = "10.77.0.50"
        self.scope.end_range = "10.77.0.200"
        self.scope.save(update_fields=["start_range", "end_range"])
        DhcpExclusion.objects.create(
            scope=self.scope, start_address="10.77.0.100",
            end_address="10.77.0.119",
        )
        mk = lambda a: IPAddress.objects.create(  # noqa: E731
            tenant=self.tenant, prefix=self.prefix, ip_address=a
        )
        pool_ip, excl_ip, outside_ip = mk("10.77.0.60"), mk("10.77.0.105"), mk("10.77.0.10")
        DhcpReservation.objects.create(scope=self.scope, ip="10.77.0.60",
                                       mac="aa:bb:cc:00:00:60", ip_address=pool_ip)
        qs = annotate_dhcp(IPAddress.objects.filter(prefix=self.prefix))
        states = {r["ip_address"]: r["dhcp"]
                  for r in IPAddressSerializer(qs, many=True).data}
        self.assertEqual(states["10.77.0.60"], "leased")
        self.assertEqual(states["10.77.0.105"], "exclusion")
        self.assertEqual(states["10.77.0.10"], None)

    def test_create_local_scope_no_push(self):
        with mock.patch("integrations.dhcp_api.push_scope") as push:
            res = self.client.post("/api/dhcp-scopes/", {
                "name": "Local lab", "subnet": "10.90.0.0/24",
                "start_range": "10.90.0.10", "end_range": "10.90.0.99",
            }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        push.assert_not_called()
        row = DhcpScope.objects.get(scope_id="10.90.0.0")
        self.assertIsNone(row.connection_id)
        self.assertEqual(row.tenant_id, self.tenant.id)
        self.assertTrue(row.is_local)
        # Listed alongside synced scopes for the tenant.
        listing = self.client.get("/api/dhcp-scopes/")
        ids = {r["scope_id"] for r in listing.json()["results"]}
        self.assertIn("10.90.0.0", ids)

    def test_create_scope_from_existing_prefix_with_vrf(self):
        from api.models import VRF, Prefix

        vrf = VRF.objects.create(tenant=self.tenant, name="lab-vrf", rd="65000:1")
        pfx = Prefix.objects.create(
            tenant=self.tenant, cidr="10.91.0.0/24", vrf=vrf
        )
        res = self.client.post("/api/dhcp-scopes/", {
            "name": "From prefix", "prefix": str(pfx.id),
            "start_range": "10.91.0.10", "end_range": "10.91.0.50",
        }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        row = DhcpScope.objects.get(scope_id="10.91.0.0")
        self.assertEqual(row.prefix_id, pfx.id)
        self.assertEqual(row.prefix.vrf_id, vrf.id)

    def test_create_scope_subnet_in_vrf(self):
        from api.models import VRF, Prefix

        vrf = VRF.objects.create(tenant=self.tenant, name="v2", rd="65000:2")
        res = self.client.post("/api/dhcp-scopes/", {
            "name": "VRF subnet", "subnet": "10.92.0.0/24", "vrf": str(vrf.id),
            "start_range": "10.92.0.10", "end_range": "10.92.0.50",
        }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        row = DhcpScope.objects.get(scope_id="10.92.0.0")
        self.assertEqual(row.prefix.vrf_id, vrf.id)
        self.assertTrue(
            Prefix.objects.filter(cidr="10.92.0.0/24", vrf=vrf).exists()
        )

    def test_local_reservation_no_push_links_ip(self):
        r = self.client.post("/api/dhcp-scopes/", {
            "name": "Local", "subnet": "10.93.0.0/24",
            "start_range": "10.93.0.10", "end_range": "10.93.0.99",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        scope_id = r.json()["id"]
        with mock.patch("integrations.dhcp_api.push_reservation") as push:
            res = self.client.post("/api/dhcp-reservations/", {
                "scope": scope_id, "ip": "10.93.0.20",
                "mac": "aa:bb:cc:00:93:20", "name": "local-host",
            }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        push.assert_not_called()
        row = DhcpReservation.objects.get(ip="10.93.0.20")
        self.assertTrue(row.managed)
        self.assertIsNotNone(row.ip_address_id)
        # Delete needs no server either.
        with mock.patch("integrations.dhcp_api.remove_reservation") as rm:
            d = self.client.delete(f"/api/dhcp-reservations/{row.id}/")
        self.assertEqual(d.status_code, 204, d.content)
        rm.assert_not_called()

    def test_delete_local_scope_no_push(self):
        r = self.client.post("/api/dhcp-scopes/", {
            "name": "Bye", "subnet": "10.94.0.0/24",
            "start_range": "10.94.0.10", "end_range": "10.94.0.20",
        }, format="json")
        sid = r.json()["id"]
        with mock.patch("integrations.dhcp_api.remove_scope") as rm:
            d = self.client.delete(f"/api/dhcp-scopes/{sid}/")
        self.assertEqual(d.status_code, 204, d.content)
        rm.assert_not_called()

    def test_local_scope_foreign_tenant_invisible(self):
        other = Tenant.objects.create(org=self.tenant.org, name="T3", slug="t3")
        DhcpScope.objects.create(tenant=other, scope_id="10.95.0.0", name="theirs")
        listing = self.client.get("/api/dhcp-scopes/")
        ids = {r["scope_id"] for r in listing.json()["results"]}
        self.assertNotIn("10.95.0.0", ids)
