"""SFTP backup targets (#319) against a real asyncssh server on 127.0.0.1.

The server runs in-process on its own event loop thread, chrooted to a temp
directory, so every byte crosses a real SSH/SFTP session: host key pinning,
password and key auth, temp-name upload and rename, listing, download for
restore, retention deletes and failure handling.
"""
from __future__ import annotations

import os
import tempfile
from unittest import mock

import asyncssh
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from backups.archive import Reader, Writer
from backups.engine import create_backup, prune_schedule, run_backup
from backups.models import Backup, BackupSchedule, BackupTarget
from backups.restore import preview
from backups.sftp import HostKeyChanged, SFTPBackend, _Loop, normalize_fingerprint
from backups.storage import StorageError
from core.models import DeploymentSettings, Organization, Tenant

USER, PASSWORD = "backup", "s3cret-pw"


class _FakeSFTPServer:
    """Starts ``asyncssh.listen`` on 127.0.0.1:0 with a chrooted SFTP root."""

    def __init__(self, root: str, host_key=None, client_key=None):
        self.root = root
        self.host_key = host_key or asyncssh.generate_private_key("ssh-ed25519")
        self.auth_attempts = 0
        self.fail_writes_after: int | None = None
        server = self

        class Server(asyncssh.SSHServer):
            def begin_auth(self, username):
                return True

            def password_auth_supported(self):
                return True

            def validate_password(self, username, password):
                server.auth_attempts += 1
                return username == USER and password == PASSWORD

            def public_key_auth_supported(self):
                return client_key is not None

            def validate_public_key(self, username, key):
                server.auth_attempts += 1
                return client_key is not None and username == USER and \
                    key.public_data == client_key.public_data

        class Root(asyncssh.SFTPServer):
            def __init__(self, chan):
                super().__init__(chan, chroot=server.root.encode())
                self._writes = 0

            def write(self, file_obj, offset, data):
                self._writes += 1
                if server.fail_writes_after is not None and self._writes > server.fail_writes_after:
                    raise asyncssh.SFTPFailure("disk full")
                return super().write(file_obj, offset, data)

        self.loop = _Loop()
        self.acceptor = self.loop.run(asyncssh.listen(
            "127.0.0.1", 0, server_host_keys=[self.host_key], server_factory=Server,
            sftp_factory=Root, allow_scp=False,
        ))
        self.port = self.acceptor.sockets[0].getsockname()[1]

    @property
    def fingerprint(self) -> str:
        return self.host_key.get_fingerprint("sha256")

    def close(self):
        if self.loop.loop.is_closed():
            return

        async def _close():
            self.acceptor.close()
            await self.acceptor.wait_closed()

        self.loop.run(_close())
        self.loop.stop()


class _Base(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.join(self.tmp.name, "remote")
        os.makedirs(self.root)
        self.server = _FakeSFTPServer(self.root)
        self.addCleanup(self.server.close)
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = ["127.0.0.1/32"]
        ds.save()
        self.src = os.path.join(self.tmp.name, "src.dbk")
        with open(self.src, "wb") as fh:
            fh.write(os.urandom(300_000))

    def backend(self, **kw) -> SFTPBackend:
        args = dict(host="127.0.0.1", port=self.server.port, username=USER, path="/archive",
                    host_key_fingerprint=self.server.fingerprint, password=PASSWORD)
        args.update(kw)
        return SFTPBackend(**args)

    def remote(self, *parts) -> str:
        return os.path.join(self.root, "archive", *parts)


class BackendTests(_Base):
    def test_put_list_size_open_delete(self):
        b = self.backend()
        loc = b.put(self.src, "one.dbk")
        self.assertEqual(loc, f"sftp://{USER}@127.0.0.1:{self.server.port}/archive/one.dbk")
        self.assertEqual(sorted(os.listdir(self.remote())), ["one.dbk"])
        self.assertEqual([e["name"] for e in b.list()], ["one.dbk"])
        self.assertEqual(b.size("one.dbk"), 300_000)
        with open(self.src, "rb") as fh, b.open("one.dbk") as remote:
            self.assertEqual(remote.read(), fh.read())
        b.delete("one.dbk")
        b.delete("one.dbk")  # idempotent
        self.assertEqual(b.list(), [])

    def test_list_ignores_parts_and_other_files(self):
        os.makedirs(self.remote())
        for name in ("a.dbk.part", "notes.txt"):
            with open(self.remote(name), "wb") as fh:
                fh.write(b"x")
        os.makedirs(self.remote("dir.dbk"))
        self.assertEqual(self.backend().list(), [])

    def test_missing_directory_lists_empty_and_probe_creates_it(self):
        b = self.backend(path="/deep/er")
        self.assertEqual(b.list(), [])
        b.probe()
        self.assertEqual(os.listdir(os.path.join(self.root, "deep", "er")), [])

    def test_names_cannot_escape(self):
        with self.assertRaises(StorageError):
            self.backend().open("../etc/passwd")

    def test_private_key_with_passphrase(self):
        self.server.close()
        key = asyncssh.generate_private_key("ssh-ed25519")
        self.server = _FakeSFTPServer(self.root, client_key=key)
        self.addCleanup(self.server.close)
        pem = key.export_private_key("pkcs8-pem", passphrase="pp").decode()
        b = self.backend(password="", private_key=pem, passphrase="pp")
        b.put(self.src, "k.dbk")
        self.assertEqual([e["name"] for e in b.list()], ["k.dbk"])
        with self.assertRaises(StorageError):
            self.backend(password="", private_key=pem, passphrase="wrong").list()
        plain = key.export_private_key("openssh").decode()
        self.assertEqual(len(self.backend(password="", private_key=plain).list()), 1)

    def test_wrong_password(self):
        with self.assertRaisesRegex(StorageError, "authentication failed"):
            self.backend(password="nope").list()

    def test_no_trusted_key_refuses_before_any_login(self):
        with self.assertRaisesRegex(StorageError, "No host key is trusted"):
            self.backend(host_key_fingerprint="").put(self.src, "a.dbk")
        self.assertEqual(self.server.auth_attempts, 0)
        self.assertFalse(os.path.exists(self.remote()))

    def test_host_key_read_without_login(self):
        key = self.backend(host_key_fingerprint="").host_key()
        self.assertEqual(key["fingerprint"], self.server.fingerprint)
        self.assertEqual(key["algorithm"], "ssh-ed25519")
        self.assertEqual(self.server.auth_attempts, 0)

    def test_changed_host_key_is_refused_and_no_password_is_sent(self):
        trusted = self.server.fingerprint
        self.server.close()
        self.server = _FakeSFTPServer(self.root)  # same address, new key
        self.addCleanup(self.server.close)
        with self.assertRaises(HostKeyChanged) as ctx:
            self.backend(host_key_fingerprint=trusted).put(self.src, "a.dbk")
        self.assertIn(self.server.fingerprint, str(ctx.exception))
        self.assertEqual(self.server.auth_attempts, 0)
        self.assertFalse(os.path.exists(self.remote()))

    def test_interrupted_upload_leaves_no_archive(self):
        self.server.fail_writes_after = 0
        b = self.backend()
        with self.assertRaisesRegex(StorageError, "disk full"):
            b.put(self.src, "cut.dbk")
        self.assertEqual(b.list(), [])
        self.assertEqual(os.listdir(self.remote()), [])

    def test_a_part_left_by_a_dropped_connection_is_not_an_archive(self):
        b = self.backend()
        with mock.patch("asyncssh.SFTPClient.rename", side_effect=ConnectionResetError("gone")), \
             mock.patch("asyncssh.SFTPClient.remove", side_effect=ConnectionResetError("gone")):
            with self.assertRaises(StorageError):
                b.put(self.src, "cut.dbk")
        self.assertEqual(os.listdir(self.remote()), ["cut.dbk.part"])
        self.assertEqual(b.list(), [])

    def test_outbound_policy_applies(self):
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = []
        ds.save()
        with self.assertRaisesRegex(StorageError, "non-public"):
            self.backend().list()
        with self.assertRaisesRegex(StorageError, "non-public"):
            self.backend(host_key_fingerprint="").host_key()
        self.assertEqual(self.server.auth_attempts, 0)

    def test_fingerprint_normalisation(self):
        fp = self.server.fingerprint
        self.assertEqual(normalize_fingerprint(fp.removeprefix("SHA256:")), fp)
        self.assertEqual(normalize_fingerprint(f"  {fp}= "), fp)
        self.assertEqual(normalize_fingerprint(""), "")
        with self.assertRaises(StorageError):
            normalize_fingerprint("MD5:aa:bb")


def _fake_pg_dump(cmd, **kwargs):
    dest = cmd[cmd.index("-f") + 1]
    with open(dest, "wb") as fh:
        fh.write(b"PGDMP fake dump " * 64)

    class R:
        returncode = 0
        stderr = ""

    return R()


class EngineTests(_Base):
    def setUp(self):
        super().setUp()
        self.override = override_settings(
            MEDIA_ROOT=os.path.join(self.tmp.name, "media"),
            DANBYTE_BACKUP_DIR=os.path.join(self.tmp.name, "backups"),
            PLUGIN_UPLOAD_DIR=os.path.join(self.tmp.name, "plugins_local"),
            MONITORING_SECRET_KEY="sftp-test-key",
        )
        self.override.enable()
        self.addCleanup(self.override.disable)
        org = Organization.objects.create(name="O", slug="o")
        Tenant.objects.create(org=org, name="T", slug="t")
        for target, kw in (("backups.engine.subprocess.run", {"side_effect": _fake_pg_dump}),
                           ("backups.engine.shutil.which", {"return_value": "/usr/bin/pg_dump"})):
            p = mock.patch(target, **kw)
            p.start()
            self.addCleanup(p.stop)
        self.target = BackupTarget.objects.create(
            name="NAS", kind="sftp",
            config={"host": "127.0.0.1", "port": self.server.port, "username": USER,
                    "path": "/archive", "host_key_fingerprint": self.server.fingerprint},
            credentials={"password": PASSWORD},
        )

    def test_backup_lands_on_the_server_and_restores_from_it(self):
        b = run_backup(str(create_backup(kind="manual", components=["db"], target=self.target).id))
        self.assertEqual(b.status, "success", b.error)
        self.assertEqual(os.listdir(self.remote()), [b.filename])
        self.assertTrue(b.location.startswith("sftp://backup@127.0.0.1:"))
        # restore reads the archive straight off the server
        pv = preview(b)
        self.assertTrue(next(c for c in pv["checks"] if c["name"] == "key")["ok"], pv["checks"])
        dest = os.path.join(self.tmp.name, "db.dump")
        Reader(lambda: self.target.backend().open(b.filename)).extract("db.dump", dest)
        with open(dest, "rb") as fh:
            self.assertEqual(fh.read(), b"PGDMP fake dump " * 64)

    def test_large_archive_downloads_intact(self):
        path = os.path.join(self.tmp.name, "big.dbk")
        payload = os.urandom(3 * 1024 * 1024 + 17)  # spans several 1 MiB chunks
        with Writer(path, "sftp-test-key") as w:
            w.add_json("manifest.json", {"created_at": "x"})
            w.add_bytes("db.dump", payload)
        backend = self.target.backend()
        backend.put(path, "big.dbk")
        dest = os.path.join(self.tmp.name, "out")
        Reader(lambda: backend.open("big.dbk"), "sftp-test-key").extract("db.dump", dest)
        with open(dest, "rb") as fh:
            self.assertEqual(fh.read(), payload)

    def test_failed_upload_fails_the_backup_records_the_error_and_notifies(self):
        self.server.fail_writes_after = 0
        with mock.patch("backups.notify._mail_admins") as mail:
            b = run_backup(str(create_backup(kind="manual", components=["db"], target=self.target).id))
        self.assertEqual(b.status, "failed")
        self.assertEqual(b.steps[-1]["name"], "upload")
        self.assertIn("disk full", b.error)
        self.target.refresh_from_db()
        self.assertIn("disk full", self.target.last_error)
        mail.assert_called_once()
        self.assertTrue(mail.call_args[0][0].startswith("Backup failed"))
        self.assertEqual(self.target.backend().list(), [])
        # the next good run clears the error
        self.server.fail_writes_after = None
        b = run_backup(str(create_backup(kind="manual", components=["db"], target=self.target).id))
        self.assertEqual(b.status, "success", b.error)
        self.target.refresh_from_db()
        self.assertEqual(self.target.last_error, "")

    def test_changed_host_key_fails_the_backup(self):
        self.server.close()
        self.server = _FakeSFTPServer(self.root)
        self.addCleanup(self.server.close)
        self.target.config = {**self.target.config, "port": self.server.port}
        self.target.save()
        with mock.patch("backups.notify._mail_admins"):
            b = run_backup(str(create_backup(kind="manual", components=["db"], target=self.target).id))
        self.assertEqual(b.status, "failed")
        self.assertIn("host key changed", b.error)
        self.assertEqual(self.server.auth_attempts, 0)

    def test_schedule_retention_deletes_remote_archives(self):
        schedule = BackupSchedule.objects.create(
            name="nightly", components=["db"], target=self.target,
            cadence={"frequency": "daily", "at": "02:00"}, retention={"max_count": 1},
        )
        made = []
        for _ in range(3):
            b = run_backup(str(create_backup(kind="scheduled", components=["db"], target=self.target,
                                             schedule=schedule).id))
            self.assertEqual(b.status, "success", b.error)
            made.append(b)
        self.assertEqual(os.listdir(self.remote()), [made[-1].filename])
        self.assertEqual(list(Backup.objects.filter(schedule=schedule)), [made[-1]])
        self.assertEqual(prune_schedule(schedule), 0)


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        self.client.force_login(self.admin)

    def _create(self, **config):
        body = {"name": "NAS", "kind": "sftp",
                "config": {"host": "127.0.0.1", "port": self.server.port, "username": USER,
                           "path": "/archive", **config},
                "credentials": {"password": PASSWORD}}
        return self.client.post("/api/backups/targets/", body, content_type="application/json")

    def test_secrets_are_write_only_and_config_is_normalised(self):
        r = self._create(port=str(self.server.port), host_key_fingerprint=self.server.fingerprint[7:])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("credentials", r.json())
        self.assertNotIn(PASSWORD, r.content.decode())
        self.assertTrue(r.json()["has_credentials"])
        self.assertEqual(r.json()["config"]["port"], self.server.port)
        self.assertEqual(r.json()["config"]["host_key_fingerprint"], self.server.fingerprint)
        t = BackupTarget.objects.get(pk=r.json()["id"])
        self.assertEqual(t.credentials, {"password": PASSWORD})
        listing = self.client.get("/api/backups/targets/").content.decode()
        self.assertNotIn(PASSWORD, listing)

    def test_validation(self):
        bad = [
            ({"config": {"host": "", "username": USER}}, "config"),
            ({"config": {"host": "h", "username": ""}}, "config"),
            ({"config": {"host": "h", "username": USER, "port": 70000}}, "config"),
            ({"config": {"host": "h", "username": USER, "host_key_fingerprint": "nope!"}}, "config"),
            ({"config": {"host": "h", "username": USER}, "credentials": {}}, "credentials"),
            ({"config": {"host": "h", "username": USER},
              "credentials": {"private_key": "not a key"}}, "credentials"),
        ]
        for extra, field in bad:
            body = {"name": "x", "kind": "sftp", "credentials": {"password": "p"}, **extra}
            r = self.client.post("/api/backups/targets/", body, content_type="application/json")
            self.assertEqual(r.status_code, 400, extra)
            self.assertIn(field, r.json(), extra)

    def test_edit_keeps_the_stored_secret(self):
        t = self._create().json()
        r = self.client.patch(f"/api/backups/targets/{t['id']}/",
                              {"config": {**t["config"], "path": "/other"}, "credentials": {"password": ""}},
                              content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(BackupTarget.objects.get(pk=t["id"]).credentials, {"password": PASSWORD})

    def test_first_test_shows_the_key_then_confirm_saves_it(self):
        tid = self._create().json()["id"]
        r = self.client.post(f"/api/backups/targets/{tid}/test/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["confirm_host_key"])
        self.assertEqual(r.json()["host_key"]["fingerprint"], self.server.fingerprint)
        self.assertEqual(BackupTarget.objects.get(pk=tid).config["host_key_fingerprint"], "")
        self.assertEqual(self.server.auth_attempts, 0)

        r = self.client.post(f"/api/backups/targets/{tid}/test/",
                             {"accept_host_key": "SHA256:AAAAwrongAAAA"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(BackupTarget.objects.get(pk=tid).config["host_key_fingerprint"], "")

        r = self.client.post(f"/api/backups/targets/{tid}/test/",
                             {"accept_host_key": self.server.fingerprint}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["ok"])
        t = BackupTarget.objects.get(pk=tid)
        self.assertEqual(t.config["host_key_fingerprint"], self.server.fingerprint)
        self.assertEqual(t.last_error, "")
        self.assertEqual(os.listdir(self.remote()), [])  # the marker is gone

    def test_test_refuses_a_changed_key(self):
        tid = self._create(host_key_fingerprint=self.server.fingerprint).json()["id"]
        self.server.close()
        self.server = _FakeSFTPServer(self.root)
        self.addCleanup(self.server.close)
        t = BackupTarget.objects.get(pk=tid)
        t.config = {**t.config, "port": self.server.port}
        t.save()
        r = self.client.post(f"/api/backups/targets/{tid}/test/",
                             {"accept_host_key": self.server.fingerprint}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("host key changed", r.json()["detail"])
        t.refresh_from_db()
        self.assertIn("host key changed", t.last_error)
        self.assertNotEqual(t.config["host_key_fingerprint"], self.server.fingerprint)

    def test_only_deployment_admins(self):
        user = get_user_model().objects.create_user("u", "u@e.com", "x")
        self.client.force_login(user)
        self.assertEqual(self._create().status_code, 403)

    def test_kind_is_listed(self):
        r = self.client.get("/api/backups/status/")
        kinds = {k["kind"]: k for k in r.json()["storage_kinds"]}
        self.assertIn("sftp", kinds)
        secret = {f["name"] for f in kinds["sftp"]["fields"] if f.get("secret")}
        self.assertEqual(secret, {"password", "private_key", "passphrase"})
