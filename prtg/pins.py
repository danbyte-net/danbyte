"""Sensors and sensor channels pinned to an object's Overview.

The object is a device or VM - the sensor's own - or one thing the sensor
watches: its IP address, interface (device or VM) or service. A pin on one
of those is allowed only for a sensor linked to it.

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

#: Pins one object may carry: an Overview card, not a dashboard.
MAX_PINS = 24

#: The objects a pin may sit on, by field; exactly one is set.
PARENT_FIELDS = (
    "device", "virtual_machine", "ip_address", "interface", "vm_interface", "service",
)


def _one_parent() -> models.Q:
    q = models.Q()
    for field in PARENT_FIELDS:
        q |= models.Q(**{
            f"{f}__isnull": f != field for f in PARENT_FIELDS
        })
    return q


class PrtgSensorPin(TimestampedModel):
    """One pinned channel, or a whole sensor, on an object's Overview."""

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
    ip_address = models.ForeignKey(
        "api.IPAddress", on_delete=models.CASCADE, related_name="prtg_sensor_pins",
        null=True, blank=True,
    )
    interface = models.ForeignKey(
        "api.Interface", on_delete=models.CASCADE, related_name="prtg_sensor_pins",
        null=True, blank=True,
    )
    vm_interface = models.ForeignKey(
        "api.VMInterface", on_delete=models.CASCADE, related_name="prtg_sensor_pins",
        null=True, blank=True,
    )
    service = models.ForeignKey(
        "api.Service", on_delete=models.CASCADE, related_name="prtg_sensor_pins",
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
            models.CheckConstraint(condition=_one_parent(), name="prtg_pin_one_parent"),
            models.UniqueConstraint(
                fields=["device", "sensor", "channel_id"], name="uniq_prtg_pin_device",
            ),
            models.UniqueConstraint(
                fields=["virtual_machine", "sensor", "channel_id"], name="uniq_prtg_pin_vm",
            ),
            models.UniqueConstraint(
                fields=["ip_address", "sensor", "channel_id"], name="uniq_prtg_pin_ip",
            ),
            models.UniqueConstraint(
                fields=["interface", "sensor", "channel_id"], name="uniq_prtg_pin_interface",
            ),
            models.UniqueConstraint(
                fields=["vm_interface", "sensor", "channel_id"], name="uniq_prtg_pin_vm_interface",
            ),
            models.UniqueConstraint(
                fields=["service", "sensor", "channel_id"], name="uniq_prtg_pin_service",
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
    def parent_field(self) -> str:
        """The field that names the pin's object."""
        return next(f for f in PARENT_FIELDS if getattr(self, f"{f}_id"))

    @property
    def parent(self):
        return getattr(self, self.parent_field)
