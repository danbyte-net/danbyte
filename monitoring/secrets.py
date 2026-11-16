"""Secrets-at-rest for the monitoring app.

Check credentials (SNMP communities / v3 auth, SSH passwords / keys, Telnet
passwords) must never be stored as plaintext - not in a JSONB column, not in a
log line, not in an API response. This module provides:

* a small ``SecretsBackend`` protocol so the encryption can later be delegated
  to an external store (OpenBao / Vault) without touching the models, and
* ``EncryptedJSONField`` - a ``TextField`` that JSON-serialises its Python value
  and stores the Fernet-encrypted ciphertext, transparently decrypting on read.

The default backend is Fernet (symmetric AES-128-CBC + HMAC) from the
``cryptography`` package - a pure-Python wheel, so an airgapped wheel-house
install works. The key comes from ``settings.MONITORING_SECRET_KEY`` when set;
otherwise (DEBUG only) it is *derived* from ``settings.SECRET_KEY`` so
development works out of the box. Production must set a dedicated key.

``MONITORING_SECRET_KEY`` may list several keys, comma-separated and newest
first (#493): values are encrypted under the first and decrypted with any, and
``manage.py rotate_monitoring_key`` re-encrypts every stored value under the
first so the old key can be dropped.

Swap the whole mechanism by pointing ``settings.MONITORING_SECRETS_BACKEND`` at
a dotted path to a callable returning a ``SecretsBackend``.
"""
from __future__ import annotations

import base64
import hashlib
import json
from functools import lru_cache
from typing import Any, Protocol

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.signals import setting_changed
from django.db import models
from django.utils.module_loading import import_string


class SecretsBackend(Protocol):
    """Pluggable encrypt/decrypt boundary.

    Implementations must be symmetric: ``decrypt(encrypt(x)) == x``. They never
    see model instances - only opaque byte strings - so an external secrets
    store (OpenBao) can be wired in by satisfying this Protocol.
    """

    def encrypt(self, plaintext: bytes) -> bytes: ...

    def decrypt(self, token: bytes) -> bytes: ...


def monitoring_keys() -> list[str]:
    """The raw ``MONITORING_SECRET_KEY`` entries, newest first (#493).

    One key, or a comma-separated list during a rotation: the first encrypts,
    every one decrypts. Falls back to ``SECRET_KEY`` only with DEBUG on so dev
    just works; ``settings.py`` already refused a malformed list at start.
    """
    from danbyte.secret_keys import parse_monitoring_keys

    try:
        keys = parse_monitoring_keys(getattr(settings, "MONITORING_SECRET_KEY", "") or "")
    except ValueError as exc:
        raise ImproperlyConfigured(str(exc)) from None
    if keys:
        return keys
    if not settings.DEBUG:
        # In production, don't silently encrypt every stored credential under a
        # key derived from SECRET_KEY: rotating SECRET_KEY would void all
        # secrets, and a SECRET_KEY leak would decrypt them. Require a dedicated
        # key so credential encryption has an independent lifecycle.
        raise ImproperlyConfigured(
            "MONITORING_SECRET_KEY must be set when DEBUG is off - it encrypts "
            "SNMP/SSH/SMTP/LDAP credentials at rest independently of SECRET_KEY."
        )
    return [settings.SECRET_KEY]


def _fernet_key_for(raw: str) -> bytes:
    """A stable urlsafe-base64 32-byte Fernet key from any string, namespaced
    so it never collides with other uses of the same secret."""
    digest = hashlib.sha256(f"danbyte.monitoring.secrets:{raw}".encode()).digest()
    return base64.urlsafe_b64encode(digest)


def _derive_fernet_key() -> bytes:
    """The Fernet key new values are encrypted under (the newest key)."""
    return _fernet_key_for(monitoring_keys()[0])


class FernetSecretsBackend:
    """Default backend - Fernet keys derived from ``MONITORING_SECRET_KEY``.

    Several keys make a ``MultiFernet``: encrypt with the first, decrypt with
    any, and ``rotate`` re-encrypts a token under the first.
    """

    def __init__(self, key: bytes | None = None, keys: list[bytes] | None = None) -> None:
        if not keys:
            keys = [key] if key else [_fernet_key_for(k) for k in monitoring_keys()]
        self._primary = Fernet(keys[0])
        self._fernet = MultiFernet([Fernet(k) for k in keys])
        self.key_count = len(keys)

    def encrypt(self, plaintext: bytes) -> bytes:
        return self._fernet.encrypt(plaintext)

    def decrypt(self, token: bytes) -> bytes:
        return self._fernet.decrypt(token)

    def is_current(self, token: bytes) -> bool:
        """True when ``token`` already decrypts under the newest key."""
        try:
            self._primary.decrypt(token)
        except InvalidToken:
            return False
        return True

    def rotate(self, token: bytes) -> bytes:
        """``token`` re-encrypted under the newest key; ``InvalidToken`` when
        no configured key opens it."""
        return self._fernet.rotate(token)


@lru_cache(maxsize=1)
def get_secrets_backend() -> SecretsBackend:
    """The configured secrets backend (cached for the process lifetime)."""
    path = getattr(settings, "MONITORING_SECRETS_BACKEND", "")
    if path:
        factory = import_string(path)
        return factory()
    return FernetSecretsBackend()


def _reset_backend(*, setting, **kwargs):  # noqa: ARG001
    """Drop the cached backend when a test overrides the key settings."""
    if setting in {"MONITORING_SECRET_KEY", "MONITORING_SECRETS_BACKEND", "SECRET_KEY", "DEBUG"}:
        get_secrets_backend.cache_clear()


setting_changed.connect(_reset_backend, dispatch_uid="monitoring.secrets.reset_backend")


class EncryptedJSONField(models.TextField):
    """A JSON field whose value is encrypted at rest.

    Stores ``fernet(json.dumps(value))`` as text. Reads decrypt + parse back to
    the Python value. An empty / null value stays empty (nothing to protect).
    Decryption failure (wrong key, corrupted row) returns ``{}`` rather than
    raising mid-query - misconfiguration must not 500 a list view - and is the
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
        # A plaintext string that slipped through (e.g. a fixture) - parse it.
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return {}

    def get_prep_value(self, value):
        if value in (None, "", {}, []):
            return ""
        token = get_secrets_backend().encrypt(json.dumps(value, default=str).encode())
        return token.decode()
