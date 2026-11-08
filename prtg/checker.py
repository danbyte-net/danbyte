"""The ``prtg`` check kind.

What a CheckTemplate, a policy or an assignment names to put PRTG's verdict on
a device into Danbyte's status, alerts and SLA - the same machinery as every
other check, nothing PRTG-specific to learn.

By default the check is the device's roll-up: the worst state over its active
sensors through the connection's map. ``sensor_type`` narrows it to sensors of
one PRTG type (``ping``, or the display name ``Ping v2``), ``sensor_tag`` to
sensors carrying one tag - "only the Ping sensor" is a check of its own.

The checker never runs. A PRTG check is answered in bulk by the engine driver
from the last status read, so ``run`` only says so if the core is ever handed
one - unknown with a readable reason, never down.
"""
from __future__ import annotations

from danbyte_checks.base import CheckConfigError, CheckOutcome, register

KIND = "prtg"
#: The params a PRTG check takes.
PARAMS = ("sensor_type", "sensor_tag")


@register
class PrtgChecker:
    kind = KIND
    label = "PRTG"

    async def run(self, target, params, secret_params, timeout_ms):
        return CheckOutcome.unknown(
            "A PRTG check is answered by a PRTG engine. Bind this target's "
            "site or location to one, or use a different check kind.",
            target=target,
        )

    def validate_params(self, params: dict) -> None:
        """The two narrowing params, each a short name. Thresholds are
        configured in PRTG - Danbyte reads its verdict."""
        for key in PARAMS:
            value = (params or {}).get(key)
            if value is None or value == "":
                continue
            if not isinstance(value, str) or len(value) > 128:
                raise CheckConfigError(f"{key} must be a name of at most 128 characters.")
