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
private endpoint, none of which the public guard would allow. Both the vault
URL and the sign-in endpoint must be ``https://``: the client secret goes to
the one and the bearer token and secret values to the other (#512).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from urllib.parse import urlsplit

import requests

from .secret_store import SecretPathError, SecretStoreError, clean_secret_path

log = logging.getLogger(__name__)

API_VERSION = "7.4"
PUBLIC_AUTHORITY = "https://login.microsoftonline.com"

# Key Vault names are `[0-9a-zA-Z-]{1,127}`, which a ref like "csr/<uuid>" or an
# operator's "team/ssh" does not satisfy. Refs are therefore sanitised for
# readability and suffixed with a digest of the original, so the mapping stays
# one-to-one - two refs that sanitise the same way still get different names.
NAME_MAX = 127
DIGEST_LEN = 12
_LEGAL_NAME = re.compile(r"[0-9A-Za-z-]{1,127}")
# The names Danbyte files its own secrets under: the tenant is a UUID, so the
# managed namespace is exactly this shape - for every tenant, past or present.
_MANAGED_NAME = re.compile(
    r"danbyte-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-", re.I
)


# Entra ID tokens, shared by every store instance in this process (#510).
# ``active_secret_store()`` builds a fresh store per operation, so a cache on
# the instance never got a second hit. Keyed on everything that decides the
# token - authority, directory, client, scope, and a digest of the client
# secret - so a settings change misses the cache and signs in again at once.
_TOKENS: dict[tuple, tuple[str, float]] = {}
_TOKENS_LOCK = threading.Lock()
#: Renew this long before the token's stated expiry (at most half its life).
TOKEN_MARGIN = 300


def clear_token_cache() -> None:
    """Forget every cached token."""
    with _TOKENS_LOCK:
        _TOKENS.clear()


def https_url_problem(value: str, label: str) -> str:
    """Why ``value`` is not an https URL with a host, or ``""`` when it is.

    Azure serves Entra ID and Key Vault over HTTPS only, so a plain-http value
    is a typo or a man in the middle: the client secret, the bearer token and
    the secret values would cross the wire in clear (#512)."""
    parts = urlsplit((value or "").strip())
    if parts.scheme.lower() != "https" or not parts.hostname:
        return f"{label} must be an https:// URL."
    return ""


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
        # Refused here as well as in the settings form, so a row saved before
        # the check can never send the client secret in clear.
        for url, label in ((self.vault_url, "Key Vault URL"),
                           (self.authority, "Sign-in endpoint")):
            problem = https_url_problem(url, label)
            if problem:
                raise SecretStoreError(problem)
        self.timeout = timeout

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
        try:
            return cls(
                url,
                directory,
                client,
                secret,
                authority=(dep.azure_authority or "").strip(),
            )
        except SecretStoreError as exc:
            # A plain-http URL saved before the check: unusable, so disabled
            # (fail closed) rather than an error on every caller.
            log.warning("Azure Key Vault secret store refused: %s", exc)
            return None

    # ─── naming ─────────────────────────────────────────────────────────
    def _name(self, tenant_id, ref: str) -> str:
        """The Key Vault secret name for one of Danbyte's own refs.

        Deterministic: the same tenant and ref always resolve to the same
        name, which is what makes ``get`` find what ``put`` wrote. The
        sanitising already keeps a ``..`` from reaching the URL, but the ref
        is refused all the same so every store behaves alike (#315).
        """
        clean_secret_path(ref, label="Secret ref")
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

    def _token_key(self) -> tuple:
        secret = hashlib.sha256(self.client_secret.encode()).hexdigest()
        return (self.authority, self.directory_id, self.client_id, self._scope(), secret)

    def _access_token(self, *, renew: bool = False) -> str:
        """A token from the process-wide cache, signing in when there is none,
        it is about to expire, or ``renew`` (the vault refused the cached one).
        Under the lock, so concurrent callers share one sign-in."""
        key = self._token_key()
        with _TOKENS_LOCK:
            now = time.monotonic()
            hit = _TOKENS.get(key)
            if hit and not renew and now < hit[1]:
                return hit[0]
            token, lifetime = self._sign_in()
            for stale in [k for k, (_, exp) in _TOKENS.items() if exp <= now]:
                del _TOKENS[stale]
            margin = min(TOKEN_MARGIN, lifetime // 2)
            _TOKENS[key] = (token, now + max(0, lifetime - margin))
            return token

    def _sign_in(self) -> tuple[str, int]:
        """One client-credentials round trip: ``(access_token, expires_in)``."""
        url =f"{self.authority}/{self.directory_id}/oauth2/v2.0/token"
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
        token = body.get("access_token") or ""
        if not token:
            raise SecretStoreError("Key Vault sign-in returned no access token.")
        try:
            lifetime = int(body.get("expires_in") or 3600)
        except (TypeError, ValueError):
            lifetime = 3600
        return token, lifetime

    def _req(self, method: str, path: str, **kw):
        r = self._send(method, path, self._access_token(), **kw)
        if r.status_code == 401:
            # A cached token the vault no longer takes (revoked, role
            # changed): sign in again once rather than fail until it expires.
            r = self._send(method, path, self._access_token(renew=True), **kw)
        return r

    def _send(self, method: str, path: str, token: str, **kw):
        try:
            return requests.request(
                method,
                f"{self.vault_url}/{path.lstrip('/')}",
                params={"api-version": API_VERSION},
                headers={"Authorization": f"Bearer {token}"},
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

    def validate_external_path(self, path: str) -> None:
        """An external reference is one Key Vault secret name: letters, digits
        and hyphens only (so it cannot become a different URL), and never one
        of Danbyte's own ``danbyte-<tenant>-…`` names - for any tenant, since
        every tenant reaches the vault with the same app registration (#315)."""
        clean_secret_path(path)
        if not _LEGAL_NAME.fullmatch(path):
            raise SecretPathError(
                "A Key Vault secret name allows only letters, digits and hyphens "
                "(up to 127 characters)."
            )
        if _MANAGED_NAME.match(path):
            raise SecretPathError(
                f"'{path}' is inside Danbyte's managed namespace (danbyte-<tenant>-…); "
                "an external credential cannot reference a secret Danbyte manages."
            )

    def get_at_path(self, tenant_id, path: str) -> dict | None:
        """Read a secret an operator authored themselves, by its Key Vault
        name - outside Danbyte's ``danbyte-{tenant}-{ref}`` namespace, so the
        name is used verbatim. ``tenant_id`` is unused: Key Vault addresses the
        operator's secret directly; :meth:`validate_external_path` keeps the
        name out of every tenant's managed namespace. Missing → ``None``."""
        self.validate_external_path(path)
        return self._read(f"secrets/{path}")

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

    def _secret_names(self) -> list[str]:
        """Every secret name in the vault, following ``nextLink`` only while
        it stays on this vault over https - the bearer token goes with it."""
        own = urlsplit(self.vault_url)
        names: list[str] = []
        path = "secrets"
        for _ in range(10000):
            r = self._req("GET", path)
            if r.status_code != 200:
                raise SecretStoreError(
                    f"Key Vault list failed ({r.status_code}): {r.text[:200]}"
                )
            body = r.json()
            for item in body.get("value") or []:
                name = (item.get("id") or "").rstrip("/").rsplit("/", 1)[-1]
                if name:
                    names.append(name)
            nxt = body.get("nextLink") or ""
            if not nxt:
                break
            parts = urlsplit(nxt)
            if parts.scheme != "https" or parts.netloc != own.netloc:
                raise SecretStoreError("Key Vault list pointed at another host; stopped.")
            # The skip token rides in the query; api-version is added again.
            query = "&".join(
                q for q in parts.query.split("&") if not q.startswith("api-version=")
            )
            path = parts.path.lstrip("/") + (f"?{query}" if query else "")
        return names

    def managed_refs(self, tenant_id=None) -> list[tuple[str, str]]:
        """``(tenant id, ref)`` of every Danbyte-managed secret in the vault -
        one tenant's, or every tenant's (a deleted tenant's too). A name is
        mapped back to its ref by rebuilding the name from the ref, so only
        names Danbyte itself wrote are returned. Never the values."""
        from .secret_refs import MANAGED_SECRETS

        shape = re.compile(
            r"danbyte-(?P<tenant>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-"
            rf"(?P<body>.+)-[0-9a-f]{{{DIGEST_LEN}}}"
        )
        uuid_re = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
        out = []
        for name in self._secret_names():
            m = shape.fullmatch(name)
            if not m:
                continue
            tenant = m.group("tenant")
            if tenant_id is not None and tenant != str(tenant_id):
                continue
            body = m.group("body")
            for spec in MANAGED_SECRETS:
                folder = _safe(spec.folder)
                tail = "-account" if spec.folder == "issuer" else ""
                hit = re.fullmatch(rf"{re.escape(folder)}-({uuid_re}){tail}", body)
                if not hit:
                    continue
                ref = f"{spec.folder}/{hit.group(1)}" + ("/account" if tail else "")
                if self._name(tenant, ref) == name:
                    out.append((tenant, ref))
                break
        return out

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
