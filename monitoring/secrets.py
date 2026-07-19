"""Secrets-at-rest for the monitoring app.

Check credentials (SNMP communities / v3 auth, SSH passwords / keys, Telnet
passwords) must never be stored as plaintext — not in a JSONB column, not in a
log line, not in an API response. This module provides:

* a small ``SecretsBackend`` protocol so the encryption can later be delegated
  to an external store (OpenBao / Vault) without touching the models, and
* ``EncryptedJSONField`` — a ``TextField`` that JSON-serialises its Python value
  and stores the Fernet-encrypted ciphertext, transparently decrypting on read.

The default backend is Fernet (symmetric AES-128-CBC + HMAC) from the
``cryptography`` package — a pure-Python wheel, so an airgapped wheel-house
install works. The key comes from ``settings.MONITORING_SECRET_KEY`` when set;
otherwise it is *derived* from ``settings.SECRET_KEY`` so development works out
of the box. Production should set a dedicated key (rotating the Django secret
then no longer silently invalidates stored credentials).

Swap the whole mechanism by pointing ``settings.MONITORING_SECRETS_BACKEND`` at
a dotted path to a callable returning a ``SecretsBackend``.
"""
from __future__ import annotations

import base64
import hashlib
import json
from functools import lru_cache
from typing import Any, Protocol

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.db import models
from django.utils.module_loading import import_string


class SecretsBackend(Protocol):
    """Pluggable encrypt/decrypt boundary.

    Implementations must be symmetric: ``decrypt(encrypt(x)) == x``. They never
    see model instances — only opaque byte strings — so an external secrets
    store (OpenBao) can be wired in by satisfying this Protocol.
    """

    def encrypt(self, plaintext: bytes) -> bytes: ...

    def decrypt(self, token: bytes) -> bytes: ...


def _derive_fernet_key() -> bytes:
    """A stable urlsafe-base64 32-byte Fernet key.

    Prefers an explicit ``MONITORING_SECRET_KEY`` (already a Fernet key, or any
    string we hash to one); falls back to deriving from ``SECRET_KEY`` so dev
    just works. Namespaced so it never collides with other SECRET_KEY uses.
    """
    explicit = getattr(settings, "MONITORING_SECRET_KEY", "") or ""
    if not explicit and not settings.DEBUG:
        # In production, don't silently encrypt every stored credential under a
        # key derived from SECRET_KEY: rotating SECRET_KEY would void all
        # secrets, and a SECRET_KEY leak would decrypt them. Require a dedicated
        # key so credential encryption has an independent lifecycle.
        from django.core.exceptions import ImproperlyConfigured

        raise ImproperlyConfigured(
            "MONITORING_SECRET_KEY must be set when DEBUG is off — it encrypts "
            "SNMP/SSH/SMTP/LDAP credentials at rest independently of SECRET_KEY."
        )
    raw = explicit or settings.SECRET_KEY
    digest = hashlib.sha256(f"danbyte.monitoring.secrets:{raw}".encode()).digest()
    return base64.urlsafe_b64encode(digest)


class FernetSecretsBackend:
    """Default backend — Fernet with a key derived from Django settings."""

    def __init__(self, key: bytes | None = None) -> None:
        self._fernet = Fernet(key or _derive_fernet_key())

    def encrypt(self, plaintext: bytes) -> bytes:
        return self._fernet.encrypt(plaintext)

    def decrypt(self, token: bytes) -> bytes:
        return self._fernet.decrypt(token)


@lru_cache(maxsize=1)
def get_secrets_backend() -> SecretsBackend:
    """The configured secrets backend (cached for the process lifetime)."""
    path = getattr(settings, "MONITORING_SECRETS_BACKEND", "")
    if path:
        factory = import_string(path)
        return factory()
    return FernetSecretsBackend()


class EncryptedJSONField(models.TextField):
    """A JSON field whose value is encrypted at rest.

    Stores ``fernet(json.dumps(value))`` as text. Reads decrypt + parse back to
    the Python value. An empty / null value stays empty (nothing to protect).
    Decryption failure (wrong key, corrupted row) returns ``{}`` rather than
    raising mid-query — misconfiguration must not 500 a list view — and is the
    caller's cue that the key changed.
    """

    description = "JSON value encrypted at rest via the monitoring secrets backend"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("blank", True)
        kwargs.setdefault("default", dict)
        super().__init__(*args, **kwargs)

    def get_internal_type(self) -> str:
        return "TextField"

    def from_db_value(self, value, expression, connection):  # noqa: ARG002
        if value in (None, ""):
            return {}
        try:
            plaintext = get_secrets_backend().decrypt(value.encode())
        except (InvalidToken, ValueError, TypeError):
            return {}
        try:
            return json.loads(plaintext.decode())
        except (ValueError, UnicodeDecodeError):
            return {}

    def to_python(self, value):
        if value is None:
            return {}
        if isinstance(value, (dict, list)):
            return value
        # A plaintext string that slipped through (e.g. a fixture) — parse it.
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return {}

    def get_prep_value(self, value):
        if value in (None, "", {}, []):
            return ""
        token = get_secrets_backend().encrypt(json.dumps(value, default=str).encode())
        return token.decode()
