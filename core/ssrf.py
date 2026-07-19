"""SSRF guard for outbound, user-configured network egress (webhooks,
notifications, automation, device-type import, SMTP/LDAP relays, monitoring
targets).

Resolves the host and rejects loopback / RFC1918 / link-local /
``169.254.0.0/16`` (cloud metadata!) / ULA / reserved addresses, so a tenant
admin can't point egress at internal services and read the response back.

Internal targets that are *legitimately* needed (e.g. an on-prem automation
runner or SMTP relay) are allow-listed via ``DANBYTE_SSRF_ALLOWLIST`` — a
comma-separated list of CIDRs/IPs whose resolved addresses are permitted.
Empty by default.

Two entry points:
- URL callers use ``safe_request`` / ``safe_post`` / ``safe_get`` instead of
  ``requests.*`` — they validate the host, force ``allow_redirects=False`` (a
  redirect could bounce to an internal address), AND **pin the connection to
  the validated IP** so a DNS-rebinding flip between the check and the connect
  can't reach an internal address (TOCTOU).
- Bare host:port callers (SMTP, LDAP) use ``assert_public_host(host, port)``
  before opening their own socket.
"""
from __future__ import annotations

import ipaddress
import os
import socket
from functools import lru_cache
from urllib.parse import urlparse, urlunparse

import requests
from requests.adapters import HTTPAdapter


class SSRFError(ValueError):
    """Raised when an outbound target resolves to a non-public address."""


@lru_cache(maxsize=1)
def _allowlist() -> tuple:
    nets = []
    for part in os.getenv("DANBYTE_SSRF_ALLOWLIST", "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            continue
    return tuple(nets)


def _db_allowlist() -> tuple:
    """Deployment-admin-managed allowlist (Settings → Deployment → General).

    Read fresh per check — guards run rarely and the singleton read is one
    indexed query, while caching would make the setting appear to "not work"
    until a restart. Deployment tier on purpose: a TENANT admin must never be
    able to widen the guard (that's who it protects against).
    """
    try:
        from core.models import DeploymentSettings

        entries = DeploymentSettings.load().ssrf_allowlist or []
    except Exception:  # noqa: BLE001 — DB not ready (migrations, early boot)
        return ()
    nets = []
    for part in entries:
        try:
            nets.append(ipaddress.ip_network(str(part).strip(), strict=False))
        except ValueError:
            continue
    return tuple(nets)


def _blocked(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if any(addr in net for net in _allowlist() + _db_allowlist()):
        return False
    return (
        addr.is_loopback
        or addr.is_private  # RFC1918 + 169.254 + 0.0.0.0/8 + …
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def _resolve_public(host: str, port: int) -> list[str]:
    """Resolve ``host`` and return its addresses, or raise :class:`SSRFError`
    if it doesn't resolve or ANY resolved address is non-public."""
    if not host:
        raise SSRFError("No host to resolve.")
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise SSRFError(f"Could not resolve host '{host}': {exc}") from exc
    ips = []
    for info in infos:
        ip = info[4][0]
        if _blocked(ip):
            raise SSRFError(
                f"Host '{host}' resolves to a non-public address ({ip}). A "
                "deployment admin can permit it under Settings → Deployment → "
                "Outbound connections (or via DANBYTE_SSRF_ALLOWLIST)."
            )
        ips.append(ip)
    if not ips:
        raise SSRFError(f"Host '{host}' did not resolve to any address.")
    return ips


def _split(url: str) -> tuple[str, str, int]:
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        raise SSRFError(f"URL scheme '{parsed.scheme or '(none)'}' is not allowed.")
    host = parsed.hostname
    if not host:
        raise SSRFError("URL has no host.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, host, port


def assert_public_url(url: str) -> None:
    """Raise :class:`SSRFError` unless ``url`` is http(s) and every address its
    host resolves to is public (or explicitly allow-listed)."""
    _, host, port = _split(url)
    _resolve_public(host, port)


def assert_public_host(host: str, port: int) -> None:
    """Validate a bare ``host:port`` (SMTP, LDAP, …) resolves only to public
    addresses. Raises :class:`SSRFError` otherwise. Use before opening a raw
    socket to a user-configured host."""
    _resolve_public(host, int(port))


class _PinnedSNIAdapter(HTTPAdapter):
    """Verifies TLS against the original hostname while the URL connects to a
    pre-validated IP — so cert checking still works after we rewrite the URL's
    host to the pinned address."""

    def __init__(self, server_hostname: str, **kw):
        self._sni = server_hostname
        super().__init__(**kw)

    def init_poolmanager(self, connections, maxsize, block=False, **kw):
        kw["server_hostname"] = self._sni
        kw["assert_hostname"] = self._sni
        super().init_poolmanager(connections, maxsize, block=block, **kw)


def safe_request(method: str, url: str, **kwargs):
    """``requests.request`` hardened against SSRF: validates the host resolves
    to a public IP, forces ``allow_redirects=False``, and **pins the connection
    to the validated IP** (closing the DNS-rebinding TOCTOU) while preserving
    the Host header and TLS SNI/cert verification against the original host."""
    scheme, host, port = _split(url)
    ip = _resolve_public(host, port)[0]
    kwargs.setdefault("allow_redirects", False)

    parsed = urlparse(url)
    netloc_ip = f"[{ip}]" if ":" in ip else ip
    if parsed.port:
        netloc_ip += f":{parsed.port}"
    pinned_url = urlunparse(parsed._replace(netloc=netloc_ip))

    headers = dict(kwargs.pop("headers", None) or {})
    headers.setdefault("Host", host if not parsed.port else f"{host}:{parsed.port}")

    with requests.Session() as sess:
        if scheme == "https":
            sess.mount(pinned_url, _PinnedSNIAdapter(host))
        return sess.request(method, pinned_url, headers=headers, **kwargs)


def safe_post(url: str, **kwargs):
    return safe_request("POST", url, **kwargs)


def safe_get(url: str, **kwargs):
    return safe_request("GET", url, **kwargs)
