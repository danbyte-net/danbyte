"""The ``vault`` secret-store provider — HashiCorp Vault / OpenBao KV v2.

Secrets live under ``{mount}/{tenant_id}/{ref}`` in a KV-v2 mount, so Danbyte
holds only the reference and the key material never touches the database. The
Vault address is **deployment-admin-configured** — the same trust tier as the
SSRF allowlist — and a Vault agent commonly listens on loopback/RFC1918, so this
talks to it directly (TLS-verified, redirects disabled, short timeout) rather
than through the tenant-facing SSRF guard, exactly as the Redfish collector
reaches admin-configured BMCs.
"""
from __future__ import annotations

import requests

from .secret_store import SecretStoreError


class VaultSecretStore:
    """A :class:`monitoring.secret_store.SecretStore` backed by Vault KV v2."""

    def __init__(self, addr, token, *, mount="danbyte", verify_tls=True, timeout=8):
        self.addr = addr.rstrip("/")
        self.token = token
        self.mount = mount.strip("/")
        self.verify_tls = verify_tls
        self.timeout = timeout

    @classmethod
    def from_deployment(cls):
        """Build from the deployment settings, or ``None`` if unconfigured
        (missing address or token) — the caller then treats it as disabled."""
        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        addr = (dep.vault_addr or "").strip()
        token = (dep.secrets or {}).get("vault_token", "")
        if not addr or not token:
            return None
        return cls(
            addr,
            token,
            mount=(dep.vault_mount or "danbyte"),
            verify_tls=bool(dep.vault_verify_tls),
        )

    def _url(self, kind: str, tenant_id, ref: str) -> str:
        # kind is "data" (values) or "metadata" (for a permanent delete).
        return f"{self.addr}/v1/{self.mount}/{kind}/{tenant_id}/{ref.strip('/')}"

    def _req(self, method: str, url: str, **kw):
        try:
            return requests.request(
                method,
                url,
                headers={"X-Vault-Token": self.token},
                timeout=self.timeout,
                verify=self.verify_tls,
                allow_redirects=False,
                **kw,
            )
        except requests.RequestException as exc:
            raise SecretStoreError(f"Vault unreachable: {exc}") from exc

    def put(self, tenant_id, ref: str, value: dict) -> None:
        r = self._req(
            "POST", self._url("data", tenant_id, ref), json={"data": value or {}}
        )
        if r.status_code not in (200, 204):
            raise SecretStoreError(f"Vault write failed ({r.status_code}): {r.text[:200]}")

    def get(self, tenant_id, ref: str) -> dict | None:
        r = self._req("GET", self._url("data", tenant_id, ref))
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise SecretStoreError(f"Vault read failed ({r.status_code}): {r.text[:200]}")
        # KV v2 nests the value under data.data.
        return (r.json().get("data") or {}).get("data")

    def delete(self, tenant_id, ref: str) -> None:
        # metadata delete removes all versions permanently — the request's key is
        # gone for good, which is what deleting the request should mean.
        r = self._req("DELETE", self._url("metadata", tenant_id, ref))
        if r.status_code not in (200, 204, 404):
            raise SecretStoreError(f"Vault delete failed ({r.status_code}): {r.text[:200]}")
