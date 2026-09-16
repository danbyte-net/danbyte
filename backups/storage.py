"""Where archives live: a small registry of storage backends (#27).

``local`` writes into a directory; ``s3`` talks to any S3-compatible bucket
through ``boto3`` when it is installed. Plugins may register more kinds the
same way the secret store does.
"""
from __future__ import annotations

import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import BinaryIO, Protocol

_MARKER = ".danbyte-probe"


class StorageError(RuntimeError):
    pass


class StorageBackend(Protocol):
    def put(self, local_path: str, name: str) -> str:
        """Store the file under ``name``; return the location string shown to admins."""
        ...

    def open(self, name: str) -> BinaryIO: ...

    def size(self, name: str) -> int: ...

    def list(self) -> list[dict]: ...

    def delete(self, name: str) -> None: ...

    def probe(self) -> None:
        """Write and delete a marker; raise :class:`StorageError` when the target is unusable."""
        ...


class LocalBackend:
    kind = "local"

    def __init__(self, path: str):
        if not path:
            raise StorageError("A local target needs a directory path.")
        self.path = os.path.abspath(os.path.expanduser(path))

    def _p(self, name: str) -> str:
        if "/" in name or name in (".", ".."):
            raise StorageError("bad archive name")
        return os.path.join(self.path, name)

    def put(self, local_path: str, name: str) -> str:
        os.makedirs(self.path, mode=0o700, exist_ok=True)
        dest = self._p(name)
        tmp = dest + ".part"
        shutil.copyfile(local_path, tmp)
        os.chmod(tmp, 0o600)
        os.replace(tmp, dest)
        return dest

    def open(self, name: str) -> BinaryIO:
        return open(self._p(name), "rb")

    def size(self, name: str) -> int:
        return os.path.getsize(self._p(name))

    def list(self) -> list[dict]:
        if not os.path.isdir(self.path):
            return []
        out = []
        for entry in os.scandir(self.path):
            if entry.is_file() and entry.name.endswith(".dbk"):
                st = entry.stat()
                out.append({
                    "name": entry.name,
                    "size": st.st_size,
                    "modified": datetime.fromtimestamp(st.st_mtime, UTC),
                })
        return sorted(out, key=lambda e: e["modified"], reverse=True)

    def delete(self, name: str) -> None:
        try:
            os.unlink(self._p(name))
        except FileNotFoundError:
            pass

    def probe(self) -> None:
        try:
            os.makedirs(self.path, mode=0o700, exist_ok=True)
            marker = os.path.join(self.path, _MARKER)
            with open(marker, "wb") as fh:
                fh.write(b"ok")
            os.unlink(marker)
        except OSError as exc:
            raise StorageError(f"{self.path}: {exc.strerror or exc}") from exc


class S3Backend:
    kind = "s3"

    def __init__(
        self,
        bucket: str,
        prefix: str = "",
        endpoint_url: str = "",
        region: str = "",
        access_key: str = "",
        secret_key: str = "",
        verify_tls: bool = True,
        client=None,
    ):
        if not bucket:
            raise StorageError("An S3 target needs a bucket.")
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self._client = client or self._make_client(
            endpoint_url, region, access_key, secret_key, verify_tls
        )

    @staticmethod
    def _make_client(endpoint_url, region, access_key, secret_key, verify_tls):
        try:
            import boto3
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise StorageError(
                "S3 targets need the boto3 package: install it into the Danbyte "
                "environment (uv pip install boto3) and restart the workers."
            ) from exc
        return boto3.client(
            "s3",
            endpoint_url=endpoint_url or None,
            region_name=region or None,
            aws_access_key_id=access_key or None,
            aws_secret_access_key=secret_key or None,
            verify=verify_tls,
        )

    def _key(self, name: str) -> str:
        return f"{self.prefix}/{name}" if self.prefix else name

    def put(self, local_path: str, name: str) -> str:
        self._client.upload_file(local_path, self.bucket, self._key(name))
        return f"s3://{self.bucket}/{self._key(name)}"

    def open(self, name: str) -> BinaryIO:
        return self._client.get_object(Bucket=self.bucket, Key=self._key(name))["Body"]

    def size(self, name: str) -> int:
        return int(self._client.head_object(Bucket=self.bucket, Key=self._key(name))["ContentLength"])

    def list(self) -> list[dict]:
        out = []
        paginator = self._client.get_paginator("list_objects_v2")
        kwargs = {"Bucket": self.bucket}
        if self.prefix:
            kwargs["Prefix"] = self.prefix + "/"
        for page in paginator.paginate(**kwargs):
            for obj in page.get("Contents", []):
                name = obj["Key"].rsplit("/", 1)[-1]
                if name.endswith(".dbk"):
                    out.append({"name": name, "size": obj["Size"], "modified": obj["LastModified"]})
        return sorted(out, key=lambda e: e["modified"], reverse=True)

    def delete(self, name: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=self._key(name))

    def probe(self) -> None:
        key = self._key(_MARKER)
        try:
            self._client.put_object(Bucket=self.bucket, Key=key, Body=b"ok")
            self._client.delete_object(Bucket=self.bucket, Key=key)
        except Exception as exc:  # noqa: BLE001 - botocore has many error types
            raise StorageError(f"s3://{self.bucket}: {exc}") from exc


@dataclass(frozen=True)
class StorageKind:
    kind: str
    label: str
    factory: Callable[[dict, dict], StorageBackend]
    fields: tuple[dict, ...] = ()


_REGISTRY: dict[str, StorageKind] = {}


def register_storage(kind: str, label: str, factory, fields=()) -> None:
    _REGISTRY[kind] = StorageKind(kind, label, factory, tuple(fields))


def storage_kinds() -> list[dict]:
    return [
        {"kind": k.kind, "label": k.label, "fields": [dict(f) for f in k.fields]}
        for k in _REGISTRY.values()
    ]


def backend_for(kind: str, config: dict | None, credentials: dict | None) -> StorageBackend:
    entry = _REGISTRY.get(kind)
    if entry is None:
        raise StorageError(f"Unknown storage kind '{kind}'.")
    return entry.factory(config or {}, credentials or {})


register_storage(
    "local", "Local directory",
    lambda cfg, _cred: LocalBackend(cfg.get("path", "")),
    fields=({"name": "path", "label": "Directory", "type": "text", "placeholder": "/srv/danbyte-backups"},),
)
register_storage(
    "s3", "S3-compatible bucket",
    lambda cfg, cred: S3Backend(
        bucket=cfg.get("bucket", ""), prefix=cfg.get("prefix", ""),
        endpoint_url=cfg.get("endpoint_url", ""), region=cfg.get("region", ""),
        access_key=cred.get("access_key", ""), secret_key=cred.get("secret_key", ""),
        verify_tls=cfg.get("verify_tls", True),
    ),
    fields=(
        {"name": "bucket", "label": "Bucket", "type": "text"},
        {"name": "prefix", "label": "Prefix", "type": "text", "placeholder": "danbyte/"},
        {"name": "endpoint_url", "label": "Endpoint URL", "type": "text",
         "placeholder": "https://s3.eu-central-1.amazonaws.com (blank for AWS)"},
        {"name": "region", "label": "Region", "type": "text", "placeholder": "eu-central-1"},
        {"name": "access_key", "label": "Access key", "type": "password", "secret": True},
        {"name": "secret_key", "label": "Secret key", "type": "password", "secret": True},
        {"name": "verify_tls", "label": "Verify TLS certificate", "type": "checkbox", "default": True},
    ),
)
