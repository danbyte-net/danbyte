"""Example plugin monitoring check kind.

Demonstrates that a plugin can register a check kind into the shared checker
registry (``danbyte_checks``) so it validates through the API and runs via the
core runner and the Outposts — no core changes. Importing this module registers
the checker (the ``@register`` side effect).
"""
from __future__ import annotations

from danbyte_checks.base import CheckConfigError, CheckOutcome, register


@register
class ExamplePingChecker:
    kind = "example_ping"

    def validate_params(self, params: dict) -> None:
        # Optional integer "latency_ms" for the reported latency.
        v = params.get("latency_ms", 1)
        if not isinstance(v, (int, float)) or v < 0:
            raise CheckConfigError("latency_ms must be a non-negative number")

    async def run(
        self,
        target: str,
        params: dict,
        secret_params: dict,
        timeout_ms: int,
    ) -> CheckOutcome:
        # A trivial always-up probe (the reference kind isn't a real protocol).
        return CheckOutcome("up", latency_ms=float(params.get("latency_ms", 1)))
