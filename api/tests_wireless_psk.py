"""An SSID's PSK lives in the secret store, never in the row (#68).

Danbyte holds a reference. The value goes in through a write-only field and
comes back only through the audited reveal action, and only when a secret
store is configured - there is no plaintext fallback for a credential.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeAction, ChangeLogEntry
from core.models import DeploymentSettings, Organization, Tenant

from .models import WirelessLAN

User = get_user_model()


def _enable_local_store() -> None:
    ds = DeploymentSettings.load()
    ds.secrets_provider = "local"
    ds.save(update_fields=["secrets_provider"])


def _disable_store() -> None:
    ds = DeploymentSettings.load()
    ds.secrets_provider = ""
    ds.save(update_fields=["secrets_provider"])


class WirelessPSKTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        _enable_local_store()

    def _create(self, **extra):
        payload = {"ssid": "corp", "auth_type": "wpa-personal", **extra}
        return self.client.post("/api/wireless-lans/", payload, format="json")

    def test_psk_is_stored_and_never_read_back(self):
        r = self._create(psk="hunter2-hunter2")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["psk_set"])
        self.assertNotIn("psk", body)
        # And it is nowhere in the row itself.
        lan = WirelessLAN.objects.get(pk=body["id"])
        self.assertNotIn("hunter2", str(lan.__dict__))
        self.assertEqual(lan.psk_secret_path, f"wireless-lans/{lan.id}")
        self.assertEqual(lan.psk_secret_provider, "local")

    def test_detail_and_list_never_carry_the_psk(self):
        lan_id = self._create(psk="hunter2-hunter2").json()["id"]
        for url in (f"/api/wireless-lans/{lan_id}/", "/api/wireless-lans/"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertNotIn("hunter2", r.content.decode())

    def test_reveal_returns_it_and_leaves_an_audit_trail(self):
        lan_id = self._create(psk="hunter2-hunter2").json()["id"]
        r = self.client.post(f"/api/wireless-lans/{lan_id}/reveal-psk/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["psk"], "hunter2-hunter2")
        # Revealing changes no field, so without this nothing would record it.
        entry = ChangeLogEntry.objects.filter(
            action=ChangeAction.REVEAL, object_id=str(lan_id)
        ).first()
        self.assertIsNotNone(entry)
        self.assertEqual(entry.changes, {"revealed": "psk"})
        self.assertEqual(entry.user_name, "root")

    def test_without_a_secret_store_a_psk_is_refused_not_stored_in_the_clear(self):
        _disable_store()
        r = self._create(psk="hunter2-hunter2")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("psk", r.json())
        self.assertFalse(WirelessLAN.objects.filter(ssid="corp").exists())

    def test_an_ssid_without_a_psk_is_fine_with_no_store(self):
        _disable_store()
        r = self._create()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(r.json()["psk_set"])

    def test_blank_on_edit_keeps_the_stored_key(self):
        lan_id = self._create(psk="hunter2-hunter2").json()["id"]
        r = self.client.patch(
            f"/api/wireless-lans/{lan_id}/",
            {"description": "renamed", "psk": ""},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["psk_set"])
        reveal = self.client.post(f"/api/wireless-lans/{lan_id}/reveal-psk/")
        self.assertEqual(reveal.json()["psk"], "hunter2-hunter2")

    def test_null_clears_it(self):
        lan_id = self._create(psk="hunter2-hunter2").json()["id"]
        r = self.client.patch(
            f"/api/wireless-lans/{lan_id}/", {"psk": None}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["psk_set"])
        lan = WirelessLAN.objects.get(pk=lan_id)
        self.assertEqual(lan.psk_secret_path, "")
        self.assertEqual(lan.psk_secret_provider, "")

    def test_rotating_the_psk_replaces_it(self):
        lan_id = self._create(psk="old-passphrase").json()["id"]
        self.client.patch(
            f"/api/wireless-lans/{lan_id}/", {"psk": "new-passphrase"},
            format="json",
        )
        r = self.client.post(f"/api/wireless-lans/{lan_id}/reveal-psk/")
        self.assertEqual(r.json()["psk"], "new-passphrase")

    def test_revealing_an_ssid_with_no_psk_is_a_clean_error(self):
        lan_id = self._create().json()["id"]
        r = self.client.post(f"/api/wireless-lans/{lan_id}/reveal-psk/")
        self.assertEqual(r.status_code, 400, r.content)

    def test_deleting_the_ssid_takes_the_key_with_it(self):
        from monitoring.secret_store import active_secret_store

        lan_id = self._create(psk="hunter2-hunter2").json()["id"]
        lan = WirelessLAN.objects.get(pk=lan_id)
        path, tenant_id = lan.psk_secret_path, lan.tenant_id
        self.assertIsNotNone(active_secret_store().get(tenant_id, path))
        r = self.client.delete(f"/api/wireless-lans/{lan_id}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertIsNone(active_secret_store().get(tenant_id, path))
