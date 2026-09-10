"""The Zabbix JSON-RPC API, as three POSTs and a token.

No SDK. The whole API is one endpoint that takes ``{jsonrpc, method, params,
id}``, and adding a dependency to an airgapped installer to send that would buy
nothing - the same call made for the assistant's model providers and for Azure
Key Vault, both of which ship as plain ``requests``.

Outbound goes through :func:`core.ssrf.safe_post`, so a tenant-configured URL is
never a way to reach an internal service. A Zabbix on RFC1918 - which is most of
them - is reached by a deployment admin allow-listing it under Settings →
Security → Outbound connections. That is deliberate: unlike Vault and the local
model provider, this URL is set by a *tenant* admin, so it does not get their
bypass.
"""
from __future__ import annotations

import json

from core.ssrf import safe_post


class ZabbixError(RuntimeError):
    """The server answered, and the answer was no."""


class ZabbixUnreachable(ZabbixError):
    """The server did not answer at all."""


class ZabbixClient:
    def __init__(self, url: str, token: str = "", *, verify_tls=True, timeout=20):
        self.url = url
        self.token = token
        self.verify_tls = verify_tls
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, params=None, *, authenticated=True):
        self._id += 1
        headers = {"Content-Type": "application/json-rpc"}
        # apiinfo.version is the one method that must NOT carry auth - Zabbix
        # rejects the call outright if it does, which makes it the right probe
        # for "is this a Zabbix, and which one" before any token exists.
        if authenticated and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": params if params is not None else {},
                "id": self._id,
            }
        )
        try:
            resp = safe_post(
                self.url,
                headers=headers,
                data=body,
                timeout=self.timeout,
                verify=self.verify_tls,
            )
        except Exception as exc:
            raise ZabbixUnreachable(str(exc)) from exc

        if resp.status_code != 200:
            raise ZabbixError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            payload = resp.json()
        except ValueError as exc:
            # Almost always the frontend URL pointing at the login page rather
            # than the API - worth saying so instead of "invalid JSON".
            raise ZabbixError(
                "The URL did not return a JSON-RPC response - check it points "
                "at the Zabbix frontend."
            ) from exc

        if "error" in payload:
            err = payload["error"]
            raise ZabbixError(err.get("data") or err.get("message") or str(err))
        return payload.get("result")

    def version(self) -> str:
        return self.call("apiinfo.version", authenticated=False)

    def host_count(self) -> int:
        """How many hosts the token can see.

        Doubles as the auth probe: it is a normal read, so it fails the way
        every later call will fail, and the number is worth telling the
        operator - a token scoped to nothing returns 0 rather than an error,
        which no exception would have revealed.
        """
        return int(self.call("host.get", {"countOutput": True}))
