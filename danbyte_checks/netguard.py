"""Target-address policy for the check engine (SSRF guard).

The same checkers run in two places:

* on a **remote outpost agent**, deployed *inside* a customer's network to
  monitor local and internal hosts — reaching loopback / RFC1918 there is the
  whole point, and
* in the **central Danbyte server**, where a tenant-defined check target that
  points at ``127.0.0.1`` or an RFC1918 neighbour is an SSRF vector: the check
  result (status code, body-regex match) is an oracle onto internal services.

So the policy can't be hard-coded. This module keeps a process-wide policy that
**defaults to permissive** (the outpost's needs, and backward-compatible for
existing agents that never call :func:`configure`). The central process opts
into a stricter policy at startup via :func:`configure` — see
``monitoring/apps.py``.

The cloud-metadata endpoint (link-local ``169.254.0.0/16`` / ``fe80::/10``) and
the unspecified address are **always** refused: they are never a legitimate
monitoring target anywhere, and metadata is the top SSRF prize on a cloud host.
"""
from __future__ import annotations

import ipaddress

# Process-wide policy. Permissive by default (outpost semantics).
_BLOCK_INTERNAL = False
_ALLOWLIST: list[ipaddress._BaseNetwork] = []


def configure(*, block_internal: bool, allowlist: list[str] | None = None) -> None:
    """Set the process policy. Call once at startup.

    ``block_internal`` — also refuse loopback / private (RFC1918 + ULA) /
    reserved targets (the central-server posture). ``allowlist`` — CIDRs/IPs
    whose resolved addresses are permitted even when ``block_internal`` is on
    (e.g. an on-prem automation runner the operator explicitly trusts).
    """
    global _BLOCK_INTERNAL, _ALLOWLIST
    _BLOCK_INTERNAL = bool(block_internal)
    nets: list[ipaddress._BaseNetwork] = []
    for entry in allowlist or []:
        entry = entry.strip()
        if not entry:
            continue
        try:
            nets.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue  # ignore malformed entries rather than fail startup
    _ALLOWLIST = nets


def _allowlisted(addr: ipaddress._BaseAddress) -> bool:
    return any(addr in net for net in _ALLOWLIST)


def address_blocked(addr: ipaddress._BaseAddress) -> bool:
    """Whether a resolved IP is refused under the current policy."""
    if _allowlisted(addr):
        return False
    # Never-legitimate ranges, blocked regardless of policy.
    if addr.is_link_local or addr.is_unspecified:
        return True
    if not _BLOCK_INTERNAL:
        return False
    # Central-server posture: also refuse internal / non-global ranges.
    return bool(
        addr.is_loopback
        or addr.is_private
        or addr.is_reserved
        or addr.is_multicast
    )


def target_blocked(target: str) -> bool:
    """Whether a check target (an IP literal) is refused.

    Non-literal targets (hostnames) return ``False`` here — checks are attached
    to ``IPAddress`` objects, so the target is normally a literal; callers that
    accept hostnames should resolve first and re-check each address.
    """
    try:
        addr = ipaddress.ip_address(target)
    except ValueError:
        return False
    return address_blocked(addr)
