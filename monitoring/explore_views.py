"""The check page, the explore view and the latency page - all read from the
rollups through :mod:`monitoring.figures`, scoped like the checks list."""
from __future__ import annotations

from django.db.models import Count
from django.db.models.functions import Coalesce
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant

from .engines import SOURCE_EXPR
from .figures import figures, series, sums, window_from_params
from .history import apply_target_filters
from .models import CheckState
from .rollups import DEFAULT_FLOOR_MS, _spike_rules, baselines
from .views import CHECK_ROW_RELATED, _scope_ip_keyed, check_row

_WINDOW_PARAMS = [
    OpenApiParameter("days", OpenApiTypes.INT, OpenApiParameter.QUERY,
                     description="Last N days, day-aligned (default 7, up to 366)."),
    OpenApiParameter("hours", OpenApiTypes.INT, OpenApiParameter.QUERY,
                     description="Last N hours instead (up to 48); wins over days."),
]


def _narrower(request, tenant, params):
    """Tenant, the caller's site scope, then the shared target filters - for
    CheckState and both rollup tables alike (they share the field names)."""
    def narrow(qs):
        qs = _scope_ip_keyed(request, tenant, qs.filter(tenant=tenant))
        filtered = apply_target_filters(qs, params)
        if params.get("tag"):
            # The tag filter joins a many-to-many and de-duplicates; summing
            # over that join would count a row once per tag.
            return qs.model.objects.filter(pk__in=filtered.values("pk"))
        return filtered
    return narrow


def _window_body(win) -> dict:
    return {"since": win.since, "until": win.until, "daily": win.daily}


# ─── the check page ─────────────────────────────────────────────────────────


@extend_schema(
    summary="One check: its state, window figures, series and baseline",
    tags=["monitoring"],
    parameters=_WINDOW_PARAMS,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def check_detail_view(request, state_id):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "Not found."}, status=404)
    st = (
        _scope_ip_keyed(request, tenant, CheckState.objects.filter(tenant=tenant))
        .annotate(source=SOURCE_EXPR)
        .select_related(*CHECK_ROW_RELATED)
        .filter(pk=state_id)
        .first()
    )
    if st is None:
        return Response({"detail": "Not found."}, status=404)
    win = window_from_params(request.query_params)

    def narrow(qs):
        return qs.filter(tenant=tenant, target_ip_id=st.target_ip_id, template_id=st.template_id)

    got = sums(win, narrow).get((), {})
    factor, floors = _spike_rules(tenant.id)
    base = baselines(
        tenant.id, win.until, pairs=({st.target_ip_id}, {st.template_id})
    ).get((str(st.target_ip_id), str(st.template_id)))
    floor = floors.get(st.kind, DEFAULT_FLOOR_MS)
    return Response({
        **check_row(st),
        "template_kind": st.template.kind,
        "window": _window_body(win),
        "figures": figures(got),
        "series": series(win, narrow),
        "baseline_ms": base,
        # The line a probe must cross to count as a spike.
        "spike_threshold_ms": round(max(factor * base, base + floor), 2) if base else None,
    })


# ─── explore: one row per group ─────────────────────────────────────────────

#: group_by → (rollup/CheckState field or annotation, how to name the keys).
_SITE = Coalesce(
    "target_ip__site_id", "target_ip__prefix__site_id", "target_ip__assigned_device__site_id"
)
DIMENSIONS = {
    "site": ("_g", _SITE),
    "role": ("target_ip__assigned_device__role_id", None),
    "device_type": ("target_ip__assigned_device__device_type_id", None),
    "platform": ("target_ip__assigned_device__platform_id", None),
    "device": ("target_ip__assigned_device_id", None),
    "prefix": ("target_ip__prefix_id", None),
    "vrf": ("target_ip__vrf_id", None),
    "template": ("template_id", None),
    "kind": ("kind", None),
}


def _names(group_by: str, keys) -> dict:
    """Display name (and color, where the object has one) per group key."""
    from api.models import (
        VRF,
        Device,
        DeviceRole,
        DeviceType,
        Platform,
        Prefix,
        Site,
    )

    from .models import CheckTemplate

    ids = [k for k in keys if k is not None]
    if group_by == "kind":
        return {k: {"name": k} for k in ids}
    model, label = {
        "site": (Site, "name"), "role": (DeviceRole, "name"),
        "device_type": (DeviceType, "model"), "platform": (Platform, "name"),
        "device": (Device, "name"), "prefix": (Prefix, "cidr"), "vrf": (VRF, "name"),
        "template": (CheckTemplate, "name"),
    }[group_by]
    fields = ["id", label] + (["color"] if hasattr(model, "color") else [])
    return {
        r["id"]: {"name": str(r[label]), "color": r.get("color")}
        for r in model.objects.filter(pk__in=ids).values(*fields)
    }


@extend_schema(
    summary="Monitoring figures grouped by a dimension",
    tags=["monitoring"],
    parameters=[
        OpenApiParameter("group_by", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description=", ".join(DIMENSIONS)),
        *_WINDOW_PARAMS,
    ],
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def explore_view(request):
    params = request.query_params
    group_by = params.get("group_by") or "site"
    if group_by not in DIMENSIONS:
        return Response({"group_by": f"One of: {', '.join(DIMENSIONS)}."}, status=400)
    tenant = _get_active_tenant(request)
    win = window_from_params(params)
    if tenant is None:
        return Response({"group_by": group_by, "window": _window_body(win), "rows": []})
    field, expr = DIMENSIONS[group_by]
    base_narrow = _narrower(request, tenant, params)

    def narrow(qs):
        qs = base_narrow(qs)
        return qs.annotate(_g=expr) if expr is not None else qs

    checks = {
        r[field]: r["n"]
        for r in narrow(CheckState.objects.all()).values(field).annotate(n=Count("id")).order_by()
    }
    totals = sums(win, narrow, (field,))
    by_kind = sums(win, narrow, (field, "kind"))
    names = _names(group_by, set(checks) | {k[0] for k in totals})
    rows = []
    for key in set(checks) | {k[0] for k in totals}:
        f = figures(totals.get((key,), {}))
        latency = sorted(
            (
                {"kind": kind, **{k: v for k, v in figures(r).items()
                                  if k in ("samples", "p50", "p95", "spikes")}}
                for (g, kind), r in by_kind.items() if g == key and r.get("lat_n")
            ),
            key=lambda x: -x["samples"],
        )
        meta = names.get(key, {})
        rows.append({
            "key": None if key is None else str(key),
            "name": meta.get("name"),
            "color": meta.get("color"),
            "checks": checks.get(key, 0),
            **f,
            "latency": latency,
        })
    # Worst first; groups with nothing measured last.
    rows.sort(key=lambda r: (r["availability"] is None, r["availability"] or 0, r["name"] or ""))
    return Response({"group_by": group_by, "window": _window_body(win), "rows": rows})


# ─── latency page ───────────────────────────────────────────────────────────

OFFENDERS = 15


@extend_schema(
    summary="Latency per check kind, with the checks furthest from normal",
    tags=["monitoring"],
    parameters=[
        OpenApiParameter("kind", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description="The kind to chart (default: the busiest)."),
        *_WINDOW_PARAMS,
    ],
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def latency_view(request):
    params = request.query_params
    tenant = _get_active_tenant(request)
    win = window_from_params(params)
    empty = {"window": _window_body(win), "kinds": [], "kind": None, "series": [],
             "slowest": [], "spikiest": []}
    if tenant is None:
        return Response(empty)
    # The kind picker must not narrow the list of kinds it picks from.
    rest = params.copy()
    rest.pop("kind", None)
    narrow_all = _narrower(request, tenant, rest)
    kinds = sorted(
        (
            {"kind": k[0], **{x: v for x, v in figures(r).items()
                              if x in ("samples", "p50", "p95", "p99", "max", "spikes")}}
            for k, r in sums(win, narrow_all, ("kind",)).items() if r.get("lat_n")
        ),
        key=lambda x: -x["samples"],
    )
    if not kinds:
        return Response(empty)
    kind = params.get("kind") if params.get("kind") in {k["kind"] for k in kinds} else kinds[0]["kind"]

    def narrow(qs):
        return narrow_all(qs).filter(kind=kind)

    per_check = {
        k: figures(r)
        for k, r in sums(win, narrow, ("target_ip_id", "template_id")).items()
        if r.get("lat_n")
    }
    base = baselines(
        tenant.id, win.until,
        pairs=({k[0] for k in per_check}, {k[1] for k in per_check}),
    )
    scored = []
    for (ip_id, tmpl_id), f in per_check.items():
        b = base.get((str(ip_id), str(tmpl_id)))
        ratio = round(f["p95"] / b, 2) if b and f["p95"] is not None else None
        scored.append(((ip_id, tmpl_id), f, b, ratio))
    slowest = sorted(
        (s for s in scored if s[3] is not None), key=lambda s: -s[3]
    )[:OFFENDERS]
    spikiest = sorted(
        (s for s in scored if s[1]["spikes"]), key=lambda s: -s[1]["spikes"]
    )[:OFFENDERS]
    wanted = {s[0] for s in slowest} | {s[0] for s in spikiest}
    states = {
        (st.target_ip_id, st.template_id): st
        for st in narrow(CheckState.objects.all())
        .annotate(source=SOURCE_EXPR)
        .select_related(*CHECK_ROW_RELATED)
        .filter(target_ip_id__in={w[0] for w in wanted}, template_id__in={w[1] for w in wanted})
    }

    def rows(picked):
        out = []
        for key, f, b, ratio in picked:
            st = states.get(key)
            if st is None:  # the check is gone; its history is not worth a row
                continue
            out.append({**check_row(st), "figures": f, "baseline_ms": b, "ratio": ratio})
        return out

    return Response({
        "window": _window_body(win),
        "kinds": kinds,
        "kind": kind,
        "series": series(win, narrow),
        "slowest": rows(slowest),
        "spikiest": rows(spikiest),
    })
