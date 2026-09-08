"""Storage backends: the local directory and an S3 client double."""
from __future__ import annotations

import os
import tempfile
from datetime import UTC, datetime
from unittest import mock

from django.test import SimpleTestCase

from backups.storage import (
    LocalBackend,
    S3Backend,
    StorageError,
    backend_for,
    storage_kinds,
)


class LocalBackendTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "backups")
        self.src = os.path.join(self.tmp.name, "src.dbk")
        with open(self.src, "wb") as fh:
            fh.write(b"x" * 100)

    def test_put_list_open_size_delete(self):
        b = LocalBackend(self.dir)
        loc = b.put(self.src, "one.dbk")
        self.assertEqual(loc, os.path.join(self.dir, "one.dbk"))
        self.assertEqual(oct(os.stat(loc).st_mode & 0o777), "0o600")
        self.assertEqual([e["name"] for e in b.list()], ["one.dbk"])
        self.assertEqual(b.size("one.dbk"), 100)
        with b.open("one.dbk") as fh:
            self.assertEqual(fh.read(), b"x" * 100)
        b.delete("one.dbk")
        b.delete("one.dbk")  # idempotent
        self.assertEqual(b.list(), [])

    def test_names_cannot_escape(self):
        b = LocalBackend(self.dir)
        with self.assertRaises(StorageError):
            b.open("../etc/passwd")

    def test_probe(self):
        LocalBackend(self.dir).probe()
        with self.assertRaises(StorageError):
            LocalBackend("/proc/nope").probe()
        with self.assertRaises(StorageError):
            LocalBackend("")


class _FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.calls = []

    def upload_file(self, path, bucket, key):
        with open(path, "rb") as fh:
            self.objects[key] = fh.read()
        self.calls.append(("upload", bucket, key))

    def get_object(self, Bucket, Key):
        import io

        return {"Body": io.BytesIO(self.objects[Key])}

    def head_object(self, Bucket, Key):
        return {"ContentLength": len(self.objects[Key])}

    def get_paginator(self, name):
        objs = self.objects

        class P:
            def paginate(self, **kw):
                prefix = kw.get("Prefix", "")
                yield {"Contents": [
                    {"Key": k, "Size": len(v), "LastModified": datetime(2026, 1, 1, tzinfo=UTC)}
                    for k, v in objs.items() if k.startswith(prefix)
                ]}
        return P()

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)
        self.calls.append(("delete", Bucket, Key))

    def put_object(self, Bucket, Key, Body):
        self.objects[Key] = Body


class S3BackendTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = os.path.join(self.tmp.name, "src.dbk")
        with open(self.src, "wb") as fh:
            fh.write(b"y" * 10)
        self.fake = _FakeS3()

    def test_round_trip_with_prefix(self):
        b = S3Backend(bucket="bk", prefix="/danbyte/", client=self.fake)
        self.assertEqual(b.put(self.src, "a.dbk"), "s3://bk/danbyte/a.dbk")
        self.assertEqual([e["name"] for e in b.list()], ["a.dbk"])
        self.assertEqual(b.size("a.dbk"), 10)
        self.assertEqual(b.open("a.dbk").read(), b"y" * 10)
        b.probe()
        b.delete("a.dbk")
        self.assertEqual(b.list(), [])

    def test_missing_boto3_is_explained(self):
        with mock.patch.dict("sys.modules", {"boto3": None}):
            with self.assertRaises(StorageError) as ctx:
                S3Backend(bucket="bk")
        self.assertIn("boto3", str(ctx.exception))

    def test_registry(self):
        self.assertEqual([k["kind"] for k in storage_kinds()], ["local", "s3"])
        self.assertIsInstance(backend_for("local", {"path": self.tmp.name}, {}), LocalBackend)
        with self.assertRaises(StorageError):
            backend_for("ftp", {}, {})
