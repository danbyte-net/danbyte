"""Sensors and sensor channels pinned to a device's or VM's Overview.

A pin says "show this channel of this sensor on the object's Overview" - or,
with a blank channel, "show this sensor": the sensor, the channel's PRTG id
(blank for the whole sensor) and how to draw it. It stores no reading - the
Overview reads the channel live, as the sensor panel does - so a pin never
goes stale, it only goes away with its sensor (a sensor gone from PRTG is
deleted, and its pins with it).

Kept apart from :mod:`prtg.models` and loaded by the app config, so the pins
travel as one piece.
"""
from __future__ import annotations

import uuid

from django.db import models

from core.models import Tenant, TimestampedModel

from .models import PrtgSensor

#: Pins one device or VM may carry: an Overview card, not a dashboard.
MAX_PINS = 24


class PrtgSensorPin(TimestampedModel):
    """One pinned channel, or a whole sensor, on a device's or VM's Overview."""

    AUTO, GAUGE, LOOKUP, VALUE = "auto", "gauge", "lookup", "value"
    DISPLAY_CHOICES = [
        (AUTO, "As the channel is drawn"),
        (GAUGE, "Gauge"),
        (LOOKUP, "Lookup bar"),
        (VALUE, "Value"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="prtg_sensor_pins"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="prtg_sensor_pins",
        null=True, blank=True,
    )
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, related_name="prtg_sensor_pins",
        null=True, blank=True,
    )
    sensor = models.ForeignKey(PrtgSensor, on_delete=models.CASCADE, related_name="pins")
    #: PRTG's channel id within the sensor ("0", "2", "-4"); blank pins the
    #: whole sensor. The unique constraints below hold blank as a value of its
    #: own, so a sensor pins once whole and each of its channels once more.
    channel_id = models.CharField(max_length=16, blank=True, default="", db_default="")
    display = models.CharField(
        max_length=8, choices=DISPLAY_CHOICES, default=AUTO, db_default=AUTO,
    )
    #: Order on the Overview, lowest first.
    position = models.PositiveIntegerField(default=0, db_default=0)

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(device__isnull=False, virtual_machine__isnull=True)
                    | models.Q(device__isnull=True, virtual_machine__isnull=False)
                ),
                name="prtg_pin_one_parent",
            ),
            models.UniqueConstraint(
                fields=["device", "sensor", "channel_id"], name="uniq_prtg_pin_device",
            ),
            models.UniqueConstraint(
                fields=["virtual_machine", "sensor", "channel_id"], name="uniq_prtg_pin_vm",
            ),
        ]
        indexes = [
            models.Index(fields=["tenant", "device"], name="prtg_pin_tenant_device"),
            models.Index(fields=["tenant", "virtual_machine"], name="prtg_pin_tenant_vm"),
        ]

    def __str__(self) -> str:
        return f"{self.sensor_id}:{self.channel_id or '*'}"

    @property
    def whole_sensor(self) -> bool:
        return not self.channel_id

    @property
    def parent(self):
        return self.device if self.device_id else self.virtual_machine
