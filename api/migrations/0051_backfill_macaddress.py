"""Backfill MACAddress objects from existing Interface.mac_address strings, so
every interface that already records a MAC gets a first-class MACAddress row."""
from __future__ import annotations

from django.db import migrations


def backfill(apps, schema_editor):
    Interface = apps.get_model("api", "Interface")
    MACAddress = apps.get_model("api", "MACAddress")
    seen = set()
    for iface in Interface.objects.select_related("device").exclude(
        mac_address=""
    ).iterator():
        mac = (iface.mac_address or "").strip().lower()
        if not mac:
            continue
        tenant_id = iface.device.tenant_id
        key = (tenant_id, mac, iface.id)
        if key in seen:
            continue
        seen.add(key)
        if not MACAddress.objects.filter(
            tenant_id=tenant_id, mac_address=mac, assigned_interface=iface
        ).exists():
            MACAddress.objects.create(
                tenant_id=tenant_id, mac_address=mac, assigned_interface=iface
            )


def unbackfill(apps, schema_editor):
    # The schema migration drops the table on reverse; nothing to undo here.
    pass


class Migration(migrations.Migration):
    dependencies = [("api", "0050_macaddress")]
    operations = [migrations.RunPython(backfill, unbackfill)]
