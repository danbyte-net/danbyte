"""UDP checker — best-effort.

Generic UDP "open" detection is unreliable: a silent port and an open one both
just don't answer. So:

* **probe configured** (``send`` + optional ``expect``): a matching reply →
  ``up``; a non-matching reply → ``degraded``; an ICMP port-unreachable →
  ``down``; no reply → ``unknown`` (could be open-and-silent or filtered).
* **no probe**: send an empty datagram; ICMP unreachable → ``down``; anything
  else → ``unknown``.

We never call a silent UDP port ``down`` without a probe — no-reply ≠ down.
On Linux a connected UDP socket surfaces the ICMP unreachable as
``ConnectionRefusedError`` on the next recv, which is how ``down`` is detected.
"""
from __future__ import annotations

import asyncio
import re
import socket
import time

from .base import CheckConfigError, CheckOutcome, register, require_port


@register
class UdpChecker:
    kind = "udp"

    def validate_params(self, params: dict) -> None:
        require_port(params)
        expect = params.get("expect")
        if expect is not None:
            try:
                re.compile(expect)
            except re.error as e:
                raise CheckConfigError(f"'expect' is not a valid regex: {e}") from None

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        port = require_port(params)
        send = params.get("send")
        expect = params.get("expect")
        timeout_s = max(timeout_ms / 1000, 0.1)
        probe = send.encode() if isinstance(send, str) else (send or b"")
        started = time.monotonic()

        loop = asyncio.get_running_loop()
        family = socket.AF_INET6 if ":" in target else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_DGRAM)
        sock.setblocking(False)
        try:
            await loop.sock_connect(sock, (target, port))
            await loop.sock_sendall(sock, probe)
            try:
                raw = await asyncio.wait_for(loop.sock_recv(sock, 1024), timeout=timeout_s)
            except asyncio.TimeoutError:
                # No reply — open-and-silent or filtered. Not an outage.
                return CheckOutcome.unknown(
                    "no reply (udp open|filtered)",
                    port=port,
                    probed=bool(send),
                )
            latency = (time.monotonic() - started) * 1000
            banner = raw.decode("utf-8", "replace")
            if expect is not None and not re.search(expect, banner):
                return CheckOutcome(
                    "degraded", latency, {"port": port, "reply": banner[:200], "expected": expect}
                )
            return CheckOutcome("up", latency, {"port": port, "reply": banner[:200]})
        except ConnectionRefusedError:
            # ICMP port-unreachable came back → genuinely closed.
            return CheckOutcome("down", None, {"port": port, "error": "port unreachable"})
        except OSError as e:
            return CheckOutcome.unknown(f"udp error: {e}", port=port)
        finally:
            sock.close()
