"""Reverse DNS (PTR), shared by the core and the Outpost agent.

Not a check kind - nothing here reports up/down. It answers "what is this
address called", which both sides need and neither should implement twice.

**Why the Outpost needs its own copy of this.** PTR is the one lookup whose
right answer depends on *where you ask from*. A branch-office Outpost can
usually reach that branch's DNS; the core server often cannot, and on a
split-horizon network it may get a confidently wrong answer instead of none.
Running the lookup next to the target is the only way to get the view the
operator actually means.

Two modes, deliberately:

* **No resolvers** - the host's own resolver, via the standard library. Costs
  no dependency, and is the sensible default for an Outpost, whose machine
  usually already resolves its own site correctly.
* **Explicit resolvers** - asked directly, which needs ``dnspython``. Imported
  lazily so an agent that never configures resolvers never needs the package.

Servers are tried in order. NXDOMAIN is an *answer*, so the search stops there
rather than shopping around for a better one; only a transport failure advances
to the next server. It never silently falls back to the host resolver - a
setting that quietly ignores itself is worse than no setting, because the names
it produces look right while coming from the wrong place.
"""
from __future__ import annotations

import asyncio
import socket


class ReverseDNSUnavailable(RuntimeError):
    """Explicit resolvers were asked for but dnspython isn't installed."""


def split_resolver(entry: str) -> tuple[str, int]:
    """``10.0.0.45`` or ``10.0.0.45:5353`` -> ``(host, port)``.

    IPv6 needs brackets to be unambiguous, since a bare address is all colons.
    """
    entry = (entry or "").strip()
    if entry.startswith("["):
        host, _, rest = entry[1:].partition("]")
        port = rest.lstrip(":")
        return host, int(port) if port else 53
    host, sep, port = entry.rpartition(":")
    if sep and port.isdigit() and ":" not in host:
        return host, int(port)
    return entry, 53


def _ptr_sockaddr(addr: str):
    return (addr, 0, 0, 0) if ":" in addr else (addr, 0)


async def _via_system(addresses, concurrency: int, timeout: float) -> dict:
    loop = asyncio.get_running_loop()
    sem = asyncio.Semaphore(concurrency)

    async def one(addr: str):
        async with sem:
            try:
                host, _ = await asyncio.wait_for(
                    loop.getnameinfo(_ptr_sockaddr(addr), socket.NI_NAMEREQD),
                    timeout=timeout,
                )
                return addr, host
            except (socket.gaierror, OSError, asyncio.TimeoutError):
                return addr, None

    return dict(await asyncio.gather(*(one(a) for a in addresses)))


async def _via_resolvers(addresses, resolvers, concurrency, timeout) -> dict:
    try:
        import dns.asyncresolver
        import dns.resolver
        import dns.reversename
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise ReverseDNSUnavailable(
            "Reverse DNS with explicit nameservers needs dnspython. Install it, "
            "or clear the resolver list to use this host's own resolver."
        ) from exc

    parsed = [split_resolver(r) for r in resolvers]
    res = dns.asyncresolver.Resolver(configure=False)
    res.nameservers = [h for h, _ in parsed]
    ports = {h: p for h, p in parsed}
    if any(p != 53 for p in ports.values()):
        res.nameserver_ports = ports
    res.timeout, res.lifetime = timeout, timeout * 2
    sem = asyncio.Semaphore(concurrency)

    async def one(addr: str):
        async with sem:
            try:
                answer = await res.resolve(dns.reversename.from_address(addr), "PTR")
                return addr, str(answer[0]).rstrip(".")
            except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
                return addr, None  # an answer: this address has no PTR
            except Exception:  # noqa: BLE001 - timeouts, refusals, bad config
                return addr, None

    return dict(await asyncio.gather(*(one(a) for a in addresses)))


async def resolve_ptrs(
    addresses,
    resolvers=(),
    *,
    concurrency: int = 100,
    timeout: float = 3.0,
) -> dict:
    """``{address: hostname or None}``.

    ``None`` means "looked, found nothing" - callers must not confuse it with
    "didn't look", which is why the Outpost protocol keys on the *presence* of
    the field rather than its value.
    """
    addresses = list(addresses)
    if not addresses:
        return {}
    resolvers = [r for r in (resolvers or ()) if str(r).strip()]
    if resolvers:
        return await _via_resolvers(addresses, resolvers, concurrency, timeout)
    return await _via_system(addresses, concurrency, timeout)


def resolve_ptr(addr: str, resolvers=(), *, timeout: float = 3.0):
    """One address, synchronously - the shape an agent's check loop wants."""
    return asyncio.run(
        resolve_ptrs([addr], resolvers, concurrency=1, timeout=timeout)
    ).get(addr)
