"""Switching the secret store strands nothing (#511): each secret is read from
the store stamped on its record, and migrate_secret_store moves them."""
from __future__ import annotations

import io

from django.contrib.auth.models import User
from django.core.management import call_command
from django.core.management.base import CommandError
from rest_framework.test import APITestCase

from api.models import Device, WirelessLAN
from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import CertificateRequest, DeviceCredential, StoredSecret
from .secret_store import _REGISTRY, SecretPathError, register_secret_store

BASE = "/api/monitoring/device-credentials/"


class MemStore:
    """An external store kept in memory (the shape of Vault / Key Vault)."""

    data: dict = {}

    def put(self, tenant_id, ref, value):
        self.data[(str(tenant_id), ref)] = dict(value)

    def get(self, tenant_id, ref):
        return self.data.get((str(tenant_id), ref))

    def delete(self, tenant_id, ref):
        self.data.pop((str(tenant_id), ref), None)

    def validate_external_path(self, path):
        if path.startswith("device-credentials/"):
            raise SecretPathError("managed")

    def get_at_path(self, tenant_id, path):
        return self.data.get(("ext", path))

    def managed_refs(self, tenant_id=None):
        return [k for k in self.data if k[0] != "ext"]


def _provider(kind):
    dep = DeploymentSettings.load()
    dep.secrets_provider = kind
    dep.save(update_fields=["secrets_provider"])


class _Base(APITestCase):
    def setUp(self):
        MemStore.data = {}
        register_secret_store("mem", "Memory", MemStore)
        self.addCleanup(_REGISTRY.pop, "mem", None)
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

    def _managed(self, password="pw-1", **extra):
        r = self.client.post(BASE, {
            "device": str(self.device.id), "name": "login", "kind": "ssh_password",
            "username": "netops", "password": password, **extra,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return DeviceCredential.objects.get(pk=r.json()["id"])

    def _reveal(self, cred):
        return self.client.post(f"{BASE}{cred.id}/reveal/")

    def _mem(self, cred):
        return MemStore.data.get((str(self.tenant.id), f"device-credentials/{cred.id}"))


class ReadFromTheStampedStoreTests(_Base):
    def test_a_secret_stays_readable_after_a_switch(self):
        cred = self._managed()
        self.assertEqual(cred.secret_provider, "local")
        _provider("mem")
        r = self._reveal(cred)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret"], {"password": "pw-1"})

    def test_a_rewrite_after_a_switch_moves_it_and_drops_the_old_copy(self):
        cred = self._managed()
        _provider("mem")
        r = self.client.patch(f"{BASE}{cred.id}/", {"password": "pw-2"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        cred.refresh_from_db()
        self.assertEqual(cred.secret_provider, "mem")
        self.assertEqual(self._mem(cred), {"password": "pw-2"})
        self.assertFalse(StoredSecret.objects.filter(ref=cred.secret_path).exists())
        self.assertEqual(self._reveal(cred).json()["secret"], {"password": "pw-2"})

    def test_a_stamped_store_no_longer_configured_says_so(self):
        cred = self._managed()
        DeviceCredential.objects.filter(pk=cred.pk).update(secret_provider="vault")
        StoredSecret.objects.all().delete()
        r = self._reveal(cred)
        self.assertEqual(r.status_code, 400)
        self.assertIn("no longer configured", r.json()["detail"])
        self.assertIn("migrate_secret_store", r.json()["detail"])

    def test_the_active_store_is_the_fallback(self):
        # Copied over by hand, stamp not updated.
        cred = self._managed()
        DeviceCredential.objects.filter(pk=cred.pk).update(secret_provider="vault")
        r = self._reveal(cred)
        self.assertEqual(r.status_code, 200, r.content)

    def test_disabled_still_means_off(self):
        cred = self._managed()
        _provider("")
        r = self._reveal(cred)
        self.assertEqual(r.status_code, 400)
        self.assertIn("No secret store is enabled", r.json()["detail"])

    def test_a_client_cannot_stamp_a_managed_credential(self):
        cred = self._managed(secret_provider="vault")
        self.assertEqual(cred.secret_provider, "local")
        self.client.patch(f"{BASE}{cred.id}/", {"secret_provider": "vault"}, format="json")
        cred.refresh_from_db()
        self.assertEqual(cred.secret_provider, "local")

    def test_an_external_path_is_read_from_its_stamped_store_after_a_switch(self):
        StoredSecret.objects.create(tenant=self.tenant, ref="creds/sw1", value={"password": "x"})
        r = self.client.post(BASE, {
            "device": str(self.device.id), "name": "ext", "kind": "ssh_password",
            "username": "u", "secret_managed": False, "secret_provider": "local",
            "secret_path": "creds/sw1",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        cred = DeviceCredential.objects.get(pk=r.json()["id"])
        _provider("mem")
        r = self._reveal(cred)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret"], {"password": "x"})

    def test_a_psk_stays_readable_after_a_switch(self):
        r = self.client.post("/api/wireless-lans/", {
            "ssid": "corp", "auth_type": "wpa-personal", "psk": "hunter2-hunter2"},
            format="json")
        self.assertEqual(r.status_code, 201, r.content)
        lan = WirelessLAN.objects.get(pk=r.json()["id"])
        self.assertEqual(lan.psk_secret_provider, "local")
        _provider("mem")
        r = self.client.post(f"/api/wireless-lans/{lan.id}/reveal-psk/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["psk"], "hunter2-hunter2")

    def test_a_csr_key_is_stamped_and_read_after_a_switch(self):
        from .csr import generate, get_private_key

        req, pem = generate(tenant=self.tenant, user=self.su, common_name="svc.example.net",
                            key_spec="ec-p256")
        self.assertEqual(req.key_provider, "local")
        _provider("mem")
        req.refresh_from_db()
        self.assertEqual(get_private_key(req), pem)

    def test_an_unstamped_key_is_found_in_any_configured_store(self):
        req = CertificateRequest.objects.create(
            tenant=self.tenant, common_name="old", key_ref="csr/old")
        StoredSecret.objects.create(tenant=self.tenant, ref="csr/old",
                                    value={"private_key": "PK"})
        _provider("mem")
        from .csr import get_private_key

        self.assertEqual(get_private_key(req), "PK")

    def test_the_card_gets_counts_per_store(self):
        self._managed()
        r = self.client.get("/api/deployment/secret-stores/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["secret_counts"], {"local": 1})


class MigrateCommandTests(_Base):
    def _run(self, *args):
        out, err = io.StringIO(), io.StringIO()
        call_command("migrate_secret_store", *args, stdout=out, stderr=err)
        return out.getvalue() + err.getvalue()

    def test_dry_run_counts_and_moves_nothing(self):
        cred = self._managed()
        out = self._run("--from", "local", "--to", "mem")
        self.assertIn("1 to move", out)
        self.assertIsNone(self._mem(cred))
        cred.refresh_from_db()
        self.assertEqual(cred.secret_provider, "local")
        self.assertNotIn("pw-1", out)

    def test_apply_copies_verifies_restamps_and_deletes(self):
        cred = self._managed()
        req = CertificateRequest.objects.create(
            tenant=self.tenant, common_name="old", key_ref="csr/old")
        StoredSecret.objects.create(tenant=self.tenant, ref="csr/old",
                                    value={"private_key": "PK"})
        out = self._run("--from", "local", "--to", "mem", "--apply")
        self.assertIn("2 moved", out)
        cred.refresh_from_db()
        req.refresh_from_db()
        self.assertEqual((cred.secret_provider, req.key_provider), ("mem", "mem"))
        self.assertEqual(self._mem(cred), {"password": "pw-1"})
        self.assertEqual(StoredSecret.objects.count(), 0)
        entry = ChangeLogEntry.objects.get(cause="manage.py migrate_secret_store")
        self.assertEqual(entry.tenant_id, self.tenant.id)
        self.assertEqual(entry.changes["moved"], 2)
        # Reads follow the stamp, whichever store is active.
        self.assertEqual(self._reveal(cred).json()["secret"], {"password": "pw-1"})

    def test_a_second_run_finishes_what_the_first_left(self):
        cred = self._managed()
        self._run("--from", "local", "--to", "mem", "--apply")
        # The old copy survived (say the delete failed last time).
        StoredSecret.objects.create(tenant=self.tenant, ref=cred.secret_path,
                                    value={"password": "pw-1"})
        out = self._run("--from", "local", "--to", "mem", "--apply")
        self.assertIn("1 old copy removed", out)
        self.assertEqual(StoredSecret.objects.count(), 0)
        out = self._run("--from", "local", "--to", "mem", "--apply")
        self.assertIn("1 already moved", out)

    def test_a_failed_copy_leaves_the_record_where_it_was(self):
        cred = self._managed()

        class Broken(MemStore):
            def get(self, tenant_id, ref):
                return {"password": "different"}

        register_secret_store("mem", "Memory", Broken)
        with self.assertRaises(CommandError):
            self._run("--from", "local", "--to", "mem", "--apply")
        cred.refresh_from_db()
        self.assertEqual(cred.secret_provider, "local")
        self.assertTrue(StoredSecret.objects.filter(ref=cred.secret_path).exists())

    def test_external_credentials_are_left_alone(self):
        r = self.client.post(BASE, {
            "device": str(self.device.id), "name": "ext", "kind": "ssh_password",
            "username": "u", "secret_managed": False, "secret_provider": "local",
            "secret_path": "creds/sw1",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        out = self._run("--from", "local", "--to", "mem", "--apply")
        self.assertIn("1 external, left alone", out)
        self.assertEqual(DeviceCredential.objects.get(pk=r.json()["id"]).secret_provider, "local")

    def test_unconfigured_or_identical_stores_are_refused(self):
        for args in (("--from", "local", "--to", "local"),
                     ("--from", "local", "--to", "vault"),
                     ("--from", "nope", "--to", "mem")):
            with self.assertRaises(CommandError):
                self._run(*args)
