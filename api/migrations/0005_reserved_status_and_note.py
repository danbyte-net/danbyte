"""Add Reserved status (requires a small note), and the note field itself.

  * IPStatus.requires_note — when true, the IP form will demand reservation_note
  * IPAddress.reservation_note — short free text shown on hover wherever the
    IP appears
  * Per-tenant seed: a "Reserved" status with requires_note=True, ready to use
"""
from __future__ import annotations

import uuid

from django.db import migrations, models
from django.utils.text import slugify


def seed_reserved(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    IPStatus = apps.get_model("api", "IPStatus")
    for tenant in Tenant.objects.all():
        IPStatus.objects.get_or_create(
            tenant=tenant,
            slug="reserved",
            defaults={
                "id": uuid.uuid4(),
                "name": "Reserved",
                "color": "#f59e0b",
                "weight": 18,
                "is_default": False,
                "is_available": False,
                "requires_note": True,
            },
        )


def reverse_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0004_iprole_is_virtual"),
    ]

    operations = [
        migrations.AddField(
            model_name="ipstatus",
            name="requires_note",
            field=models.BooleanField(
                default=False,
                help_text=("Picking this status on an IP forces the operator "
                           "to fill in the reservation_note field — used so "
                           "e.g. 'Reserved' always carries the who/why on "
                           "hover."),
            ),
        ),
        migrations.AddField(
            model_name="ipaddress",
            name="reservation_note",
            field=models.CharField(
                blank=True,
                default="",
                max_length=200,
                help_text=("Short free-text note shown on hover. Statuses "
                           "with ``requires_note=True`` (e.g. Reserved) "
                           "demand this."),
            ),
        ),
        migrations.RunPython(seed_reserved, reverse_noop),
    ]
