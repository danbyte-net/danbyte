"""Hypervisor API clients for virtualization sync.

Two hypervisors behind the same
:class:`~integrations.models.VirtualizationSource` model:

* **Proxmox VE** - plain REST with an API token
  (``Authorization: PVEAPIToken=<token_id>=<secret>``): revocable, no ticket
  dance, works against any node in the cluster.
* **VMware vCenter** - the vSphere Automation REST API (``/api/``): a session
  is created once with username/password (``POST /api/session``) and reused via
  the ``vmware-api-session-id`` header for the rest of the pass.

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


# ─── VMware vCenter (vSphere Automation REST) ────────────────────────────────


class VCenterClient:
    """A short-lived vCenter REST session, reused across one sync pass.

    Login is one ``POST /api/session`` with the source's username/password; the
    returned session id authenticates every subsequent GET. The session is torn
    down again in :meth:`close` so we never leave login tokens lingering on the
    appliance.
    """

    def __init__(self, source):
        self.source = source
        self.base = f"https://{source.host}:{source.port}/api"
        self._session_id: str | None = None
        self._http = requests.Session()
        self._http.verify = source.verify_ssl

    def _guard(self) -> None:
        try:
            assert_public_host(self.source.host, self.source.port)
        except SSRFError as exc:
            raise VirtAPIError(str(exc)) from exc

    def login(self) -> VCenterClient:
        self._guard()
        creds = self.source.credentials or {}
        username = creds.get("username", "")
        password = creds.get("password", "")
        try:
            r = self._http.post(
                f"{self.base}/session", auth=(username, password), timeout=15
            )
        except requests.RequestException as exc:
            raise VirtAPIError(
                f"vCenter API at {self.source.host}:{self.source.port} unreachable: {exc}"
            ) from exc
        if r.status_code in (401, 403):
            raise VirtAPIError("vCenter rejected the credentials (401/403).")
        if not r.ok:
            raise VirtAPIError(f"vCenter login returned {r.status_code}.")
        try:
            self._session_id = r.json()
        except ValueError as exc:
            raise VirtAPIError("vCenter login returned non-JSON output.") from exc
        return self

    def get(self, path: str):
        """GET ``/api/<path>`` and return the decoded JSON body."""
        if self._session_id is None:
            self.login()
        self._guard()
        url = f"{self.base}/{path.lstrip('/')}"
        try:
            r = self._http.get(
                url,
                headers={"vmware-api-session-id": self._session_id},
                timeout=30,
            )
        except requests.RequestException as exc:
            raise VirtAPIError(
                f"vCenter API at {self.source.host}:{self.source.port} unreachable: {exc}"
            ) from exc
        if r.status_code in (401, 403):
            raise VirtAPIError("vCenter session expired or unauthorized (401/403).")
        if not r.ok:
            raise VirtAPIError(f"vCenter API returned {r.status_code} for {path}.")
        try:
            return r.json()
        except ValueError as exc:
            raise VirtAPIError("vCenter API returned non-JSON output.") from exc

    def close(self) -> None:
        if self._session_id is None:
            return
        try:
            self._http.delete(
                f"{self.base}/session",
                headers={"vmware-api-session-id": self._session_id},
                timeout=10,
            )
        except requests.RequestException:
            pass  # best-effort logout; the session expires on its own regardless
        finally:
            self._session_id = None
