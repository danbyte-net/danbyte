"""HTTP(S) checker.

Connects to the **assigned IP** (never an arbitrary hostname — that's the SSRF
guard: the target is fixed by the assignment, the user only chooses scheme /
port / path). ``up`` when the response status is in ``expected_status`` (and the
optional body regex matches); ``degraded`` when reachable but those criteria
fail; ``down`` on a connection/timeout failure.

An optional ``host_header`` sets the ``Host:`` (and TLS SNI via the URL) for
name-based vhosts while still dialing the IP.
"""
from __future__ import annotations

import re

import httpx

from . import netguard
from .base import CheckConfigError, CheckOutcome, register, require_port

_DEFAULT_PORTS = {"http": 80, "https": 443}


@register
class HttpChecker:
    kind = "http"

    def validate_params(self, params: dict) -> None:
        scheme = params.get("scheme", "http")
        if scheme not in ("http", "https"):
            raise CheckConfigError("'scheme' must be 'http' or 'https'")
        if "port" in params and params["port"] is not None:
            require_port(params)
        body_re = params.get("expected_body_regex")
        if body_re:
            try:
                re.compile(body_re)
            except re.error as e:
                raise CheckConfigError(f"'expected_body_regex' invalid: {e}") from None
        codes = params.get("expected_status")
        if codes is not None and not isinstance(codes, (list, tuple)):
            raise CheckConfigError("'expected_status' must be a list of status codes")

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        scheme = params.get("scheme", "http")
        port = params.get("port") or _DEFAULT_PORTS[scheme]
        path = params.get("path", "/")
        if not path.startswith("/"):
            path = "/" + path
        method = (params.get("method") or "GET").upper()
        verify_tls = bool(params.get("verify_tls", True))
        expected = set(params.get("expected_status") or [200])
        body_re = params.get("expected_body_regex")
        host_header = params.get("host_header")

        # SSRF guard (policy in danbyte_checks/netguard.py): the cloud metadata
        # endpoint + unspecified address are always refused; a central Danbyte
        # server additionally refuses loopback/RFC1918/reserved (a tenant-defined
        # check would otherwise be a content oracle onto internal services). An
        # outpost agent keeps the permissive default so on-prem monitoring works.
        if netguard.target_blocked(target):
            return CheckOutcome(
                "down", None,
                {"url": f"{scheme}://{target}:{port}{path}",
                 "error": "target address not permitted"},
            )

        # Bracket IPv6 literals for the URL authority.
        authority = f"[{target}]" if ":" in target else target
        url = f"{scheme}://{authority}:{port}{path}"
        headers = {"Host": host_header} if host_header else {}
        timeout_s = max(timeout_ms / 1000, 0.1)

        try:
            async with httpx.AsyncClient(
                verify=verify_tls, timeout=timeout_s, follow_redirects=False
            ) as client:
                resp = await client.request(method, url, headers=headers)
        except httpx.TimeoutException:
            return CheckOutcome("down", None, {"url": url, "error": "timeout"})
        except httpx.HTTPError as e:
            return CheckOutcome("down", None, {"url": url, "error": str(e) or type(e).__name__})

        latency = resp.elapsed.total_seconds() * 1000
        detail = {"url": url, "status_code": resp.status_code, "reason": resp.reason_phrase}

        ok = resp.status_code in expected
        if ok and body_re:
            ok = re.search(body_re, resp.text) is not None
            if not ok:
                detail["body_mismatch"] = body_re
        if not ok:
            detail["expected_status"] = sorted(expected)
            # Reachable but wrong → degraded (the server answered, just not as
            # required); the runner downgrades to 'up' if degraded is disabled.
            return CheckOutcome("degraded", latency, detail)
        return CheckOutcome("up", latency, detail)
