"""ICMP prefix sweep — the discovery primitive, shared by the core and a remote
Outpost. Enumerates a CIDR's hosts and ICMP-sweeps them (sharded), returning the
addresses that answered. ORM-free (only ``icmplib``), so an Outpost runs the same
sweep the core does.
"""
from __future__ import annotations

import asyncio
import ipaddress

# A prefix bigger than this many hosts is skipped here (the caller decides how to
# handle large blocks — the core has a size gate before it ever hands one over).
MAX_HOSTS = 8192
SHARD = 512


async def _multiping(addresses: list[str], timeout_ms: int):
    from icmplib import async_multiping

    return await async_multiping(
        addresses,
        count=1,
        interval=0.05,
        timeout=max(timeout_ms / 1000, 0.1),
        privileged=False,
    )


def sweep_cidr(cidr: str, timeout_ms: int = 1000, max_hosts: int = MAX_HOSTS) -> list[str]:
    """ICMP-sweep every host in ``cidr`` → the alive addresses (sharded). Returns
    ``[]`` for an unparseable CIDR or one larger than ``max_hosts``."""
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return []
    hosts = [str(h) for h in net.hosts()]
    if not hosts or len(hosts) > max_hosts:
        return []
    alive: list[str] = []
    for i in range(0, len(hosts), SHARD):
        shard = hosts[i : i + SHARD]
        try:
            results = asyncio.run(_multiping(shard, timeout_ms))
        except Exception:  # a failed shard must not abort the rest
            continue
        alive.extend(h.address for h in results if h.is_alive)
    return alive
