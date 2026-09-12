"""Status history and timelines - what has happened, filterable.

Every endpoint here is site-aware through ``_scope_ip_keyed`` or a scoped
object fetch, for the same reason the stats are: a Site-A viewer must not
learn when Site-B's hosts went down.
"""
from __future__ import annotations

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import Device, IPAddress, Prefix
from api.views import _get_active_tenant

from .charts import (
    bucket_seconds,
    latency_series,
    per_day,
    transition_heatmap,
    transition_top,
    viewer_tz,
)
from .engines import executing_engine, source_of
from .history import (
    apply_transition_filters,
    facet_counts,
    paginate,
    transition_series,
    window,
)
from .models import CheckResult, CheckState, StateTransition
from .timeline import integrate, merge_worst, segments_for_pairs
from .views import (
    _get_ip,
    _scope_ip_keyed,
    _scoped_get,
    _viewable_child_ip_ids,
    _viewable_ips,
)

TRANSITION_FACETS = (
    "to_status", "from_status", "kind", "source", "site",
    "device_type", "role", "platform", "template", "engine",
)

_ORDERING = {
    "at": "at", "-at": "-at",
    "ip": "target_ip__ip_address", "-ip": "-target_ip__ip_address",
}


def _row(t) -> dict:
    ip = t.target_ip if t.target_ip_id else None
    device = ip.assigned_device if ip is not None and ip.assigned_device_id else None
    site = None
    if ip is not None:
        site_obj = ip.site if ip.site_id else (
            ip.prefix.site if ip.prefix_id and ip.prefix.site_id else (
                device.site if device is not None and device.site_id else None
            )
        )
        if site_obj is not None:
            site = {"id": str(site_obj.id), "name": site_obj.name}
    return {
        "id": t.id,
        "at": t.at,
        "kind": t.kind,
        "from_status": t.from_status,
        "to_status": t.to_status,
        "detail": t.detail,
        "template": {"id": str(t.template_id), "name": t.template.name} if t.template_id else None,
        "target_ip": (
            {"id": str(ip.id), "ip_address": ip.ip_address, "dns_name": ip.dns_name}
            if ip is not None else None
        ),
        "device": {"id": str(device.id), "name": device.name} if device is not None else None,
        "site": site,
        "source": source_of(t.engine if t.engine_id else None),
        "engine": {"id": str(t.engine_id), "name": t.engine.name} if t.engine_id else None,
    }


def _related(qs):
    return qs.select_related(
        "template", "engine", "target_ip", "target_ip__site", "target_ip__prefix",
        "target_ip__prefix__site", "target_ip__assigned_device",
        "target_ip__assigned_device__site",
    )


def _transitions_response(request, base, params):
    """The shared body of every transitions list: filter, count, bucket, page."""
    tz = viewer_tz(request, _get_active_tenant(request))

    def apply(b, p):
        return apply_transition_filters(b, p, tz=tz)

    qs, since, until = apply(base, params)
    ordering = _ORDERING.get(params.get("ordering", "-at"), "-at")
    qs = _related(qs).order_by(ordering, "-id")
    rows, total, page, page_size = paginate(qs, params)
    facets = facet_counts(base, params, TRANSITION_FACETS, apply)
    filtered = apply(base, params)[0]
    series, bucket = transition_series(filtered, since, until)
    # The heatmap keeps the whole week while a cell is selected; the top
    # list follows the cell like the table does.
    from .history import _without

    whole_week = apply(base, _without(params, ("dow", "hour")))[0]
    return Response({
        "count": total,
        "page": page,
        "page_size": page_size,
        "since": since,
        "until": until,
        "bucket": bucket,
        "facets": facets,
        "series": series,
        "heatmap": transition_heatmap(whole_week, tz),
        "top": transition_top(filtered, limit=50),
        "results": [_row(t) for t in rows],
    })


@extend_schema(
    summary="Status changes across the tenant, filterable and paged",
    tags=["monitoring"],
    request=None,
    responses=serializers.DictField(),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def transitions_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    base = _scope_ip_keyed(request, tenant, StateTransition.objects.filter(tenant=tenant))
    return _transitions_response(request, base, request.query_params)


@extend_schema(summary="Status changes for one address", tags=["monitoring"], request=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ip_transitions_view(request, ip_id):
    ip, tenant = _get_ip(request, ip_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if ip is None:
        return Response({"detail": "Not found."}, status=404)
    base = StateTransition.objects.filter(tenant=tenant, target_ip=ip)
    return _transitions_response(request, base, request.query_params)


@extend_schema(summary="Status changes for one device's addresses", tags=["monitoring"], request=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_transitions_view(request, device_id):
    device, tenant = _scoped_get(request, Device, "device", "view", device_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if device is None:
        return Response({"detail": "Not found."}, status=404)
    ip_ids = _viewable_ips(
        request, tenant, IPAddress.objects.filter(assigned_device=device)
    ).values_list("id", flat=True)
    base = StateTransition.objects.filter(tenant=tenant, target_ip_id__in=list(ip_ids))
    return _transitions_response(request, base, request.query_params)


@extend_schema(summary="Status changes inside one prefix", tags=["monitoring"], request=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def prefix_transitions_view(request, prefix_id):
    prefix, tenant = _scoped_get(request, Prefix, "prefix", "view", prefix_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if prefix is None:
        return Response({"detail": "Not found."}, status=404)
    ip_ids = _viewable_child_ip_ids(request, prefix, tenant)
    base = StateTransition.objects.filter(tenant=tenant, target_ip_id__in=ip_ids)
    return _transitions_response(request, base, request.query_params)


# ─── timelines ───────────────────────────────────────────────────────────

_UP = {"up", "degraded"}
_DOWN = {"down", "stale"}


def _summary(segments) -> dict:
    """The window's figures from a run of segments - the same arithmetic the
    SLA card used, so the History panel can carry them instead."""
    t = integrate(segments, up=_UP, down=_DOWN)
    measured = t["up"] + t["down"]
    return {
        "uptime_pct": round(100.0 * t["up"] / measured, 3) if measured > 0 else None,
        "incidents": t["incidents"],
        "down_seconds": round(t["down"]),
        "mttr_seconds": round(t["down"] / t["incidents"], 1) if t["incidents"] else None,
    }


def _check_rows(tenant_id, states, since, until) -> tuple[list, list]:
    """Per-check segments for a set of states, plus their merged rollup."""
    pairs = [(s.target_ip_id, s.template_id) for s in states]
    by_pair = segments_for_pairs(tenant_id, pairs, since, until)
    checks = []
    for s in states:
        segs = by_pair.get((str(s.target_ip_id), str(s.template_id)), [])
        checks.append({
            "state_id": str(s.id),
            "target_ip": {"id": str(s.target_ip_id), "ip_address": s.target_ip.ip_address},
            "template_id": str(s.template_id),
            "template_name": s.template.name if s.template_id else None,
            "kind": s.kind,
            # Who *runs* it, not what it is bound to: a ping on a
            # Zabbix-bound address is the core's own.
            "source": source_of(executing_engine(s)),
            "segments": segs,
            **_summary(segs),
        })
    return checks, merge_worst([c["segments"] for c in checks])


@extend_schema(summary="Status over time for one address", tags=["monitoring"], request=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ip_timeline_view(request, ip_id):
    ip, tenant = _get_ip(request, ip_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if ip is None:
        return Response({"detail": "Not found."}, status=404)
    since, until = window(request.query_params)
    states = list(
        CheckState.objects.filter(target_ip=ip).select_related("template", "target_ip", "engine")
    )
    checks, rollup = _check_rows(tenant.id, states, since, until)
    return Response({
        "since": since, "until": until, "rollup": rollup, "checks": checks,
        "summary": _summary(rollup),
        "days": per_day(rollup, since, until, viewer_tz(request, tenant)),
    })


@extend_schema(summary="Status over time for one device", tags=["monitoring"], request=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_timeline_view(request, device_id):
    device, tenant = _scoped_get(request, Device, "device", "view", device_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if device is None:
        return Response({"detail": "Not found."}, status=404)
    since, until = window(request.query_params)
    ip_ids = list(
        _viewable_ips(
            request, tenant, IPAddress.objects.filter(assigned_device=device)
        ).values_list("id", flat=True)
    )
    states = list(
        CheckState.objects.filter(target_ip_id__in=ip_ids)
        .select_related("template", "target_ip", "engine")
        .order_by("target_ip__ip_address")
    )
    checks, rollup = _check_rows(tenant.id, states, since, until)
    per_ip: dict = {}
    for c in checks:
        per_ip.setdefault(c["target_ip"]["id"], {"ip": c["target_ip"], "lists": []})
        per_ip[c["target_ip"]["id"]]["lists"].append(c["segments"])
    ips = []
    for v in per_ip.values():
        merged = merge_worst(v["lists"])
        ips.append({
            "id": v["ip"]["id"], "ip_address": v["ip"]["ip_address"],
            "rollup": merged, **_summary(merged),
        })
    return Response({
        "since": since, "until": until, "rollup": rollup, "ips": ips, "checks": checks,
        "summary": _summary(rollup),
        "days": per_day(rollup, since, until, viewer_tz(request, tenant)),
    })


@extend_schema(
    summary="Status over time for a set of checks (list strips)",
    tags=["monitoring"],
    request=serializers.DictField(),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def timeline_batch_view(request):
    """``{states: [ids], days}`` → ``{segments: {state_id: [seg]}}``.

    Two queries for a page of two hundred rows, which is why a list asks in
    one go rather than a request per row.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    ids = request.data.get("states") or []
    if not isinstance(ids, list) or len(ids) > 200:
        return Response({"detail": "states: a list of at most 200 ids."}, status=400)
    since, until = window(request.data)
    states = list(
        _scope_ip_keyed(request, tenant, CheckState.objects.filter(tenant=tenant, id__in=ids))
    )
    by_pair = segments_for_pairs(
        tenant.id, [(s.target_ip_id, s.template_id) for s in states], since, until
    )
    return Response({
        "since": since,
        "until": until,
        "segments": {
            str(s.id): by_pair.get((str(s.target_ip_id), str(s.template_id)), [])
            for s in states
        },
    })


@extend_schema(summary="Latency over time for one check on an address", tags=["monitoring"], request=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ip_latency_view(request, ip_id):
    """``?template=<id>&hours=24|168|720`` → buckets of average / min / max
    latency and loss. Buckets follow the window: five minutes over a day, an
    hour over a week, six hours over a month."""
    ip, tenant = _get_ip(request, ip_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if ip is None:
        return Response({"detail": "Not found."}, status=404)
    hours = request.query_params.get("hours")
    hours = int(hours) if hours in ("24", "168", "720") else 24
    from datetime import timedelta

    from django.utils import timezone

    until = timezone.now()
    since = until - timedelta(hours=hours)
    qs = CheckResult.objects.filter(target_ip=ip)
    template = (request.query_params.get("template") or "").strip()
    if template:
        qs = qs.filter(template_id=template)
    bucket = bucket_seconds(hours)
    return Response({
        "since": since, "until": until, "bucket_seconds": bucket,
        "points": latency_series(qs, since, until, bucket),
    })
