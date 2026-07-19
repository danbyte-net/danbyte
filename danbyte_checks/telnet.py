"""Telnet checker — raw asyncio socket.

``telnetlib`` was removed in Python 3.13 (PEP 594), so this is a minimal check
over a plain asyncio connection: TCP connect to port 23 (default) plus an
optional banner read / send+expect. It strips Telnet IAC negotiation bytes from
the banner so an expected-string match works against the visible text.

Reachable but banner mismatch → ``degraded``; connect refused/timeout → ``down``.
"""
from __future__ import annotations

import asyncio
import re
import time

from .base import CheckConfigError, CheckOutcome, register


def _strip_iac(raw: bytes) -> str:
    """Drop Telnet IAC (0xFF) command triples so the human-readable banner
    survives. Crude but enough for a banner match."""
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0xFF:
            i += 3  # IAC + command + option
            continue
        out.append(raw[i])
        i += 1
    return out.decode("utf-8", "replace")


@register
class TelnetChecker:
    kind = "telnet"

    def validate_params(self, params: dict) -> None:
        expect = params.get("expect")
        if expect is not None:
            try:
                re.compile(expect)
            except re.error as e:
                raise CheckConfigError(f"'expect' is not a valid regex: {e}") from None

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        port = int(params.get("port", 23))
        send = params.get("send")
        expect = params.get("expect")
        timeout_s = max(timeout_ms / 1000, 0.1)
        started = time.monotonic()

        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(target, port), timeout=timeout_s
            )
            latency = (time.monotonic() - started) * 1000
            banner = None
            if send is not None:
                writer.write(send.encode() if isinstance(send, str) else send)
                await writer.drain()
            if expect is not None or send is not None:
                remaining = max(timeout_s - (time.monotonic() - started), 0.05)
                try:
                    raw = await asyncio.wait_for(reader.read(512), timeout=remaining)
                    banner = _strip_iac(raw)
                except asyncio.TimeoutError:
                    banner = ""
            if expect is not None and not re.search(expect, banner or ""):
                return CheckOutcome(
                    "degraded",
                    latency,
                    {"port": port, "banner": (banner or "")[:200], "expected": expect},
                )
            detail = {"port": port}
            if banner:
                detail["banner"] = banner[:200]
            return CheckOutcome("up", latency, detail)
        except (ConnectionRefusedError, asyncio.TimeoutError, OSError) as e:
            return CheckOutcome("down", None, {"port": port, "error": str(e) or type(e).__name__})
        except Exception as e:  # noqa: BLE001
            return CheckOutcome.unknown(f"telnet error: {e}", port=port)
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except (OSError, asyncio.TimeoutError):
                    pass
