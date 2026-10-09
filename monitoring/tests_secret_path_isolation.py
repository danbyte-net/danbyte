"""Secret paths never cross a tenant boundary, on any store (#315).

With Vault as the store every tenant shares the deployment's one token, so the
only thing between tenant B and tenant A's managed secrets is the path Danbyte
builds. These tests run the real API and the real Vault client against an
in-memory KV v2 that normalises the URL the way urllib3 does before sending -
so a ``..`` the client collapses is caught here rather than hidden by a mock.

Routes covered: an external credential naming another tenant's managed path
(plain, ``metadata`` form, ``..`` form, percent-encoded form), a managed
credential carrying a client-supplied path on create and on update, rows that
were written before this check existed, and the same shape on the Azure and
local stores.
"""
from __future__ import annotations

import uuid
from unittest import mock
from urllib.parse import unquote, urlsplit

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase
from urllib3.util.url import _remove_path_dot_segments

from api.models import Device, WirelessLAN
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import DeviceCredential, StoredSecret
from .secret_store import (
    MANAGED_REF_PREFIXES,
    LocalFernetSecretStore,
    SecretPathError,
    SecretStoreError,
    clean_secret_path,
)
from .secret_store_azure import AzureKeyVaultSecretStore
from .secret_store_vault import VaultSecretStore

BASE = "/api/monitoring/device-credentials/"
VAULT = "monitoring.secret_store_vault.requests.request"


def _resp(status, json_body=None, text=""):
    m = mock.Mock()
    m.status_code = status
    m.json.return_value = json_body if json_body is not None else {}
    m.text = text
    return m


class FakeVault:
    """An in-memory KV v2 behind ``requests.request``.

    Keys are the URL path after ``/v1/`` with dot segments removed and
    percent-escapes decoded - what the real server sees once urllib3 has
    normalised the URL and Vault's router has decoded it. A ``..`` that the
    client collapses therefore lands on the collapsed path, exactly as reported.
    """

    def __init__(self):
        self.data: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method, url, **kw):
        # Collapse dot segments as urllib3 does, decode as the server does, and
        # collapse once more - the most permissive server a path could meet.
        path = _remove_path_dot_segments(
            unquote(_remove_path_dot_segments(urlsplit(url).path))
        )
        assert path.startswith("/v1/"), path
        key = path[len("/v1/"):]
        self.calls.append((method, key))
        if method == "POST":
            self.data[key] = dict((kw.get("json") or {}).get("data") or {})
            return _resp(204)
        if method == "GET":
            if key in self.data:
                return _resp(200, {"data": {"data": self.data[key], "metadata": {"version": 1}}})
            as_data = key.replace("/metadata/", "/data/", 1)
            if "/metadata/" in key and as_data in self.data:
                return _resp(200, {"data": {"versions": {"1": {}}, "custom_metadata": None}})
            return _resp(404)
        if method == "DELETE":
            self.data.pop(key.replace("/metadata/", "/data/", 1), None)
            return _resp(204)
        return _resp(405)

    def reads_of(self, key: str) -> int:
        return sum(1 for m, k in self.calls if m == "GET" and k == key)


def _enable_vault():
    dep = DeploymentSettings.load()
    dep.secrets_provider = "vault"
    dep.vault_addr = "http://vault.example:8200"
    dep.vault_mount = "danbyte"
    dep.secrets = {"vault_token": "tok"}
    dep.save()


class _TwoTenants:
    def _tenants(self):
        org = Organization.objects.create(name="O", slug="o")
        self.a = Tenant.objects.create(org=org, name="A", slug="a")
        self.b = Tenant.objects.create(org=org, name="B", slug="b")
        self.a_device = Device.objects.create(tenant=self.a, name="a-sw1")
        self.b_device = Device.objects.create(tenant=self.b, name="b-sw1")

    def _user(self, name, tenant, *, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        UserProfile.objects.create(user=u, role="custom").tenants.add(tenant)
        return u

    def _grant(self, user, tenant, slug_actions):
        for slug, actions in slug_actions.items():
            perm = ObjectPermission.objects.create(
                name=f"{slug}:{','.join(actions)}", object_types=[slug], actions=actions
            )
            perm.users.add(user)
            perm.tenants.add(tenant)

    def _login(self, user, tenant):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()


class VaultTenantIsolationApiTests(_TwoTenants, APITestCase):
    """The report's reproduction, end to end, against the fake Vault."""

    def setUp(self):
        self._tenants()
        _enable_vault()
        self.vault = FakeVault()
        patcher = mock.patch(VAULT, new=self.vault)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.a_root = self._user("a-root", self.a, superuser=True)
        # Tenant B's operator: full credential rights on B, nothing deployment-wide.
        self.b_user = self._user("b-user", self.b)
        self._grant(
            self.b_user, self.b,
            {"devicecredential": ["view", "add", "change", "reveal"], "device": ["view"]},
        )
        self.b_root = self._user("b-root", self.b, superuser=True)

        # Tenant A stores a managed credential: Danbyte files it under A's namespace.
        self._login(self.a_root, self.a)
        r = self.client.post(
            BASE,
            {
                "device": str(self.a_device.id), "name": "root", "kind": "ssh_password",
                "username": "root", "secret_managed": True, "password": "TenantA-Root-Pw",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.a_cred = DeviceCredential.objects.get(pk=r.json()["id"])
        self.a_key = f"danbyte/data/{self.a.id}/device-credentials/{self.a_cred.id}"
        self.assertEqual(self.vault.data[self.a_key], {"password": "TenantA-Root-Pw"})

    def _a_reveal(self):
        self._login(self.a_root, self.a)
        r = self.client.post(f"{BASE}{self.a_cred.id}/reveal/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["secret"]

    def _attack_paths(self):
        a, cid, b = self.a.id, self.a_cred.id, self.b.id
        return [
            f"danbyte/data/{a}/device-credentials/{cid}",
            f"danbyte/metadata/{a}/device-credentials/{cid}",
            f"danbyte/subkeys/{a}/device-credentials/{cid}",
            f"danbyte/data/{b}/../{a}/device-credentials/{cid}",
            f"danbyte/data/{b}/..%2F{a}/device-credentials/{cid}",
            f"danbyte/data/%2e%2e/{a}/device-credentials/{cid}",
            f"danbyte/data/{b}/%252e%252e/{a}/device-credentials/{cid}",
            f"/danbyte/data/{a}/device-credentials/{cid}",
            f"danbyte//data/{a}/device-credentials/{cid}",
            f"danbyte\\data\\{a}\\device-credentials\\{cid}",
            f"danbyte/data/{a}/device-credentials/{cid}?version=1",
            f"danbyte/data/{a}/device-credentials/{cid}\n",
        ]

    # ── (a) external credentials naming another tenant's managed secret ──────
    def test_tenant_operator_cannot_create_an_external_credential_at_all(self):
        # External paths are read with the deployment's one token, so naming
        # one is a deployment-level act: a tenant operator is refused even for
        # a path that is nowhere near another tenant.
        self._login(self.b_user, self.b)
        r = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "x", "kind": "ssh_password",
                "secret_managed": False, "secret_path": "kv/data/team/ssh",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(DeviceCredential.objects.filter(tenant=self.b).exists())

    def test_tenant_operator_cannot_read_another_tenants_secret_by_path(self):
        # The report's step 3-4, for every spelling of A's path. Whatever the
        # status, A's value must never leave and Vault must never be asked.
        self._login(self.b_user, self.b)
        for i, path in enumerate(self._attack_paths()):
            r = self.client.post(
                BASE,
                {
                    "device": str(self.b_device.id), "name": f"x{i}", "kind": "ssh_password",
                    "secret_managed": False, "secret_path": path,
                },
                format="json",
            )
            self.assertIn(r.status_code, (400, 403), (path, r.content))
            self.assertNotIn("TenantA-Root-Pw", r.content.decode())
        self.assertEqual(self.vault.reads_of(self.a_key), 0)
        self.assertEqual(self.vault.reads_of(self.a_key.replace("/data/", "/metadata/")), 0)

    def test_deployment_admin_cannot_point_an_external_credential_into_a_managed_namespace(self):
        # Even the admin who may create external credentials gets a field
        # error: the managed namespace of ANY tenant is off limits, compared
        # after normalisation.
        self._login(self.b_root, self.b)
        for i, path in enumerate(self._attack_paths()):
            r = self.client.post(
                BASE,
                {
                    "device": str(self.b_device.id), "name": f"x{i}", "kind": "ssh_password",
                    "secret_managed": False, "secret_path": path,
                },
                format="json",
            )
            self.assertEqual(r.status_code, 400, (path, r.content))
            self.assertIn("secret_path", r.json(), path)
        self.assertFalse(DeviceCredential.objects.filter(tenant=self.b).exists())
        self.assertEqual(self.vault.reads_of(self.a_key), 0)

    def test_deployment_admin_can_create_an_external_credential_on_another_mount(self):
        self.vault.data["kv/data/team/ssh"] = {"password": "team-pw"}
        self._login(self.b_root, self.b)
        r = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "team", "kind": "ssh_password",
                "secret_managed": False, "secret_path": "kv/data/team/ssh",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        rev = self.client.post(f"{BASE}{r.json()['id']}/reveal/")
        self.assertEqual(rev.status_code, 200, rev.content)
        self.assertEqual(rev.json()["secret"], {"password": "team-pw"})

    def test_external_path_on_the_same_mount_outside_any_tenant_is_allowed(self):
        # A shared mount is fine as long as the path is not a tenant's folder.
        self.vault.data["danbyte/data/team/ssh"] = {"password": "team-pw"}
        self._login(self.b_root, self.b)
        r = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "team", "kind": "ssh_password",
                "secret_managed": False, "secret_path": "danbyte/data/team/ssh",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        rev = self.client.post(f"{BASE}{r.json()['id']}/reveal/")
        self.assertEqual(rev.json()["secret"], {"password": "team-pw"})

    def test_tenant_operator_cannot_repoint_or_unmanage_an_existing_credential(self):
        self.vault.data["kv/data/team/ssh"] = {"password": "team-pw"}
        self._login(self.b_root, self.b)
        ext = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "team", "kind": "ssh_password",
                "secret_managed": False, "secret_path": "kv/data/team/ssh",
            },
            format="json",
        ).json()
        managed = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "mine", "kind": "ssh_password",
                "secret_managed": True, "password": "b-pw",
            },
            format="json",
        ).json()

        self._login(self.b_user, self.b)
        # Editing the login details of an existing external credential is fine...
        r = self.client.patch(
            f"{BASE}{ext['id']}/",
            {"username": "ops", "secret_managed": False, "secret_path": "kv/data/team/ssh"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        # ...re-pointing it is not...
        r = self.client.patch(
            f"{BASE}{ext['id']}/", {"secret_path": "kv/data/other/ssh"}, format="json"
        )
        self.assertEqual(r.status_code, 403, r.content)
        # ...and neither is turning a managed credential into an external one.
        r = self.client.patch(
            f"{BASE}{managed['id']}/",
            {"secret_managed": False, "secret_path": "kv/data/team/ssh"},
            format="json",
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertTrue(DeviceCredential.objects.get(pk=managed["id"]).secret_managed)

    # ── (b) managed credentials never take a path from the client ────────────
    def test_managed_path_is_derived_on_create(self):
        # The report's step 5: a managed credential with a traversal path and a
        # new password. The path is ignored, the write lands in B's own folder,
        # and A's secret is untouched.
        self._login(self.b_user, self.b)
        r = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "x", "kind": "ssh_password",
                "secret_managed": True,
                "secret_path": f"../{self.a.id}/device-credentials/{self.a_cred.id}",
                "password": "owned-by-B",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        cred = DeviceCredential.objects.get(pk=r.json()["id"])
        self.assertEqual(cred.secret_path, f"device-credentials/{cred.id}")
        self.assertEqual(r.json()["secret_path"], f"device-credentials/{cred.id}")
        self.assertEqual(
            self.vault.data[f"danbyte/data/{self.b.id}/device-credentials/{cred.id}"],
            {"password": "owned-by-B"},
        )
        self.assertEqual(self.vault.data[self.a_key], {"password": "TenantA-Root-Pw"})
        self.assertEqual(self._a_reveal(), {"password": "TenantA-Root-Pw"})

    def test_managed_path_is_derived_on_update(self):
        self._login(self.b_user, self.b)
        cred_id = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "x", "kind": "ssh_password",
                "secret_managed": True, "password": "first",
            },
            format="json",
        ).json()["id"]
        for path in (
            f"../{self.a.id}/device-credentials/{self.a_cred.id}",
            f"danbyte/data/{self.a.id}/device-credentials/{self.a_cred.id}",
        ):
            r = self.client.patch(
                f"{BASE}{cred_id}/",
                {"secret_path": path, "password": "owned-by-B"},
                format="json",
            )
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()["secret_path"], f"device-credentials/{cred_id}")
        self.assertEqual(self.vault.data[self.a_key], {"password": "TenantA-Root-Pw"})
        self.assertEqual(
            self.vault.data[f"danbyte/data/{self.b.id}/device-credentials/{cred_id}"],
            {"password": "owned-by-B"},
        )
        self.assertEqual(self._a_reveal(), {"password": "TenantA-Root-Pw"})

    def test_managed_path_cannot_be_changed_without_a_new_secret(self):
        # A managed credential's path never moves on a plain edit either.
        self._login(self.b_user, self.b)
        cred_id = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "x", "kind": "ssh_password",
                "secret_managed": True, "password": "first",
            },
            format="json",
        ).json()["id"]
        r = self.client.patch(
            f"{BASE}{cred_id}/", {"secret_path": self.a_key}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret_path"], f"device-credentials/{cred_id}")
        rev = self.client.post(f"{BASE}{cred_id}/reveal/")
        self.assertEqual(rev.json()["secret"], {"password": "first"})

    def test_switching_an_external_credential_to_managed_drops_the_old_path(self):
        self.vault.data["kv/data/team/ssh"] = {"password": "team-pw"}
        self._login(self.b_root, self.b)
        ext_id = self.client.post(
            BASE,
            {
                "device": str(self.b_device.id), "name": "team", "kind": "ssh_password",
                "secret_managed": False, "secret_path": "kv/data/team/ssh",
            },
            format="json",
        ).json()["id"]
        r = self.client.patch(f"{BASE}{ext_id}/", {"secret_managed": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret_path"], "")
        self.assertFalse(r.json()["secret_set"])
        r = self.client.patch(f"{BASE}{ext_id}/", {"password": "typed"}, format="json")
        self.assertEqual(r.json()["secret_path"], f"device-credentials/{ext_id}")
        self.assertEqual(
            self.vault.data[f"danbyte/data/{self.b.id}/device-credentials/{ext_id}"],
            {"password": "typed"},
        )

    # ── rows written before this check existed ───────────────────────────────
    def test_legacy_external_row_inside_a_managed_namespace_is_refused_on_reveal(self):
        for i, path in enumerate(self._attack_paths()):
            cred = DeviceCredential.objects.create(
                tenant=self.b, device=self.b_device, name=f"old-{i}",
                kind="ssh_password", secret_managed=False, secret_provider="vault",
                secret_path=path,
            )
            self._login(self.b_root, self.b)
            r = self.client.post(f"{BASE}{cred.id}/reveal/")
            self.assertEqual(r.status_code, 400, (path, r.content))
            self.assertNotIn("TenantA-Root-Pw", r.content.decode())
            self.assertIn("detail", r.json())
        self.assertEqual(self.vault.reads_of(self.a_key), 0)

    def test_legacy_external_row_outside_the_namespace_still_resolves(self):
        self.vault.data["kv/data/team/ssh"] = {"password": "team-pw"}
        cred = DeviceCredential.objects.create(
            tenant=self.b, device=self.b_device, name="old", kind="ssh_password",
            secret_managed=False, secret_provider="vault", secret_path="kv/data/team/ssh",
        )
        self._login(self.b_user, self.b)
        r = self.client.post(f"{BASE}{cred.id}/reveal/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret"], {"password": "team-pw"})

    def test_legacy_managed_row_with_a_traversal_ref_is_refused_then_healed(self):
        # A managed row whose path was planted before the fix: reading refuses
        # (no collapse into A's folder), and the next secret write re-derives
        # the path into B's own folder.
        cred = DeviceCredential.objects.create(
            tenant=self.b, device=self.b_device, name="old", kind="ssh_password",
            secret_managed=True, secret_provider="vault",
            secret_path=f"../{self.a.id}/device-credentials/{self.a_cred.id}",
        )
        self._login(self.b_user, self.b)
        r = self.client.post(f"{BASE}{cred.id}/reveal/")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertNotIn("TenantA-Root-Pw", r.content.decode())
        self.assertEqual(self.vault.reads_of(self.a_key), 0)

        r = self.client.patch(f"{BASE}{cred.id}/", {"password": "owned-by-B"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret_path"], f"device-credentials/{cred.id}")
        self.assertEqual(self.vault.data[self.a_key], {"password": "TenantA-Root-Pw"})
        self.assertEqual(self._a_reveal(), {"password": "TenantA-Root-Pw"})

    def test_legacy_managed_row_with_a_custom_in_tenant_ref_still_resolves(self):
        # Before the fix a managed credential could carry a custom ref. It is
        # still inside B's own folder, so reading it stays allowed.
        self.vault.data[f"danbyte/data/{self.b.id}/creds/sw1/admin"] = {"password": "legacy"}
        cred = DeviceCredential.objects.create(
            tenant=self.b, device=self.b_device, name="old", kind="ssh_password",
            secret_managed=True, secret_provider="vault", secret_path="creds/sw1/admin",
        )
        self._login(self.b_user, self.b)
        r = self.client.post(f"{BASE}{cred.id}/reveal/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret"], {"password": "legacy"})


class CleanSecretPathTests(TestCase):
    """The shared hygiene check every store applies to a ref or path."""

    def test_accepts_ordinary_paths(self):
        for p in ("device-credentials/abc", "kv/data/team/ssh", "team/my%20secret", "a.b/c-d_e"):
            self.assertEqual(clean_secret_path(p), p)

    def test_refuses_traversal_and_malformed_paths(self):
        bad = [
            "", "/kv/data/x", "kv//data", "kv/data/x/", "..", "kv/../x", "kv/./x",
            "kv/%2e%2e/x", "kv/%252e%252e/x", "kv%2F..%2Fx", "kv\\data", "kv/data%5C..",
            "kv/data/x?version=2", "kv/data/x#f", "kv/data/x\n", "kv/data/\x00x", " /x",
            "kv/ /x",
        ]
        for p in bad:
            with self.assertRaises(SecretPathError, msg=repr(p)):
                clean_secret_path(p)

    def test_is_a_store_error_so_callers_already_handle_it(self):
        self.assertTrue(issubclass(SecretPathError, SecretStoreError))


class VaultStoreBoundaryTests(TestCase):
    def setUp(self):
        self.vault = FakeVault()
        patcher = mock.patch(VAULT, new=self.vault)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = VaultSecretStore("http://vault.example:8200", "tok", mount="danbyte")
        self.tid = uuid.uuid4()
        self.other = uuid.uuid4()

    def test_managed_refs_are_checked_before_any_request(self):
        for ref in (f"../{self.other}/x", "/x", "a//b", "a\\b", "x?y", "%2e%2e/x"):
            for op in (
                lambda r: self.store.put(self.tid, r, {"k": "v"}),
                lambda r: self.store.get(self.tid, r),
                lambda r: self.store.delete(self.tid, r),
            ):
                with self.assertRaises(SecretPathError, msg=ref):
                    op(ref)
        self.assertEqual(self.vault.calls, [])

    def test_external_paths_inside_any_tenant_folder_are_refused(self):
        self.vault.data[f"danbyte/data/{self.other}/x"] = {"k": "v"}
        for path in (
            f"danbyte/data/{self.other}/x",
            f"danbyte/metadata/{self.other}/x",
            f"danbyte/subkeys/{self.other}/x",
            f"danbyte/{self.other}/x",
            f"danbyte/data/{self.tid}/x",  # not even the caller's own folder
            f"danbyte/data/{str(self.other).upper()}/x",
            f"danbyte/data/{self.other.hex}/x",
            f"danbyte/data/{self.other}",
        ):
            with self.assertRaises(SecretPathError, msg=path):
                self.store.get_at_path(self.tid, path)
        self.assertEqual(self.vault.calls, [])

    def test_external_paths_elsewhere_are_read(self):
        self.vault.data["kv/data/team/ssh"] = {"password": "p"}
        self.vault.data["danbyte/data/team/ssh"] = {"password": "q"}
        self.assertEqual(self.store.get_at_path(self.tid, "kv/data/team/ssh"), {"password": "p"})
        self.assertEqual(
            self.store.get_at_path(self.tid, "danbyte/data/team/ssh"), {"password": "q"}
        )
        self.assertIsNone(self.store.get_at_path(self.tid, "kv/data/none"))

    def test_nested_mount_is_compared_segment_wise(self):
        store = VaultSecretStore("http://vault.example:8200", "tok", mount="/secret/danbyte/")
        with self.assertRaises(SecretPathError):
            store.get_at_path(self.tid, f"secret/danbyte/data/{self.other}/x")
        # A different mount that merely shares a prefix string is not ours.
        self.vault.data[f"secret/danbyte2/data/{self.other}/x"] = {"k": "v"}
        self.assertEqual(
            store.get_at_path(self.tid, f"secret/danbyte2/data/{self.other}/x"), {"k": "v"}
        )


class AzureStoreBoundaryTests(TestCase):
    def setUp(self):
        self.store = AzureKeyVaultSecretStore(
            "https://kv.vault.azure.net", "dir", "client", "secret"
        )
        self.store._token = "t"
        self.store._token_expires = float("inf")
        self.tid = uuid.uuid4()
        self.other = uuid.uuid4()

    def test_external_names_inside_a_tenant_namespace_are_refused(self):
        managed = self.store._name(self.other, "device-credentials/abc")
        with mock.patch("monitoring.secret_store_azure.requests.request") as req:
            for name in (managed, f"danbyte-{self.other}-x", f"DANBYTE-{str(self.other).upper()}-x"):
                with self.assertRaises(SecretPathError, msg=name):
                    self.store.get_at_path(self.tid, name)
            req.assert_not_called()

    def test_external_names_must_be_key_vault_names(self):
        with mock.patch("monitoring.secret_store_azure.requests.request") as req:
            for name in ("a/b", "../keys/x", "x?api-version=1", "team ssh", "a\\b", "", "x" * 128):
                with self.assertRaises(SecretPathError, msg=name):
                    self.store.get_at_path(self.tid, name)
            req.assert_not_called()

    def test_external_name_is_read_verbatim(self):
        with mock.patch(
            "monitoring.secret_store_azure.requests.request",
            return_value=_resp(200, {"value": "hunter2"}),
        ) as req:
            self.assertEqual(self.store.get_at_path(self.tid, "team-ssh"), {"value": "hunter2"})
        self.assertTrue(req.call_args[0][1].endswith("/secrets/team-ssh"))

    def test_managed_refs_are_checked_before_naming(self):
        with mock.patch("monitoring.secret_store_azure.requests.request") as req:
            for ref in (f"../{self.other}/x", "/x", "a//b"):
                with self.assertRaises(SecretPathError, msg=ref):
                    self.store.put(self.tid, ref, {"k": "v"})
                with self.assertRaises(SecretPathError, msg=ref):
                    self.store.get(self.tid, ref)
            req.assert_not_called()


class LocalStoreBoundaryTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.store = LocalFernetSecretStore()

    def test_external_path_never_names_a_managed_secret(self):
        self.store.put(self.tenant.id, "device-credentials/abc", {"password": "managed"})
        self.store.put(self.tenant.id, "wireless-lans/abc", {"psk": "managed"})
        for path in ("device-credentials/abc", "wireless-lans/abc", "csr/abc", "issuer/abc/account"):
            with self.assertRaises(SecretPathError, msg=path):
                self.store.get_at_path(self.tenant.id, path)
        StoredSecret.objects.create(
            tenant=self.tenant, ref="creds/sw1/admin", value={"password": "seeded"}
        )
        self.assertEqual(
            self.store.get_at_path(self.tenant.id, "creds/sw1/admin"), {"password": "seeded"}
        )

    def test_hygiene_applies_to_the_local_store_too(self):
        for path in ("../x", "/x", "a//b"):
            with self.assertRaises(SecretPathError, msg=path):
                self.store.get_at_path(self.tenant.id, path)
            with self.assertRaises(SecretPathError, msg=path):
                self.store.get(self.tenant.id, path)

    def test_every_managed_prefix_is_listed(self):
        # The local store refuses external paths under these; keep the list in
        # step with what the models actually write.
        from api.models import IPSecProfile
        from routing.models import RoutingKeychain

        from .models import DeviceCredential

        for prefix in (
            DeviceCredential.MANAGED_REF_PREFIX,
            WirelessLAN.psk_secret_prefix,
            IPSecProfile.psk_secret_prefix,
            RoutingKeychain.psk_secret_prefix,
            "csr",
            "issuer",
        ):
            self.assertIn(f"{prefix}/", MANAGED_REF_PREFIXES)


class PskPathDerivationTests(TestCase):
    """The PSK models share the shape: the path is always derived, so a row
    whose path was altered by any route cannot write somewhere else."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.a = Tenant.objects.create(org=org, name="A", slug="a")
        self.b = Tenant.objects.create(org=org, name="B", slug="b")
        _enable_vault()
        self.vault = FakeVault()
        patcher = mock.patch(VAULT, new=self.vault)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_store_psk_always_files_under_the_rows_own_ref(self):
        a_lan = WirelessLAN.objects.create(tenant=self.a, ssid="a", auth_type="wpa-personal")
        a_lan.store_psk("a-psk")
        a_key = f"danbyte/data/{self.a.id}/wireless-lans/{a_lan.id}"
        self.assertEqual(self.vault.data[a_key], {"psk": "a-psk"})

        b_lan = WirelessLAN.objects.create(
            tenant=self.b, ssid="b", auth_type="wpa-personal",
            psk_secret_path=f"../{self.a.id}/wireless-lans/{a_lan.id}",
        )
        b_lan.store_psk("owned-by-B")
        self.assertEqual(b_lan.psk_secret_path, f"wireless-lans/{b_lan.id}")
        self.assertEqual(self.vault.data[a_key], {"psk": "a-psk"})
        self.assertEqual(
            self.vault.data[f"danbyte/data/{self.b.id}/wireless-lans/{b_lan.id}"],
            {"psk": "owned-by-B"},
        )

    def test_resolve_psk_refuses_a_planted_traversal_ref(self):
        a_lan = WirelessLAN.objects.create(tenant=self.a, ssid="a", auth_type="wpa-personal")
        a_lan.store_psk("a-psk")
        b_lan = WirelessLAN.objects.create(
            tenant=self.b, ssid="b", auth_type="wpa-personal",
            psk_secret_path=f"../{self.a.id}/wireless-lans/{a_lan.id}",
        )
        with self.assertRaises(SecretStoreError):
            b_lan.resolve_psk()
        self.assertEqual(self.vault.reads_of(f"danbyte/data/{self.a.id}/wireless-lans/{a_lan.id}"), 0)
