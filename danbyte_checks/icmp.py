"""ICMP (ping) checker — async, unprivileged.

Uses ``icmplib`` in unprivileged mode (Linux ``SOCK_DGRAM`` ICMP) so it works
without ``cap_net_raw`` as long as ``net.ipv4.ping_group_range`` covers the
worker's gid. We never shell out to the ``ping`` binary — that breaks airgapped
batching and is far slower for prefix-wide fan-out (see ``multiping`` in the
dispatcher).

If the socket can't be opened at all (privilege/sysctl misconfig), that's an
internal error → ``unknown``, never ``down``.
"""
from __future__ import annotations

import asyncio

from icmplib import async_ping
from icmplib.exceptions import ICMPLibError, SocketPermissionError

from .base import CheckConfigError, CheckOutcome, register


@register
class IcmpChecker:
    kind = "icmp"

    def validate_params(self, params: dict) -> None:
        count = params.get("count", 2)
        if not isinstance(count, int) or not (1 <= count <= 10):
            raise CheckConfigError("'count' must be an integer between 1 and 10")

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        count = int(params.get("count", 2))
        timeout_s = max(timeout_ms / 1000, 0.1)
        try:
            host = await async_ping(
                target,
                count=count,
                interval=0.05,
                timeout=timeout_s,
                privileged=False,
            )
        except SocketPermissionError as e:
            # Can't open the ICMP socket — sysctl/privilege problem, not an
            # outage of the target.
            return CheckOutcome.unknown(f"icmp socket permission: {e}")
        except (ICMPLibError, OSError, asyncio.TimeoutError) as e:
            return CheckOutcome.unknown(f"icmp error: {e}")

        detail = {
            "packets_sent": host.packets_sent,
            "packets_received": host.packets_received,
            "packet_loss": host.packet_loss,
            "avg_rtt": host.avg_rtt,
            "min_rtt": host.min_rtt,
            "max_rtt": host.max_rtt,
        }
        if not host.is_alive:
            return CheckOutcome("down", None, detail)

        latency = host.avg_rtt
        # Degraded: reachable but slow / lossy. Advisory — the runner only keeps
        # it when the template enables degraded evaluation.
        threshold = params.get("latency_degraded_ms")
        loss_threshold = params.get("loss_degraded_pct")
        degraded = (threshold is not None and latency is not None and latency > threshold) or (
            loss_threshold is not None and host.packet_loss * 100 > loss_threshold
        )
        return CheckOutcome("degraded" if degraded else "up", latency, detail)
