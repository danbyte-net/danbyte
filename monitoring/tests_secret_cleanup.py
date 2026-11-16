"""A deleted record takes its managed secret with it (#509), and the orphan
sweep finds what older releases left behind."""
from __future__ import annotations

import io
import uuid
from unittest import mock

from django.contrib.auth.models import User
from django.core.management import call_command
from django.db import transaction
from rest_framework.test import APITestCase

from api.models import Device, WirelessLAN
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import CertificateRequest, DeviceCredential, Issuer, StoredSecret
from .secret_refs import MANAGED_SECRETS, owner_exists, spec_for_ref
from .secret_store import MANAGED_REF_PREFIXES, LocalFernetSecretStore
from .secret_store_azure import AzureKeyVaultSecretStore
from .secret_store_vault import VaultSecretStore

BASE = "/api/monitoring/device-credentials/"


def _provider(kind):
    dep = DeploymentSettings.load()
    dep.secrets_provider = kind
    dep.save(update_fields=["secrets_provider"])


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        self.su = User.objects.create_user("root", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.su, role="custom").tenants.add(self.tenant)
        self.client.force_login(self.su)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        _provider("local")

    def _managed(self, name="kv-managed", password="pw-1"):
        r = self.client.post(BASE, {
            "device": str(self.device.id), "name": name, "kind": "ssh_password",
            "username": "netops", "password": password,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return DeviceCredential.objects.get(pk=r.json()["id"])

    def _secrets(self, cred):
        return StoredSecret.objects.filter(tenant=self.tenant, ref=f"device-credentials/{cred.id}")


class DeleteTakesTheSecretTests(_Base):
    def test_deleting_a_managed_credential_removes_its_secret(self):
        cred = self._managed()
        self.client.patch(f"{BASE}{cred.id}/", {"password": "pw-2"}, format="json")
        self.assertEqual(self._secrets(cred).count(), 1)
        self.assertEqual(self.client.delete(f"{BASE}{cred.id}/").status_code, 204)
        self.assertEqual(self._secrets(cred).count(), 0)

    def test_deleting_the_device_removes_its_credentials_secrets(self):
        a, b = self._managed("a"), self._managed("b")
        self.device.delete()
        self.assertEqual(self._secrets(a).count() + self._secrets(b).count(), 0)

    def test_a_queryset_delete_removes_them_too(self):
        cred = self._managed()
        DeviceCredential.objects.filter(pk=cred.pk).delete()
        self.assertEqual(self._secrets(cred).count(), 0)

    def test_a_rolled_back_delete_keeps_the_secret(self):
        cred = self._managed()
        pk = cred.pk
        try:
            with transaction.atomic():
                cred.delete()
                raise RuntimeError("roll back")
        except RuntimeError:
            pass
        self.assertTrue(DeviceCredential.objects.filter(pk=pk).exists())
        self.assertEqual(
            StoredSecret.objects.filter(ref=f"device-credentials/{pk}").count(), 1)

    def test_an_external_credential_leaves_the_operators_secret_alone(self):
        StoredSecret.objects.create(tenant=self.tenant, ref="creds/sw1", value={"password": "x"})
        r = self.client.post(BASE, {
            "device": str(self.device.id), "name": "ext", "kind": "ssh_password",
            "username": "u", "secret_managed": False, "secret_path": "creds/sw1",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.client.delete(f"{BASE}{r.json()['id']}/")
        self.assertTrue(StoredSecret.objects.filter(ref="creds/sw1").exists())

    def test_turning_a_credential_external_drops_the_filed_secret(self):
        StoredSecret.objects.create(tenant=self.tenant, ref="creds/sw1", value={"password": "x"})
        cred = self._managed()
        r = self.client.patch(f"{BASE}{cred.id}/", {
            "secret_managed": False, "secret_path": "creds/sw1"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._secrets(cred).count(), 0)
        self.assertTrue(StoredSecret.objects.filter(ref="creds/sw1").exists())

    def test_an_external_store_deletes_only_after_the_commit(self):
        cred = self._managed()
        remote = mock.Mock(spec=["delete"])
        with mock.patch("monitoring.secret_store.store_for",
                        side_effect=lambda k: remote if k == "azure" else None):
            DeviceCredential.objects.filter(pk=cred.pk).update(secret_provider="azure")
            cred.refresh_from_db()
            ref = f"device-credentials/{cred.pk}"
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                cred.delete()
            remote.delete.assert_not_called()
            for cb in callbacks:
                cb()
        remote.delete.assert_called_once_with(self.tenant.id, ref)

    def test_an_unreachable_store_does_not_fail_the_delete(self):
        from .secret_store import SecretStoreError

        cred = self._managed()
        remote = mock.Mock(spec=["delete"])
        remote.delete.side_effect = SecretStoreError("down")
        DeviceCredential.objects.filter(pk=cred.pk).update(secret_provider="vault")
        with mock.patch("monitoring.secret_store.store_for",
                        side_effect=lambda k: remote if k == "vault" else None):
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.delete(f"{BASE}{cred.id}/")
        self.assertEqual(r.status_code, 204)
        remote.delete.assert_called_once()

    def test_wireless_bulk_delete_removes_each_key(self):
        r = self.client.post("/api/wireless-lans/", {
            "ssid": "corp", "auth_type": "wpa-personal", "psk": "hunter2-hunter2"},
            format="json")
        self.assertEqual(r.status_code, 201, r.content)
        lan = WirelessLAN.objects.get(pk=r.json()["id"])
        self.assertTrue(StoredSecret.objects.filter(ref=lan.psk_secret_path).exists())
        r = self.client.post("/api/wireless-lans/bulk-delete/", {"ids": [str(lan.id)]},
                             format="json")
        self.assertIn(r.status_code, (200, 204), r.content)
        self.assertFalse(StoredSecret.objects.filter(ref=lan.psk_secret_path).exists())


class RegistryTests(_Base):
    def test_every_managed_folder_is_a_protected_prefix(self):
        for spec in MANAGED_SECRETS:
            self.assertIn(f"{spec.folder}/", MANAGED_REF_PREFIXES, spec.model)

    def test_refs_parse_back_to_their_row(self):
        pk = uuid.uuid4()
        self.assertEqual(spec_for_ref(f"device-credentials/{pk}")[1], pk)
        self.assertEqual(spec_for_ref(f"issuer/{pk}/account")[0].model, "monitoring.Issuer")
        for ref in ("device-credentials/x", f"issuer/{pk}", f"csr/{pk}/x", "creds/sw1"):
            self.assertIsNone(spec_for_ref(ref), ref)

    def test_ownership_is_per_tenant(self):
        cred = self._managed()
        ref = f"device-credentials/{cred.id}"
        org = self.tenant.org
        other = Tenant.objects.create(org=org, name="Two", slug="two")
        self.assertTrue(owner_exists(self.tenant.id, ref))
        self.assertFalse(owner_exists(other.id, ref))
        self.assertFalse(owner_exists(self.tenant.id, f"device-credentials/{uuid.uuid4()}"))


class CleanupCommandTests(_Base):
    def _orphans(self):
        dead = uuid.uuid4()
        StoredSecret.objects.create(tenant=self.tenant, ref=f"device-credentials/{dead}",
                                    value={"password": "old"})
        StoredSecret.objects.create(tenant=self.tenant, ref=f"issuer/{dead}/account",
                                    value={"account_key": "k"})
        return dead

    def _run(self, *args):
        out = io.StringIO()
        call_command("cleanup_secret_store", *args, stdout=out, stderr=io.StringIO())
        return out.getvalue()

    def test_dry_run_lists_and_keeps(self):
        live = self._managed()
        dead = self._orphans()
        StoredSecret.objects.create(tenant=self.tenant, ref="creds/sw1", value={})
        out = self._run("--store", "local")
        self.assertIn(f"device-credentials/{dead}", out)
        self.assertIn(f"issuer/{dead}/account", out)
        self.assertNotIn(str(live.id), out)
        self.assertNotIn("creds/sw1", out)
        self.assertNotIn("old", out.replace("orphaned", ""))
        self.assertEqual(StoredSecret.objects.count(), 4)
        self.assertFalse(ChangeLogEntry.objects.filter(object_type="monitoring.storedsecret").exists())

    def test_delete_removes_local_orphans_and_audits(self):
        live = self._managed()
        dead = self._orphans()
        self._run("--store", "local", "--delete")
        self.assertEqual(
            sorted(StoredSecret.objects.values_list("ref", flat=True)),
            [f"device-credentials/{live.id}"],
        )
        entry = ChangeLogEntry.objects.get(object_type="monitoring.storedsecret")
        self.assertEqual(entry.action, ChangeAction.DELETE)
        self.assertEqual(entry.tenant_id, self.tenant.id)
        self.assertEqual(entry.changes["removed"], 2)
        self.assertIn(f"device-credentials/{dead}", entry.changes["refs"])

    def test_tenant_flag_limits_the_sweep(self):
        other = Tenant.objects.create(org=self.tenant.org, name="Two", slug="two")
        StoredSecret.objects.create(tenant=other, ref=f"csr/{uuid.uuid4()}", value={})
        self._orphans()
        self._run("--store", "local", "--tenant", "two", "--delete")
        self.assertEqual(StoredSecret.objects.filter(tenant=other).count(), 0)
        self.assertEqual(StoredSecret.objects.filter(tenant=self.tenant).count(), 2)

    def test_a_credential_in_another_tenant_does_not_own_the_ref(self):
        cred = self._managed()
        other = Tenant.objects.create(org=self.tenant.org, name="Two", slug="two")
        StoredSecret.objects.create(tenant=other, ref=f"device-credentials/{cred.id}", value={})
        self._run("--store", "local", "--delete")
        self.assertEqual(StoredSecret.objects.filter(tenant=other).count(), 0)
        self.assertEqual(self._secrets(cred).count(), 1)

    def test_remote_orphans_need_the_remote_flag(self):
        tid = str(self.tenant.id)
        dead = uuid.uuid4()
        vault = mock.Mock(spec=["managed_refs", "delete"])
        vault.managed_refs.return_value = [(tid, f"device-credentials/{dead}")]
        with mock.patch("monitoring.management.commands.cleanup_secret_store.store_for",
                        side_effect=lambda k: vault if k == "vault" else None):
            out = self._run("--store", "vault", "--delete")
            vault.delete.assert_not_called()
            self.assertIn("--remote", out)
            self._run("--store", "vault", "--delete", "--remote")
        vault.delete.assert_called_once_with(tid, f"device-credentials/{dead}")


def _resp(status, json_body=None, text=""):
    m = mock.Mock()
    m.status_code = status
    m.json.return_value = json_body or {}
    m.text = text
    return m


class StoreListingTests(_Base):
    def test_vault_lists_tenant_folders_only(self):
        tid = str(self.tenant.id)
        cid, iid = uuid.uuid4(), uuid.uuid4()
        tree = {
            "": [f"{tid}/", "team/"],
            f"{tid}/": ["device-credentials/", "issuer/", "other/"],
            f"{tid}/device-credentials/": [str(cid)],
            f"{tid}/issuer/": [f"{iid}/"],
            f"{tid}/issuer/{iid}/": ["account"],
        }
        store = VaultSecretStore("http://vault.lan:8200", "t", mount="danbyte")

        def fake(method, url, **kw):
            self.assertEqual(method, "LIST")
            path = url.split("/v1/danbyte/metadata/", 1)[1]
            if path not in tree:
                return _resp(404)
            return _resp(200, {"data": {"keys": tree[path]}})

        with mock.patch("monitoring.secret_store_vault.requests.request", side_effect=fake):
            refs = store.managed_refs()
        self.assertEqual(sorted(refs), sorted([
            (tid, f"device-credentials/{cid}"), (tid, f"issuer/{iid}/account")]))

    def test_key_vault_maps_names_back_and_stays_on_the_vault(self):
        tid = str(self.tenant.id)
        cid = uuid.uuid4()
        store = AzureKeyVaultSecretStore("https://kv.vault.azure.net", "d", "c", "s")
        mine = store._name(tid, f"device-credentials/{cid}")
        csr = store._name(tid, f"csr/{cid}")
        pages = [
            _resp(200, {"value": [{"id": f"https://kv.vault.azure.net/secrets/{mine}"},
                                  {"id": "https://kv.vault.azure.net/secrets/team-ssh"}],
                        "nextLink": "https://kv.vault.azure.net/secrets?api-version=7.4&$skiptoken=x"}),
            _resp(200, {"value": [{"id": f"https://kv.vault.azure.net/secrets/{csr}"}]}),
        ]
        with (
            mock.patch.object(AzureKeyVaultSecretStore, "_access_token", return_value="t"),
            mock.patch("monitoring.secret_store_azure.requests.request",
                       side_effect=pages) as req,
        ):
            refs = store.managed_refs()
        self.assertEqual(sorted(refs), sorted([(tid, f"device-credentials/{cid}"),
                                               (tid, f"csr/{cid}")]))
        self.assertIn("skiptoken", req.call_args_list[1][0][1])

    def test_key_vault_refuses_a_next_link_to_another_host(self):
        store = AzureKeyVaultSecretStore("https://kv.vault.azure.net", "d", "c", "s")
        from .secret_store import SecretStoreError

        page = _resp(200, {"value": [], "nextLink": "https://evil.example/secrets?x=1"})
        with (
            mock.patch.object(AzureKeyVaultSecretStore, "_access_token", return_value="t"),
            mock.patch("monitoring.secret_store_azure.requests.request",
                       return_value=page) as req,
        ):
            with self.assertRaises(SecretStoreError):
                store.managed_refs()
        self.assertEqual(req.call_count, 1)


class IssuerDeleteTests(_Base):
    def test_an_issuer_with_an_implied_ref_drops_it(self):
        issuer = Issuer.objects.create(tenant=self.tenant, name="le",
                                       directory_url="https://acme.test/directory",
                                       account_uri="https://acme.test/acct/1")
        ref = f"issuer/{issuer.id}/account"
        StoredSecret.objects.create(tenant=self.tenant, ref=ref, value={"account_key": "k"})
        issuer.delete()
        self.assertFalse(StoredSecret.objects.filter(ref=ref).exists())
