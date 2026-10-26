"""Acknowledge, pause and resume from Danbyte.

An operator acts on a PRTG sensor, or on a whole linked PRTG device, from
the device's or VM's Sensors tab or the /prtg Alarms tab. Each action is one
call to PRTG through the classic client, made inline - the operator is
waiting for the answer and PRTG's error is what they need to see. The row is
then updated the way the next status read would see it, so the card, the
strip and the counts follow at once, and a journal note and a change-log
entry on the device or VM say who did what.

Acknowledging needs the connection's ``write_acknowledgements`` switch, the
same switch that writes Danbyte alert acknowledgements into PRTG, and a
sensor PRTG will take one for (Down, Down (Partial)). Pausing and resuming
need only a working connection.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from . import status as st
from .acks import ACKABLE, message
from .client import PrtgError
from .models import PrtgDeviceLink, PrtgSensor
from .reader import client_for, roll_up, write_sensors
from .writer import record

log = logging.getLogger("prtg.actions")

#: The longest timed pause: a year. Longer is "until resumed".
MAX_MINUTES = 60 * 24 * 366


class ActionError(Exception):
    """A refusal or a PRTG failure, with the HTTP status to answer with."""

    def __init__(self, detail: str, status: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def _name(user) -> str:
    if user is None:
        return ""
    full = (getattr(user, "get_full_name", lambda: "")() or "").strip()
    return full or user.get_username()


def _owner(obj):
    return obj.device if obj.device_id else obj.virtual_machine


def clean_minutes(raw) -> int | None:
    """``None`` (until resumed) or a whole number of minutes."""
    if raw in (None, "", 0, "0"):
        return None
    try:
        minutes = int(raw)
    except (TypeError, ValueError):
        raise ActionError("Minutes must be a whole number, or empty for until resumed.") from None
    if not 1 <= minutes <= MAX_MINUTES:
        raise ActionError(f"Minutes must be between 1 and {MAX_MINUTES}.")
    return minutes


def _for_how_long(minutes: int | None) -> str:
    if minutes is None:
        return "until resumed"
    if minutes % (60 * 24) == 0:
        days = minutes // (60 * 24)
        return f"for {days} day{'s' if days != 1 else ''}"
    if minutes % 60 == 0:
        hours = minutes // 60
        return f"for {hours} hour{'s' if hours != 1 else ''}"
    return f"for {minutes} minutes"


def _call(fn, *args) -> None:
    try:
        fn(*args)
    except PrtgError as exc:
        raise ActionError(str(exc)[:300], status=502) from exc


def _roll(link: PrtgDeviceLink) -> None:
    """The link's state and counts from its rows, keeping its read time: an
    action changed what Danbyte knows, not when it last read PRTG."""
    conn = link.connection
    roll_up(link, st.clean_map(conn.state_map), link.status_read_at or timezone.now())


def _reread(link: PrtgDeviceLink, client) -> bool:
    """Read the link's sensors again, as a push hint does. False when PRTG
    did not answer - the caller keeps its own update then."""
    try:
        rows = client.sensors({"parentid": link.objid}).rows
    except PrtgError as exc:
        log.info("prtg re-read after an action on %s failed: %s", link.objid, exc)
        return False
    write_sensors(link.connection, [link], rows, timezone.now())
    return True


def _set_code(sensor: PrtgSensor, code: int, text: str | None = None) -> None:
    mapping = st.clean_map(sensor.connection.state_map)
    sensor.status_raw = code
    sensor.state = st.map_code(code, mapping)
    fields = ["status_raw", "state"]
    if text is not None:
        sensor.message = text
        fields.append("message")
    sensor.save(update_fields=fields)


# ── sensors ─────────────────────────────────────────────────────────────────


def acknowledge(sensor: PrtgSensor, user, note: str = "", *, client=None) -> PrtgSensor:
    conn = sensor.connection
    if not conn.write_acknowledgements:
        raise ActionError("Acknowledgements are off for this PRTG connection.")
    if sensor.status_raw not in ACKABLE:
        raise ActionError("Only a down sensor can be acknowledged.")
    note = (note or "").strip()[:500]
    text = message(_name(user), note)
    client = client or client_for(conn)
    _call(client.acknowledge, int(sensor.objid), text)
    _set_code(sensor, st.DOWN_ACKNOWLEDGED, text)
    _roll(sensor.link)
    record(
        _owner(sensor),
        f"Acknowledged PRTG sensor {sensor.name}" + (f": {note}" if note else "."),
        user,
    )
    return sensor


def pause(sensor: PrtgSensor, user, minutes=None, note: str = "", *, client=None) -> PrtgSensor:
    minutes = clean_minutes(minutes)
    text = message(_name(user), (note or "").strip()[:500])
    client = client or client_for(sensor.connection)
    _call(client.pause, int(sensor.objid), text, minutes)
    _set_code(sensor, st.PAUSED_UNTIL if minutes else st.PAUSED_USER, text)
    _roll(sensor.link)
    record(_owner(sensor), f"Paused PRTG sensor {sensor.name} {_for_how_long(minutes)}.", user)
    return sensor


def resume(sensor: PrtgSensor, user, *, client=None) -> PrtgSensor:
    client = client or client_for(sensor.connection)
    _call(client.resume, int(sensor.objid))
    if not _reread(sensor.link, client):
        # PRTG rescans a resumed sensor before it has a state again.
        _set_code(sensor, st.UNKNOWN, "")
        _roll(sensor.link)
    record(_owner(sensor), f"Resumed PRTG sensor {sensor.name}.", user)
    sensor.refresh_from_db()
    return sensor


# ── devices ─────────────────────────────────────────────────────────────────


def pause_link(link: PrtgDeviceLink, user, minutes=None, note: str = "", *, client=None):
    minutes = clean_minutes(minutes)
    text = message(_name(user), (note or "").strip()[:500])
    client = client or client_for(link.connection)
    _call(client.pause, int(link.objid), text, minutes)
    link.status_raw = st.PAUSED_UNTIL if minutes else st.PAUSED_USER
    link.save(update_fields=["status_raw"])
    if not _reread(link, client):
        # PRTG pauses the device's sensors with it.
        for sensor in PrtgSensor.objects.filter(link=link, active=True).exclude(
            status_raw__in=st.PAUSED
        ):
            _set_code(sensor, st.PAUSED_DEPENDENCY)
        _roll(link)
    record(
        _owner(link),
        f"Paused PRTG device {link.name or link.objid} {_for_how_long(minutes)}.",
        user,
    )
    return link


def resume_link(link: PrtgDeviceLink, user, *, client=None):
    client = client or client_for(link.connection)
    _call(client.resume, int(link.objid))
    link.status_raw = st.UNKNOWN
    link.save(update_fields=["status_raw"])
    if not _reread(link, client):
        for sensor in PrtgSensor.objects.filter(
            link=link, active=True, status_raw=st.PAUSED_DEPENDENCY
        ):
            _set_code(sensor, st.UNKNOWN)
        _roll(link)
    record(_owner(link), f"Resumed PRTG device {link.name or link.objid}.", user)
    link.refresh_from_db()
    return link
