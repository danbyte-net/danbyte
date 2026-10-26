"""Acknowledgements, both ways.

**Danbyte → PRTG.** Acknowledging a Danbyte alert that a ``prtg`` check
raised acknowledges, in PRTG, each sensor behind it that the last read saw
Down or Down (Partial) - with the operator's name and note after a
``[Danbyte]`` marker. A job, never inline: the acknowledgement in Danbyte is
the decision and must not wait on, or fail because of, PRTG. PRTG has no
un-acknowledge call, so clearing the acknowledgement in Danbyte is recorded
and goes no further.

**PRTG → Danbyte.** A status read that finds every sensor behind a firing,
unacknowledged alert in Down (Acknowledged) - at least one acknowledged by a
person in PRTG rather than by Danbyte - acknowledges the alert through
:func:`monitoring.alerts.set_acknowledged` with ``source="prtg"``, so the
write-back above is not called for it. The marker keeps Danbyte's own
acknowledgements from being read back, and a fingerprint of what was read
keeps an acknowledgement an operator cleared in Danbyte from being set again
by the same PRTG acknowledgement.
"""
from __future__ import annotations

import hashlib
import logging
import re

import django_rq
from django.db import transaction
from django.utils import timezone

from integrations.toggles import integration_enabled
from monitoring.models import Alert, CheckState

from . import status as st
from .checker import KIND
from .client import PrtgClient, PrtgError
from .driver import _connection, narrow
from .models import PrtgDeviceLink, PrtgSensor

log = logging.getLogger("prtg.acks")

#: The system name PRTG acknowledgements carry as their ``source``.
SYSTEM = "prtg"
#: Leads every acknowledgement Danbyte writes into PRTG. PRTG puts the note
#: first in the sensor's message ("<note> (Acknowledged by … on …): …"), so a
#: message that starts with it is Danbyte's own.
MARKER = "[Danbyte]"
#: Codes PRTG accepts an acknowledgement for. It answers anything else with
#: a redirect and does nothing (PRTG 26.3), so nothing else is sent.
ACKABLE = (st.DOWN, st.DOWN_PARTIAL)

_ACKED_BY = re.compile(r"\s*\(Acknowledged by (?P<who>.+?) on [^)]*\):?\s*")


def message(actor: str, note: str) -> str:
    head = f"{MARKER} {actor}" if actor else MARKER
    return f"{head}: {note}" if note else head


def is_ours(text: str) -> bool:
    return (text or "").lstrip().startswith(MARKER)


def parse_ack(text: str) -> tuple[str, str]:
    """``(who, note)`` from the message of an acknowledged sensor."""
    text = (text or "").strip()
    m = _ACKED_BY.search(text)
    if not m:
        return "", text
    return m.group("who").strip(), text[: m.start()].strip()


def link_for(conn, ip) -> PrtgDeviceLink | None:
    """The link a check on ``ip`` reads, the way the driver finds it."""
    links = PrtgDeviceLink.objects.filter(connection=conn)
    if ip.assigned_device_id:
        link = links.filter(device_id=ip.assigned_device_id).first()
        if link is not None:
            return link
    if ip.assigned_vm_id:
        link = links.filter(virtual_machine_id=ip.assigned_vm_id).first()
        if link is not None:
            return link
    address = str(ip.ip_address).split("/")[0]
    rows = list(links.filter(host__iexact=address)[:2])
    return rows[0] if len(rows) == 1 else None


def _behind(conn, alert, link) -> list:
    """The active, unpaused sensors the alert's check speaks for."""
    params = (alert.template.params or {}) if alert.template_id else {}
    sensors = PrtgSensor.objects.filter(connection=conn, link=link, active=True)
    return [s for s in narrow(sensors, params) if s.status_raw not in st.PAUSED]


def _state_and_connection(alert):
    state = (
        CheckState.objects.filter(
            target_ip=alert.target_ip, template=alert.template, kind=KIND
        )
        .select_related("engine")
        .first()
    )
    if state is None or state.engine_id is None:
        return state, None
    return state, _connection(state.engine)


# ── Danbyte → PRTG ──────────────────────────────────────────────────────────


def write_back(alert, acknowledged, actor=None, **kwargs) -> None:
    """Queue the write-back for a PRTG alert, after commit. Registered as
    the ``prtg`` acknowledgement writer; not called for an acknowledgement
    whose ``source`` is PRTG."""
    if alert.kind != KIND:
        return
    name = ""
    if actor is not None:
        name = (getattr(actor, "get_full_name", lambda: "")() or "").strip()
        name = name or actor.get_username()
    alert_id = str(alert.id)

    def _go():
        django_rq.get_queue("low").enqueue(
            write_ack, alert_id, bool(acknowledged), name, job_timeout=120
        )

    transaction.on_commit(_go)


def _stamp(alert, stamp: dict) -> dict:
    # One key, merged into the detail as it is now - the alert's own detail
    # keeps changing underneath while checks run.
    fresh = Alert.objects.filter(pk=alert.pk).values_list("detail", flat=True).first() or {}
    Alert.objects.filter(pk=alert.pk).update(detail={**fresh, "prtg_ack": stamp})
    return stamp


def write_ack(alert_id: str, acknowledged: bool, actor: str = "", *, client=None) -> dict:
    """Acknowledge in PRTG the Down sensors behind one alert. Every switch is
    re-checked here, at run time."""
    alert = (
        Alert.objects.filter(pk=alert_id)
        .select_related("tenant", "target_ip", "template")
        .first()
    )
    if alert is None:
        return {"skipped": "gone"}
    if alert.kind != KIND:
        return {"skipped": "not a PRTG alert"}
    if not alert.tenant.is_active or not integration_enabled(alert.tenant, "prtg"):
        return {"skipped": "integration off"}
    state, conn = _state_and_connection(alert)
    if conn is None:
        return {"skipped": "no check state"}
    if not (conn.enabled and conn.write_acknowledgements and conn.api_key_set):
        return {"skipped": "write-back off"}
    now = timezone.now()
    if not acknowledged:
        return _stamp(alert, {
            "objids": [], "acknowledged": False, "at": now.isoformat(),
            "error": "", "note": "PRTG cannot un-acknowledge.",
        })
    link = link_for(conn, alert.target_ip)
    if link is None:
        return {"skipped": "not linked"}
    # The sensors the last read saw down - the ones the alert is about.
    objids = [s.objid for s in _behind(conn, alert, link) if s.status_raw in ACKABLE]
    if not objids:
        return {"skipped": "nothing down in PRTG"}
    client = client or PrtgClient.for_connection(conn)
    text = message(actor, alert.ack_note)
    errors = []
    done = []
    for objid in objids:
        try:
            client.acknowledge(int(objid), text)
            done.append(objid)
        except PrtgError as exc:
            errors.append(f"{objid}: {exc}")
            log.warning("prtg ack write-back %s on %s failed: %s", alert_id, objid, exc)
    if done:
        # What was just written, so the next read does not mistake the
        # sensor's state for a fresh acknowledgement made in PRTG.
        PrtgSensor.objects.filter(connection=conn, objid__in=done).update(
            status_raw=st.DOWN_ACKNOWLEDGED, message=text,
        )
    return _stamp(alert, {
        "objids": done, "acknowledged": True, "at": now.isoformat(),
        "error": "; ".join(errors)[:500],
    })


# ── PRTG → Danbyte ──────────────────────────────────────────────────────────


def _fingerprint(sensors) -> str:
    raw = "|".join(f"{s.objid}:{s.message}" for s in sorted(sensors, key=lambda s: s.objid))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def read_acks(conn, links=None) -> int:
    """Acknowledge the firing PRTG alerts whose sensors were all
    acknowledged in PRTG. Returns how many were acknowledged.

    ``links`` narrows the pass to some links (a push re-read); the whole
    connection otherwise. Reads only the rows the status pass just wrote.
    """
    from monitoring.alerts import set_acknowledged

    if not (conn.enabled and conn.write_acknowledgements):
        return 0
    engines = list(conn.engines.values_list("id", flat=True))
    if not engines:
        return 0
    link_ids = None if links is None else {lk.id for lk in links}
    alerts = (
        Alert.objects.filter(
            tenant=conn.tenant, kind=KIND, status="firing", acknowledged_at__isnull=True,
        )
        .select_related("target_ip", "template")
    )
    n = 0
    for alert in alerts:
        state = CheckState.objects.filter(
            target_ip=alert.target_ip, template=alert.template, kind=KIND,
            engine_id__in=engines,
        ).first()
        if state is None:
            continue
        link = link_for(conn, alert.target_ip)
        if link is None or (link_ids is not None and link.id not in link_ids):
            continue
        sensors = _behind(conn, alert, link)
        relevant = [s for s in sensors if s.status_raw in (*ACKABLE, st.DOWN_ACKNOWLEDGED)]
        if not relevant or any(s.status_raw != st.DOWN_ACKNOWLEDGED for s in relevant):
            continue
        theirs = [s for s in relevant if not is_ours(s.message)]
        if not theirs:
            continue
        mark = _fingerprint(relevant)
        if (alert.detail or {}).get("prtg_ack_read") == mark:
            # Already taken once and cleared in Danbyte since: the operator's
            # word stands until PRTG says something new.
            continue
        who, note = parse_ack(theirs[0].message)
        head = f"Acknowledged in PRTG by {who}" if who else "Acknowledged in PRTG"
        with transaction.atomic():
            set_acknowledged(
                alert, True, actor=None,
                note=f"{head}: {note}" if note else head, source=SYSTEM,
            )
            fresh = Alert.objects.filter(pk=alert.pk).values_list("detail", flat=True).first()
            Alert.objects.filter(pk=alert.pk).update(
                detail={**(fresh or {}), "prtg_ack_read": mark}
            )
        n += 1
    return n
