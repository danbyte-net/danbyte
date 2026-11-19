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
from .secret_store_azure import AzureKeyVaultSecretStore, clear_token_cache
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
        clear_token_cache()
        self.addCleanup(clear_token_cache)
        patcher = mock.patch.object(
            AzureKeyVaultSecretStore, "_access_token", return_value="tok"
        )
        patcher.start()
        self.addCleanup(patcher.stop)
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


class AzurePurgeProtectedVaultTests(TestCase):
    """A vault with purge protection keeps a deleted secret for its whole
    retention period and refuses a write to that name with 409; a cleared
    key is recovered and overwritten instead (#536). A mock that answers as
    Microsoft documents it - no live vault."""

    DELETED = {"error": {
        "code": "Conflict",
        "message": "Secret x is currently in a deleted but recoverable state, and its "
                   "name cannot be reused; in this state, the secret can only be "
                   "recovered or purged.",
        "innererror": {"code": "ObjectIsDeletedButRecoverable"}}}
    BUSY = {"error": {"code": "Conflict", "message": "Secret x is currently being deleted.",
                      "innererror": {"code": "ObjectIsBeingDeleted"}}}

    def setUp(self):
        self.store = AzureKeyVaultSecretStore(
            "https://kv-danbyte.vault.azure.net/", "dir-id", "client-id", "client-secret")
        for p in (mock.patch.object(AzureKeyVaultSecretStore, "_access_token",
                                    return_value="tok"),
                  mock.patch("monitoring.secret_store_azure._sleep")):
            p.start()
            self.addCleanup(p.stop)
        self.tid = "11111111-1111-1111-1111-111111111111"
        self.name = self.store._name(self.tid, "ipsec-profiles/abc")

    def _vault(self, purge_protected=True, recover_lag=1):
        """A tiny Key Vault: live and deleted secrets, purge protection, and
        a recovery that takes ``recover_lag`` more requests to finish."""
        state = {"live": {}, "deleted": {}, "recovering": 0}

        def request(method, url, **kw):
            path = url.split("vault.azure.net/", 1)[1]
            if state["recovering"]:
                state["recovering"] -= 1
                if not state["recovering"]:
                    state["live"].update(state.pop("pending"))
            if method == "PUT" and path.startswith("secrets/"):
                n = path.split("/", 1)[1]
                if n in state["deleted"]:
                    return _resp(409, self.DELETED, text="deleted but recoverable")
                if state["recovering"]:
                    return _resp(409, {"error": {"code": "Conflict", "innererror": {
                        "code": "ObjectIsBeingRecovered"}}})
                state["live"][n] = kw["json"]["value"]
                return _resp(200)
            if method == "GET" and path.startswith("secrets/"):
                n = path.split("/", 1)[1]
                return _resp(200, {"value": state["live"][n]}) if n in state["live"] \
                    else _resp(404)
            if method == "DELETE" and path.startswith("secrets/"):
                n = path.split("/", 1)[1]
                if n not in state["live"]:
                    return _resp(404)
                state["deleted"][n] = state["live"].pop(n)
                return _resp(200)
            if method == "DELETE" and path.startswith("deletedsecrets/"):
                n = path.split("/", 1)[1]
                if purge_protected:
                    return _resp(403, text="purge protection")
                state["deleted"].pop(n, None)
                return _resp(204)
            if method == "POST" and path.endswith("/recover"):
                n = path.split("/")[1]
                if n not in state["deleted"]:
                    return _resp(404)
                state["pending"] = {n: state["deleted"].pop(n)}
                state["recovering"] = recover_lag
                return _resp(200)
            raise AssertionError((method, path))

        return state, request

    def test_a_cleared_key_can_be_set_again(self):
        state, request = self._vault()
        with mock.patch("monitoring.secret_store_azure.requests.request",
                        side_effect=request) as req:
            self.store.put(self.tid, "ipsec-profiles/abc", {"psk": "Psk-one-1"})
            self.store.delete(self.tid, "ipsec-profiles/abc")
            self.assertIn(self.name, state["deleted"])
            self.store.put(self.tid, "ipsec-profiles/abc", {"psk": "Psk-two-2"})
            self.assertEqual(self.store.get(self.tid, "ipsec-profiles/abc"), {"psk": "Psk-two-2"})
        posts = [c for c in req.call_args_list if c[0][0] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0][0][1].endswith(f"/deletedsecrets/{self.name}/recover"))
        # The secret value is never in a URL.
        for c in req.call_args_list:
            self.assertNotIn("Psk-", c[0][1])

    def test_without_purge_protection_nothing_is_recovered(self):
        state, request = self._vault(purge_protected=False)
        with mock.patch("monitoring.secret_store_azure.requests.request",
                        side_effect=request) as req:
            self.store.put(self.tid, "ipsec-profiles/abc", {"psk": "a"})
            self.store.delete(self.tid, "ipsec-profiles/abc")
            self.store.put(self.tid, "ipsec-profiles/abc", {"psk": "b"})
        self.assertFalse([c for c in req.call_args_list if c[0][0] == "POST"])
        self.assertEqual(state["live"][self.name], '{"psk": "b"}')

    def test_a_purge_in_progress_is_waited_for(self):
        answers = [_resp(409, self.BUSY), _resp(409, self.BUSY), _resp(200)]
        with mock.patch("monitoring.secret_store_azure.requests.request",
                        side_effect=answers) as req:
            self.store.put(self.tid, "ipsec-profiles/abc", {"psk": "a"})
        self.assertEqual([c[0][0] for c in req.call_args_list], ["PUT", "PUT", "PUT"])

    def test_another_conflict_or_a_stuck_name_still_fails(self):
        with mock.patch("monitoring.secret_store_azure.requests.request",
                        return_value=_resp(409, {"error": {"code": "Conflict"}}, text="other")):
            with self.assertRaises(SecretStoreError):
                self.store.put(self.tid, "ipsec-profiles/abc", {"psk": "a"})
        with mock.patch("monitoring.secret_store_azure.requests.request",
                        return_value=_resp(409, self.BUSY, text="busy")) as req:
            with self.assertRaises(SecretStoreError):
                self.store.put(self.tid, "ipsec-profiles/abc", {"psk": "a"})
        self.assertEqual(len(req.call_args_list), 9)


class AzureTokenCacheTests(TestCase):
    """One Entra ID token per expiry period, across store instances (#510)."""

    tid = "11111111-1111-1111-1111-111111111111"

    def setUp(self):
        clear_token_cache()
        self.addCleanup(clear_token_cache)

    def _configure(self, secret="s"):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "azure"
        dep.azure_vault_url = "https://kv.vault.azure.net"
        dep.azure_directory_id = "dir"
        dep.azure_client_id = "client"
        dep.azure_authority = ""
        dep.secrets = {"azure_client_secret": secret}
        dep.save()

    def test_a_fresh_store_per_operation_reuses_one_token(self):
        # active_secret_store() builds a new instance every call, as reveal does.
        self._configure()
        token = _resp(200, {"access_token": "T", "expires_in": 3600})
        with (
            mock.patch("monitoring.secret_store_azure.requests.post",
                       return_value=token) as post,
            mock.patch("monitoring.secret_store_azure.requests.request",
                       return_value=_resp(200, {"value": "{}"})) as req,
        ):
            for _ in range(5):
                active_secret_store().get(self.tid, "device-credentials/x")
        self.assertEqual(post.call_count, 1)
        self.assertEqual(req.call_count, 5)

    def test_changed_settings_sign_in_again_at_once(self):
        self._configure("old")
        tokens = [_resp(200, {"access_token": "A", "expires_in": 3600}),
                  _resp(200, {"access_token": "B", "expires_in": 3600})]
        with (
            mock.patch("monitoring.secret_store_azure.requests.post",
                       side_effect=tokens) as post,
            mock.patch("monitoring.secret_store_azure.requests.request",
                       return_value=_resp(200, {"value": "{}"})) as req,
        ):
            active_secret_store().get(self.tid, "a")
            self._configure("new")
            active_secret_store().get(self.tid, "a")
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args[1]["data"]["client_secret"], "new")
        self.assertEqual(req.call_args[1]["headers"]["Authorization"], "Bearer B")

    def test_a_token_is_renewed_before_it_expires(self):
        store = AzureKeyVaultSecretStore("https://kv.vault.azure.net", "d", "c", "s")
        tokens = [_resp(200, {"access_token": "A", "expires_in": 3600}),
                  _resp(200, {"access_token": "B", "expires_in": 3600})]
        clock = mock.Mock(return_value=1000.0)
        with (
            mock.patch("monitoring.secret_store_azure.time.monotonic", clock),
            mock.patch("monitoring.secret_store_azure.requests.post",
                       side_effect=tokens) as post,
        ):
            self.assertEqual(store._access_token(), "A")
            clock.return_value = 1000.0 + 3600 - 301
            self.assertEqual(store._access_token(), "A")
            clock.return_value = 1000.0 + 3600 - 299
            self.assertEqual(store._access_token(), "B")
        self.assertEqual(post.call_count, 2)

    def test_a_refused_token_is_renewed_once(self):
        store = AzureKeyVaultSecretStore("https://kv.vault.azure.net", "d", "c", "s")
        tokens = [_resp(200, {"access_token": "A", "expires_in": 3600}),
                  _resp(200, {"access_token": "B", "expires_in": 3600})]
        with (
            mock.patch("monitoring.secret_store_azure.requests.post",
                       side_effect=tokens),
            mock.patch("monitoring.secret_store_azure.requests.request",
                       side_effect=[_resp(401), _resp(200, {"value": '{"k": 1}'})]) as req,
        ):
            self.assertEqual(store.get(self.tid, "a"), {"k": 1})
        auth = [c[1]["headers"]["Authorization"] for c in req.call_args_list]
        self.assertEqual(auth, ["Bearer A", "Bearer B"])

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


class AzureFromDeploymentTests(TestCase):
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


class AzureHttpsOnlyTests(TestCase):
    """The client secret, the bearer token and the secret values never go to
    a plain-http Key Vault URL or sign-in endpoint (#512). A HashiCorp Vault
    on plain HTTP inside the LAN stays allowed."""

    def setUp(self):
        from django.contrib.auth.models import User
        from django.test import Client

        user = User.objects.create_user("root", password="x", is_superuser=True)
        self.c = Client()
        self.c.force_login(user)

    def _put(self, **body):
        import json

        return self.c.put(
            "/api/deployment/email/", data=json.dumps(body), content_type="application/json"
        )

    def test_the_store_refuses_an_http_vault_url_or_authority(self):
        with self.assertRaises(SecretStoreError):
            AzureKeyVaultSecretStore("http://kv.vault.azure.net", "d", "c", "s")
        with self.assertRaises(SecretStoreError):
            AzureKeyVaultSecretStore(
                "https://kv.vault.azure.net", "d", "c", "s",
                authority="http://login.microsoftonline.com",
            )

    def test_an_http_row_saved_before_the_check_is_disabled_not_used(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "azure"
        dep.azure_vault_url = "http://kvmock.vault.azure.test:9080"
        dep.azure_directory_id = "dir"
        dep.azure_client_id = "client"
        dep.azure_authority = ""
        dep.secrets = {"azure_client_secret": "s"}
        dep.save()
        with (
            mock.patch("monitoring.secret_store_azure.requests.post") as post,
            mock.patch("monitoring.secret_store_azure.requests.request") as req,
        ):
            self.assertIsNone(active_secret_store())
            with self.assertRaises(SecretStoreDisabled):
                require_secret_store()
        post.assert_not_called()
        req.assert_not_called()

    def test_settings_refuse_http_for_the_vault_url_and_sign_in_endpoint(self):
        r = self._put(azure_vault_url="http://kvmock.vault.azure.test:9080")
        self.assertEqual(r.status_code, 400)
        self.assertIn("https://", str(r.json()["azure_vault_url"]))
        r = self._put(azure_authority="http://login.azure.test:9080")
        self.assertEqual(r.status_code, 400)
        self.assertIn("https://", str(r.json()["azure_authority"]))
        r = self._put(azure_vault_url="https:///no-host")
        self.assertEqual(r.status_code, 400)

    def test_settings_accept_https_and_blank(self):
        r = self._put(
            azure_vault_url="https://kv-danbyte.vault.azure.net",
            azure_authority="https://login.microsoftonline.us",
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self._put(azure_vault_url="", azure_authority="")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_plain_http_hashicorp_vault_still_saves_and_works(self):
        r = self._put(vault_addr="http://10.0.0.48:8200", vault_token="hvs.x",
                      secrets_provider="vault")
        self.assertEqual(r.status_code, 200, r.content)
        store = VaultSecretStore.from_deployment()
        self.assertEqual(store.addr, "http://10.0.0.48:8200")
        with mock.patch(
            "monitoring.secret_store_vault.requests.request",
            return_value=_resp(200, {"data": {"data": {"k": "v"}}}),
        ) as req:
            self.assertEqual(store.get("t", "csr/x"), {"k": "v"})
        self.assertTrue(req.call_args[0][1].startswith("http://10.0.0.48:8200/v1/"))

    def test_the_vault_address_field_carries_a_warning_not_a_rule(self):
        r = self.c.get("/api/deployment/secret-stores/")
        vault = next(p for p in r.json()["providers"] if p["kind"] == "vault")
        addr = next(f for f in vault["fields"] if f["name"] == "vault_addr")
        self.assertIn("warn_http", addr)
