"""The deployment switch for discovery (#451): a stored setting changed by
deployment admins while DANBYTE_DISCOVERY_ENABLED is unset, locked on or
off when it is set."""
from __future__ import annotations

from django.test import override_settings

from audit.models import ChangeLogEntry
from core.models import DeploymentSettings

from . import gate
from .tests_discovery import ApiBase

URL = "/api/discovery/deployment/"


@override_settings(DISCOVERY_ENABLED=None)
class StoredSwitchTests(ApiBase):
    def test_off_by_default_and_gates_everything(self):
        self.assertFalse(DeploymentSettings._meta.get_field("discovery_enabled").default)
        self.assertEqual(gate.deployment_source(), "setting")
        self.assertFalse(gate.deployment_enabled())
        self.assertFalse(gate.active(self.tenant))
        self.assertEqual(gate.active_tenant_ids(), set())
        self.login(self.su)
        self.assertEqual(self.client.get("/api/discovery/profiles/").status_code, 404)

    def test_a_deployment_admin_turns_it_on_and_it_is_logged(self):
        self.login(self.su)
        r = self.client.patch(URL, {"enabled": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["deployment"]["enabled"])
        self.assertEqual(body["deployment"]["source"], "setting")
        self.assertTrue(body["active"])
        self.assertEqual(body["deployment"]["changed_by"], "root")
        self.assertIsNotNone(body["deployment"]["changed_at"])
        self.assertTrue(gate.active(self.tenant))
        self.assertEqual(self.client.get("/api/discovery/profiles/").status_code, 200)
        entry = ChangeLogEntry.objects.filter(
            object_type="core.deploymentsettings",
            changes__has_key="discovery_enabled").latest("timestamp")
        self.assertEqual(entry.user_name, "root")
        self.assertEqual(entry.changes["discovery_enabled"]["new"], True)
        r = self.client.patch(URL, {"enabled": False}, format="json")
        self.assertFalse(r.json()["deployment"]["enabled"])
        self.assertFalse(gate.active(self.tenant))

    def test_a_tenant_admin_is_refused(self):
        self.member("tadmin", {"user": ["view", "add", "change", "delete"]})
        # The grant is tenant-scoped: a tenant admin, not a deployment admin.
        r = self.client.get("/api/discovery/status/")
        self.assertTrue(r.json()["can_manage"])
        self.assertFalse(r.json()["deployment"]["can_change"])
        r = self.client.patch(URL, {"enabled": True}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(gate.deployment_enabled())

    def test_validation_and_login(self):
        self.assertIn(self.client.patch(URL, {"enabled": True}, format="json").status_code,
                      (401, 403))
        self.login(self.su)
        self.assertEqual(self.client.patch(URL, {"enabled": "yes"},
                                           format="json").status_code, 400)
        self.assertEqual(self.client.post(URL, {"enabled": True},
                                          format="json").status_code, 405)

    def test_a_member_does_not_see_who_changed_it(self):
        DeploymentSettings.load()
        self.login(self.su)
        self.client.patch(URL, {"enabled": True}, format="json")
        self.member("reader", {"device": ["view"]})
        d = self.client.get("/api/discovery/status/").json()["deployment"]
        self.assertTrue(d["enabled"])
        self.assertEqual((d["changed_by"], d["changed_at"]), ("", None))


class LockedTests(ApiBase):
    def test_locked_off_cannot_be_enabled(self):
        DeploymentSettings.objects.update_or_create(pk=1, defaults={"discovery_enabled": True})
        with override_settings(DISCOVERY_ENABLED=False):
            self.assertEqual(gate.deployment_source(), "env")
            self.assertFalse(gate.deployment_enabled())
            self.login(self.su)
            d = self.client.get("/api/discovery/status/").json()["deployment"]
            self.assertEqual((d["enabled"], d["source"], d["can_change"]),
                             (False, "env", False))
            r = self.client.patch(URL, {"enabled": True}, format="json")
            self.assertEqual(r.status_code, 409)
            self.assertEqual(self.client.get("/api/discovery/runs/").status_code, 404)

    def test_locked_on(self):
        with override_settings(DISCOVERY_ENABLED=True):
            self.assertTrue(gate.deployment_enabled())
            self.login(self.su)
            d = self.client.get("/api/discovery/status/").json()["deployment"]
            self.assertEqual((d["enabled"], d["source"], d["can_change"]),
                             (True, "env", False))
            self.assertEqual(self.client.patch(URL, {"enabled": False},
                                               format="json").status_code, 409)
            self.assertTrue(gate.deployment_enabled())

    def test_the_tenant_toggle_is_still_needed(self):
        from integrations.models import IntegrationSettings

        IntegrationSettings.objects.filter(tenant=self.tenant).update(discovery_enabled=False)
        with override_settings(DISCOVERY_ENABLED=True):
            self.assertFalse(gate.active(self.tenant))
        with override_settings(DISCOVERY_ENABLED=None):
            DeploymentSettings.objects.update_or_create(
                pk=1, defaults={"discovery_enabled": True})
            self.assertFalse(gate.active(self.tenant))
