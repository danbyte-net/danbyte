"""The ``zabbix`` check kind.

Registering a kind is what lets an operator target Zabbix with the machinery
they already use - a :class:`CheckTemplate`, a policy over a site or a role,
the same intervals and the same history. There is no separate "Zabbix
assignment" concept to learn, because there did not need to be one: this was
the answer to "how does a CheckState come to exist for Zabbix", and it was
sitting in the product already.

The checker itself never runs. A Zabbix check is answered in bulk by the
engine driver - one ``problem.get`` for a thousand hosts, not a thousand
probes - so ``run`` exists only to say so clearly if the core is ever handed
one. That happens when somebody assigns the template to a scope resolving to
the local engine, and ``unknown`` with a readable error is exactly right for
it: a misconfiguration must never look like an outage.
"""
from __future__ import annotations

from danbyte_checks.base import CheckOutcome, register

KIND = "zabbix"


@register
class ZabbixChecker:
    kind = KIND
    #: What the check-kind picker calls it. Without this the registry falls
    #: back to the slug and an operator picks "zabbix" from a list of things
    #: like "TLS certificate".
    label = "Zabbix"

    async def run(self, target, params, secret_params, timeout_ms):
        return CheckOutcome.unknown(
            "A Zabbix check is answered by a Zabbix engine. Bind this target's "
            "site or location to one, or use a different check kind.",
            target=target,
        )

    def validate_params(self, params: dict) -> None:
        """Nothing to configure. What Zabbix watches is configured in Zabbix -
        Danbyte reads the verdict, and a second place to set thresholds would
        be two sources of truth for one number."""
        return None
