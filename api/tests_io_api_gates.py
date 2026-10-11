"""Spreadsheet import and export refuse a type wherever its API refuses it:
the viewset's ``initial()`` gates (an integration switched off for the
tenant, a disabled plugin) and its allowed methods apply to the whole file
before any row is read (#388)."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

OX_ROW = {"name": "x", "url": "https://ox.example.com"}


class _Case(APITestCase):
    def setUp(self):
        from integrations.models import IntegrationSettings

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.settings = IntegrationSettings.objects.create(tenant=self.tenant)

    def _toggle(self, **flags):
        type(self.settings).objects.filter(pk=self.settings.pk).update(**flags)

    def _user(self, name, grants, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        for slug, actions in grants.items():
            perm = ObjectPermission.objects.create(
                name=f"{name}-{slug}", object_types=[slug], actions=list(actions),
            )
            perm.users.add(u)
            perm.tenants.add(self.tenant)
        return u

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _import(self, slug, rows, dry_run=False):
        return self.client.post(f"/api/io/{slug}/import/",
                                {"rows": rows, "dry_run": dry_run}, format="json")

    def _export(self, slug, fmt="csv"):
        return self.client.get(f"/api/io/{slug}/export/?fmt={fmt}")


class IntegrationToggleTests(_Case):
    def setUp(self):
        super().setUp()
        self.user = self._user("ops", {
            "oxidizedconnection": ["view", "add", "change"],
            "zabbixconnection": ["view", "add", "change"],
        })
        self._login(self.user)

    def test_api_refuses_while_off(self):
        """The baseline the import must match."""
        resp = self.client.post("/api/oxidized/connections/", OX_ROW, format="json")
        self.assertEqual(resp.status_code, 404)

    def test_import_create_refused_while_off(self):
        from oxidized.models import OxidizedConnection

        for dry in (True, False):
            resp = self._import("oxidizedconnection", [OX_ROW], dry_run=dry)
            self.assertEqual(resp.status_code, 404, (dry, resp.content))
            self.assertIn("not enabled", resp.json()["detail"])
        self.assertFalse(OxidizedConnection.objects.exists())

    def test_import_update_refused_while_off(self):
        from oxidized.models import OxidizedConnection

        conn = OxidizedConnection.objects.create(
            tenant=self.tenant, name="ox", url="https://ox.example.com")
        for dry in (True, False):
            resp = self._import("oxidizedconnection",
                                [{"id": str(conn.id), "name": "renamed"}], dry_run=dry)
            self.assertEqual(resp.status_code, 404, dry)
        conn.refresh_from_db()
        self.assertEqual(conn.name, "ox")

    def test_import_works_once_switched_on(self):
        from oxidized.models import OxidizedConnection

        self._toggle(oxidized_enabled=True)
        resp = self._import("oxidizedconnection", [OX_ROW], dry_run=True)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual((resp.json()["created"], resp.json()["errors"]), (1, []))
        self.assertFalse(OxidizedConnection.objects.exists())
        resp = self._import("oxidizedconnection", [OX_ROW])
        self.assertEqual((resp.json()["created"], resp.json()["errors"]), (1, []))
        self.assertTrue(OxidizedConnection.objects.filter(name="x").exists())

    def test_other_integrations_are_gated_too(self):
        from zabbix.models import ZabbixConnection

        ZabbixConnection.objects.create(
            tenant=self.tenant, name="zbx", url="https://zbx.example.com")
        resp = self._import("zabbixconnection",
                            [{"name": "z2", "url": "https://zbx2.example.com"}])
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(self._export("zabbixconnection").status_code, 404)
        self._toggle(zabbix_enabled=True)
        self.assertEqual(self._export("zabbixconnection").status_code, 200)

    def test_export_refused_while_off(self):
        from oxidized.models import OxidizedConnection

        OxidizedConnection.objects.create(
            tenant=self.tenant, name="ox", url="https://ox.example.com")
        for fmt in ("csv", "json", "xlsx"):
            self.assertEqual(self._export("oxidizedconnection", fmt).status_code, 404)
        resp = self.client.post("/api/io/oxidizedconnection/export/", {"fmt": "csv"},
                                format="json")
        self.assertEqual(resp.status_code, 404)
        self._toggle(oxidized_enabled=True)
        resp = self._export("oxidizedconnection")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"ox", b"".join(resp.streaming_content))

    def test_fields_refused_while_off(self):
        resp = self.client.get("/api/io/oxidizedconnection/fields/")
        self.assertEqual(resp.status_code, 404)

    def test_types_list_leaves_disabled_integrations_out(self):
        slugs = {t["slug"] for t in self.client.get("/api/io/types/").json()["object_types"]}
        self.assertNotIn("oxidizedconnection", slugs)
        self._toggle(oxidized_enabled=True)
        slugs = {t["slug"] for t in self.client.get("/api/io/types/").json()["object_types"]}
        self.assertIn("oxidizedconnection", slugs)

    def test_superuser_is_gated_as_the_api_gates_them(self):
        root = self._user("root", {}, superuser=True)
        self._login(root)
        self.assertEqual(
            self.client.post("/api/oxidized/connections/", OX_ROW, format="json").status_code,
            404)
        self.assertEqual(self._import("oxidizedconnection", [OX_ROW]).status_code, 404)

    def test_ungated_types_unaffected(self):
        """A core type with no toggle still imports and exports."""
        self._login(self._user("ipam", {"vrf": ["view", "add", "change"]}))
        resp = self._import("vrf", [{"name": "blue"}])
        self.assertEqual((resp.status_code, resp.json()["created"]), (200, 1))
        self.assertEqual(self._export("vrf").status_code, 200)


class AllowedMethodsTests(_Case):
    """A viewset that does not take PATCH is not updated by import."""

    def test_node_link_update_refused(self):
        from api.models import Cluster, ClusterType, VirtualMachine
        from oxidized.models import OxidizedConnection, OxidizedNodeLink

        self._toggle(oxidized_enabled=True)
        self._login(self._user("ops", {"oxidizednodelink": ["view", "add", "change"]}))
        conn = OxidizedConnection.objects.create(
            tenant=self.tenant, name="ox", url="https://ox.example.com")
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cluster)
        link = OxidizedNodeLink.objects.create(
            tenant=self.tenant, connection=conn, virtual_machine=vm,
            full_name="g/vm1", node_name="vm1", matched_by="manual",
        )
        self.assertEqual(
            self.client.patch(f"/api/oxidized/links/{link.id}/", {"node_name": "z"},
                              format="json").status_code, 405)
        resp = self._import("oxidizednodelink",
                            [{"id": str(link.id), "node_name": "changed"}])
        if resp.status_code == 200:
            self.assertEqual(resp.json()["updated"], 0)
            self.assertTrue(resp.json()["errors"])
        else:
            self.assertEqual(resp.status_code, 405)
        link.refresh_from_db()
        self.assertEqual(link.node_name, "vm1")


class PluginGateTests(_Case):
    def setUp(self):
        super().setUp()
        self._login(self._user("w", {"widget": ["view", "add", "change"]}))

    def test_disabled_plugin_refuses_import_and_export(self):
        from danbyte_example_plugin.models import Widget
        from plugins.models import PluginConfig

        PluginConfig.objects.create(tenant=self.tenant, plugin_slug="example",
                                    enabled=False)
        for dry in (True, False):
            self.assertEqual(self._import("widget", [{"name": "w1"}], dry).status_code, 404)
        self.assertEqual(self._export("widget").status_code, 404)
        self.assertFalse(Widget.objects.exists())

    def test_enabled_plugin_imports(self):
        resp = self._import("widget", [{"name": "w1"}])
        self.assertEqual((resp.status_code, resp.json()["created"]), (200, 1))
