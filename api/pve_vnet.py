"""Proxmox SDN VNet ids: at most 8 characters, a lowercase letter first, then
lowercase letters and digits."""
from __future__ import annotations

import re

from django.core.exceptions import ValidationError

VNET_ID_RE = re.compile(r"^[a-z][a-z0-9]{0,7}$")


def is_pve_vnet(value: str) -> bool:
    return bool(VNET_ID_RE.match(value or ""))


def validate_pve_vnet(value: str) -> None:
    if value and not is_pve_vnet(value):
        raise ValidationError(
            "A VNet id is 1-8 characters: a lowercase letter, then lowercase "
            "letters or digits."
        )
