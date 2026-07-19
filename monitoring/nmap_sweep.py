"""nmap L3 host sweep (#84, Phase 4).

Shells out to ``nmap -sn`` (a ping sweep — no port scan, no root needed) to find
live hosts in a prefix, then seeds them as *discovered* IPAddresses. The output
parser is pure so it's unit-testable without the nmap binary; the runner fails
cleanly with ``NmapError`` when nmap isn't installed.
"""
from __future__ import annotations

import re
import shutil
import subprocess

from django.db import IntegrityError
from django.utils import timezone

from api.models import IPAddress
from .discovery import auto_discovered_status


class NmapError(Exception):
    """nmap is unavailable or the scan failed."""


_GREPABLE_HOST = re.compile(r"^Host:\s+(\S+)\b.*Status:\s+Up", re.MULTILINE)


def parse_nmap_grepable(text: str) -> list[str]:
    """Live IPs from ``nmap -oG -`` output (lines ``Host: <ip> (...) Status: Up``)."""
    return _GREPABLE_HOST.findall(text or "")


def nmap_ping_sweep(cidr: str, timeout: int = 120) -> list[str]:
    """Run ``nmap -sn -oG - <cidr>`` and return the live IPs."""
    if shutil.which("nmap") is None:
        raise NmapError("nmap is not installed on this host.")
    try:
        proc = subprocess.run(
            ["nmap", "-sn", "-n", "-oG", "-", cidr],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise NmapError(f"nmap scan of {cidr} timed out.")
    except Exception as e:  # noqa: BLE001
        raise NmapError(f"nmap failed: {e}")
    if proc.returncode != 0:
        raise NmapError(proc.stderr.strip() or "nmap returned an error.")
    return parse_nmap_grepable(proc.stdout)


def sweep_prefix(prefix, tenant) -> dict:
    """Ping-sweep ``prefix``'s CIDR and create any live hosts not already
    recorded as IPAddresses. Returns ``{found, created}``."""
    found = nmap_ping_sweep(prefix.cidr)
    # Dedupe within the prefix (so the (tenant, vrf, ip_address) identity is
    # respected — the same address in another VRF is a distinct host), matching
    # the ICMP discovery path.
    existing = set(
        IPAddress.objects.filter(prefix=prefix, ip_address__in=found)
        .values_list("ip_address", flat=True)
    )
    now = timezone.now()
    status = None  # created lazily only when there's a new IP to assign it to
    created = 0
    for ip in found:
        if ip in existing:
            continue
        if status is None:
            status = auto_discovered_status(tenant)
        try:
            IPAddress.objects.create(
                tenant=tenant, vrf=prefix.vrf, prefix=prefix, ip_address=ip,
                status=status, discovered=True, last_seen=now,
                description="Discovered by nmap sweep.",
            )
            created += 1
        except IntegrityError:
            # Raced with another creator (or a unique-constraint edge); skip.
            continue
    return {"found": len(found), "created": created}
