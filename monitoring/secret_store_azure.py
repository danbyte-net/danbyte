"""The ``azure`` secret-store provider - Azure Key Vault.

Secrets live as Key Vault secrets named ``danbyte-{tenant}-{ref}``, so Danbyte
holds only the reference and the key material never touches the database. Auth
is the client-credentials flow against Entra ID; the client secret is the only
credential Danbyte keeps, encrypted in ``DeploymentSettings.secrets``.

No Azure SDK: this is three REST calls plus a token, and the SDK would pull a
dependency tree into an airgapped installer for nothing.

Like the Vault backend, the vault URL is **deployment-admin-configured** - the
same trust tier as the SSRF allowlist - so it is reached directly (TLS-verified,
redirects disabled, short timeout) rather than through the tenant-facing guard.
That is also what lets it work against Azure Government, Azure Stack or a
private endpoint, none of which the public guard would allow.
"""
from __future__ import annotations

import hashlib
import json
import time
from urllib.parse import urlsplit

import requests

from .secret_store import SecretStoreError

API_VERSION = "7.4"
PUBLIC_AUTHORITY = "https://login.microsoftonline.com"

# Key Vault names are `[0-9a-zA-Z-]{1,127}`, which a ref like "csr/<uuid>" or an
# operator's "team/ssh" does not satisfy. Refs are therefore sanitised for
# readability and suffixed with a digest of the original, so the mapping stays
# one-to-one - two refs that sanitise the same way still get different names.
NAME_MAX = 127
DIGEST_LEN = 12


def _safe(text: str) -> str:
    out = "".join(c if (c.isascii() and c.isalnum()) else "-" for c in text)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


class AzureKeyVaultSecretStore:
    """A :class:`monitoring.secret_store.SecretStore` backed by Azure Key Vault."""

    def __init__(
        self,
        vault_url,
        directory_id,
        client_id,
        client_secret,
        *,
        authority="",
        timeout=8,
    ):
        self.vault_url = vault_url.rstrip("/")
        self.directory_id = directory_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.authority = (authority or PUBLIC_AUTHORITY).rstrip("/")
        self.timeout = timeout
        self._token = ""
        self._token_expires = 0.0

    @classmethod
    def from_deployment(cls):
        """Build from the deployment settings, or ``None`` if any part of the
        connection is missing - the caller then treats it as disabled, so a
        half-configured vault leaves CSR/ACME fail-closed rather than erroring
        at issuance time."""
        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        url = (dep.azure_vault_url or "").strip()
        directory = (dep.azure_directory_id or "").strip()
        client = (dep.azure_client_id or "").strip()
        secret = (dep.secrets or {}).get("azure_client_secret", "")
        if not (url and directory and client and secret):
            return None
        return cls(
            url,
            directory,
            client,
            secret,
            authority=(dep.azure_authority or "").strip(),
        )

    # ─── naming ─────────────────────────────────────────────────────────
    def _name(self, tenant_id, ref: str) -> str:
        """The Key Vault secret name for one of Danbyte's own refs.

        Deterministic: the same tenant and ref always resolve to the same
        name, which is what makes ``get`` find what ``put`` wrote.
        """
        digest = hashlib.sha256(f"{tenant_id}/{ref}".encode()).hexdigest()[:DIGEST_LEN]
        prefix = f"danbyte-{_safe(str(tenant_id))}-"
        room = NAME_MAX - len(prefix) - DIGEST_LEN - 1
        return f"{prefix}{_safe(ref)[:room].strip('-')}-{digest}"

    # ─── auth ───────────────────────────────────────────────────────────
    def _scope(self) -> str:
        """The token audience, derived from the vault host.

        ``kv.vault.azure.net`` → ``https://vault.azure.net/.default``, and the
        same shape gives the right audience on Azure Government and Azure
        Stack without a second setting to keep in sync with the URL.
        """
        host = urlsplit(self.vault_url).hostname or ""
        suffix = host.split(".", 1)[1] if "." in host else host
        return f"https://{suffix}/.default"

    def _access_token(self) -> str:
        # Cached until shortly before it expires: one token covers a whole
        # issuance run, and a round-trip per read would double every call.
        if self._token and time.monotonic() < self._token_expires:
            return self._token
        url = f"{self.authority}/{self.directory_id}/oauth2/v2.0/token"
        try:
            r = requests.post(
                url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "scope": self._scope(),
                },
                timeout=self.timeout,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise SecretStoreError(f"Entra ID unreachable: {exc}") from exc
        if r.status_code != 200:
            # The body names the AADSTS code, which is what an operator needs
            # to tell a wrong secret from a missing role assignment.
            raise SecretStoreError(
                f"Key Vault sign-in failed ({r.status_code}): {r.text[:200]}"
            )
        body = r.json()
        self._token = body.get("access_token") or ""
        if not self._token:
            raise SecretStoreError("Key Vault sign-in returned no access token.")
        self._token_expires = time.monotonic() + max(
            60, int(body.get("expires_in") or 3600) - 60
        )
        return self._token

    def _req(self, method: str, path: str, **kw):
        try:
            return requests.request(
                method,
                f"{self.vault_url}/{path.lstrip('/')}",
                params={"api-version": API_VERSION},
                headers={"Authorization": f"Bearer {self._access_token()}"},
                timeout=self.timeout,
                allow_redirects=False,
                **kw,
            )
        except requests.RequestException as exc:
            raise SecretStoreError(f"Key Vault unreachable: {exc}") from exc

    # ─── the SecretStore protocol ───────────────────────────────────────
    def put(self, tenant_id, ref: str, value: dict) -> None:
        r = self._req(
            "PUT",
            f"secrets/{self._name(tenant_id, ref)}",
            json={"value": json.dumps(value or {})},
        )
        if r.status_code != 200:
            raise SecretStoreError(
                f"Key Vault write failed ({r.status_code}): {r.text[:200]}"
            )

    def get(self, tenant_id, ref: str) -> dict | None:
        return self._read(f"secrets/{self._name(tenant_id, ref)}")

    def get_at_path(self, tenant_id, path: str) -> dict | None:
        """Read a secret an operator authored themselves, by its Key Vault
        name - outside Danbyte's ``danbyte-{tenant}-{ref}`` namespace, so the
        name is used verbatim. ``tenant_id`` is unused: Key Vault addresses the
        operator's secret directly, and cross-tenant isolation is theirs to
        enforce with the vault's access policy or RBAC. Missing → ``None``."""
        return self._read(f"secrets/{path.strip('/')}")

    def _read(self, path: str) -> dict | None:
        r = self._req("GET", path)
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise SecretStoreError(
                f"Key Vault read failed ({r.status_code}): {r.text[:200]}"
            )
        raw = r.json().get("value")
        if raw is None:
            return None
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        # Danbyte writes a JSON object. An operator's own secret is usually a
        # bare string, so it comes back as {"value": "…"} rather than nothing.
        return parsed if isinstance(parsed, dict) else {"value": raw}

    def delete(self, tenant_id, ref: str) -> None:
        name = self._name(tenant_id, ref)
        r = self._req("DELETE", f"secrets/{name}")
        if r.status_code not in (200, 404):
            raise SecretStoreError(
                f"Key Vault delete failed ({r.status_code}): {r.text[:200]}"
            )
        # Key Vault soft-deletes, so the key would still be recoverable. Purge
        # it - but a vault with purge protection on refuses (403/409), and that
        # is the operator's deliberate retention policy, not a failure here.
        purge = self._req("DELETE", f"deletedsecrets/{name}")
        if purge.status_code not in (200, 204, 403, 404, 409):
            raise SecretStoreError(
                f"Key Vault purge failed ({purge.status_code}): {purge.text[:200]}"
            )
