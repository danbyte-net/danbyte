"""A named key/value secret store for issuance keys (CSR / ACME private keys).

This is distinct from :class:`monitoring.secrets.EncryptedJSONField`, which
encrypts a *model field in place*. Here the app stores private-key material under
an opaque ``ref`` and holds only that reference — the secret bytes live in a
backend an operator chooses:

* ``local`` — an encrypted table (:class:`monitoring.models.StoredSecret`),
  reusing the same Fernet-at-rest machinery as every other credential. Works out
  of the box, airgap-friendly, no external dependency.
* ``vault`` — an external HashiCorp Vault / OpenBao (added by the Vault backend).

It is **opt-in and deployment-tier**: choosing where the org's private keys live
is a deployment-admin decision (like the SSRF allowlist), never a tenant one.
Until a provider is enabled, :func:`secret_store_enabled` is ``False`` and every
key-bearing feature (CSR, ACME) must stay **fail-closed** — call
:func:`require_secret_store`, which raises :class:`SecretStoreDisabled`.
"""
from __future__ import annotations

from typing import Protocol

PROVIDERS = {"local", "vault"}


class SecretStoreError(RuntimeError):
    """A secret store operation failed (backend unreachable, auth, etc.)."""


class SecretStoreDisabled(SecretStoreError):
    """No secret store is enabled — a key-bearing feature refused to proceed."""


class SecretStore(Protocol):
    """A tenant-scoped named secret store. Values are JSON-able dicts (e.g.
    ``{"private_key": "-----BEGIN…"}``)."""

    def put(self, tenant_id, ref: str, value: dict) -> None: ...

    def get(self, tenant_id, ref: str) -> dict | None: ...

    def delete(self, tenant_id, ref: str) -> None: ...

    def get_at_path(self, path: str) -> dict | None:
        """Read an operator-chosen *external* path — a secret authored outside
        Danbyte's ``{tenant}/{ref}`` namespace. Used by device credentials,
        which store only the reference to a secret an operator manages
        elsewhere. Returns the value dict, or ``None`` if nothing is there."""
        ...


class LocalFernetSecretStore:
    """The ``local`` provider — secrets in the encrypted ``StoredSecret`` table.

    Reuses ``EncryptedJSONField`` on the row, so the value is Fernet-encrypted at
    rest under the deployment's ``MONITORING_SECRET_KEY`` exactly like every
    other stored credential.
    """

    def put(self, tenant_id, ref: str, value: dict) -> None:
        from .models import StoredSecret

        StoredSecret.objects.update_or_create(
            tenant_id=tenant_id, ref=ref, defaults={"value": value or {}}
        )

    def get(self, tenant_id, ref: str) -> dict | None:
        from .models import StoredSecret

        row = StoredSecret.objects.filter(tenant_id=tenant_id, ref=ref).first()
        return row.value if row is not None else None

    def delete(self, tenant_id, ref: str) -> None:
        from .models import StoredSecret

        StoredSecret.objects.filter(tenant_id=tenant_id, ref=ref).delete()

    def get_at_path(self, path: str) -> dict | None:
        """A ``StoredSecret`` whose ``ref`` equals ``path``, regardless of the
        namespace convention — for the local provider an operator seeds a secret
        by creating a ``StoredSecret`` with that exact ref. Returns ``None`` when
        no such secret exists."""
        from .models import StoredSecret

        row = StoredSecret.objects.filter(ref=path).first()
        return row.value if row is not None else None


def _provider() -> str:
    from core.models import DeploymentSettings

    return (DeploymentSettings.load().secrets_provider or "").strip()


def secret_store_enabled() -> bool:
    """True when a usable secret store is configured — the gate CSR/ACME check
    before touching a private key. A provider that is selected but unconfigured
    (e.g. ``vault`` with no address/token) counts as disabled: fail closed."""
    return active_secret_store() is not None


def active_secret_store() -> SecretStore | None:
    """The configured store, or ``None`` when disabled/unconfigured."""
    provider = _provider()
    if provider == "local":
        return LocalFernetSecretStore()
    if provider == "vault":
        # The Vault backend is wired in separately; importing lazily keeps the
        # local path dependency-free.
        try:
            from .secret_store_vault import VaultSecretStore
        except ImportError:  # pragma: no cover - backend not present
            return None
        return VaultSecretStore.from_deployment()
    return None


def require_secret_store() -> SecretStore:
    """The active store, or raise :class:`SecretStoreDisabled` (fail closed)."""
    store = active_secret_store()
    if store is None:
        raise SecretStoreDisabled(
            "No secret store is enabled. An administrator must enable one under "
            "Settings → Security → Secret store before certificates can be "
            "requested or issued."
        )
    return store
