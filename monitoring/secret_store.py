"""A named key/value secret store for issuance keys (CSR / ACME private keys).

This is distinct from :class:`monitoring.secrets.EncryptedJSONField`, which
encrypts a *model field in place*. Here the app stores private-key material under
an opaque ``ref`` and holds only that reference - the secret bytes live in a
backend an operator chooses:

* ``local`` - an encrypted table (:class:`monitoring.models.StoredSecret`),
  reusing the same Fernet-at-rest machinery as every other credential. Works out
  of the box, airgap-friendly, no external dependency.
* ``vault`` - an external HashiCorp Vault / OpenBao (added by the Vault backend).
* anything a plugin registers with :func:`register_secret_store`.

It is **opt-in and deployment-tier**: choosing where the org's private keys live
is a deployment-admin decision (like the SSRF allowlist), never a tenant one.
Until a provider is enabled, :func:`secret_store_enabled` is ``False`` and every
key-bearing feature (CSR, ACME) must stay **fail-closed** - call
:func:`require_secret_store`, which raises :class:`SecretStoreDisabled`.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol


class SecretStoreError(RuntimeError):
    """A secret store operation failed (backend unreachable, auth, etc.)."""


class SecretStoreDisabled(SecretStoreError):
    """No secret store is enabled - a key-bearing feature refused to proceed."""


class SecretStore(Protocol):
    """A tenant-scoped named secret store. Values are JSON-able dicts (e.g.
    ``{"private_key": "-----BEGIN…"}``)."""

    def put(self, tenant_id, ref: str, value: dict) -> None: ...

    def get(self, tenant_id, ref: str) -> dict | None: ...

    def delete(self, tenant_id, ref: str) -> None: ...

    def get_at_path(self, tenant_id, path: str) -> dict | None:
        """Read an operator-chosen *external* path - a secret authored outside
        Danbyte's ``{tenant}/{ref}`` namespace. ``tenant_id`` scopes the lookup
        for stores that keep secrets in Danbyte's own DB (the local provider);
        external stores (Vault) address the operator's path directly. Used by
        device credentials,
        which store only the reference to a secret an operator manages
        elsewhere. Returns the value dict, or ``None`` if nothing is there."""
        ...


class LocalFernetSecretStore:
    """The ``local`` provider - secrets in the encrypted ``StoredSecret`` table.

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

    def get_at_path(self, tenant_id, path: str) -> dict | None:
        """A ``StoredSecret`` whose ``ref`` equals ``path`` **within this
        tenant** - for the local provider an operator seeds a secret by creating
        a ``StoredSecret`` with that ref. Tenant-scoped so one tenant's path can
        never resolve another tenant's secret. ``None`` when nothing matches."""
        from .models import StoredSecret

        row = StoredSecret.objects.filter(tenant_id=tenant_id, ref=path).first()
        return row.value if row is not None else None


# ─── provider registry ──────────────────────────────────────────────────────
# Providers register a kind, a factory (returns a ready store, or ``None`` when
# the deployment hasn't configured it fully - fail closed), and the settings
# fields the Security card renders for it. Plugins add stores the same way from
# ``danbyte_plugin.py``. Field ``type`` is text | password | checkbox; a
# password field is write-only and ``set_flag`` names the boolean that says
# whether one is stored.


@dataclass(frozen=True)
class SecretStoreProvider:
    kind: str
    label: str
    factory: Callable[[], SecretStore | None]
    description: str = ""
    fields: tuple[dict, ...] = field(default_factory=tuple)

    def payload(self) -> dict:
        return {
            "kind": self.kind,
            "label": self.label,
            "description": self.description,
            "fields": [dict(f) for f in self.fields],
        }


_REGISTRY: dict[str, SecretStoreProvider] = {}


def register_secret_store(
    kind: str,
    label: str,
    factory: Callable[[], SecretStore | None],
    *,
    description: str = "",
    fields: tuple[dict, ...] | list[dict] = (),
) -> SecretStoreProvider:
    """Make ``kind`` selectable under Settings → Security → Secret store."""
    kind = (kind or "").strip()
    if not kind:
        raise ValueError("secret store kind must be non-empty")
    prov = SecretStoreProvider(
        kind=kind, label=label, factory=factory, description=description,
        fields=tuple(dict(f) for f in fields),
    )
    _REGISTRY[kind] = prov
    return prov


def secret_store_providers() -> list[SecretStoreProvider]:
    """Registered providers, in registration order (built-ins first)."""
    return list(_REGISTRY.values())


def secret_store_kinds() -> set[str]:
    return set(_REGISTRY)


def _vault_factory() -> SecretStore | None:
    # Imported lazily so the local path stays dependency-free.
    try:
        from .secret_store_vault import VaultSecretStore
    except ImportError:  # pragma: no cover - backend not present
        return None
    return VaultSecretStore.from_deployment()


register_secret_store(
    "local",
    "Local",
    LocalFernetSecretStore,
    description="Encrypted at rest in Danbyte's own database under MONITORING_SECRET_KEY.",
)
register_secret_store(
    "vault",
    "HashiCorp Vault / OpenBao",
    _vault_factory,
    description="An external Vault / OpenBao KV v2 mount; Danbyte holds only a reference.",
    fields=(
        {
            "name": "vault_addr",
            "label": "Vault address",
            "type": "text",
            "placeholder": "https://vault.danbyte.lan:8200",
        },
        {
            "name": "vault_mount",
            "label": "KV v2 mount",
            "type": "text",
            "placeholder": "danbyte",
            "default": "danbyte",
        },
        {
            "name": "vault_token",
            "label": "Vault token",
            "type": "password",
            "placeholder": "hvs.…",
            "set_flag": "vault_token_set",
        },
        {
            "name": "vault_verify_tls",
            "label": "Verify TLS certificate",
            "type": "checkbox",
            "default": True,
            "hint": "Turn off only for a Vault with a self-signed cert on a trusted network.",
        },
    ),
)


def _provider() -> str:
    from core.models import DeploymentSettings

    return (DeploymentSettings.load().secrets_provider or "").strip()


def secret_store_enabled() -> bool:
    """True when a usable secret store is configured - the gate CSR/ACME check
    before touching a private key. A provider that is selected but unconfigured
    (e.g. ``vault`` with no address/token) counts as disabled: fail closed."""
    return active_secret_store() is not None


def active_secret_store() -> SecretStore | None:
    """The configured store, or ``None`` when disabled, unconfigured, or the
    selected kind is no longer registered (a removed plugin fails closed)."""
    prov = _REGISTRY.get(_provider())
    return prov.factory() if prov is not None else None


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
