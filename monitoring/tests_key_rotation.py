"""MONITORING_SECRET_KEY rotation (#493): key lists, MultiFernet, and
``manage.py rotate_monitoring_key``."""
from __future__ import annotations

import base64
import hashlib
import io
import os
import subprocess
import sys
from pathlib import Path

from cryptography.fernet import Fernet
from django.core.exceptions import ImproperlyConfigured
from django.core.management import CommandError, call_command
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant
from danbyte.secret_keys import parse_monitoring_keys
from integrations.models import Webhook
from monitoring.secrets import FernetSecretsBackend, get_secrets_backend, monitoring_keys

ROOT = Path(__file__).resolve().parent.parent


def _legacy_fernet(raw: str) -> Fernet:
    """The pre-#493 single-key derivation, verbatim."""
    digest = hashlib.sha256(f"danbyte.monitoring.secrets:{raw}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


class KeyListParsingTests(SimpleTestCase):
    def test_single_key_is_one_entry(self):
        self.assertEqual(parse_monitoring_keys("abc"), ["abc"])

    def test_list_is_newest_first_and_stripped(self):
        self.assertEqual(parse_monitoring_keys(" new , old "), ["new", "old"])

    def test_unset_is_empty(self):
        self.assertEqual(parse_monitoring_keys(""), [])
        self.assertEqual(parse_monitoring_keys(None), [])

    def test_empty_entry_is_refused_without_echoing_keys(self):
        for raw in ("new,,old", "new,", ",new", "new, ,old"):
            with self.assertRaises(ValueError) as cm:
                parse_monitoring_keys(raw)
            self.assertNotIn("new", str(cm.exception).replace("remove", ""))

    def test_duplicate_is_refused(self):
        with self.assertRaises(ValueError):
            parse_monitoring_keys("same,same")

    @override_settings(MONITORING_SECRET_KEY="a,,b")
    def test_runtime_refuses_a_bad_list(self):
        with self.assertRaises(ImproperlyConfigured):
            monitoring_keys()


class BadKeyListStopsStartTests(SimpleTestCase):
    def _import_settings(self, value):
        env = {**os.environ, "MONITORING_SECRET_KEY": value, "DEBUG": "True"}
        return subprocess.run(
            [sys.executable, "-c", "import danbyte.settings"],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
        )

    def test_empty_entry_stops_the_service(self):
        r = self._import_settings("good-key,,other-key")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ImproperlyConfigured", r.stderr)
        self.assertIn("is empty", r.stderr)
        self.assertNotIn("good-key", r.stderr)

    def test_duplicate_stops_the_service(self):
        r = self._import_settings("k1,k1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("more than once", r.stderr)

    def test_valid_list_starts(self):
        r = self._import_settings("k-new,k-old")
        self.assertEqual(r.returncode, 0, r.stderr)


class MultiKeyBackendTests(SimpleTestCase):
    @override_settings(MONITORING_SECRET_KEY="only-key")
    def test_single_key_is_unchanged(self):
        backend = get_secrets_backend()
        self.assertEqual(backend.key_count, 1)
        legacy = _legacy_fernet("only-key")
        # Old ciphertext opens, and new ciphertext opens under the old scheme.
        self.assertEqual(backend.decrypt(legacy.encrypt(b"x")), b"x")
        self.assertEqual(legacy.decrypt(backend.encrypt(b"y")), b"y")

    def test_two_keys_decrypt_old_and_encrypt_new(self):
        old_token = _legacy_fernet("old").encrypt(b"secret")
        with override_settings(MONITORING_SECRET_KEY="new,old"):
            backend = get_secrets_backend()
            self.assertEqual(backend.key_count, 2)
            self.assertEqual(backend.decrypt(old_token), b"secret")
            self.assertFalse(backend.is_current(old_token))
            fresh = backend.encrypt(b"other")
            self.assertTrue(backend.is_current(fresh))
            self.assertEqual(_legacy_fernet("new").decrypt(fresh), b"other")
            rotated = backend.rotate(old_token)
            self.assertEqual(_legacy_fernet("new").decrypt(rotated), b"secret")

    def test_cache_follows_the_setting(self):
        with override_settings(MONITORING_SECRET_KEY="a"):
            first = get_secrets_backend()
        with override_settings(MONITORING_SECRET_KEY="b,a"):
            self.assertIsNot(get_secrets_backend(), first)
            self.assertEqual(get_secrets_backend().key_count, 2)

    def test_explicit_key_still_accepted(self):
        key = Fernet.generate_key()
        self.assertEqual(FernetSecretsBackend(key).key_count, 1)


class BackupArchiveKeyListTests(SimpleTestCase):
    def _header(self, secret):
        import tempfile

        from backups.archive import Writer

        with tempfile.NamedTemporaryFile(suffix=".dbk", delete=False) as fh:
            path = fh.name
        with Writer(path, secret) as w:
            w.add_bytes("manifest.json", b"{}")
        return path

    def test_old_archive_opens_with_the_key_list_and_new_ones_use_the_first_key(self):
        from backups.archive import KeyMismatch, open_header

        old = self._header("old")
        new = self._header("new,old")
        try:
            with open(old, "rb") as fh:
                open_header(fh, "new,old")
            with open(new, "rb") as fh:
                open_header(fh, "new")
            with open(old, "rb") as fh, self.assertRaises(KeyMismatch):
                open_header(fh, "new")
        finally:
            os.unlink(old)
            os.unlink(new)


class RotateCommandTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o-rot")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t-rot")
        kw = {"tenant": self.tenant, "object_types": ["device"],
              "payload_url": "https://hooks.example/x"}
        with override_settings(MONITORING_SECRET_KEY="old-key"):
            self.hooks = [Webhook.objects.create(name=f"h{i}", secret=f"sign-{i}", **kw)
                          for i in range(5)]
            self.blank = Webhook.objects.create(name="blank", **kw)

    def _raw(self, hook):
        with connection.cursor() as cur:
            cur.execute("SELECT secret FROM integrations_webhook WHERE id = %s", [hook.pk])
            return cur.fetchone()[0]

    def _run(self, *args):
        out, err = io.StringIO(), io.StringIO()
        call_command("rotate_monitoring_key", *args, stdout=out, stderr=err)
        return out.getvalue(), err.getvalue()

    def _line(self, out):
        return next(ln for ln in out.splitlines() if ln.startswith("integrations.Webhook.secret"))

    @override_settings(MONITORING_SECRET_KEY="new-key,old-key")
    def test_dry_run_counts_and_writes_nothing(self):
        before = [self._raw(h) for h in self.hooks]
        out, _ = self._run("--dry-run")
        self.assertIn("5 would rotate, 0 current, 0 unreadable", self._line(out))
        self.assertEqual([self._raw(h) for h in self.hooks], before)
        self.assertFalse(ChangeLogEntry.objects.filter(object_type="monitoring.secretkey").exists())

    @override_settings(MONITORING_SECRET_KEY="new-key,old-key")
    def test_rotate_re_encrypts_under_the_new_key_and_is_idempotent(self):
        out, _ = self._run("--batch-size", "2")
        self.assertIn("5 rotated, 0 current", self._line(out))
        new = _legacy_fernet("new-key")
        for i, h in enumerate(self.hooks):
            self.assertEqual(new.decrypt(self._raw(h).encode()), f'"sign-{i}"'.encode())
        self.assertEqual(self._raw(self.blank), "")
        # The ORM still reads the values.
        self.assertEqual(Webhook.objects.get(pk=self.hooks[0].pk).secret, "sign-0")
        # One audit entry for the run, no per-row noise, no plaintext.
        entries = ChangeLogEntry.objects.filter(object_type="monitoring.secretkey")
        self.assertEqual(entries.count(), 1)
        self.assertEqual(entries[0].changes["rotated"], 5)
        self.assertEqual(entries[0].changes["keys_configured"], 2)
        self.assertNotIn("sign-", str(entries[0].changes))
        self.assertFalse(ChangeLogEntry.objects.filter(object_type="integrations.webhook",
                                                       action="update").exists())
        self.assertNotIn("sign-", out)

        again, _ = self._run()
        self.assertIn("0 rotated, 5 current", self._line(again))

    def test_check_mode(self):
        with override_settings(MONITORING_SECRET_KEY="new-key,old-key"):
            with self.assertRaises(CommandError):
                self._run("--check")
            self._run()
            out, _ = self._run("--check")
            self.assertIn("Every value decrypts under the first key", out)
        # The old key can go: a single new key reads everything.
        with override_settings(MONITORING_SECRET_KEY="new-key"):
            out, _ = self._run("--check")
            self.assertIn("0 on an older key, 5 current", self._line(out))
            self.assertEqual(Webhook.objects.get(pk=self.hooks[4].pk).secret, "sign-4")

    def test_partial_failure_names_model_and_pk_and_exits_non_zero(self):
        with override_settings(MONITORING_SECRET_KEY="lost-key"):
            stray = Webhook.objects.create(tenant=self.tenant, name="stray", secret="gone",
                                           object_types=[], payload_url="https://x.example/")
        with override_settings(MONITORING_SECRET_KEY="new-key,old-key"):
            out, err = io.StringIO(), io.StringIO()
            with self.assertRaises(CommandError):
                call_command("rotate_monitoring_key", stdout=out, stderr=err)
            self.assertIn(f"integrations.Webhook pk={stray.pk}", err.getvalue())
            self.assertNotIn("gone", err.getvalue() + out.getvalue())
            self.assertIn("5 rotated, 0 current, 1 unreadable", self._line(out.getvalue()))
            # The readable rows were still rotated; the stray row is untouched.
            self.assertTrue(get_secrets_backend().is_current(self._raw(self.hooks[0]).encode()))
            self.assertEqual(_legacy_fernet("lost-key").decrypt(self._raw(stray).encode()),
                             b'"gone"')
            entry = ChangeLogEntry.objects.get(object_type="monitoring.secretkey")
            self.assertEqual(entry.changes["unreadable"], 1)

    @override_settings(MONITORING_SECRET_KEY="new-key,old-key")
    def test_settings_card_shows_the_key_count(self):
        from django.contrib.auth import get_user_model

        admin = get_user_model().objects.create_superuser("rot-admin", "a@x.test", "pw")
        self.client.force_login(admin)
        r = self.client.get("/api/deployment/secret-stores/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["monitoring_keys"], 2)
        self.assertNotIn("new-key", r.content.decode())
