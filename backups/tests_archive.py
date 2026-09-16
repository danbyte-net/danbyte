"""The .dbk archive: round trip, manifest-first reads, wrong key, damage."""
from __future__ import annotations

import os
import tempfile

from django.test import SimpleTestCase

from backups.archive import (
    CHUNK,
    MAGIC,
    Corrupt,
    KeyMismatch,
    Reader,
    Writer,
    open_header,
    sha256_file,
)

SECRET = "unit-test-secret"


class ArchiveTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "a.dbk")

    def _write(self, secret=SECRET, big=False):
        blob = os.urandom(3 * CHUNK + 12345) if big else b"hello " * 1000
        src = os.path.join(self.tmp.name, "db.dump")
        with open(src, "wb") as fh:
            fh.write(blob)
        with Writer(self.path, secret=secret) as w:
            w.add_json("manifest.json", {"format": 1, "components": ["db"], "size": len(blob)})
            w.add_file("db.dump", src)
            w.add_bytes("config.json", b"{}")
        return blob

    def _reader(self, secret=SECRET):
        return Reader(lambda: open(self.path, "rb"), secret=secret)

    def test_round_trip_and_manifest_first(self):
        blob = self._write(big=True)
        r = self._reader()
        self.assertEqual(r.read_manifest()["components"], ["db"])
        self.assertEqual([m["name"] for m in r.members()], ["manifest.json", "db.dump", "config.json"])
        out = os.path.join(self.tmp.name, "out.dump")
        self.assertEqual(r.extract("db.dump", out), len(blob))
        with open(out, "rb") as fh:
            self.assertEqual(fh.read(), blob)
        self.assertEqual(sha256_file(out), sha256_file(os.path.join(self.tmp.name, "db.dump")))

    def test_manifest_read_touches_only_the_head(self):
        self._write(big=True)
        reads = []

        class Spy:
            def __init__(self, fh):
                self.fh = fh

            def read(self, n=-1):
                reads.append(n)
                return self.fh.read(n)

            def close(self):
                self.fh.close()

        Reader(lambda: Spy(open(self.path, "rb")), secret=SECRET).read_manifest()
        # header + a couple of chunks, never the 3 MiB tail
        self.assertLess(sum(n for n in reads if n and n > 0), 2 * CHUNK + 4096)

    def test_wrong_key_is_named(self):
        self._write()
        with self.assertRaises(KeyMismatch):
            self._reader(secret="another-host").read_manifest()

    def test_foreign_file_and_truncation(self):
        with open(self.path, "wb") as fh:
            fh.write(b"not a backup at all")
        with self.assertRaises(Corrupt):
            self._reader().read_manifest()
        self._write(big=True)
        size = os.path.getsize(self.path)
        with open(self.path, "r+b") as fh:
            fh.truncate(size - 100)
        with self.assertRaises(Corrupt):
            self._reader().extract("db.dump", os.path.join(self.tmp.name, "x"))
        # cut exactly at a chunk boundary: still not a clean end
        self._write(big=True)
        head = len(MAGIC) + 16 + 32
        with open(self.path, "r+b") as fh:
            fh.truncate(head + (12 + CHUNK + 16) * 2)
        with self.assertRaises(Corrupt):
            self._reader().extract("db.dump", os.path.join(self.tmp.name, "y"))

    def test_tampering_fails_authentication(self):
        self._write(big=True)
        head = len(MAGIC) + 16 + 32
        with open(self.path, "r+b") as fh:
            fh.seek(head + 12 + 500)
            b = fh.read(1)
            fh.seek(-1, os.SEEK_CUR)
            fh.write(bytes([b[0] ^ 0xFF]))
        with self.assertRaises(Corrupt):
            self._reader().extract("db.dump", os.path.join(self.tmp.name, "z"))

    def test_header_check_without_reading_body(self):
        self._write()
        with open(self.path, "rb") as fh:
            key = open_header(fh, SECRET)
        self.assertEqual(len(key), 32)
        with open(self.path, "rb") as fh, self.assertRaises(KeyMismatch):
            open_header(fh, "other")

    def test_failed_write_leaves_no_file(self):
        with self.assertRaises(RuntimeError):
            with Writer(self.path, secret=SECRET) as w:
                w.add_bytes("manifest.json", b"{}")
                raise RuntimeError("boom")
        self.assertFalse(os.path.exists(self.path))
