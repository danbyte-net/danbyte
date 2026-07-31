"""The opt-in secret store for issuance keys (M2).

Two invariants matter: it is fail-closed until an operator enables a provider,
and the local backend round-trips values encrypted at rest and tenant-scoped.
"""
from __future__ import annotations

from django.test import TestCase

from core.models import DeploymentSettings, Organization, Tenant

from .models import StoredSecret
from .secret_store import (
    SecretStoreDisabled,
    active_secret_store,
    require_secret_store,
    secret_store_enabled,
)


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
