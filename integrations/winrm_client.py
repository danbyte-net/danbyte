"""Agentless WinRM access to Windows servers (DHCP/DNS sync).

Shell-exec mode: every call opens a WinRM shell and runs
``powershell -NoProfile -NonInteractive -EncodedCommand …`` with the script's
output serialized as JSON (``ConvertTo-Json``). Stateless and simple - the
PSRP upgrade path stays open if session reuse ever becomes a bottleneck.

Two hard rules:

* **No interpolation of raw user data.** Anything user-controlled reaching a
  script goes through :func:`ps_str`, which emits a PowerShell single-quoted
  literal (the only escape inside is doubling ``'``).
* **The SSRF allowlist applies.** Internal hosts must be allow-listed under
  Settings → Deployment (or ``DANBYTE_SSRF_ALLOWLIST``), exactly like the
  NetBox importer's targets; :func:`run_ps` checks before any socket opens
  and pins every request to the address it checked.
"""
from __future__ import annotations

import json
from urllib.parse import urlparse

from requests.exceptions import TooManyRedirects
from requests.utils import should_bypass_proxies

from core.ssrf import SSRFError, mount_pinned_adapter, pinned_url, resolve_public_ip


class WinRMError(RuntimeError):
    """A WinRM transport failure or a non-zero PowerShell exit."""


def ps_str(value: str) -> str:
    """Render ``value`` as a PowerShell single-quoted string literal."""
    return "'" + str(value).replace("'", "''") + "'"


def _session(conn, ip: str):
    """Build a ``winrm.Session`` for a WindowsServerConnection (no I/O yet),
    every request of which goes to ``ip``, the address the SSRF check passed."""
    import winrm

    scheme = "https" if conn.use_tls else "http"
    endpoint = f"{scheme}://{conn.host}:{conn.port}/wsman"
    password = (conn.credentials or {}).get("password", "")
    session = winrm.Session(
        endpoint,
        auth=(conn.username, password),
        transport=conn.auth_mode,
        server_cert_validation="validate" if conn.verify_ssl else "ignore",
        operation_timeout_sec=60,
        read_timeout_sec=70,
        # The URL carries the pinned address; the Kerberos service principal
        # is still the server's name.
        kerberos_hostname_override=conn.host,
    )
    # pywinrm sends through a plain requests.Session, which resolves the name
    # again on connect and follows redirects. Every message (the encryption
    # handshake included) passes through _send_message_request, so that is
    # where it is pinned to the checked address, with the Host header and TLS
    # verification kept on the name, and where redirects are refused before
    # the next hop is sent: a host that passes the check could otherwise
    # answer 307 and land the SOAP request on an internal address (#321).
    transport = session.protocol.transport
    send = transport._send_message_request

    def _send_pinned(http, prepared_request):
        http.max_redirects = 0
        url = prepared_request.url
        if urlparse(url).hostname != ip:
            pinned, host_header = pinned_url(url, ip)
            if http.trust_env and should_bypass_proxies(url, no_proxy=None):
                # NO_PROXY names hosts: an exempted host stays direct.
                http.proxies = {**http.proxies, "no_proxy": ip}
            prepared_request.url = pinned
            prepared_request.headers["Host"] = host_header
            mount_pinned_adapter(http, pinned, conn.host)
        return send(http, prepared_request)

    transport._send_message_request = _send_pinned
    return session


def run_ps(conn, script: str) -> str:
    """Run a PowerShell script on the connection's host, returning stdout.

    Raises :class:`WinRMError` on transport failures, auth failures, or a
    non-zero exit - with the remote stderr in the message so sync logs are
    actionable.
    """
    try:
        ip = resolve_public_ip(conn.host, conn.port)
    except SSRFError as exc:
        # Surface the allowlist guidance through the normal error channel so
        # test-connection and sync logs tell the operator exactly what to do.
        raise WinRMError(str(exc)) from exc
    try:
        result = _session(conn, ip).run_ps(script)
    except TooManyRedirects as exc:
        raise WinRMError(
            f"WinRM at {conn.host}:{conn.port} answered with a redirect. Danbyte does "
            "not follow redirects; point the connection at the WinRM endpoint itself."
        ) from exc
    except Exception as exc:  # winrm raises requests + protocol errors alike
        raise WinRMError(f"WinRM connection to {conn.host}:{conn.port} failed: {exc}") from exc
    if result.status_code != 0:
        err = (result.std_err or b"").decode("utf-8", "replace").strip()
        raise WinRMError(err or f"PowerShell exited {result.status_code}")
    return (result.std_out or b"").decode("utf-8", "replace")


def run_json(conn, script: str):
    """Run a script whose last expression is piped to ``ConvertTo-Json``.

    ``ConvertTo-Json`` emits a bare object (not a list) for single-element
    input; callers that expect lists should wrap with ``@(...)`` in the script.
    Empty output maps to ``None``.
    """
    out = run_ps(conn, script).strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise WinRMError(f"Remote output was not valid JSON: {out[:500]}") from exc
