"""Reading PRTG: the status pass, the linking pass and the push re-read.

One status read is two calls - the devices table and the sensors table - and
everything else follows from them:

1. **Linking.** Every device of the tenant is matched against PRTG's devices
   through the cascade (:mod:`prtg.matching`). An unambiguous match is linked
   at once (``link_mode = auto``) or proposed in the review queue
   (``review``); an ambiguity is always a queue row and never a link.
2. **Sensors.** Each linked device's sensors are written as
   :class:`~prtg.models.PrtgSensor` rows, their state mapped through the
   connection's map; a sensor PRTG no longer has is deleted.
3. **Roll-up.** Each link gets its device's worst state and its counts.

The ``prtg`` check (:mod:`prtg.driver`) then answers from those rows - one
read serves the device list, the panel and every check.

Linking covers the whole tenant, not a provisioning scope: an object that is
a device's by tag, address, DNS name or name is that device whichever checks
or policies exist. Provisioning, when it comes, decides what PRTG should
*have*; this decides what it already has.
"""
from __future__ import annotations

import logging
from collections import defaultdict

from django.db import transaction
from django.utils import timezone

from monitoring.external.beat import skip_reason

from . import status as st
from .client import PrtgClient, PrtgError
from .matching import annotate_devices, index_devices, match_device, shared_addresses
from .models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor

log = logging.getLogger("prtg.reader")

#: How long a pass may hold the connection. The classic API is served by the
#: same web server as PRTG's own interface; two passes at once is one too many.
LOCK_SECONDS = 300
#: Problems carried per link for the hover and the check's detail.
PROBLEM_LIMIT = 20


def client_for(conn) -> PrtgClient:
    return PrtgClient.for_connection(conn)


# ── the lock ────────────────────────────────────────────────────────────────


def _lock_key(conn) -> str:
    return f"danbyte-prtg:{conn.id}"


def _acquire(conn) -> bool:
    """A per-connection Redis lock, so a burst of pushes cannot stack passes.
    Without Redis the pass runs unlocked rather than not at all."""
    try:
        import django_rq

        return bool(django_rq.get_connection("low").set(
            _lock_key(conn), "1", nx=True, ex=LOCK_SECONDS
        ))
    except Exception:  # noqa: BLE001 - no Redis is not a reason to stop reading
        return True


def _release(conn) -> None:
    try:
        import django_rq

        django_rq.get_connection("low").delete(_lock_key(conn))
    except Exception:  # noqa: BLE001
        pass


# ── linking ─────────────────────────────────────────────────────────────────


def link_pass(conn: PrtgConnection, devices: list, now) -> dict:
    """Match every device of the tenant to PRTG's devices; link or propose.

    ``devices`` are normalised ``table.json`` device rows. Returns counts.
    """
    from api.models import Device

    counts = {"linked": 0, "proposed": 0, "ambiguous": 0, "unmatched": 0}
    index = index_devices(devices)
    tenant_devices = annotate_devices(
        conn.tenant,
        Device.objects.filter(tenant=conn.tenant).only("id", "name", "tenant_id"),
    )
    links = {link.device_id: link for link in PrtgDeviceLink.objects.filter(connection=conn)}
    shared = shared_addresses(conn.tenant, set(index["address"]))

    matches = []
    by_objid: dict[str, list] = defaultdict(list)
    for device in tenant_devices:
        match = match_device(device, index, links.get(device.id))
        if match.matched and match.how == "address":
            host = (match.remote.get("host") or "").strip()
            owners = shared.get(host) if host else None
            if owners:
                match.host, match.how = None, "ambiguous"
                match.reason = (
                    f"Address {host} of PRTG device {match_name(index, host)} is held "
                    f"by several Danbyte objects ({', '.join(owners[:4])})."
                )
        matches.append(match)
        if match.matched:
            by_objid[match.remote["objid"]].append(match)

    fresh: set = set()
    with transaction.atomic():
        for match in matches:
            device = match.device
            if match.how == "ambiguous":
                counts["ambiguous"] += 1
                PrtgChange.propose(
                    conn, fresh, {"reason": match.reason},
                    device=device, kind=PrtgChange.AMBIGUOUS, key="",
                )
                continue
            if not match.matched:
                counts["unmatched"] += 1
                continue
            remote = match.remote
            rivals = by_objid[remote["objid"]]
            if len(rivals) > 1:
                # One PRTG device answering to two Danbyte devices is the
                # same question asked from the other side.
                counts["ambiguous"] += 1
                names = ", ".join(sorted(m.device.name for m in rivals)[:4])
                PrtgChange.propose(
                    conn, fresh,
                    {"reason": (
                        f"PRTG device {remote.get('name')} matches several Danbyte "
                        f"devices by {match.how} ({names})."
                    ), "objid": remote["objid"]},
                    device=device, kind=PrtgChange.AMBIGUOUS, key="",
                )
                continue
            link = links.get(device.id)
            if link is not None and link.objid == remote["objid"]:
                _refresh_link(link, remote, now)
                counts["linked"] += 1
                continue
            if conn.link_mode == PrtgConnection.LINK_AUTO and _free(conn, device, remote):
                make_link(conn, device, remote, match.how, now)
                counts["linked"] += 1
                continue
            counts["proposed"] += 1
            PrtgChange.propose(
                conn, fresh,
                {"objid": remote["objid"], "name": remote.get("name", ""),
                 "host": remote.get("host", ""), "matched_by": match.how,
                 "replaces": link.objid if link is not None else ""},
                device=device, kind=PrtgChange.LINK, key=remote["objid"],
            )
        PrtgChange.drop_stale(conn, fresh)
    return counts


def match_name(index, host) -> str:
    rows = index["address"].get(host) or []
    return rows[0].get("name", host) if rows else host


def _free(conn, device, remote) -> bool:
    """Whether linking would collide with another device's link."""
    return not PrtgDeviceLink.objects.filter(
        connection=conn, objid=remote["objid"]
    ).exclude(device=device).exists()


def _link_fields(remote, now) -> dict:
    return {
        "name": (remote.get("name") or "")[:255],
        "host": (remote.get("host") or "")[:255],
        "probe_name": (remote.get("probe") or "")[:255],
        "group_path": (remote.get("group") or "")[:255],
        "status_raw": remote.get("status_raw"),
        "last_seen_at": now,
    }


def make_link(conn, device, remote, how, now) -> PrtgDeviceLink:
    """Pair ``device`` with the PRTG device ``remote``, replacing any older
    pairing of the device on this connection."""
    link, _ = PrtgDeviceLink.objects.update_or_create(
        connection=conn, device=device,
        defaults={
            "tenant": conn.tenant, "objid": str(remote["objid"]),
            "matched_by": how, "unwanted_since": None,
            "tagged": _tagged(device.id, remote),
            **_link_fields(remote, now),
        },
    )
    return link


def _tagged(device_id, remote) -> bool:
    """Whether the PRTG device carries this device's ``danbyte-<uuid>`` tag."""
    return f"danbyte-{device_id}".lower() in [t.lower() for t in remote.get("tags") or ()]


def _refresh_link(link, remote, now) -> None:
    for field, value in _link_fields(remote, now).items():
        setattr(link, field, value)
    link.tagged = _tagged(link.device_id, remote)
    link.save(update_fields=[*_link_fields(remote, now), "tagged"])


def apply_link(change: PrtgChange) -> str:
    """Apply a ``link_device`` proposal: the operator's act."""
    conn = change.connection
    detail = change.detail or {}
    objid = str(detail.get("objid") or change.key or "")
    if change.device_id is None or not objid:
        raise ValueError("This proposal names no device to link.")
    if change.device.tenant_id != conn.tenant_id:
        raise ValueError("The device is not in this connection's tenant.")
    if not _free(conn, change.device, {"objid": objid}):
        raise ValueError("Another device is already linked to that PRTG device.")
    make_link(conn, change.device, {**detail, "objid": objid},
              detail.get("matched_by") or "link", timezone.now())
    name = detail.get("name") or objid
    change.delete()
    return f"Linked {change.device.name} to PRTG device {name}."


# ── sensors and the roll-up ─────────────────────────────────────────────────


def write_sensors(conn, links, sensor_rows, now) -> dict:
    """Upsert the sensors of ``links`` from ``sensor_rows`` and roll each link
    up. Only the given links are touched, so one device's re-read leaves the
    others alone."""
    mapping = st.clean_map(conn.state_map)
    by_parent: dict[str, list] = defaultdict(list)
    for row in sensor_rows:
        if row.get("parent_id") is not None:
            by_parent[str(row["parent_id"])].append(row)

    counts = {"sensors": 0, "deleted": 0}
    with transaction.atomic():
        for link in links:
            rows = by_parent.get(link.objid, [])
            existing = {s.objid: s for s in PrtgSensor.objects.filter(link=link)}
            seen = set()
            for row in rows:
                objid = str(row["objid"])
                seen.add(objid)
                fields = {
                    "tenant": conn.tenant, "connection": conn, "link": link,
                    "device_id": link.device_id,
                    "name": (row.get("name") or "")[:255],
                    "kind": (row.get("kind") or "")[:128],
                    "kind_label": (row.get("type") or "")[:128],
                    "status_raw": row.get("status_raw"),
                    "state": st.map_code(row.get("status_raw"), mapping),
                    "message": row.get("message") or "",
                    "tags": list(row.get("tags") or []),
                    "active": row.get("active", True),
                    "last_check_at": row.get("last_check_at"),
                    "last_seen_at": now,
                }
                sensor = existing.get(objid)
                if sensor is None:
                    PrtgSensor.objects.update_or_create(
                        connection=conn, objid=objid, defaults=fields
                    )
                else:
                    for k, v in fields.items():
                        setattr(sensor, k, v)
                    sensor.save()
                counts["sensors"] += 1
            gone = [s.id for o, s in existing.items() if o not in seen]
            if gone:
                counts["deleted"] += PrtgSensor.objects.filter(id__in=gone).delete()[0]
            roll_up(link, mapping, now)
    return counts


def roll_up(link, mapping, now) -> None:
    """The link's state and counts from its sensor rows."""
    sensors = list(PrtgSensor.objects.filter(link=link, active=True))
    codes = [s.status_raw for s in sensors]
    counts: dict[str, int] = {"total": len(sensors), "paused": 0}
    for s in sensors:
        if s.status_raw in st.PAUSED:
            counts["paused"] += 1
        else:
            counts[s.state] = counts.get(s.state, 0) + 1
    link.state = st.rollup(codes, mapping) if not link.paused else "unknown"
    link.sensor_counts = counts
    link.status_read_at = now
    link.save(update_fields=["state", "sensor_counts", "status_read_at"])


def problems_for(link) -> list[dict]:
    """The link's down and degraded sensors, worst first, for the hover and
    the check's detail."""
    rank = {"down": 0, "degraded": 1}
    rows = [
        s for s in PrtgSensor.objects.filter(link=link, active=True)
        if s.state in rank and s.status_raw not in st.PAUSED
    ]
    rows.sort(key=lambda s: (rank[s.state], s.name))
    return [
        {"name": s.name, "severity": s.state, "status": st.label(s.status_raw),
         "message": s.message[:300], "objid": s.objid}
        for s in rows[:PROBLEM_LIMIT]
    ]


def remap(conn) -> int:
    """Re-apply a changed state map to the stored sensors and roll-ups, so
    the device list does not wait for the next read."""
    mapping = st.clean_map(conn.state_map)
    changed = []
    for sensor in PrtgSensor.objects.filter(connection=conn):
        state = st.map_code(sensor.status_raw, mapping)
        if state != sensor.state:
            sensor.state = state
            changed.append(sensor)
    PrtgSensor.objects.bulk_update(changed, ["state"], batch_size=1000)
    now = timezone.now()
    for link in PrtgDeviceLink.objects.filter(connection=conn).select_related("device"):
        roll_up(link, mapping, now)
    return len(changed)


# ── the passes ──────────────────────────────────────────────────────────────


def read_status(conn: PrtgConnection, now=None, *, client: PrtgClient | None = None) -> dict:
    """One status pass: devices, sensors, links, roll-ups. Raises
    :class:`PrtgError` when PRTG cannot be read - nothing is written then,
    because an unread tree says nothing about what is linked."""
    now = now or timezone.now()
    client = client or client_for(conn)
    devices = client.devices()
    sensors = client.sensors()
    counts = link_pass(conn, devices.rows, now)
    links = list(PrtgDeviceLink.objects.filter(connection=conn).select_related("device"))
    present = {str(r["objid"]) for r in devices.rows}
    for link in links:
        if link.objid not in present:
            # PRTG no longer has it: the link stands (the next pass may find
            # it again) but nothing it said is current.
            link.status_raw = None
    counts.update(write_sensors(conn, [lk for lk in links if lk.objid in present],
                                sensors.rows, now))
    for link in links:
        if link.objid not in present:
            PrtgSensor.objects.filter(link=link).delete()
            link.state, link.sensor_counts, link.status_read_at = "unknown", {}, now
            link.save(update_fields=["status_raw", "state", "sensor_counts", "status_read_at"])
    counts["gone"] = sum(1 for lk in links if lk.objid not in present)
    counts["skipped_rows"] = devices.skipped + sensors.skipped
    return counts


def _stamp(conn, now, *, error: str = "", summary: dict | None = None) -> None:
    conn.last_status_at = now
    conn.last_checked_at = now
    conn.last_error = error[:500]
    conn.last_status_summary = summary or ({"error": error[:300]} if error else {})
    conn.save(update_fields=[
        "last_status_at", "last_checked_at", "last_error", "last_status_summary",
    ])


def run_status_read(connection_id: str) -> dict:
    """The status pass as an RQ job. Every switch is re-checked here, at run
    time; the attempt is stamped even when it fails, so a broken connection
    backs off to its interval instead of being queued every minute."""
    conn = PrtgConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    reason = skip_reason(conn, "prtg")
    if reason:
        return {"skipped": reason}
    if not (conn.enabled and conn.api_key_set):
        return {"skipped": "connection off"}
    if not _acquire(conn):
        return {"skipped": "already reading"}
    now = timezone.now()
    try:
        counts = read_status(conn, now)
    except PrtgError as exc:
        log.warning("prtg status %s failed: %s", conn.name, exc)
        _stamp(conn, now, error=str(exc))
        return {"error": str(exc)[:300]}
    except Exception as exc:
        log.exception("prtg status %s failed", conn.name)
        _stamp(conn, now, error=f"Status read failed: {type(exc).__name__}")
        raise
    finally:
        _release(conn)
    _stamp(conn, now, summary=counts)
    log.info("prtg status %s: %s", conn.name, counts)
    return counts


def refresh_device(connection_id: str, sensor_objid=None, device_objid=None) -> dict:
    """Re-read one linked device's sensors - what a push hint asks for.

    The hint's ids only say *where* to look. Nothing in the notification is
    believed: PRTG is asked again, through the same client and the same map.
    """
    conn = PrtgConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    reason = skip_reason(conn, "prtg")
    if reason:
        return {"skipped": reason}
    if not (conn.enabled and conn.api_key_set and conn.push_enabled):
        return {"skipped": "push off"}
    link = None
    if device_objid:
        link = PrtgDeviceLink.objects.filter(connection=conn, objid=str(device_objid)).first()
    if link is None and sensor_objid:
        sensor = PrtgSensor.objects.filter(
            connection=conn, objid=str(sensor_objid)
        ).select_related("link").first()
        link = sensor.link if sensor else None
    if link is None:
        return {"skipped": "not linked"}
    now = timezone.now()
    try:
        rows = client_for(conn).sensors({"parentid": link.objid}).rows
    except PrtgError as exc:
        return {"error": str(exc)[:300]}
    counts = write_sensors(conn, [link], rows, now)
    _hurry_checks(conn, link, now)
    return counts


def _hurry_checks(conn, link, now) -> None:
    """Make the device's ``prtg`` checks due now, so the hint reaches the
    status in seconds rather than at the next interval."""
    from monitoring.models import CheckState

    from .checker import KIND

    CheckState.objects.filter(
        tenant=conn.tenant, kind=KIND, engine__in=conn.engines.all(),
        target_ip__assigned_device_id=link.device_id, in_flight=False,
    ).update(next_run=now)
