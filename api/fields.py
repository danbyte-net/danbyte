"""Model fields shared by the IPAM models."""

from __future__ import annotations

import ipaddress

from django.db import models


def split_host_mask(value):
    """``'10.0.0.5/24'`` -> ``('10.0.0.5', 24)``.

    A value without a mask, or one that does not parse as ``address/length``,
    comes back unchanged with ``None``: the column's own validation, or
    PostgreSQL, still gets to reject it.
    """
    if value is None:
        return value, None
    text = str(value).strip()
    if "/" not in text:
        return value, None
    try:
        iface = ipaddress.ip_interface(text)
    except ValueError:
        return value, None
    return str(iface.ip), iface.network.prefixlen


class HostAddressField(models.GenericIPAddressField):
    """An ``inet`` column that only ever stores a bare host address.

    PostgreSQL's ``inet`` keeps a mask when it is given one (``10.0.0.5/24``)
    and reads it back the same way, while Django checks the value only in
    ``full_clean()``. An ORM ``create()``, ``bulk_create()`` or ``update()``
    from a shell, a trusted script or a sync could therefore store an address
    that every ``ipaddress.ip_address()`` reading it rejects. The mask is
    dropped here, on the way to the database, so no write path can store one.
    ``IPAddress.save()`` moves the length to ``mask_length`` before that.

    A row stored with a mask before this field existed, and left so because
    its bare form was already taken (api 0185 reports those), reads back as
    the bare host too, so code parsing the value does not fail on it.
    """

    def get_prep_value(self, value):
        return super().get_prep_value(split_host_mask(value)[0])

    def from_db_value(self, value, expression, connection):
        if value is None or "/" not in value:
            return value
        return split_host_mask(value)[0]
