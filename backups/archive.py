"""The ``.dbk`` archive: an encrypted, streamable tar (#27).

Layout of a file::

    b"DBK1" | 16-byte salt | 32-byte key check | chunk | chunk | … | final

Every chunk is ``12-byte nonce + AES-256-GCM(plaintext, aad=index) + tag``
over at most 1 MiB of a tar stream; the last chunk carries ``aad=b"final"``
so a file cut at a chunk boundary is still detected. The key is
HKDF-SHA256 of the deployment's ``MONITORING_SECRET_KEY`` with the archive's
salt, and the key check is an HMAC of a fixed string under that key: a
restore on a host with another key fails here, loudly, instead of quietly
restoring credentials that decrypt to nothing.

The tar's first member is ``manifest.json`` so a preview reads the header
and one chunk, never the whole file.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import struct
import tarfile
from typing import BinaryIO

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b"DBK1"
SALT_LEN = 16
CHECK_LEN = 32
NONCE_LEN = 12
TAG_LEN = 16
CHUNK = 1024 * 1024
_CHECK_TEXT = b"danbyte-backup"
_FINAL_AAD = b"final"
MANIFEST_NAME = "manifest.json"


class ArchiveError(RuntimeError):
    """The file is not a Danbyte backup, or is damaged."""


class Corrupt(ArchiveError):
    """Truncated, tampered with, or not a ``.dbk`` at all."""


class KeyMismatch(ArchiveError):
    """Made under a different MONITORING_SECRET_KEY."""


def _secret(explicit: str | None) -> bytes:
    """The same rule the encrypted fields follow (``monitoring/secrets.py``):
    ``MONITORING_SECRET_KEY``, else - only with DEBUG on - ``SECRET_KEY``.
    Whatever protects the stored credentials protects the archive."""
    if explicit is not None:
        raw = explicit
    else:
        from django.conf import settings

        raw = settings.MONITORING_SECRET_KEY or (settings.SECRET_KEY if settings.DEBUG else "")
    if not raw:
        raise ArchiveError("MONITORING_SECRET_KEY is not set; backups cannot be encrypted.")
    return raw.encode()


def derive_key(salt: bytes, secret: str | None = None) -> bytes:
    """32-byte AES key for this archive from the deployment secret."""
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=salt, info=b"danbyte-backup"
    ).derive(_secret(secret))


def key_check(key: bytes) -> bytes:
    return hmac.new(key, _CHECK_TEXT, hashlib.sha256).digest()


def _nonce(index: int) -> bytes:
    return struct.pack(">IQ", 0, index)


class _EncryptingSink(io.RawIOBase):
    """Write-side file object: buffers tar bytes and emits encrypted chunks."""

    def __init__(self, out: BinaryIO, key: bytes):
        super().__init__()
        self._out = out
        self._aead = AESGCM(key)
        self._buf = bytearray()
        self._index = 0
        self.plain_bytes = 0

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:  # type: ignore[override]
        self._buf.extend(data)
        self.plain_bytes += len(data)
        while len(self._buf) >= CHUNK:
            self._emit(bytes(self._buf[:CHUNK]), final=False)
            del self._buf[:CHUNK]
        return len(data)

    def _emit(self, plain: bytes, *, final: bool) -> None:
        nonce = _nonce(self._index)
        aad = _FINAL_AAD if final else str(self._index).encode()
        self._out.write(nonce + self._aead.encrypt(nonce, plain, aad))
        self._index += 1

    def finish(self) -> None:
        self._emit(bytes(self._buf), final=True)
        self._buf.clear()


class Writer:
    """Build an archive. Add ``manifest.json`` first, then the components."""

    def __init__(self, path: str | os.PathLike, secret: str | None = None):
        self.path = str(path)
        self._file = open(self.path, "wb")
        self.salt = os.urandom(SALT_LEN)
        self.key = derive_key(self.salt, secret)
        self._file.write(MAGIC + self.salt + key_check(self.key))
        self._sink = _EncryptingSink(self._file, self.key)
        self._tar = tarfile.open(fileobj=self._sink, mode="w|")
        self._closed = False

    def add_bytes(self, name: str, data: bytes) -> None:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        self._tar.addfile(info, io.BytesIO(data))

    def add_json(self, name: str, obj) -> None:
        self.add_bytes(name, json.dumps(obj, indent=1, sort_keys=True, default=str).encode())

    def add_file(self, name: str, path: str | os.PathLike) -> None:
        self._tar.add(str(path), arcname=name, recursive=False)

    def close(self) -> int:
        """Finish the archive; returns its size in bytes."""
        if self._closed:
            return os.path.getsize(self.path)
        self._closed = True
        self._tar.close()
        self._sink.finish()
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()
        return os.path.getsize(self.path)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if exc[0] is not None:
            try:
                self._file.close()
            finally:
                try:
                    os.unlink(self.path)
                except OSError:
                    pass
            return False
        self.close()
        return False


class _DecryptingSource(io.RawIOBase):
    """Read-side file object: decrypts chunk by chunk as the tar asks."""

    def __init__(self, src: BinaryIO, key: bytes):
        super().__init__()
        self._src = src
        self._aead = AESGCM(key)
        self._index = 0
        self._buf = b""
        self._done = False

    def readable(self) -> bool:
        return True

    def _next_chunk(self) -> bool:
        if self._done:
            return False
        nonce = self._src.read(NONCE_LEN)
        if not nonce:
            raise Corrupt("archive ends without its final chunk")
        if len(nonce) != NONCE_LEN or nonce != _nonce(self._index):
            raise Corrupt("chunk header out of sequence")
        body = self._src.read(CHUNK + TAG_LEN)
        # A full chunk is exactly CHUNK + TAG bytes; the final one is shorter.
        final = len(body) < CHUNK + TAG_LEN
        aad = _FINAL_AAD if final else str(self._index).encode()
        try:
            plain = self._aead.decrypt(nonce, body, aad)
        except InvalidTag:
            if not final:
                raise Corrupt("chunk failed authentication") from None
            # A cut at a chunk boundary looks like a short final chunk that
            # happens to be a whole earlier one - try it as a middle chunk so
            # the error names the truth.
            try:
                self._aead.decrypt(nonce, body, str(self._index).encode())
            except InvalidTag:
                raise Corrupt("chunk failed authentication") from None
            raise Corrupt("archive ends without its final chunk") from None
        self._index += 1
        self._buf += plain
        if final:
            self._done = True
        return True

    def readinto(self, b) -> int:  # type: ignore[override]
        while not self._buf and self._next_chunk():
            pass
        n = min(len(b), len(self._buf))
        b[:n] = self._buf[:n]
        self._buf = self._buf[n:]
        return n


def open_header(src: BinaryIO, secret: str | None = None) -> bytes:
    """Validate the header and return the archive key. Raises
    :class:`Corrupt` for a foreign file and :class:`KeyMismatch` for a
    Danbyte archive made under another secret."""
    head = src.read(len(MAGIC) + SALT_LEN + CHECK_LEN)
    if len(head) < len(MAGIC) + SALT_LEN + CHECK_LEN or head[: len(MAGIC)] != MAGIC:
        raise Corrupt("not a Danbyte backup (.dbk)")
    salt = head[len(MAGIC) : len(MAGIC) + SALT_LEN]
    check = head[len(MAGIC) + SALT_LEN :]
    key = derive_key(salt, secret)
    if not hmac.compare_digest(check, key_check(key)):
        raise KeyMismatch(
            "This backup was made under a different MONITORING_SECRET_KEY. "
            "Copy the key from the host that made it before restoring."
        )
    return key


class Reader:
    """Sequential reader. Each call re-opens the source, so a preview that
    only needs the manifest touches one chunk."""

    def __init__(self, opener, secret: str | None = None):
        """``opener()`` returns a fresh binary file object positioned at 0."""
        self._opener = opener
        self._secret = secret

    def _tar(self):
        src = self._opener()
        key = open_header(src, self._secret)
        return tarfile.open(fileobj=_DecryptingSource(src, key), mode="r|"), src

    def read_manifest(self) -> dict:
        tar, src = self._tar()
        try:
            member = tar.next()
            if member is None or member.name != MANIFEST_NAME:
                raise Corrupt("the archive does not start with manifest.json")
            fh = tar.extractfile(member)
            return json.loads(fh.read().decode())
        finally:
            src.close()

    def members(self) -> list[dict]:
        tar, src = self._tar()
        try:
            return [{"name": m.name, "size": m.size} for m in tar]
        finally:
            src.close()

    def extract(self, name: str, dest: str | os.PathLike) -> int:
        """Copy member ``name`` to ``dest``; returns bytes written."""
        tar, src = self._tar()
        try:
            for member in tar:
                if member.name != name:
                    continue
                fh = tar.extractfile(member)
                written = 0
                with open(dest, "wb") as out:
                    while True:
                        block = fh.read(CHUNK)
                        if not block:
                            break
                        out.write(block)
                        written += len(block)
                return written
            raise ArchiveError(f"{name} is not in the archive")
        finally:
            src.close()


def sha256_file(path: str | os.PathLike) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()
