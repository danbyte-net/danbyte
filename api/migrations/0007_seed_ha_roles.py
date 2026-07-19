"""Seed Active / Standby / Virtual default roles, restore Gateway's arrow.

  * Active — physical interface currently forwarding (HSRP active, VRRP
    master, or one half of an active/active pair). Amber, ``crown`` icon.
  * Standby — physical interface in backup state (HSRP standby, VRRP
    backup). Amber, ``crown-off`` icon. Not used in active/active.
  * Virtual — the shared VIP that clients reach. Whatever the protocol
    (HSRP/VRRP/GLBP/CARP), this is the gateway your hosts target.
    Emerald, ``crown`` icon, ``is_gateway=True``, ``is_virtual=True``.
  * Gateway — keep its semantics, restore the right-arrow icon since the
    crown reads as "leader of a group" and Gateway is the *no-group* case.

Idempotent: existing rows are left alone (we look up by slug). Only the
Gateway icon is forcibly normalised back to ``arrow-right`` because the
prior diagnostic that set it to ``crown`` muddied the meaning.
"""
from __future__ import annotations

import uuid

from django.db import migrations


HA_ROLES = [
    # (slug, name,     color,     weight, is_gateway, is_virtual, icon)
    ("active",   "Active",   "#f59e0b", 20, False, False, "crown"),
    ("standby",  "Standby",  "#f59e0b", 21, False, False, "crown-off"),
    ("virtual",  "Virtual",  "#10b981", 15, True,  True,  "crown"),
]


def seed(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    IPRole = apps.get_model("api", "IPRole")
    for tenant in Tenant.objects.all():
        # Restore Gateway's arrow icon if it's still empty or got set to
        # crown (which conflicts with Virtual). Leaves anything else the
        # user actively picked alone.
        gw = IPRole.objects.filter(tenant=tenant, is_gateway=True, is_virtual=False).first()
        if gw and gw.icon in ("", "crown"):
            gw.icon = "arrow-right"
            gw.save(update_fields=["icon"])
        # Seed the three HA defaults if missing.
        for slug, name, color, weight, is_gw, is_virt, icon in HA_ROLES:
            IPRole.objects.get_or_create(
                tenant=tenant,
                slug=slug,
                defaults={
                    "id": uuid.uuid4(),
                    "name": name,
                    "color": color,
                    "weight": weight,
                    "is_gateway": is_gw,
                    "is_virtual": is_virt,
                    "icon": icon,
                },
            )


def reverse_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0006_iprole_icon"),
    ]

    operations = [
        migrations.RunPython(seed, reverse_noop),
    ]
