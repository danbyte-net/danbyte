"""Status over time, as segments.

The transition log says *when* a check changed; a timeline needs *what it was*
between those moments. This turns transitions into ``[{start, end, status}]``
runs over a window - the same integration :mod:`uptime` does to add up
availability, kept in one place so a strip drawn on a page and a percentage
printed beside it can never disagree.

Two queries for any number of checks: one for the status each was in as the
window opened, one for every change inside it. PostgreSQL's ``DISTINCT ON``
does the first; this is a Postgres-only application.
"""
from __future__ import annotations

from .models import StateTransition
from .rollup import worst_status


def segments_for_pairs(tenant_id, pairs, since, until) -> dict:
    """``{(ip_id, template_id): [segment, ...]}`` for every pair asked about.

    ``pairs`` are ``(target_ip_id, template_id)`` tuples. A pair with no
    history at all gets one ``unknown`` segment spanning the window - which
    is the truth, and draws as grey rather than as nothing.
    """
    pairs = list({(str(a), str(b)) for a, b in pairs})
    if not pairs:
        return {}
    ip_ids = {a for a, _ in pairs}
    tmpl_ids = {b for _, b in pairs}

    # The status in effect as the window opens: the last change before it.
    opening: dict = {}
    for row in (
        StateTransition.objects.filter(
            tenant_id=tenant_id,
            target_ip_id__in=ip_ids,
            template_id__in=tmpl_ids,
            at__lt=since,
        )
        .order_by("target_ip_id", "template_id", "-at")
        .distinct("target_ip_id", "template_id")
        .values_list("target_ip_id", "template_id", "to_status")
    ):
        opening[(str(row[0]), str(row[1]))] = row[2]

    # Every change inside the window, oldest first.
    inside: dict = {}
    for row in (
        StateTransition.objects.filter(
            tenant_id=tenant_id,
            target_ip_id__in=ip_ids,
            template_id__in=tmpl_ids,
            at__gte=since,
            at__lte=until,
        )
        .order_by("at")
        .values_list("target_ip_id", "template_id", "at", "to_status")
    ):
        inside.setdefault((str(row[0]), str(row[1])), []).append((row[2], row[3]))

    out: dict = {}
    for key in pairs:
        cursor, status = since, opening.get(key, "unknown")
        segs = []
        for at, to_status in inside.get(key, []):
            if at > cursor:
                segs.append({"start": cursor, "end": at, "status": status})
            cursor, status = at, to_status
        if until > cursor:
            segs.append({"start": cursor, "end": until, "status": status})
        out[key] = segs
    return out


def merge_worst(segment_lists) -> list[dict]:
    """One run of segments from several, each interval carrying the worst
    status among them - a device's strip from its addresses', an address's
    from its checks'. Adjacent intervals with the same status are joined."""
    lists = [s for s in segment_lists if s]
    if not lists:
        return []
    bounds = sorted({seg["start"] for s in lists for seg in s} | {seg["end"] for s in lists for seg in s})
    out: list[dict] = []
    for i in range(len(bounds) - 1):
        start, end = bounds[i], bounds[i + 1]
        present = [
            seg["status"]
            for s in lists
            for seg in s
            if seg["start"] <= start and seg["end"] >= end
        ]
        status = worst_status(present) or "unknown"
        if out and out[-1]["status"] == status and out[-1]["end"] == start:
            out[-1]["end"] = end
        else:
            out.append({"start": start, "end": end, "status": status})
    return out


def integrate(segments, *, up, down) -> dict:
    """Seconds in each class over a run of segments, plus the incident count -
    the arithmetic :mod:`uptime` reports."""
    up_s = down_s = excluded = 0.0
    incidents = 0
    prev = None
    for seg in segments:
        length = (seg["end"] - seg["start"]).total_seconds()
        status = seg["status"]
        if status in up:
            up_s += length
        elif status in down:
            down_s += length
        else:
            excluded += length
        if status in down and prev is not None and prev not in down:
            incidents += 1
        prev = status
    return {"up": up_s, "down": down_s, "excluded": excluded, "incidents": incidents}
