"""External-sync foundation: toggles, connection CRUD, credential hygiene."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from integrations.models import IntegrationSettings, WindowsServerConnection
from integrations.toggles import integration_enabled
from integrations.winrm_client import ps_str


class PsQuotingTests(APITestCase):
    def test_ps_str_quotes_and_escapes(self):
        self.assertEqual(ps_str("plain"), "'plain'")
        self.assertEqual(ps_str("O'Brien"), "'O''Brien'")
        # Injection attempts stay inert inside single quotes.
        self.assertEqual(
            ps_str("x'; Remove-Item C:\\ -Recurse; '"),
            "'x''; Remove-Item C:\\ -Recurse; '''",
        )


class ConnectionApiTests(APITestCase):
    def setUp(self):
        from auth_api.models import ObjectPermission, UserProfile

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="T2", slug="t2")

        self.admin = User.objects.create_user("adm", password="x")
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="tenant-admin", object_types=["user", "windowsserverconnection",
                                              "virtualizationsource"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.admin)
        p.tenants.set([self.tenant])

        self.member = User.objects.create_user("mem", password="x")
        UserProfile.objects.create(user=self.member).tenants.add(self.tenant)

    def _login(self, user):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _enable(self, **flags):
        obj, _ = IntegrationSettings.objects.get_or_create(tenant=self.tenant)
        for k, v in flags.items():
            setattr(obj, k, v)
        obj.save()

    # ─── Settings → Integrations toggles ─────────────────────────────────

    def test_settings_endpoint_requires_tenant_admin(self):
        self._login(self.member)
        self.assertEqual(self.client.get("/api/integrations/settings/").status_code, 403)

    def test_settings_defaults_off_and_toggle(self):
        self._login(self.admin)
        res = self.client.get("/api/integrations/settings/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {
            "dhcp_sync_enabled": False, "dns_sync_enabled": False,
            "virtualization_enabled": False,
        })
        res = self.client.put(
            "/api/integrations/settings/", {"dhcp_sync_enabled": True},
            format="json",
        )
        self.assertTrue(res.json()["dhcp_sync_enabled"])
        self.assertTrue(integration_enabled(self.tenant, "dhcp"))
        self.assertFalse(integration_enabled(self.tenant, "dns"))

    # ─── Toggle gating on the connection endpoints ───────────────────────

    def test_connections_404_until_enabled(self):
        self._login(self.admin)
        self.assertEqual(self.client.get("/api/windows-connections/").status_code, 404)
        self._enable(dns_sync_enabled=True)  # either role opens the endpoint
        self.assertEqual(self.client.get("/api/windows-connections/").status_code, 200)
        self.assertEqual(
            self.client.get("/api/virtualization-sources/").status_code, 404
        )
        self._enable(virtualization_enabled=True)
        self.assertEqual(
            self.client.get("/api/virtualization-sources/").status_code, 200
        )

    # ─── Credential hygiene ──────────────────────────────────────────────

    def test_create_stores_password_encrypted_and_write_only(self):
        self._login(self.admin)
        self._enable(dhcp_sync_enabled=True)
        res = self.client.post("/api/windows-connections/", {
            "name": "dc1", "host": "192.0.2.10", "username": "svc-danbyte",
            "password": "pw-1", "dhcp_enabled": True,
        }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertNotIn("password", body)
        self.assertNotIn("credentials", body)
        self.assertTrue(body["password_set"])
        conn = WindowsServerConnection.objects.get(id=body["id"])
        self.assertEqual(conn.credentials["password"], "pw-1")

    def test_update_without_password_keeps_stored_one(self):
        self._login(self.admin)
        self._enable(dhcp_sync_enabled=True)
        conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10",
            username="svc", credentials={"password": "keep-me"},
        )
        res = self.client.patch(
            f"/api/windows-connections/{conn.id}/", {"name": "dc1-renamed"},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        conn.refresh_from_db()
        self.assertEqual(conn.credentials["password"], "keep-me")
        res = self.client.patch(
            f"/api/windows-connections/{conn.id}/", {"password": "new-pw"},
            format="json",
        )
        conn.refresh_from_db()
        self.assertEqual(conn.credentials["password"], "new-pw")

    def test_create_requires_password(self):
        self._login(self.admin)
        self._enable(dhcp_sync_enabled=True)
        res = self.client.post("/api/windows-connections/", {
            "name": "dc1", "host": "192.0.2.10", "username": "svc",
        }, format="json")
        self.assertEqual(res.status_code, 400)

    def test_vcenter_kind_rejected_for_now(self):
        self._login(self.admin)
        self._enable(virtualization_enabled=True)
        res = self.client.post("/api/virtualization-sources/", {
            "name": "vc", "kind": "vcenter", "host": "192.0.2.20",
            "token_id": "a@b!c", "secret": "s",
        }, format="json")
        self.assertEqual(res.status_code, 400)

    # ─── Tenant isolation ────────────────────────────────────────────────

    def test_other_tenants_connections_invisible(self):
        WindowsServerConnection.objects.create(
            tenant=self.other, name="foreign", host="192.0.2.99", username="x",
        )
        self._login(self.admin)
        self._enable(dhcp_sync_enabled=True)
        names = [r["name"] for r in
                 self.client.get("/api/windows-connections/").json()["results"]]
        self.assertNotIn("foreign", names)

    # ─── Test-connection action ──────────────────────────────────────────

    def test_test_action_reports_role_probes(self):
        self._login(self.admin)
        self._enable(dhcp_sync_enabled=True)
        conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dhcp_enabled=True,
        )
        with mock.patch(
            "integrations.winrm_client.run_ps",
            return_value='{"ps_version": "5.1", "dhcp_scopes": 3}',
        ):
            res = self.client.post(f"/api/windows-connections/{conn.id}/test/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["ok"])
        self.assertEqual(res.json()["dhcp_scopes"], 3)

    def test_test_action_blocks_unlisted_internal_host(self):
        """Internal targets need the deployment SSRF allowlist, like NetBox."""
        self._login(self.admin)
        self._enable(dhcp_sync_enabled=True)
        conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="lan", host="10.99.99.99", username="svc",
            credentials={"password": "pw"}, dhcp_enabled=True,
        )
        res = self.client.post(f"/api/windows-connections/{conn.id}/test/")
        self.assertEqual(res.status_code, 502)
        self.assertFalse(res.json()["ok"])
