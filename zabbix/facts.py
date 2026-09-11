"""What Zabbix knows about a device, offered to the drift inbox (#162).

Danbyte can walk SNMP itself, and a direct walk is better evidence than a
second-hand account of one - so this is not a rival to the poller. It is for
the devices Danbyte *cannot* poll: a site the core has no route to, kit whose
credentials live in Zabbix and are not going to be copied out. That is the
reason a Zabbix engine exists in the first place, and those devices had no
observed state at all before this.

Costs nothing. The inventory rides the ``host.get`` the provisioning pass
already makes, so recording it adds no call, no round trip and no schedule.
"""
from __future__ import annotations

from django.utils import timezone

from .models import ZabbixHostFacts

#: Zabbix host-inventory field → the key the drift engine reads it under.
#: ``serialno_a`` is the one that earns this feature: Zabbix templates fill it
#: automatically, and a device record with a blank serial is the norm.
_INVENTORY = {
    "serialno_a": "serial",
    "model": "model",
    "vendor": "vendor",
    "os": "os",
    "location": "location",
    "hardware": "hardware",
}


def facts_from_host(host: dict) -> dict:
    """The observation a Zabbix host row amounts to.

    The *visible* name, not the technical one: it is what an operator sees in
    Zabbix, so it is what they mean when they say the two disagree.
    """
    inventory = host.get("inventory") or {}
    data = {"sys_name": (host.get("name") or host.get("host") or "").strip()}
    for source, key in _INVENTORY.items():
        value = str(inventory.get(source) or "").strip()
        if value:
            data[key] = value
    return {k: v for k, v in data.items() if v}


def record(conn, device, host, now=None) -> None:
    """Store what this host says about the device. Never touches the device."""
    now = now or timezone.now()
    ZabbixHostFacts.objects.update_or_create(
        connection=conn,
        device=device,
        defaults={
            "tenant": conn.tenant,
            "data": facts_from_host(host),
            "polled_at": now,
            # Zabbix's own switch: a host somebody disabled is not being
            # watched, so what it last said is not an observation of now.
            "reachable": str(host.get("status")) != "1",
        },
    )


def forget(conn, device) -> None:
    ZabbixHostFacts.objects.filter(connection=conn, device=device).delete()


def observed_state(device, tenant):
    """The drift engine's loader: a state-shaped row, or None.

    Newest first, and only from a connection still asking for it - turning the
    switch off stops the opinions, it does not leave the last ones standing
    forever.
    """
    return (
        ZabbixHostFacts.objects.filter(
            device=device, tenant=tenant, connection__read_inventory=True,
            connection__enabled=True,
        )
        .order_by("-polled_at")
        .first()
    )
