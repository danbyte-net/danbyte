"""Checker registry for the core.

The protocol checkers live in the standalone, Django-free **danbyte_checks**
package (shared verbatim with the Outpost agent — no drift). This module
re-exports that registry and adds the one Django-coupled checker, ``exec``
(gated by ``settings.MONITORING_EXEC_ENABLED``), which can't live in the pure
package. Everything importing ``monitoring.checkers`` keeps working unchanged.
"""
from __future__ import annotations

from danbyte_checks import (  # noqa: F401
    CHECKER_REGISTRY,
    CheckConfigError,
    Checker,
    CheckOutcome,
    get_checker,
    register,
)

# Registers the Django-coupled exec checker into the shared registry.
from . import exec as _exec  # noqa: E402,F401  (module name shadows builtin)

__all__ = [
    "CHECKER_REGISTRY",
    "CheckConfigError",
    "Checker",
    "CheckOutcome",
    "get_checker",
    "register",
]
