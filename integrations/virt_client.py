"""Hypervisor API clients for virtualization sync.

Proxmox VE first: plain REST with an API token
(``Authorization: PVEAPIToken=<token_id>=<secret>``) — revocable, no ticket
dance, works against any node in the cluster. vCenter later behind the same
:class:`~integrations.models.VirtualizationSource` model.

Outbound targets obey the deployment SSRF allowlist, same as the WinRM client.
"""
from __future__ import annotations

import requests

from core.ssrf import SSRFError, assert_public_host


class VirtAPIError(RuntimeError):
    """Transport failure or non-2xx from the hypervisor API."""


def proxmox_get(source, path: str):
    """GET ``/api2/json/<path>`` on a Proxmox source and return ``data``."""
    try:
        assert_public_host(source.host, source.port)
    except SSRFError as exc:
        raise VirtAPIError(str(exc)) from exc
    creds = source.credentials or {}
    token_id = creds.get("token_id", "")
    secret = creds.get("secret", "")
    url = f"https://{source.host}:{source.port}/api2/json/{path.lstrip('/')}"
    try:
        r = requests.get(
            url,
            headers={"Authorization": f"PVEAPIToken={token_id}={secret}"},
            verify=source.verify_ssl,
            timeout=15,
        )
    except requests.RequestException as exc:
        raise VirtAPIError(f"Proxmox API at {source.host}:{source.port} unreachable: {exc}") from exc
    if r.status_code == 401:
        raise VirtAPIError("Proxmox rejected the API token (401).")
    if not r.ok:
        raise VirtAPIError(f"Proxmox API returned {r.status_code} for {path}.")
    try:
        return r.json().get("data")
    except ValueError as exc:
        raise VirtAPIError("Proxmox API returned non-JSON output.") from exc
