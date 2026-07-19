"""TCP port checker.

Success = a completed TCP handshake (``asyncio.open_connection``) within the
timeout. Optionally sends a probe and/or matches an expected banner: if the
connection opens but the banner doesn't match, the target is reachable but
mis-serving → ``degraded``.

Connection refused / timed out → ``down`` (genuine reachability failure).
Anything internal (bad params already validated, unexpected error) → ``unknown``.
"""
from __future__ import annotations

import asyncio
import re
import time

from .base import CheckConfigError, CheckOutcome, register, require_port


@register
class TcpChecker:
    kind = "tcp"

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
        timeout_s = max(timeout_ms / 1000, 0.05)
        send = params.get("send")
        expect = params.get("expect")
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
            if expect is not None:
                remaining = max(timeout_s - (time.monotonic() - started), 0.05)
                raw = await asyncio.wait_for(reader.read(512), timeout=remaining)
                banner = raw.decode("utf-8", "replace")
                if not re.search(expect, banner):
                    return CheckOutcome(
                        "degraded",
                        latency,
                        {"port": port, "banner": banner[:200], "expected": expect},
                    )

            detail = {"port": port}
            if banner is not None:
                detail["banner"] = banner[:200]
            return CheckOutcome("up", latency, detail)
        except (ConnectionRefusedError, asyncio.TimeoutError, OSError) as e:
            return CheckOutcome("down", None, {"port": port, "error": str(e) or type(e).__name__})
        except Exception as e:  # noqa: BLE001 — unexpected → unknown, never down
            return CheckOutcome.unknown(f"tcp error: {e}", port=port)
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except (OSError, asyncio.TimeoutError):
                    pass
