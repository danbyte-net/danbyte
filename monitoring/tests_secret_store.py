"""The opt-in secret store for issuance keys (M2).

Two invariants matter: it is fail-closed until an operator enables a provider,
and the local backend round-trips values encrypted at rest and tenant-scoped.
"""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from core.models import DeploymentSettings, Organization, Tenant

from .models import StoredSecret
from .secret_store import (
    SecretStoreDisabled,
    SecretStoreError,
    active_secret_store,
    require_secret_store,
    secret_store_enabled,
)
from .secret_store_vault import VaultSecretStore


class SecretStoreGateTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        # Ensure a clean deployment singleton with no provider.
        dep = DeploymentSettings.load()
        dep.secrets_provider = ""
        dep.save(update_fields=["secrets_provider"])

    def _enable(self, provider):
        dep = DeploymentSettings.load()
        dep.secrets_provider = provider
        dep.save(update_fields=["secrets_provider"])

    def test_disabled_by_default_and_fails_closed(self):
        self.assertFalse(secret_store_enabled())
        self.assertIsNone(active_secret_store())
        with self.assertRaises(SecretStoreDisabled):
            require_secret_store()

    def test_enabling_local_provides_a_store(self):
        self._enable("local")
        self.assertTrue(secret_store_enabled())
        self.assertIsNotNone(active_secret_store())
        # Doesn't raise now.
        require_secret_store()


class LocalSecretStoreTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="T2", slug="t2")
        dep = DeploymentSettings.load()
        dep.secrets_provider = "local"
        dep.save(update_fields=["secrets_provider"])
        self.store = active_secret_store()

    def test_put_get_delete_round_trip(self):
        self.store.put(self.tenant.id, "acme/account", {"private_key": "PK-DATA"})
        self.assertEqual(
            self.store.get(self.tenant.id, "acme/account"),
            {"private_key": "PK-DATA"},
        )
        self.store.delete(self.tenant.id, "acme/account")
        self.assertIsNone(self.store.get(self.tenant.id, "acme/account"))

    def test_put_is_idempotent_by_ref(self):
        self.store.put(self.tenant.id, "csr/1", {"private_key": "A"})
        self.store.put(self.tenant.id, "csr/1", {"private_key": "B"})
        self.assertEqual(
            StoredSecret.objects.filter(tenant=self.tenant, ref="csr/1").count(), 1
        )
        self.assertEqual(self.store.get(self.tenant.id, "csr/1"), {"private_key": "B"})

    def test_is_tenant_scoped(self):
        self.store.put(self.tenant.id, "k", {"private_key": "mine"})
        self.assertIsNone(self.store.get(self.other.id, "k"))

    def test_value_is_encrypted_at_rest(self):
        from django.db import connection

        self.store.put(self.tenant.id, "k", {"private_key": "TOPSECRET"})
        # Read the raw column (bypassing the field's transparent decrypt) — it
        # must be non-empty ciphertext with no trace of the plaintext.
        with connection.cursor() as cur:
            cur.execute(
                "SELECT value FROM monitoring_storedsecret WHERE ref = %s", ["k"]
            )
            raw = cur.fetchone()[0]
        self.assertTrue(raw)
        self.assertNotIn("TOPSECRET", raw)


def _resp(status, json_body=None, text=""):
    m = mock.Mock()
    m.status_code = status
    m.json.return_value = json_body or {}
    m.text = text
    return m


class VaultSecretStoreTests(TestCase):
    """Mocked so CI needs no live Vault; the request shapes are what a real
    Vault KV v2 expects (validated end-to-end against a real Vault separately)."""

    def setUp(self):
        self.store = VaultSecretStore(
            "http://vault.example:8200/", "tok", mount="danbyte", verify_tls=True
        )
        self.tid = "11111111-1111-1111-1111-111111111111"

    def test_put_posts_kv_v2_data_path_with_token(self):
        with mock.patch(
            "monitoring.secret_store_vault.requests.request", return_value=_resp(200)
        ) as req:
            self.store.put(self.tid, "csr/abc", {"private_key": "PK"})
        args, kw = req.call_args
        self.assertEqual(args[0], "POST")
        self.assertEqual(
            args[1], f"http://vault.example:8200/v1/danbyte/data/{self.tid}/csr/abc"
        )
        self.assertEqual(kw["json"], {"data": {"private_key": "PK"}})
        self.assertEqual(kw["headers"]["X-Vault-Token"], "tok")
        self.assertFalse(kw["allow_redirects"])

    def test_get_unwraps_kv_v2_nested_data(self):
        body = {"data": {"data": {"private_key": "PK"}, "metadata": {}}}
        with mock.patch(
            "monitoring.secret_store_vault.requests.request",
            return_value=_resp(200, body),
        ):
            self.assertEqual(
                self.store.get(self.tid, "csr/abc"), {"private_key": "PK"}
            )

    def test_get_missing_is_none(self):
        with mock.patch(
            "monitoring.secret_store_vault.requests.request", return_value=_resp(404)
        ):
            self.assertIsNone(self.store.get(self.tid, "nope"))

    def test_get_error_raises(self):
        with mock.patch(
            "monitoring.secret_store_vault.requests.request",
            return_value=_resp(403, text="permission denied"),
        ):
            with self.assertRaises(SecretStoreError):
                self.store.get(self.tid, "x")

    def test_delete_hits_metadata_path(self):
        with mock.patch(
            "monitoring.secret_store_vault.requests.request", return_value=_resp(204)
        ) as req:
            self.store.delete(self.tid, "csr/abc")
        args, _ = req.call_args
        self.assertEqual(args[0], "DELETE")
        self.assertIn("/v1/danbyte/metadata/", args[1])

    def test_from_deployment_none_when_unconfigured(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "vault"
        dep.vault_addr = ""
        dep.secrets = {}
        dep.save()
        self.assertIsNone(VaultSecretStore.from_deployment())
        # And the gate reports disabled, so CSR/ACME stay fail-closed.
        self.assertFalse(secret_store_enabled())

    def test_from_deployment_builds_when_configured(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "vault"
        dep.vault_addr = "https://vault.example:8200"
        dep.vault_mount = "danbyte"
        dep.secrets = {"vault_token": "tok"}
        dep.save()
        s = VaultSecretStore.from_deployment()
        self.assertIsInstance(s, VaultSecretStore)
        self.assertEqual(s.addr, "https://vault.example:8200")
        self.assertEqual(s.token, "tok")
