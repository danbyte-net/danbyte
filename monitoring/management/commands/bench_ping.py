"""Benchmark the ICMP fan-out — prove a large prefix sweeps fast.

Pings a synthetic block of addresses (default the reserved, non-responsive
240.0.0.0/24 so nothing actually replies — the worst case, every host timing
out) with one async_multiping call, and reports throughput. Use it to size
MONITORING_CONCURRENCY / shard count for a real /15.

    manage.py bench_ping --count-hosts 4096 --timeout-ms 500 --concurrency 1024
"""
from __future__ import annotations

import asyncio
import ipaddress
import time

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Benchmark icmplib async_multiping throughput for large fan-outs."

    def add_arguments(self, parser):
        parser.add_argument("--base", default="240.0.0.0", help="First address.")
        parser.add_argument("--count-hosts", type=int, default=4096)
        parser.add_argument("--timeout-ms", type=int, default=500)
        parser.add_argument("--concurrency", type=int, default=1024)
        parser.add_argument("--pings", type=int, default=1, help="Packets per host.")

    def handle(self, *args, **opts):
        from icmplib import async_multiping

        start_int = int(ipaddress.ip_address(opts["base"]))
        addresses = [
            str(ipaddress.ip_address(start_int + i)) for i in range(opts["count_hosts"])
        ]
        timeout_s = max(opts["timeout_ms"] / 1000, 0.1)

        async def _run():
            return await async_multiping(
                addresses,
                count=opts["pings"],
                interval=0.05,
                timeout=timeout_s,
                concurrent_tasks=opts["concurrency"],
                privileged=False,
            )

        t0 = time.monotonic()
        hosts = asyncio.run(_run())
        elapsed = time.monotonic() - t0

        alive = sum(1 for h in hosts if h.is_alive)
        n = len(addresses)
        rate = n / elapsed if elapsed else 0
        self.stdout.write(
            self.style.SUCCESS(
                f"pinged {n} hosts in {elapsed:.2f}s "
                f"({rate:,.0f} hosts/s, {alive} alive, concurrency={opts['concurrency']})"
            )
        )
        # Extrapolate to common large prefixes at this rate.
        for masklen, label in ((16, "/16"), (15, "/15"), (14, "/14")):
            hosts_in = 2 ** (32 - masklen)
            self.stdout.write(
                f"  projected {label} ({hosts_in:,} hosts): "
                f"{hosts_in / rate:.1f}s in one job; "
                f"{hosts_in / rate / 8:.1f}s sharded across 8 workers"
                if rate
                else "  (no rate)"
            )
