"""The nmap engine for service scans (#451 B4), server side.

A second switch on the Discovery card, usable only when the server finds an
nmap the service user can execute: ``NMAP_BINARY`` when set, else ``nmap``
on PATH, looked up once per process. Danbyte never installs it, and a
deployment can forbid it (``DANBYTE_DISCOVERY_NMAP_ALLOWED=False``).

A profile picks the engine; the run re-checks, when it starts, that the
deployment allows nmap, the binary is still there, the tenant's switch is
on and the worker is not root. The argument list comes only from
``danbyte_checks.nmap.build_argv``; the results become the same observed
services as the built-in engine's, source ``nmap``.
"""
from __future__ import annotations

from functools import lru_cache

from django.conf import settings

#: Seconds nmap may spend on one address.
HOST_TIMEOUT = 300
#: The whole run: this much per address scanned in parallel, plus a minute.
RUN_CEILING = 5 * 3600


def allowed() -> bool:
    return bool(getattr(settings, "DISCOVERY_NMAP_ALLOWED", True))


@lru_cache(maxsize=1)
def _detect() -> tuple[str, str]:
    from danbyte_checks import nmap

    path = nmap.locate(getattr(settings, "NMAP_BINARY", "") or "")
    return (path, nmap.version(path)) if path else ("", "")


def detect(*, fresh: bool = False) -> tuple[str, str]:
    """``(path, version)`` of the nmap this process may run, or ``("", "")``.
    Looked up once per process (at the first ask); ``fresh`` looks again."""
    if fresh:
        _detect.cache_clear()
    return _detect()


def state() -> dict:
    """For the Discovery card: whether nmap can be switched on here, and
    what was found."""
    if not allowed():
        return {"available": False, "path": "", "version": "",
                "label": "Forbidden by the deployment",
                "reason": "DANBYTE_DISCOVERY_NMAP_ALLOWED is off for this deployment."}
    path, ver = detect()
    if not path or not ver:
        return {"available": False, "path": path, "version": ver, "label": "Not found",
                "reason": "No nmap the service user can run. Set NMAP_BINARY or install "
                          "nmap; Danbyte never installs it."}
    return {"available": True, "path": path, "version": ver,
            "label": f"nmap {ver} at {path}", "reason": ""}


def why_not(tenant) -> str:
    """Why a run cannot use nmap now; "" when it can."""
    import os

    from .models import DiscoverySettings

    s = state()
    if not s["available"]:
        return f"nmap: {s['label']}."
    if not DiscoverySettings.for_tenant(tenant).nmap_enabled:
        return "nmap is switched off in the Host discovery settings."
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return "Refusing to run nmap as root."
    return ""


def scanner(profile):
    """A ``(addresses, plan) -> [HostResult]`` that runs nmap for this
    profile, or raises when it may not."""
    from danbyte_checks import nmap

    reason = why_not(profile.tenant)
    if reason:
        raise nmap.NmapError(reason)
    path, _ver = detect()

    def run(addresses: list[str], plan: dict) -> list:
        argv = nmap.build_argv(
            path, addresses, plan["ports"],
            intensity=profile.nmap_version_intensity, timing=profile.nmap_timing,
            max_rate=plan["rate"], host_timeout=HOST_TIMEOUT,
            max_hostgroup=plan["hosts_parallel"])
        batches = -(-len(addresses) // max(1, plan["hosts_parallel"]))
        timeout = min(RUN_CEILING, 60 + HOST_TIMEOUT * batches)
        raw = nmap.run(argv, timeout=timeout)
        return nmap.parse_xml(raw, addresses)

    return run
