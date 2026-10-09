"""Give back the opening status that the transition prune took (#356).

Before 0.17.2 the daily prune deleted every status change older than the
retention, including each check's newest one - the status its retained
window opens with. A check that had not changed since then reads as unknown
in its timeline, rollups, uptime and SLA. The prune keeps that row now; this
puts it back where it is already gone.

A check needs one when its earliest remaining change is after the cutoff
and does not start from unknown (or it has no changes left and a known
status). The status it opened with is that change's ``from_status`` (or the
current status). It is dated:

* with no changes left, at ``CheckState.since`` - when the current status
  began - or at the cutoff when that is not set;
* otherwise at the cutoff. Everything before the last prune's cutoff was
  deleted and nothing between it and the earliest remaining change, so that
  status held from at least the cutoff on.

Closed rollup records of those checks written while the opening was missing
are recomputed: the ones wholly between the restored opening and the
earliest remaining change hold that one status for the whole bucket; the
ones the two moments fall inside are recomputed from the changes. Open
records are rewritten by the rollup timer anyway.

A restored row starts from unknown, so running this again finds nothing to
do. A fresh install has no checks and nothing happens.
"""

from datetime import timedelta

from django.conf import settings
from django.db import migrations
from django.utils import timezone

EDGE = timedelta(microseconds=1)
HOUR = timedelta(hours=1)
DAY = timedelta(days=1)
REASON = "opening status restored after history was pruned"
_SECONDS_FIELD = {
    "up": "up_s", "down": "down_s", "degraded": "degraded_s",
    "stale": "stale_s", "unknown": "unknown_s", "skipped": "unknown_s",
}
_FIELDS = ("up_s", "down_s", "degraded_s", "stale_s", "unknown_s")
_DOWN_CLASS = {"down", "stale"}


def _openings(CheckState, StateTransition, cutoff):
    """``[(state row, opening status, at, first remaining change at)]``."""
    first = {}
    for ip_id, tmpl_id, at, frm in (
        StateTransition.objects.filter(template_id__isnull=False)
        .order_by("target_ip_id", "template_id", "at", "pk")
        .distinct("target_ip_id", "template_id")
        .values_list("target_ip_id", "template_id", "at", "from_status")
        .iterator(chunk_size=5000)
    ):
        first[(ip_id, tmpl_id)] = (at, frm)
    out = []
    for st in (
        CheckState.objects.order_by("pk")
        .values("tenant_id", "target_ip_id", "template_id", "kind", "status", "since")
        .iterator(chunk_size=5000)
    ):
        earliest = first.get((st["target_ip_id"], st["template_id"]))
        if earliest is None:
            if st["status"] == "unknown":
                continue
            out.append((st, st["status"], st["since"] or cutoff, None))
            continue
        at, frm = earliest
        if at <= cutoff or frm == "unknown":
            # It already has its opening, or its history starts at the beginning.
            continue
        out.append((st, frm, cutoff, at))
    return out


def _recompute(StateTransition, st, bucket, size):
    """Seconds per status and incidents for one closed bucket, the way the
    rollups count them (monitoring.rollups.roll, counted=False)."""
    pair = {
        "tenant_id": st["tenant_id"], "target_ip_id": st["target_ip_id"],
        "template_id": st["template_id"],
    }
    since, until = bucket - EDGE, bucket + size
    opening = (
        StateTransition.objects.filter(at__lt=since, **pair)
        .order_by("-at").values_list("to_status", flat=True).first()
    )
    cursor, status, segs = since, opening or "unknown", []
    for at, to in (
        StateTransition.objects.filter(at__gte=since, at__lte=until, **pair)
        .order_by("at").values_list("at", "to_status")
    ):
        if at > cursor:
            segs.append((cursor, at, status))
        cursor, status = at, to
    if until > cursor:
        segs.append((cursor, until, status))
    secs = dict.fromkeys(_FIELDS, 0.0)
    incidents = blind = 0
    prev = None
    for start, end, s in segs:
        length = (end - max(start, bucket)).total_seconds()
        if length > 0:
            secs[_SECONDS_FIELD.get(s, "unknown_s")] += length
        if prev is not None:
            if s == "down" and prev != "down":
                incidents += 1
            if s in _DOWN_CLASS and prev not in _DOWN_CLASS:
                blind += 1
        prev = s
    return {**secs, "incidents": incidents, "blind_incidents": blind}


def _repair_rollups(model, size, StateTransition, st, status, start, end):
    """Rewrite the closed records of one check that fell between ``start``
    (the restored opening) and ``end`` (its earliest remaining change, or
    None for none)."""
    rows = model.objects.filter(
        target_ip_id=st["target_ip_id"], template_id=st["template_id"], closed=True,
        bucket__gt=start - size,
    )
    if end is not None:
        rows = rows.filter(bucket__lte=end)
    whole = rows.filter(bucket__gte=start)
    if end is not None:
        whole = whole.filter(bucket__lte=end - size)
    held = dict.fromkeys(_FIELDS, 0.0)
    held[_SECONDS_FIELD.get(status, "unknown_s")] = size.total_seconds()
    whole.update(**held, incidents=0, blind_incidents=0)
    edges = rows.exclude(pk__in=whole.values("pk")).values_list("pk", "bucket")
    for pk, bucket in list(edges):
        model.objects.filter(pk=pk).update(**_recompute(StateTransition, st, bucket, size))


def restore_openings(apps, schema_editor, now=None):
    CheckState = apps.get_model("monitoring", "CheckState")
    StateTransition = apps.get_model("monitoring", "StateTransition")
    Hourly = apps.get_model("monitoring", "CheckRollupHourly")
    Daily = apps.get_model("monitoring", "CheckRollupDaily")

    now = now or timezone.now()
    days = int(getattr(settings, "MONITORING_TRANSITION_RETENTION_DAYS", 365))
    cutoff = now - timedelta(days=days)
    todo = _openings(CheckState, StateTransition, cutoff)
    if not todo:
        return
    StateTransition.objects.bulk_create(
        [
            StateTransition(
                tenant_id=st["tenant_id"], target_ip_id=st["target_ip_id"],
                template_id=st["template_id"], kind=st["kind"], from_status="unknown",
                to_status=status, at=at, detail={"reason": REASON},
            )
            for st, status, at, _end in todo
        ],
        batch_size=2000,
    )
    for st, status, at, end in todo:
        for model, size in ((Hourly, HOUR), (Daily, DAY)):
            _repair_rollups(model, size, StateTransition, st, status, at, end)


class Migration(migrations.Migration):

    dependencies = [
        ("monitoring", "0109_upgrade_db_defaults"),
    ]

    operations = [
        migrations.RunPython(restore_openings, migrations.RunPython.noop),
    ]
