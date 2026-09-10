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
from .secret_store_azure import AzureKeyVaultSecretStore
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
        # Read the raw column (bypassing the field's transparent decrypt) - it
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


class AzureKeyVaultSecretStoreTests(TestCase):
    """Mocked so CI needs no live vault or Entra ID tenant; the request shapes
    are what the Key Vault REST API expects."""

    def setUp(self):
        self.store = AzureKeyVaultSecretStore(
            "https://kv-danbyte.vault.azure.net/",
            "dir-id",
            "client-id",
            "client-secret",
        )
        # Skip the token round-trip in the operation tests - it has its own.
        self.store._token = "tok"
        self.store._token_expires = float("inf")
        self.tid = "11111111-1111-1111-1111-111111111111"

    def test_name_is_deterministic_legal_and_ref_specific(self):
        a = self.store._name(self.tid, "csr/abc")
        self.assertEqual(a, self.store._name(self.tid, "csr/abc"))
        self.assertNotEqual(a, self.store._name(self.tid, "csr/abd"))
        # Another tenant's identical ref is a different secret.
        self.assertNotEqual(a, self.store._name("22222222" + self.tid[8:], "csr/abc"))
        self.assertTrue(a.startswith(f"danbyte-{self.tid}-"))
        self.assertTrue(all(c.isalnum() or c == "-" for c in a))
        self.assertLessEqual(len(a), 127)

    def test_name_stays_legal_for_a_long_operator_path(self):
        long_ref = "device-credentials/" + ("x" * 300)
        name = self.store._name(self.tid, long_ref)
        self.assertLessEqual(len(name), 127)
        self.assertTrue(all(c.isalnum() or c == "-" for c in name))
        self.assertNotEqual(name, self.store._name(self.tid, long_ref + "y"))

    def test_scope_follows_the_vault_host(self):
        self.assertEqual(self.store._scope(), "https://vault.azure.net/.default")
        gov = AzureKeyVaultSecretStore(
            "https://kv.vault.usgovcloudapi.net", "d", "c", "s"
        )
        self.assertEqual(gov._scope(), "https://vault.usgovcloudapi.net/.default")

    def test_put_writes_json_under_the_derived_name(self):
        with mock.patch(
            "monitoring.secret_store_azure.requests.request", return_value=_resp(200)
        ) as req:
            self.store.put(self.tid, "csr/abc", {"private_key": "PK"})
        args, kw = req.call_args
        self.assertEqual(args[0], "PUT")
        self.assertEqual(
            args[1],
            f"https://kv-danbyte.vault.azure.net/secrets/"
            f"{self.store._name(self.tid, 'csr/abc')}",
        )
        self.assertEqual(kw["json"], {"value": '{"private_key": "PK"}'})
        self.assertEqual(kw["params"], {"api-version": "7.4"})
        self.assertEqual(kw["headers"]["Authorization"], "Bearer tok")
        self.assertFalse(kw["allow_redirects"])

    def test_get_parses_the_json_value(self):
        body = {"value": '{"private_key": "PK"}'}
        with mock.patch(
            "monitoring.secret_store_azure.requests.request",
            return_value=_resp(200, body),
        ):
            self.assertEqual(self.store.get(self.tid, "csr/abc"), {"private_key": "PK"})

    def test_get_at_path_uses_the_name_verbatim_and_wraps_a_bare_string(self):
        with mock.patch(
            "monitoring.secret_store_azure.requests.request",
            return_value=_resp(200, {"value": "hunter2"}),
        ) as req:
            got = self.store.get_at_path(self.tid, "team-ssh")
        self.assertEqual(got, {"value": "hunter2"})
        self.assertTrue(req.call_args[0][1].endswith("/secrets/team-ssh"))

    def test_get_missing_is_none(self):
        with mock.patch(
            "monitoring.secret_store_azure.requests.request", return_value=_resp(404)
        ):
            self.assertIsNone(self.store.get(self.tid, "nope"))

    def test_get_error_raises(self):
        with mock.patch(
            "monitoring.secret_store_azure.requests.request",
            return_value=_resp(403, text="Forbidden"),
        ):
            with self.assertRaises(SecretStoreError):
                self.store.get(self.tid, "x")

    def test_delete_soft_deletes_then_purges(self):
        with mock.patch(
            "monitoring.secret_store_azure.requests.request", return_value=_resp(200)
        ) as req:
            self.store.delete(self.tid, "csr/abc")
        calls = [(c[0][0], c[0][1]) for c in req.call_args_list]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0], "DELETE")
        self.assertIn("/secrets/", calls[0][1])
        self.assertIn("/deletedsecrets/", calls[1][1])

    def test_purge_protection_is_not_an_error(self):
        # A vault with purge protection refuses the purge; the soft delete
        # already happened and that is the operator's retention policy.
        with mock.patch(
            "monitoring.secret_store_azure.requests.request",
            side_effect=[_resp(200), _resp(403, text="purge protection")],
        ):
            self.store.delete(self.tid, "csr/abc")

    def test_token_is_fetched_once_and_reused(self):
        store = AzureKeyVaultSecretStore(
            "https://kv.vault.azure.net", "dir-id", "client-id", "sec"
        )
        token = _resp(200, {"access_token": "T", "expires_in": 3600})
        with mock.patch(
            "monitoring.secret_store_azure.requests.post", return_value=token
        ) as post:
            with mock.patch(
                "monitoring.secret_store_azure.requests.request",
                return_value=_resp(200, {"value": "{}"}),
            ):
                store.get(self.tid, "a")
                store.get(self.tid, "b")
        self.assertEqual(post.call_count, 1)
        args, kw = post.call_args
        self.assertEqual(args[0], "https://login.microsoftonline.com/dir-id/oauth2/v2.0/token")
        self.assertEqual(kw["data"]["grant_type"], "client_credentials")
        self.assertEqual(kw["data"]["scope"], "https://vault.azure.net/.default")

    def test_sign_in_failure_surfaces_the_body(self):
        store = AzureKeyVaultSecretStore("https://kv.vault.azure.net", "d", "c", "s")
        with mock.patch(
            "monitoring.secret_store_azure.requests.post",
            return_value=_resp(401, text="AADSTS7000215: Invalid client secret"),
        ):
            with self.assertRaises(SecretStoreError) as cm:
                store.get(self.tid, "a")
        self.assertIn("AADSTS7000215", str(cm.exception))

    def test_from_deployment_none_until_every_part_is_set(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "azure"
        dep.azure_vault_url = "https://kv.vault.azure.net"
        dep.azure_directory_id = "dir"
        dep.azure_client_id = ""
        dep.secrets = {"azure_client_secret": "s"}
        dep.save()
        self.assertIsNone(AzureKeyVaultSecretStore.from_deployment())
        # Half-configured means CSR/ACME stay fail-closed rather than erroring
        # at issuance time.
        self.assertFalse(secret_store_enabled())

        dep.azure_client_id = "client"
        dep.save()
        store = AzureKeyVaultSecretStore.from_deployment()
        self.assertIsInstance(store, AzureKeyVaultSecretStore)
        self.assertEqual(store.vault_url, "https://kv.vault.azure.net")
        self.assertEqual(store.authority, "https://login.microsoftonline.com")
        self.assertTrue(secret_store_enabled())

    def test_sovereign_authority_is_honoured(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "azure"
        dep.azure_vault_url = "https://kv.vault.usgovcloudapi.net"
        dep.azure_directory_id = "dir"
        dep.azure_client_id = "client"
        dep.azure_authority = "https://login.microsoftonline.us"
        dep.secrets = {"azure_client_secret": "s"}
        dep.save()
        store = AzureKeyVaultSecretStore.from_deployment()
        self.assertEqual(store.authority, "https://login.microsoftonline.us")
        self.assertEqual(store._scope(), "https://vault.usgovcloudapi.net/.default")


class RegistryTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        dep = DeploymentSettings.load()
        dep.secrets_provider = ""
        dep.save(update_fields=["secrets_provider"])

    def test_builtins_registered_in_order(self):
        from .secret_store import secret_store_providers

        kinds = [p.kind for p in secret_store_providers()]
        self.assertEqual(kinds[:3], ["local", "vault", "azure"])
        vault = next(p for p in secret_store_providers() if p.kind == "vault")
        names = [f["name"] for f in vault.payload()["fields"]]
        self.assertIn("vault_token", names)

    def test_unregistered_kind_fails_closed(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "gone-plugin"
        dep.save(update_fields=["secrets_provider"])
        self.assertIsNone(active_secret_store())
        self.assertFalse(secret_store_enabled())

    def test_registered_kind_becomes_active(self):
        from .secret_store import _REGISTRY, register_secret_store

        class Dummy:
            def put(self, t, r, v): ...
            def get(self, t, r): return {"k": 1}
            def delete(self, t, r): ...
            def get_at_path(self, t, p): return None

        register_secret_store("dummy", "Dummy", Dummy, fields=[{"name": "x", "type": "text"}])
        try:
            dep = DeploymentSettings.load()
            dep.secrets_provider = "dummy"
            dep.save(update_fields=["secrets_provider"])
            self.assertEqual(active_secret_store().get(self.tenant.id, "r"), {"k": 1})
        finally:
            _REGISTRY.pop("dummy", None)

    def test_settings_api_lists_and_validates(self):
        from django.contrib.auth.models import User
        from django.test import Client

        user = User.objects.create_user("root", password="x", is_superuser=True)
        c = Client()
        c.force_login(user)
        r = c.get("/api/deployment/secret-stores/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            [p["kind"] for p in r.json()["providers"]][:3], ["local", "vault", "azure"]
        )
        bad = c.put(
            "/api/deployment/email/",
            data='{"secrets_provider": "nope"}',
            content_type="application/json",
        )
        self.assertEqual(bad.status_code, 400)
        self.assertIn("Unknown secret store", str(bad.json()))
        ok = c.put(
            "/api/deployment/email/",
            data='{"secrets_provider": "local"}',
            content_type="application/json",
        )
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["secrets_provider"], "local")
