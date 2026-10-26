"""The PRTG engine driver.

Answers ``prtg``-kind checks in bulk, from the sensor rows the last status
read wrote (:mod:`prtg.reader`) - no call to PRTG per check, and one read
serves the device list, the panel and every check. The answers go back
through ``ingest_results``, the door an Outpost reports through, so
hysteresis, history, alert rules, silences, flapping, escalation, SLA and
notifications behave exactly as for Danbyte's own checks.

Unknown is never down: an address PRTG has no device for, two PRTG devices on
one address, a paused PRTG device, a read that is too old - each is unknown
with the reason, because not being measured is not being off.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from django.utils import timezone

from danbyte_checks.base import CheckOutcome
from integrations.toggles import integration_enabled

from . import status as st
from .checker import KIND
from .models import PrtgConnection, PrtgDeviceLink, PrtgSensor

#: One claim pass, as for Zabbix.
CLAIM_BATCH = 500


def _connection(engine):
    """The connection an engine answers through: an explicit link, never a
    guess by name."""
    return (
        PrtgConnection.objects.filter(engines=engine, enabled=True)
        .order_by("name").first()
    )


class PrtgDriver:
    def usable(self, engine) -> bool:
        """The tenant switch first, so turning PRTG off is instant."""
        if not integration_enabled(engine.tenant, "prtg"):
            return False
        conn = _connection(engine)
        return conn is not None and conn.api_key_set and conn.supported

    def claim(self, engine, now) -> int:
        from monitoring.models import CheckState
        from monitoring.worker import effective_interval, ingest_results

        conn = _connection(engine)
        if conn is None:
            return 0
        due = list(
            CheckState.objects.filter(
                engine=engine, kind=KIND, next_run__lte=now, in_flight=False,
                target_ip__monitoring_excluded=False,
            ).select_related("target_ip", "template", "assignment")[:CLAIM_BATCH]
        )
        if not due:
            return 0
        for s in due:
            s.in_flight = True
            s.in_flight_since = now
            s.next_run = now + timedelta(seconds=effective_interval(s) or 300)
        CheckState.objects.bulk_update(
            due, ["in_flight", "in_flight_since", "next_run"], batch_size=2000
        )
        outcomes, fresh = answer(conn, due, now)
        if fresh:
            # A driver is seen when it reaches its system; a stale read leaves
            # the engine unstamped so a PRTG that stopped answering still
            # raises the alarm.
            type(engine).objects.filter(pk=engine.pk).update(last_seen_at=now)
        return ingest_results(outcomes, engine_id=engine.id, tenant_id=engine.tenant_id)

    def test(self, engine) -> dict:
        from .connection import test_connection

        conn = _connection(engine)
        if conn is None:
            return {"ok": False, "detail": "No PRTG connection for this engine."}
        return test_connection(conn)


def answer(conn, states, now=None) -> tuple[dict, bool]:
    """``({state id: CheckOutcome}, whether the read was fresh)`` for claimed
    ``states`` of one connection, from the stored read."""
    now = now or timezone.now()
    if not conn.status_fresh(now):
        why = conn.last_error or "PRTG has not been read yet."
        return {
            str(s.id): CheckOutcome.unknown(f"PRTG: {why}"[:300]) for s in states
        }, False

    links = list(PrtgDeviceLink.objects.filter(connection=conn))
    by_device = {link.device_id: link for link in links if link.device_id}
    by_vm = {link.virtual_machine_id: link for link in links if link.virtual_machine_id}
    by_host: dict[str, list] = defaultdict(list)
    for link in links:
        if link.host:
            by_host[link.host.strip().lower()].append(link)
    sensors: dict = defaultdict(list)
    for sensor in PrtgSensor.objects.filter(connection=conn, active=True):
        sensors[sensor.link_id].append(sensor)
    mapping = st.clean_map(conn.state_map)

    out = {}
    for s in states:
        ip = s.target_ip
        address = str(ip.ip_address).split("/")[0]
        link = by_device.get(ip.assigned_device_id) if ip.assigned_device_id else None
        if link is None and ip.assigned_vm_id:
            link = by_vm.get(ip.assigned_vm_id)
        if link is None:
            rows = by_host.get(address.lower()) or []
            if len(rows) > 1:
                names = ", ".join(sorted(r.name for r in rows)[:4])
                out[str(s.id)] = CheckOutcome.unknown(
                    f"Several PRTG devices share this address ({names}).")
                continue
            link = rows[0] if rows else None
        if link is None:
            out[str(s.id)] = CheckOutcome.unknown("PRTG has no device for this address.")
            continue
        out[str(s.id)] = outcome_for(conn, link, sensors.get(link.id, []), mapping,
                                     (s.template.params or {}) if s.template_id else {})
    return out, True


def outcome_for(conn, link, sensors, mapping, params) -> CheckOutcome:
    """One check's answer: the link's sensors, narrowed by the check's
    params, rolled up worst-wins."""
    detail = {
        "system": "prtg", "prtg_device": link.name, "prtg_objid": link.objid,
        "prtg_url": conn.url,
    }
    if link.status_raw is None and link.status_read_at is not None:
        return CheckOutcome("unknown", None, {**detail, "error": "PRTG no longer has this device."})
    if link.paused:
        return CheckOutcome("unknown", None, {**detail, "state": f"{st.label(link.status_raw)} in PRTG"})

    kind = (params.get("sensor_type") or "").strip().lower()
    tag = (params.get("sensor_tag") or "").strip().lower()
    if kind:
        sensors = [x for x in sensors if kind in (x.kind.lower(), x.kind_label.lower())]
    if tag:
        sensors = [x for x in sensors if tag in [t.lower() for t in x.tags or ()]]
    if (kind or tag) and not sensors:
        wanted = " and ".join(p for p in (
            f"of type {params.get('sensor_type')}" if kind else "",
            f"tagged {params.get('sensor_tag')}" if tag else "",
        ) if p)
        return CheckOutcome("unknown", None, {**detail, "error": f"No PRTG sensor {wanted} on this device."})

    state = st.rollup([x.status_raw for x in sensors], mapping)
    rank = {"down": 0, "degraded": 1}
    problems = sorted(
        (x for x in sensors if x.state in rank and x.status_raw not in st.PAUSED),
        key=lambda x: (rank[x.state], x.name),
    )
    if problems:
        detail["problems"] = [
            {"name": x.name, "severity": x.state, "status": st.label(x.status_raw),
             "message": x.message[:300]}
            for x in problems[:20]
        ]
        detail["problem_count"] = len(problems)
    if state == "unknown":
        reasons = {st.UNKNOWN_REASON.get(x.status_raw) for x in sensors} - {None}
        detail["error"] = (
            "; ".join(sorted(reasons)) if reasons
            else "Every PRTG sensor on this device is paused, or it has none."
        )
    detail["sensors"] = len(sensors)
    return CheckOutcome(state, None, detail)
