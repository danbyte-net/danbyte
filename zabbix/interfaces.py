"""What Zabbix can reach a host on.

Zabbix tracks availability **per interface type** - agent, SNMP, IPMI, JMX -
and records why when it cannot. That is a different question from "is the host
up": a host with no open problems reads healthy while its SNMP interface polls
nothing, because the community is wrong or absent. Danbyte's own status cannot
see that, and Zabbix's answer is already in the host read the status came from.

Kept out of ``driver.py`` because it is a pure shape translation, and the enum
is Zabbix's rather than ours.
"""
from __future__ import annotations

#: Zabbix interface type -> the name an operator reads on the host list.
TYPES = {"1": "agent", "2": "snmp", "3": "ipmi", "4": "jmx"}

#: Zabbix's ``available``. 0 is not a failure - it means nothing has polled the
#: interface yet, which reads grey rather than red.
STATES = {"0": "unknown", "1": "up", "2": "down"}


def availability(host) -> dict:
    """``{"snmp": {"state": "down", "error": "..."}}`` for one host row.

    Worst per type wins: a host with two SNMP interfaces where one is failing
    has an SNMP problem, and reporting the healthy one would hide it.
    """
    rank = {"up": 0, "unknown": 1, "down": 2}
    out: dict = {}
    for iface in host.get("interfaces") or []:
        name = TYPES.get(str(iface.get("type")))
        if name is None:
            continue
        state = STATES.get(str(iface.get("available")), "unknown")
        current = out.get(name)
        if current is not None and rank[current["state"]] >= rank[state]:
            continue
        entry = {"state": state}
        error = (iface.get("error") or "").strip()
        if error:
            # Zabbix's own words. It is usually the whole diagnosis.
            entry["error"] = error[:300]
        out[name] = entry
    return out
