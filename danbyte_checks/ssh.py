"""SSH checker.

``up`` = TCP connect **and** authentication succeed (or, when a ``command`` is
configured, the command meets its exit-code / output criteria). Auth failure is
distinguished from connect failure: a refused/timed-out connection is ``down``
(the host is unreachable), while a reachable host that rejects the credentials
is ``degraded`` (it's up, the check just can't log in) — surfaced so a rotated
password doesn't read as an outage.

Credentials come from ``secret_params`` (encrypted at rest): ``username`` +
``password`` and/or ``private_key`` (PEM string). Host keys are not verified —
this is reachability monitoring, not a secure channel — which we note explicitly
rather than silently trusting.
"""
from __future__ import annotations

import asyncio
import re
import time

import asyncssh

from .base import CheckConfigError, CheckOutcome, register, require_port


@register
class SshChecker:
    kind = "ssh"

    def validate_params(self, params: dict) -> None:
        if "port" in params and params["port"] is not None:
            require_port(params)
        out_re = params.get("expected_output_regex")
        if out_re:
            try:
                re.compile(out_re)
            except re.error as e:
                raise CheckConfigError(f"'expected_output_regex' invalid: {e}") from None

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        port = int(params.get("port", 22))
        username = secret_params.get("username") or params.get("username")
        password = secret_params.get("password")
        client_key = secret_params.get("private_key")
        command = params.get("command")
        timeout_s = max(timeout_ms / 1000, 0.2)
        started = time.monotonic()

        conn_kwargs = {
            "port": port,
            "known_hosts": None,  # reachability check, not a trusted channel
        }
        # asyncssh rejects username=None; omit it to fall back to the local
        # user for a connect-only reachability probe.
        if username:
            conn_kwargs["username"] = username
        if password:
            conn_kwargs["password"] = password
        if client_key:
            try:
                conn_kwargs["client_keys"] = [asyncssh.import_private_key(client_key)]
            except (asyncssh.KeyImportError, ValueError) as e:
                return CheckOutcome.unknown(f"bad private_key: {e}")

        try:
            async with asyncio.timeout(timeout_s):
                async with asyncssh.connect(target, **conn_kwargs) as conn:
                    latency = (time.monotonic() - started) * 1000
                    if not command:
                        return CheckOutcome("up", latency, {"port": port, "auth": True})
                    result = await conn.run(command, check=False)
                    detail = {
                        "port": port,
                        "command": command,
                        "exit_status": result.exit_status,
                    }
                    ok = True
                    exp_code = params.get("expected_exit_code")
                    if exp_code is not None and result.exit_status != int(exp_code):
                        ok = False
                    out_re = params.get("expected_output_regex")
                    if ok and out_re:
                        ok = re.search(out_re, result.stdout or "") is not None
                        if not ok:
                            detail["output_mismatch"] = out_re
                    return CheckOutcome("up" if ok else "degraded", latency, detail)
        except asyncssh.PermissionDenied as e:
            # Reachable but auth rejected → degraded, not down.
            return CheckOutcome(
                "degraded", None, {"port": port, "auth": False, "error": str(e)}
            )
        except (OSError, asyncssh.Error, asyncio.TimeoutError) as e:
            return CheckOutcome("down", None, {"port": port, "error": str(e) or type(e).__name__})
        except Exception as e:  # noqa: BLE001 — config/internal issue → unknown
            return CheckOutcome.unknown(f"ssh error: {e}", port=port)
