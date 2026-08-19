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
  NetBox importer's targets; :func:`connect` checks before any socket opens.
"""
from __future__ import annotations

import json

from core.ssrf import SSRFError, assert_public_host


class WinRMError(RuntimeError):
    """A WinRM transport failure or a non-zero PowerShell exit."""


def ps_str(value: str) -> str:
    """Render ``value`` as a PowerShell single-quoted string literal."""
    return "'" + str(value).replace("'", "''") + "'"


def _session(conn):
    """Build a ``winrm.Session`` for a WindowsServerConnection (no I/O yet)."""
    import winrm

    scheme = "https" if conn.use_tls else "http"
    endpoint = f"{scheme}://{conn.host}:{conn.port}/wsman"
    password = (conn.credentials or {}).get("password", "")
    return winrm.Session(
        endpoint,
        auth=(conn.username, password),
        transport=conn.auth_mode,
        server_cert_validation="validate" if conn.verify_ssl else "ignore",
        operation_timeout_sec=60,
        read_timeout_sec=70,
    )


def run_ps(conn, script: str) -> str:
    """Run a PowerShell script on the connection's host, returning stdout.

    Raises :class:`WinRMError` on transport failures, auth failures, or a
    non-zero exit - with the remote stderr in the message so sync logs are
    actionable.
    """
    try:
        assert_public_host(conn.host, conn.port)
    except SSRFError as exc:
        # Surface the allowlist guidance through the normal error channel so
        # test-connection and sync logs tell the operator exactly what to do.
        raise WinRMError(str(exc)) from exc
    try:
        result = _session(conn).run_ps(script)
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
