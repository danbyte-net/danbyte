"""danbyte-checks — the protocol check engine, standalone and Django-free.

One shared implementation of every check kind (ICMP/TCP/UDP/HTTP/SNMP/SSH/
Telnet), so a check gives identical results whether it runs on the Danbyte core
or on a remote **Outpost** — no drift. Each checker's
``run(target, params, secret_params, timeout_ms) -> CheckOutcome`` takes plain
values (no ORM), so this package has zero Danbyte/Django dependencies.

The core registers one extra, Django-coupled checker (``exec``) on top of this
registry; see ``monitoring/checkers``.
"""
from __future__ import annotations

from .base import (
    CHECKER_REGISTRY,
    CheckConfigError,
    Checker,
    CheckOutcome,
    get_checker,
    register,
)

# Importing each module runs its @register side effect.
from . import icmp  # noqa: E402,F401
from . import tcp  # noqa: E402,F401
from . import http  # noqa: E402,F401
from . import udp  # noqa: E402,F401
from . import ssh  # noqa: E402,F401
from . import snmp  # noqa: E402,F401
from . import telnet  # noqa: E402,F401

__version__ = "0.1.0"

__all__ = [
    "CHECKER_REGISTRY",
    "CheckConfigError",
    "Checker",
    "CheckOutcome",
    "get_checker",
    "register",
]
