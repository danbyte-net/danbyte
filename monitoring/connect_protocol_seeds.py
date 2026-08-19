"""Built-in Connect protocols, seeded per tenant.

A fresh tenant starts with a small, **editable** catalog of the common device
access methods (SSH, Telnet, RDP, HTTP/S) so the device Connect menu is useful on
day one. These are launch-URL templates the browser hands to the OS protocol
handler - not a fixed enum: an operator renames, edits, disables, or deletes them
and adds their own custom schemes freely. Seeded like the built-in IP roles:
``bootstrap`` and ``TenantViewSet.perform_create`` call
:func:`seed_builtin_connect_protocols`, and a data migration backfills tenants
that predate it. Idempotent (keyed on ``name``).
"""
from __future__ import annotations

# (name, url_template, icon, default_port, weight)
BUILTIN_CONNECT_PROTOCOLS = [
    ("SSH", "ssh://{username}@{host}", "terminal", 22, 10),
    ("Telnet", "telnet://{host}", "terminal", 23, 20),
    ("RDP", "rdp://{host}", "monitor", 3389, 30),
    ("HTTPS", "https://{host}", "globe", 443, 40),
    ("HTTP", "http://{host}", "globe", 80, 50),
]


def seed_builtin_connect_protocols(tenant) -> int:
    """Idempotently create the built-in Connect protocols for ``tenant``.
    Returns the count of newly created rows."""
    from monitoring.models import ConnectProtocol

    created = 0
    for name, template, icon, port, weight in BUILTIN_CONNECT_PROTOCOLS:
        _, was_created = ConnectProtocol.objects.get_or_create(
            tenant=tenant,
            name=name,
            defaults={
                "url_template": template,
                "icon": icon,
                "default_port": port,
                "weight": weight,
            },
        )
        created += int(was_created)
    return created
