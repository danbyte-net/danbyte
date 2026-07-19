"""Monitoring JSON endpoints for the SPA, mounted under ``/api/monitoring/``.

Milestone 2 ships ``check-now``. CRUD for templates/assignments and the
history/state read endpoints land in later milestones.
"""
from __future__ import annotations

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

import ipaddress as _ip

from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    Location,
    Prefix,
    Site,
)
from api.views import _get_active_tenant
from auth_api import rbac

from django.db.models import Count, Q

from django.utils import timezone

from .models import (
    Alert,
    CheckResult,
    CheckState,
    DeviceSnmp,
    MonitoringSettings,
    SnmpProfile,
    SnmpProfileBinding,
    StateTransition,
)
from .resolver import resolve_effective_checks
from .rollup import status_counts, worst_status
from .runner import check_now
from .serializers import (
    AlertSerializer,
    CheckResultSerializer,
    DeviceSnmpSerializer,
    MonitoringSettingsSerializer,
    StateTransitionSerializer,
)
from danbyte_checks.snmp_facts import (
    SnmpFactsError,
    fetch_interfaces_sync,
    fetch_system_facts_sync,
)
from .snmp_resolve import resolve_device_profile
from .snmp_poll import poll_device
from .snmp_util import compute_device_utilization
from .snmp_drift import apply_drift_action, compute_device_drift, sync_device_from_snmp
from .nmap_sweep import NmapError, sweep_prefix

# How many recent results feed the per-check sparkline.
SPARK_POINTS = 30
# Cap the per-IP grid on a prefix page so a huge prefix can't return 100k rows.
GRID_CAP = 1000


def _child_ip_ids(prefix, tenant) -> list:
    """IDs of existing IPs in the prefix's tenant + VRF contained by its CIDR."""
    net = prefix.network
    if net is None:
        return []
    out = []
    for ip in IPAddress.objects.filter(
        tenant=tenant, vrf_id=prefix.vrf_id
    ).only("id", "ip_address"):
        try:
            if _ip.ip_address(ip.ip_address) in net:
                out.append(ip.id)
        except (ValueError, TypeError):
            continue
    return out


def _viewable_ips(request, tenant, qs):
    """Apply the caller's IP-address VIEW grant to an already tenant-bound qs."""
    return rbac.restrict_queryset(
        qs.filter(tenant=tenant),
        request.user,
        tenant,
        "ipaddress",
        "view",
    )


def _viewable_child_ip_ids(request, prefix, tenant) -> list:
    child_ids = _child_ip_ids(prefix, tenant)
    return list(
        _viewable_ips(
            request,
            tenant,
            IPAddress.objects.filter(id__in=child_ids),
        ).values_list("id", flat=True)
    )


def _viewable_exclusion_ids(request, tenant, assignment) -> list[str]:
    return [
        str(pk)
        for pk in _viewable_ips(
            request,
            tenant,
            assignment.exclusions.filter(tenant=tenant),
        ).values_list("id", flat=True)
    ]


def _scoped_get(request, model, slug, action, obj_id):
    """Fetch a tenant object by id, restricted to the caller's RBAC **row/site**
    scope for ``(slug, action)`` — not just type-level. Returns
    ``(obj|None, tenant)``. This is what closes the cross-site bypass: a viewer
    scoped to Site A gets ``None`` for a Site B object, same as the list views."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, None
    qs = rbac.restrict_queryset(
        model.objects.filter(tenant=tenant),
        request.user, tenant, slug, action,
    )
    return qs.filter(id=obj_id).first(), tenant


def _get_ip(request, ip_id):
    """Tenant + RBAC-row-scoped IP fetch (view)."""
    return _scoped_get(request, IPAddress, "ipaddress", "view", ip_id)


def _scope_ip_keyed(request, tenant, qs, field="target_ip"):
    """Restrict an IP-keyed monitoring queryset (CheckState, CheckResult, Alert,
    StateTransition) to the IPs the caller may **view** — site-aware, via
    ``rbac.row_filter`` on ``ipaddress``. None grant → ``.none()``; unscoped
    grant → unchanged; scoped grant → ``field__in`` the viewable IPs. This is
    what stops a Site-A viewer from seeing Site-B checks/alerts/stats."""
    q = rbac.row_filter(request.user, tenant, "ipaddress", "view")
    if q is None:
        return qs.none()
    if q is True:
        return qs
    return qs.filter(
        **{f"{field}__in": IPAddress.objects.filter(tenant=tenant).filter(q)}
    )


def _scope_device_keyed(request, tenant, qs, field="device"):
    """Restrict a device-keyed monitoring queryset (DeviceSnmp) to the devices
    the caller may **view** — site-aware, via ``rbac.row_filter`` on
    ``device``. Same None/True/scoped semantics as :func:`_scope_ip_keyed`."""
    q = rbac.row_filter(request.user, tenant, "device", "view")
    if q is None:
        return qs.none()
    if q is True:
        return qs
    return qs.filter(
        **{f"{field}__in": Device.objects.filter(tenant=tenant).filter(q)}
    )


def _alert_base(request, tenant):
    """Tenant alerts scoped to the IPs the caller may view (site-aware, via the
    alert's target_ip). None grant → no alerts; unscoped grant → all."""
    return _scope_ip_keyed(request, tenant, Alert.objects.filter(tenant=tenant))


def _can_discover_into_prefix(request, tenant, prefix) -> bool:
    """Whether one IP-add grant covers the rows discovery will actually create.

    A prefix only propagates its site when auto_assign_site is enabled.
    Constrained add grants fail closed because responder addresses are unknown
    until after the scan; the normal IP form can evaluate those exact rows.
    """
    if request.user.is_superuser:
        return True
    destination_site_id = (
        prefix.site_id if prefix.auto_assign_site and prefix.site_id else None
    )
    for perm in rbac.applicable_permissions(request.user, tenant):
        types = perm.object_types or []
        if "ipaddress" not in types and "*" not in types:
            continue
        if "add" not in (perm.actions or []) or perm.constraints:
            continue
        site_ids = {site.pk for site in perm.sites.all()}
        if not site_ids:
            return True
        if destination_site_id is not None and destination_site_id in site_ids:
            return True
    return False


def _require(request, slug, action):
    """403 unless the caller holds ``action`` on ``slug`` (type-level) in the
    active tenant. Use for endpoints that don't fetch one specific row (e.g.
    discovery, which adds rows). Row-scoped endpoints use ``_scoped_get``."""
    tenant = _get_active_tenant(request)
    if request.user.is_superuser:
        return None
    if not rbac.has_action(request.user, tenant, slug, action):
        return Response({"detail": "Not permitted."}, status=403)
    return None


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def check_now_view(request, ip_id):
    """Run every effective check for one IP immediately and return the outcomes.

    Tenant-safe: the IP must belong to the caller's active tenant.
    """
    ip, tenant = _get_ip(request, ip_id)  # tenant + RBAC row/site scoped
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if ip is None:
        return Response({"detail": "Not found."}, status=404)

    results = check_now(ip)
    return Response(
        {
            "ip_id": str(ip.id),
            "ip_address": ip.ip_address,
            "count": len(results),
            "results": results,
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ip_checks_view(request, ip_id):
    """Effective checks for an IP, each joined with its current CheckState and a
    short latency/status sparkline. Resolves on the fly, so checks show up here
    immediately after assignment — before the materialiser has run."""
    ip, tenant = _get_ip(request, ip_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if ip is None:
        return Response({"detail": "Not found."}, status=404)
    if (denied := _require(request, "ipaddress", "view")):
        return denied

    resolved = resolve_effective_checks(ip)
    states = {
        s.template_id: s
        for s in CheckState.objects.filter(target_ip=ip).select_related("template")
    }

    checks = []
    for rc in resolved:
        st = states.get(rc.template.id)
        spark = list(
            CheckResult.objects.filter(target_ip=ip, template=rc.template)
            .order_by("-timestamp")[:SPARK_POINTS]
            .values("timestamp", "status", "latency_ms")
        )
        spark.reverse()
        # Policy-sourced checks have no CheckAssignment — they're configured on
        # the Monitoring → Configuration policy, not per-IP.
        a = rc.assignment
        checks.append(
            {
                "template_id": str(rc.template.id),
                "template_name": rc.template.name,
                "kind": rc.kind,
                "source": rc.source,
                "prefix_id": str(rc.prefix.id) if rc.prefix else None,
                "assignment_id": str(a.id) if a else None,
                "interval_seconds": rc.interval_seconds,
                "degraded_enabled": rc.degraded_enabled,
                "params": rc.params,
                # Per-assignment override editing (M18) — only meaningful to edit
                # from the IP when the check is direct (not inherited/policy).
                "enabled": a.enabled if a else True,
                "schedule_mode": a.schedule_mode if a else None,
                "overrides": (a.overrides or {}) if a else {},
                "template_defaults": {
                    "interval_seconds": rc.template.interval_seconds,
                    "rise": rc.template.rise,
                    "fall": rc.template.fall,
                },
                "state": (
                    {
                        "status": st.status,
                        "since": st.since,
                        "last_checked": st.last_checked,
                        "last_latency_ms": st.last_latency_ms,
                        "consecutive_success": st.consecutive_success,
                        "consecutive_fail": st.consecutive_fail,
                        "next_run": st.next_run,
                    }
                    if st
                    else None
                ),
                "sparkline": spark,
            }
        )
    return Response({"ip_id": str(ip.id), "ip_address": ip.ip_address, "checks": checks})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ip_history_view(request, ip_id):
    """Recent CheckResult rows for an IP, optionally filtered to one template."""
    ip, tenant = _get_ip(request, ip_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if ip is None:
        return Response({"detail": "Not found."}, status=404)
    if (denied := _require(request, "ipaddress", "view")):
        return denied

    qs = CheckResult.objects.filter(target_ip=ip).order_by("-timestamp")
    template = request.query_params.get("template")
    if template:
        qs = qs.filter(template_id=template)
    status_f = request.query_params.get("status")
    if status_f:
        qs = qs.filter(status=status_f)
    try:
        limit = min(int(request.query_params.get("limit", 100)), 1000)
    except ValueError:
        limit = 100
    rows = list(qs[:limit])
    return Response(
        {"count": len(rows), "results": CheckResultSerializer(rows, many=True).data}
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ip_uptime_view(request, ip_id):
    """Time-weighted uptime / SLA for an IP over a window (``?days=30``)."""
    from .uptime import ip_uptime

    ip, tenant = _get_ip(request, ip_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if ip is None:
        return Response({"detail": "Not found."}, status=404)
    if (denied := _require(request, "ipaddress", "view")):
        return denied
    try:
        days = int(request.query_params.get("days", 30))
    except ValueError:
        days = 30
    days = max(1, min(days, 365))
    return Response(ip_uptime(ip, days=days))


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def prefix_checks_view(request, prefix_id):
    """Monitoring for a prefix: its prefix-level assignments, a roll-up across
    child IPs, and a per-IP status grid."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    prefix, tenant = _scoped_get(request, Prefix, "prefix", "view", prefix_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if prefix is None:
        return Response({"detail": "Not found."}, status=404)

    from .models import CheckAssignment

    assignments = (
        CheckAssignment.objects.filter(tenant=tenant, prefix=prefix)
        .select_related("template")
        .prefetch_related("exclusions")
    )
    assignment_rows = [
        {
            "id": str(a.id),
            "template": {
                "id": str(a.template_id),
                "name": a.template.name,
                "kind": a.template.kind,
                # Template defaults — the UI shows these as override placeholders.
                "interval_seconds": a.template.interval_seconds,
                "rise": a.template.rise,
                "fall": a.template.fall,
            },
            "enabled": a.enabled,
            "apply_to_children": a.apply_to_children,
            "schedule_mode": a.schedule_mode,
            "overrides": a.overrides or {},
            # Effective interval = override if set, else the template's.
            "interval_seconds": (a.overrides or {}).get(
                "interval_seconds", a.template.interval_seconds
            ),
            "exclusions": _viewable_exclusion_ids(request, tenant, a),
        }
        for a in assignments
    ]

    child_ids = _viewable_child_ip_ids(request, prefix, tenant)
    # Scope the child roll-up to IPs the caller may view — the prefix being
    # viewable doesn't imply every child IP is (grants can differ per type).
    states = list(
        _scope_ip_keyed(
            request, tenant,
            CheckState.objects.filter(target_ip_id__in=child_ids),
        )
        .select_related("target_ip")
        .values("target_ip_id", "target_ip__ip_address", "status")
    )
    by_ip: dict = {}
    for s in states:
        e = by_ip.setdefault(
            s["target_ip_id"],
            {"id": str(s["target_ip_id"]), "ip_address": s["target_ip__ip_address"], "statuses": []},
        )
        e["statuses"].append(s["status"])

    grid = sorted(
        (
            {
                "id": e["id"],
                "ip_address": e["ip_address"],
                "status": worst_status(e["statuses"]),
                "checks": len(e["statuses"]),
                "counts": status_counts(e["statuses"]),
            }
            for e in by_ip.values()
        ),
        key=lambda r: r["ip_address"],
    )
    rollup_status = worst_status([g["status"] for g in grid]) if grid else None

    # Which engine (Outpost, or the built-in local) monitors this prefix.
    from .engines import engine_for_prefix

    engine = engine_for_prefix(prefix)

    return Response(
        {
            "prefix_id": str(prefix.id),
            "cidr": prefix.cidr,
            "engine": {
                "id": str(engine.id),
                "name": engine.name,
                "is_local": engine.is_local,
            },
            "last_discovered_at": prefix.last_discovered_at,
            "assignments": assignment_rows,
            "rollup": {
                "status": rollup_status,
                "counts": status_counts([g["status"] for g in grid]),
                "monitored_ips": len(grid),
                "total_ips": len(child_ids),
            },
            "ips": grid[:GRID_CAP],
            "truncated": len(grid) > GRID_CAP,
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_checks_view(request, device_id):
    """Monitoring for a device: a roll-up across every IP assigned to it, plus a
    per-IP status grid. Checks attach to IPs (and a service's check lives on its
    IP), so a device has no checks of its own — this aggregates its IPs'."""
    device, tenant = _scoped_get(request, Device, "device", "view", device_id)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if device is None:
        return Response({"detail": "Not found."}, status=404)

    ip_ids = list(
        _viewable_ips(
            request,
            tenant,
            IPAddress.objects.filter(assigned_device=device),
        ).values_list(
            "id", flat=True
        )
    )
    # Scope the per-IP roll-up to IPs the caller may view — device.view doesn't
    # imply ipaddress.view on every assigned IP (grants can differ per type).
    states = list(
        _scope_ip_keyed(
            request, tenant,
            CheckState.objects.filter(target_ip_id__in=ip_ids),
        )
        .select_related("target_ip")
        .values("target_ip_id", "target_ip__ip_address", "status")
    )
    by_ip: dict = {}
    for s in states:
        e = by_ip.setdefault(
            s["target_ip_id"],
            {
                "id": str(s["target_ip_id"]),
                "ip_address": s["target_ip__ip_address"],
                "statuses": [],
            },
        )
        e["statuses"].append(s["status"])

    grid = sorted(
        (
            {
                "id": e["id"],
                "ip_address": e["ip_address"],
                "status": worst_status(e["statuses"]),
                "checks": len(e["statuses"]),
                "counts": status_counts(e["statuses"]),
            }
            for e in by_ip.values()
        ),
        key=lambda r: r["ip_address"],
    )
    rollup_status = worst_status([g["status"] for g in grid]) if grid else None

    return Response(
        {
            "device_id": str(device.id),
            "name": device.name,
            "rollup": {
                "status": rollup_status,
                "counts": status_counts([g["status"] for g in grid]),
                "monitored_ips": len(grid),
                "total_ips": len(ip_ids),
            },
            "ips": grid[:GRID_CAP],
            "truncated": len(grid) > GRID_CAP,
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def prefix_discover_view(request, prefix_id):
    """Discover responders on one prefix **now**.

    Small subnets sweep synchronously and return a summary (scanned / responders
    / created) so the UI can show "created N IPs" instantly. Larger subnets are
    enqueued onto an RQ worker (like Check-now) and return immediately with
    ``{"queued": true, "scanned": <host_count>}`` — a synchronous sweep of a
    /16 takes minutes and would blow past the proxy timeout (502). Cheap guards
    (bad CIDR / IPv6 / too-large) still resolve synchronously."""
    import ipaddress

    from django.conf import settings as dj_settings

    from .discovery import discover_prefix, enqueue_prefix_discovery
    from .models import MonitoringSettings

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    # Discovery seeds IPAddress rows — a source-of-truth write, so it needs the
    # same grant the IP form does (not just tenant membership).
    if not rbac.has_action(request.user, tenant, "ipaddress", "add"):
        return Response(
            {"detail": "You do not have permission to add IP addresses."},
            status=403,
        )
    # Site-aware: the prefix must be in the caller's row/site scope, or a
    # Site-A grant could seed IPs into a Site-B prefix by id. 404 (non-leaking).
    prefix = (
        rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant).select_related("vrf"),
            request.user, tenant, "prefix", "view",
        )
        .filter(id=prefix_id)
        .first()
    )
    if prefix is None:
        return Response({"detail": "Not found."}, status=404)
    if not _can_discover_into_prefix(request, tenant, prefix):
        return Response(
            {"detail": "Your IP-add grant does not cover rows created here."},
            status=403,
        )

    msettings = MonitoringSettings.for_tenant(tenant)

    # Cheap guards mirror discover_prefix so skips return instantly (no sweep).
    try:
        net = ipaddress.ip_network(prefix.cidr, strict=False)
    except ValueError:
        return Response({"skipped": "bad_cidr", "created": 0})
    if net.version != 4:
        return Response({"skipped": "ipv6", "created": 0})
    if net.prefixlen < msettings.discovery_min_prefix_length:
        return Response({"skipped": "too_large", "created": 0})

    # A prefix served by a remote Outpost is swept **there**, not on the core
    # (the core can't reach the remote subnet). Flag it + poke the Outpost to
    # sweep on its next poll; the UI then waits for the result.
    from django.utils import timezone

    from .engines import engine_for_prefix
    from .models import MonitoringEngine

    engine = engine_for_prefix(prefix)
    if engine.kind == MonitoringEngine.REMOTE:
        Prefix.objects.filter(pk=prefix.pk).update(last_discovered_at=None)
        MonitoringEngine.objects.filter(pk=engine.pk).update(
            sweep_requested_at=timezone.now()
        )
        return Response(
            {"queued_on_outpost": True,
             "engine": {"id": str(engine.id), "name": engine.name}},
            status=202,
        )

    host_count = max(net.num_addresses - 2, 1) if net.prefixlen <= 30 else net.num_addresses
    sync_limit = getattr(dj_settings, "MONITORING_DISCOVER_SYNC_LIMIT", 4096)
    if host_count > sync_limit:
        # Fan the sweep out as one job per shard so the worker pool runs them
        # in parallel instead of one job grinding the whole range. The run_id
        # lets the UI poll live progress.
        res = enqueue_prefix_discovery(prefix, owner_id=request.user.pk)
        return Response(
            {"queued": True, "scanned": res.get("scanned", host_count),
             "shards": res.get("shards", 0), "run_id": res.get("run_id")},
            status=202,
        )

    return Response(discover_prefix(prefix, msettings))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bulk_discover_view(request):
    """Discover responders across many selected prefixes at once. Always fans
    out onto the worker pool under a single `run_id` the UI polls (no inline
    path — bulk is for big selections). Skips IPv6 / too-large prefixes."""
    from .discovery import enqueue_bulk_discovery
    from .models import MonitoringSettings

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if not rbac.has_action(request.user, tenant, "ipaddress", "add"):
        return Response(
            {"detail": "You do not have permission to add IP addresses."},
            status=403,
        )
    prefix_ids = request.data.get("prefix_ids") or []
    # Site-aware: only prefixes in the caller's row/site scope are discovered,
    # so a Site-A grant can't seed IPs into Site-B prefixes by id.
    prefixes = [
        p for p in rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant, id__in=prefix_ids).select_related("vrf"),
            request.user, tenant, "prefix", "view",
        )
        if _can_discover_into_prefix(request, tenant, p)
    ]
    if not prefixes:
        return Response({"queued": False, "scanned": 0, "shards": 0, "skipped": 0})
    res = enqueue_bulk_discovery(
        prefixes,
        MonitoringSettings.for_tenant(tenant),
        owner_id=request.user.pk,
    )
    return Response(
        {"queued": bool(res["run_id"]), **res},
        status=202 if res["run_id"] else 200,
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discover_run_view(request, run_id):
    """Live progress for a fanned-out discovery run (polled by the UI). Returns
    counters + a `done` flag; reports `done` for an unknown/expired run so the
    poller stops cleanly."""
    from .discovery import run_progress

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    prog = run_progress(run_id)
    # Unknown/expired OR a run started by another tenant → report "done" so the
    # poller stops without revealing another tenant's run (its cidr/counters).
    wrong_owner = (
        not request.user.is_superuser
        and prog is not None
        and prog.get("owner") != str(request.user.pk)
    )
    if (
        prog is None
        or prog.get("tenant") != str(tenant.id)
        or wrong_owner
    ):
        return Response({"run_id": run_id, "found": False, "done": True, "percent": 100})
    prog["found"] = True
    prog.pop("tenant", None)
    prog.pop("owner", None)
    return Response(prog)


@api_view(["GET", "PUT", "PATCH"])
@permission_classes([IsAuthenticated])
def settings_view(request):
    """Get or update the active tenant's monitoring settings (singleton row)."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    obj = MonitoringSettings.for_tenant(tenant)
    if request.method == "GET":
        return Response(MonitoringSettingsSerializer(obj).data)
    # Monitoring settings are a tenant-wide admin setting — only admins may
    # change them (matches the Settings → Admin UI placement).
    from auth_api.permissions import can_manage_admin

    if not can_manage_admin(request.user, tenant):
        return Response({"detail": "Admin access required."}, status=403)
    ser = MonitoringSettingsSerializer(
        obj, data=request.data, partial=request.method == "PATCH"
    )
    ser.is_valid(raise_exception=True)
    # Guard: skip / flap-exclude statuses must belong to the active tenant.
    for field in ("skip_ip_statuses", "flap_exclude_ip_statuses"):
        for st in ser.validated_data.get(field, []):
            if st.tenant_id != tenant.id:
                return Response(
                    {field: "A status is not in the active tenant."},
                    status=400,
                )
    engine = ser.validated_data.get("default_engine")
    if engine is not None and engine.tenant_id != tenant.id:
        return Response(
            {"default_engine": "Not in the active tenant."}, status=400
        )
    ser.save()
    return Response(ser.data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def engine_health_view(request):
    """Stale monitoring engines for the active tenant (issue #154).

    Drives the "engine unreachable" banner: any enabled remote engine with
    ``stale_since`` set (stamped by the dispatcher's health sweep). Readable
    by every authenticated user — operational status, not engine management.
    """
    from django.utils import timezone

    from .models import CheckState, MonitoringEngine

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    now = timezone.now()
    stale = [
        {
            "id": str(eng.id),
            "name": eng.name,
            "stale_since": eng.stale_since.isoformat(),
            "last_seen_at": (
                eng.last_seen_at.isoformat() if eng.last_seen_at else None
            ),
            "stalled_checks": CheckState.objects.filter(
                engine=eng, next_run__lte=now
            ).count(),
        }
        for eng in MonitoringEngine.objects.filter(
            tenant=tenant, enabled=True, stale_since__isnull=False
        )
    ]
    return Response({"stale_engines": stale})


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def engine_binding_view(request, scope, object_id):
    """Read/write the monitoring engine bound to a site/location/prefix.

    GET returns ``{engine_id}``; PUT ``{engine_id}`` sets it (null clears →
    inherit). Prefix bindings drive subnet discovery and prefix-policy checks.
    """
    from auth_api.object_types import model_for
    from auth_api.permissions import can_manage_admin

    from .engines import binding_engine_id, set_binding
    from .models import MonitoringEngine, MonitoringEngineBinding

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if scope not in (
        MonitoringEngineBinding.SCOPE_SITE,
        MonitoringEngineBinding.SCOPE_LOCATION,
        MonitoringEngineBinding.SCOPE_PREFIX,
    ):
        return Response({"detail": "Unknown scope."}, status=400)

    # Row/site scope the bound object itself (the scope string is the RBAC slug):
    # a Site-A grant must not read or rebind a Site-B site/location/prefix by id.
    # Deployment/tenant admins bypass (they hold the wildcard grant anyway).
    is_admin = can_manage_admin(request.user, tenant)
    model = model_for(scope)

    def _in_scope(action: str) -> bool:
        if is_admin or model is None:
            return True
        return (
            rbac.restrict_queryset(
                model.objects.filter(tenant=tenant),
                request.user, tenant, scope, action,
            )
            .filter(id=object_id)
            .exists()
        )

    if request.method == "GET":
        if not _in_scope("view"):
            return Response({"detail": "Not found."}, status=404)
        return Response({"engine_id": binding_engine_id(tenant, scope, object_id)})

    # Assigning an engine is a change to the scoped object — gate on that (or admin).
    if not (is_admin or rbac.has_action(request.user, tenant, scope, "change")):
        return Response({"detail": "Not allowed."}, status=403)
    if not _in_scope("change"):
        return Response({"detail": "Not found."}, status=404)
    eid = request.data.get("engine_id")
    engine = None
    if eid:
        engine = MonitoringEngine.objects.filter(id=eid, tenant=tenant).first()
        if engine is None:
            return Response({"engine_id": "Not found."}, status=400)
    set_binding(tenant, scope, object_id, engine)
    return Response({"engine_id": str(engine.id) if engine else None})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def stats_view(request):
    """Overall monitoring stats for the active tenant — drives the Monitoring
    dashboard: status + kind breakdowns, totals, and recent transitions."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)

    # Site-aware: the dashboard counts/series must reflect only the IPs the
    # caller may view, or a Site-A viewer would learn Site-B's totals.
    states = _scope_ip_keyed(request, tenant, CheckState.objects.filter(tenant=tenant))
    by_status = {
        row["status"]: row["n"]
        for row in states.values("status").annotate(n=Count("id"))
    }
    by_kind = {
        row["kind"]: row["n"]
        for row in states.values("kind").annotate(n=Count("id"))
    }
    total_states = sum(by_status.values())
    monitored_ips = states.values("target_ip_id").distinct().count()

    recent = (
        _scope_ip_keyed(request, tenant, StateTransition.objects.filter(tenant=tenant))
        .select_related("template", "target_ip")
        .order_by("-at")[:20]
    )

    return Response(
        {
            "by_status": by_status,
            "by_kind": by_kind,
            "total_checks": total_states,
            "monitored_ips": monitored_ips,
            "templates": tenant.check_templates.count(),
            "channels": tenant.notification_channels.filter(enabled=True).count(),
            "series": _result_series(request, tenant),
            "recent_transitions": StateTransitionSerializer(recent, many=True).data,
        }
    )


def _result_series(request, tenant, hours: int = 24) -> list[dict]:
    """Hourly counts of check results over the last ``hours``, grouped into
    reachable / degraded / down buckets — drives the dashboard area chart.
    Site-aware: only the caller's viewable IPs contribute."""
    from datetime import timedelta

    from django.db.models.functions import TruncHour
    from django.utils import timezone

    since = timezone.now() - timedelta(hours=hours)
    rows = (
        _scope_ip_keyed(
            request, tenant,
            CheckResult.objects.filter(tenant=tenant, timestamp__gte=since),
        )
        .annotate(h=TruncHour("timestamp"))
        .values("h", "status")
        .annotate(n=Count("id"))
    )
    buckets: dict = {}
    for r in rows:
        key = r["h"].isoformat()
        b = buckets.setdefault(key, {"t": key, "up": 0, "degraded": 0, "down": 0})
        status = r["status"]
        if status in ("up",):
            b["up"] += r["n"]
        elif status == "degraded":
            b["degraded"] += r["n"]
        elif status in ("down", "stale"):
            b["down"] += r["n"]
    return sorted(buckets.values(), key=lambda x: x["t"])


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bulk_check_now_view(request):
    """Force an immediate check of many targets — selected IPs and/or every IP
    in selected prefixes. Materialises their checks, arms them (next_run=now),
    and dispatches through the worker so state + results update properly."""
    from django.utils import timezone

    from .scheduler import dispatch, materialise_ip

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if (denied := _require(request, "ipaddress", "view")):
        return denied

    ip_ids = request.data.get("ip_ids") or []
    prefix_ids = request.data.get("prefix_ids") or []

    ip_qs = rbac.restrict_queryset(
        IPAddress.objects.filter(tenant=tenant, id__in=ip_ids),
        request.user, tenant, "ipaddress", "view",
    )
    prefix_qs = rbac.restrict_queryset(
        Prefix.objects.filter(tenant=tenant, id__in=prefix_ids).select_related("vrf"),
        request.user, tenant, "prefix", "view",
    )
    ips = set(ip_qs)
    for prefix in prefix_qs:
        child_ids = _viewable_child_ip_ids(request, prefix, tenant)
        ips.update(
            _viewable_ips(
                request,
                tenant,
                IPAddress.objects.filter(id__in=child_ids),
            )
        )

    if not ips:
        return Response({"targets": 0, "checks": 0})

    now = timezone.now()
    for ip in ips:
        materialise_ip(ip, now=now)
    states = CheckState.objects.filter(tenant=tenant, target_ip__in=ips)
    armed_ids = [str(i) for i in states.values_list("id", flat=True)]
    armed = states.update(next_run=now, in_flight=False)
    result = dispatch()  # enqueue onto the worker (claims them: in_flight=True)
    run_id = _seed_check_run(armed_ids, tenant, request.user)
    return Response(
        {"targets": len(ips), "checks": armed, "jobs": result["jobs"], "run_id": run_id}
    )


# ─── Check-now live progress (Redis-backed, ephemeral) ───────────────────────
# dispatch() claims the armed checks (in_flight=True) and the worker pool clears
# in_flight as each completes — so progress is just "how many are still in
# flight". We stash the batch's CheckState ids under an opaque run id the UI
# polls.
_CHECK_RUN_TTL = 3600


def _check_run_key(run_id) -> str:
    return f"check:run:{run_id}"


def _seed_check_run(ids: list[str], tenant, owner):
    import json
    import uuid

    import django_rq

    if not ids:
        return None
    run_id = uuid.uuid4().hex
    try:
        conn = django_rq.get_connection("default")
        conn.hset(
            _check_run_key(run_id),
            mapping={
                "total": len(ids), "ids": json.dumps(ids),
                "tenant": str(tenant.id),
                "owner": str(owner.pk),
            },
        )
        conn.expire(_check_run_key(run_id), _CHECK_RUN_TTL)
    except Exception:  # noqa: BLE001 — progress is best-effort
        return None
    return run_id


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def check_run_view(request, run_id):
    """Live progress for a bulk Check-now run (polled by the UI). `pending` is
    the count still in flight; `done` when none remain. Unknown/expired → done."""
    import json

    import django_rq

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    try:
        raw = django_rq.get_connection("default").hgetall(_check_run_key(run_id))
    except Exception:  # noqa: BLE001
        raw = None
    if not raw:
        return Response({"run_id": run_id, "found": False, "done": True, "percent": 100})
    g = {
        (k.decode() if isinstance(k, bytes) else k): (
            v.decode() if isinstance(v, bytes) else v
        )
        for k, v in raw.items()
    }
    if (
        g.get("tenant") != str(tenant.id)
        or (
            not request.user.is_superuser
            and g.get("owner") != str(request.user.pk)
        )
    ):
        return Response({"run_id": run_id, "found": False, "done": True, "percent": 100})
    ids = json.loads(g.get("ids", "[]"))
    total = int(g.get("total", 0) or 0)
    pending = CheckState.objects.filter(
        tenant=tenant, id__in=ids, in_flight=True
    ).count()
    done = pending == 0
    done_count = total if done else max(total - pending, 0)
    percent = 100 if done else (round(done_count / total * 100) if total else 100)
    return Response(
        {"run_id": run_id, "found": True, "total": total, "done_count": done_count,
         "pending": pending, "done": done, "percent": percent}
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def alerts_view(request):
    """Alerts for the active tenant — firing by default. Returns severity/status
    counts (for the sidebar badge + filter chips) plus the filtered list."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"counts": {}, "results": []})

    base = _alert_base(request, tenant)
    counts = {
        "firing": base.filter(status="firing").count(),
        "resolved": base.filter(status="resolved").count(),
        "acknowledged": base.filter(
            status="firing", acknowledged_at__isnull=False
        ).count(),
    }
    for sev in ("critical", "warning", "info"):
        counts[sev] = base.filter(status="firing", severity=sev).count()

    qs = base.select_related("target_ip", "template", "acknowledged_by").prefetch_related(
        "target_ip__tags"
    )
    status = request.query_params.get("status", "firing")
    if status in ("firing", "resolved"):
        qs = qs.filter(status=status)
    severity = request.query_params.get("severity")
    if severity:
        qs = qs.filter(severity=severity)
    ack = request.query_params.get("ack")
    if ack == "acknowledged":
        qs = qs.filter(acknowledged_at__isnull=False)
    elif ack == "unacknowledged":
        qs = qs.filter(acknowledged_at__isnull=True)
    rows = list(qs.order_by("-opened_at")[:200])

    # Annotate which firing alerts are currently muted by a silence — one
    # silence fetch, matched in python (no per-row query).
    _annotate_silenced(tenant, rows)

    return Response(
        {"counts": counts, "results": AlertSerializer(rows, many=True).data}
    )


def _annotate_silenced(tenant, alerts):
    """Set ``_silenced`` on each firing alert covered by an active silence."""
    from django.utils import timezone

    from .alerts import _ip_matches
    from .models import Silence

    firing = [a for a in alerts if a.status == "firing"]
    if not firing:
        return
    now = timezone.now()
    silences = list(
        Silence.objects.filter(
            tenant=tenant, starts_at__lte=now, ends_at__gt=now
        ).select_related("match_prefix")
    )
    if not silences:
        return
    for a in firing:
        ip = a.target_ip
        for s in silences:
            if s.match_kinds and a.kind not in s.match_kinds:
                continue
            if s.match_statuses and a.check_status not in s.match_statuses:
                continue
            if s.match_ip_id and s.match_ip_id != a.target_ip_id:
                continue
            if not _ip_matches(s, ip):
                continue
            a._silenced = True
            break


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def flapping_view(request):
    """IPs flapping a lot for the active tenant (the 'go check on it' list)."""
    from .flapping import flapping_ips

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"results": []})
    # Site-aware: restrict to the IPs the caller may view (None grant → empty).
    q = rbac.row_filter(request.user, tenant, "ipaddress", "view")
    if q is None:
        return Response({"results": []})
    viewable = None if q is True else IPAddress.objects.filter(q)
    return Response({"results": flapping_ips(tenant, viewable_ips=viewable)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def alert_ack_view(request, alert_id):
    """Acknowledge / unacknowledge a firing alert. Body: ``{"note": "..."}``;
    ``?action=unack`` clears it."""
    from django.utils import timezone

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    alert = (
        _alert_base(request, tenant)
        .select_related("target_ip", "template")
        .filter(id=alert_id)
        .first()
    )
    if alert is None:
        return Response({"detail": "Not found."}, status=404)

    if request.query_params.get("action") == "unack":
        alert.acknowledged_at = None
        alert.acknowledged_by = None
        alert.ack_note = ""
        alert.save(update_fields=["acknowledged_at", "acknowledged_by", "ack_note"])
    else:
        alert.acknowledged_at = timezone.now()
        alert.acknowledged_by = request.user
        alert.ack_note = (request.data or {}).get("note", "")[:255]
        alert.save(update_fields=["acknowledged_at", "acknowledged_by", "ack_note"])
    return Response(AlertSerializer(alert).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def checks_list_view(request):
    """Every monitored check (CheckState) for the tenant — the global "Checks"
    list. Supports status/kind/search filters + ordering + paging, and returns
    per-status counts so the UI can render quick-filter tabs with badges."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"count": 0, "results": [], "status_counts": {}})

    # Site-aware: only the caller's viewable IPs' checks appear in the list AND
    # the per-status counts.
    base = _scope_ip_keyed(
        request, tenant,
        CheckState.objects.filter(tenant=tenant),
    ).select_related("target_ip", "template")

    # Counts across all statuses (before the status filter) so the tabs are
    # stable regardless of which one is selected.
    status_counts = {
        row["status"]: row["n"]
        for row in base.values("status").annotate(n=Count("id"))
    }
    status_counts["all"] = sum(status_counts.values())

    qs = base
    status = request.query_params.get("status")
    if status and status != "all":
        qs = qs.filter(status=status)
    kind = request.query_params.get("kind")
    if kind:
        qs = qs.filter(kind=kind)
    search = (request.query_params.get("search") or "").strip()
    if search:
        qs = qs.filter(
            Q(target_ip__ip_address__icontains=search)
            | Q(template__name__icontains=search)
        )

    ordering = request.query_params.get("ordering", "-last_checked")
    order_map = {
        "ip": ("target_ip__ip_address",),
        "-ip": ("-target_ip__ip_address",),
        "status": ("status", "target_ip__ip_address"),
        "-status": ("-status", "target_ip__ip_address"),
        "last_checked": ("last_checked", "target_ip__ip_address"),
        "-last_checked": ("-last_checked", "target_ip__ip_address"),
        "latency": ("last_latency_ms",),
        "-latency": ("-last_latency_ms",),
    }
    qs = qs.order_by(*order_map.get(ordering, order_map["-last_checked"]))

    try:
        page = max(int(request.query_params.get("page", 1)), 1)
    except ValueError:
        page = 1
    try:
        page_size = min(max(int(request.query_params.get("page_size", 50)), 1), 200)
    except ValueError:
        page_size = 50
    total = qs.count()
    start = (page - 1) * page_size
    rows = list(qs[start : start + page_size])

    results = [
        {
            "id": str(s.id),
            "target_ip": {"id": str(s.target_ip_id), "ip_address": s.target_ip.ip_address},
            "template": {"id": str(s.template_id), "name": s.template.name},
            "kind": s.kind,
            "status": s.status,
            "last_latency_ms": s.last_latency_ms,
            "last_checked": s.last_checked,
            "since": s.since,
            "consecutive_fail": s.consecutive_fail,
        }
        for s in rows
    ]
    return Response(
        {
            "count": total,
            "page": page,
            "page_size": page_size,
            "status_counts": status_counts,
            "results": results,
        }
    )


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def bulk_status_view(request):
    """Roll-up status for many targets at once, for list-table status columns.

    ``?ips=id,id`` → ``{statuses: {ip_id: {status, checks}}}``
    ``?prefixes=id,id`` → ``{statuses: {prefix_id: {status, counts, monitored_ips}}}``
    ``?devices=id,id`` → ``{statuses: {device_id: {status, counts, monitored_ips}}}``
        — rolled up across every IP assigned to the device (a service's check
        lives on its IP, so service monitoring rolls up here too).

    Also accepts POST with ``{"ips": [...]}`` / ``{"prefixes": [...]}`` /
    ``{"devices": [...]}``. A page of ~110 prefix UUIDs makes a ~4.2 KB URL,
    which is longer than gunicorn's default request-line limit (4094) — the
    proxy answered 400 before Django ever saw it, and every list page's
    monitoring column silently showed dashes. The SPA POSTs now; GET stays
    for scripts and backward compatibility.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"statuses": {}})

    def _ids(name: str):
        if request.method == "POST":
            v = (request.data or {}).get(name)
            if isinstance(v, list):
                return ",".join(str(x) for x in v)
            return v or None
        return request.query_params.get(name)

    ip_param = _ids("ips")
    if ip_param:
        ids = [x for x in ip_param.split(",") if x]
        out: dict = {}
        # Site-aware: drop any submitted IP id the caller can't view, so a
        # Site-A member can't probe Site-B IP status by id.
        states = (
            _scope_ip_keyed(
                request, tenant,
                CheckState.objects.filter(tenant=tenant, target_ip_id__in=ids),
            )
            .values("target_ip_id", "status")
        )
        grouped: dict = {}
        for s in states:
            grouped.setdefault(str(s["target_ip_id"]), []).append(s["status"])
        for ip_id, statuses in grouped.items():
            out[ip_id] = {
                "status": worst_status(statuses),
                "checks": len(statuses),
                "counts": status_counts(statuses),
            }
        return Response({"statuses": out})

    prefix_param = _ids("prefixes")
    if prefix_param:
        ids = [x for x in prefix_param.split(",") if x]
        # _child_ip_ids walks every tenant IP in Python per prefix — bound the
        # request so a member can't submit thousands of ids as a CPU DoS. The
        # UI sends at most one page of prefixes (~100).
        if len(ids) > 500:
            return Response(
                {"detail": "Too many prefixes — request at most 500 per call."},
                status=400,
            )
        # Site-aware: only prefixes the caller may view roll up.
        prefixes = rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant, id__in=ids).select_related("vrf"),
            request.user, tenant, "prefix", "view",
        )
        out = {}
        for prefix in prefixes:
            child_ids = _viewable_child_ip_ids(request, prefix, tenant)
            if not child_ids:
                continue
            states = _scope_ip_keyed(
                request, tenant,
                CheckState.objects.filter(target_ip_id__in=child_ids),
            ).values_list("status", flat=True)
            statuses = list(states)
            if not statuses:
                continue
            out[str(prefix.id)] = {
                "status": worst_status(statuses),
                "counts": status_counts(statuses),
                "monitored_ips": len(set(child_ids)),
            }
        return Response({"statuses": out})

    device_param = _ids("devices")
    if device_param:
        ids = [x for x in device_param.split(",") if x]
        out = {}
        # Site-aware: only devices the caller may view roll up.
        viewable_dev_ids = list(
            rbac.restrict_queryset(
                Device.objects.filter(tenant=tenant, id__in=ids),
                request.user, tenant, "device", "view",
            ).values_list("id", flat=True)
        )
        # All IPs assigned to each viewable device, in one query, grouped by device.
        ip_rows = _viewable_ips(
            request,
            tenant,
            IPAddress.objects.filter(assigned_device_id__in=viewable_dev_ids),
        ).values_list("assigned_device_id", "id")
        ips_by_device: dict = {}
        for dev_id, ip_id in ip_rows:
            ips_by_device.setdefault(str(dev_id), []).append(ip_id)
        for dev_id, ip_ids in ips_by_device.items():
            states = _scope_ip_keyed(
                request,
                tenant,
                CheckState.objects.filter(target_ip_id__in=ip_ids),
            ).values("target_ip_id", "status")
            statuses = [s["status"] for s in states]
            if not statuses:
                continue
            out[dev_id] = {
                "status": worst_status(statuses),
                "counts": status_counts(statuses),
                "monitored_ips": len({s["target_ip_id"] for s in states}),
            }
        return Response({"statuses": out})

    return Response({"statuses": {}})


# ─── SNMP observed facts (Phase 1, issue #84) ──────────────────────────────


def _resolve_device(request, device_id, action="view"):
    """(device, tenant) for a device in the caller's RBAC row/site scope, or
    (None, response) on error. Row-scoped (not just tenant) so a Site-A viewer
    can't read/poll a Site-B device."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, Response({"detail": "No active tenant."}, status=403)
    device, _ = _scoped_get(request, Device, "device", action, device_id)
    if device is None:
        return None, Response({"detail": "Device not found."}, status=404)
    return (device, tenant), None


def _empty_snmp(device):
    return {
        "device": str(device.id), "profile": None, "profile_name": None,
        "data": {}, "interfaces": [], "neighbors": [], "arp": [],
        "reachable": None, "error": "", "polled_at": None,
    }


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_snmp_view(request, device_id):
    """The device's last observed SNMP facts (read-only). Empty shape if never
    polled."""
    resolved, err = _resolve_device(request, device_id)
    if err is not None:
        return err
    device, tenant = resolved
    state = (
        DeviceSnmp.objects.filter(device=device, tenant=tenant)
        .select_related("profile")
        .first()
    )
    if state is None:
        return Response(_empty_snmp(device))
    return Response(DeviceSnmpSerializer(state).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def device_snmp_poll_view(request, device_id):
    """On-demand SNMP poll of a device's system facts. Body: ``{profile_id?}``
    (falls back to the tenant's default profile). Stores the observed facts —
    it never touches the device's source-of-truth fields."""
    resolved, err = _resolve_device(request, device_id, "change")
    if err is not None:
        return err
    device, tenant = resolved

    profile = None
    profile_id = request.data.get("profile_id")
    if profile_id:
        profile = SnmpProfile.objects.filter(pk=profile_id, tenant=tenant).first()
        if profile is None:
            return Response({"detail": "SNMP profile not found."}, status=400)

    # profile=None → poll_device resolves it (device → role → type → default).
    state, reason = poll_device(device, tenant, profile)
    if reason == "no_profile":
        return Response(
            {"detail": "No SNMP profile resolves for this device — assign one on "
             "the device, its role, its type, or set a tenant default."},
            status=400,
        )
    if reason == "no_target":
        return Response(
            {"detail": "Device has no primary IP or name to poll."}, status=400
        )
    return Response(DeviceSnmpSerializer(state).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_snmp_utilization_view(request, device_id):
    """Per-interface utilisation series derived from stored counter samples."""
    resolved, err = _resolve_device(request, device_id)
    if err is not None:
        return err
    device, _tenant = resolved
    return Response({"interfaces": compute_device_utilization(device)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def prefix_nmap_sweep_view(request, prefix_id):
    """nmap ping-sweep a prefix → seed live hosts as discovered IPs."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    # Seeds IPAddress rows (and runs a scan) — gate like the IP form.
    if not rbac.has_action(request.user, tenant, "ipaddress", "add"):
        return Response(
            {"detail": "You do not have permission to add IP addresses."},
            status=403,
        )
    prefix, _ = _scoped_get(request, Prefix, "prefix", "view", prefix_id)
    if prefix is None:
        return Response({"detail": "Prefix not found."}, status=404)
    if not _can_discover_into_prefix(request, tenant, prefix):
        return Response(
            {"detail": "Your IP-add grant does not cover rows created here."},
            status=403,
        )
    try:
        result = sweep_prefix(prefix, tenant)
    except NmapError as exc:
        return Response({"detail": str(exc)}, status=400)
    return Response(result)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_snmp_drift_view(request, device_id):
    """Read-only drift: observed SNMP state vs the device's source of truth."""
    resolved, err = _resolve_device(request, device_id)
    if err is not None:
        return err
    device, tenant = resolved
    return Response({"drift": compute_device_drift(device, tenant)})


# Drift kinds we summarise per device on the fleet list (in compute order).
_DRIFT_KINDS = ("device_field", "interface_missing", "interface_mismatch", "interface_stale")


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def snmp_drift_list_view(request):
    """Tenant-wide SNMP drift: one summary row per polled device, so the
    config-drift page can show observed-vs-intended drift across the fleet
    alongside the Ansible config-drift list. Read-only — accepting a diff still
    happens per-device on the reconcile endpoint (which needs `device.change`).

    Optional ``?status=drift|in_sync|unreachable`` filters the rows.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)

    # Site-aware: only devices the caller may view appear in the fleet drift list.
    states = list(
        _scope_device_keyed(
            request, tenant,
            DeviceSnmp.objects.filter(tenant=tenant, polled_at__isnull=False),
        )
        .select_related("device", "profile")
        .order_by("-polled_at")
    )

    # Only list devices that have SNMP *deliberately configured* — an explicit
    # binding (device / role / type) or a tenant default profile. A device that
    # was only polled because it's the tenant's single fallback profile has no
    # real SNMP intent, so showing it as "unreachable" here would be noise.
    bindings = SnmpProfileBinding.objects.filter(tenant=tenant).values_list(
        "scope", "object_id"
    )
    bound = {SnmpProfileBinding.SCOPE_DEVICE: set(),
             SnmpProfileBinding.SCOPE_ROLE: set(),
             SnmpProfileBinding.SCOPE_TYPE: set()}
    for scope, object_id in bindings:
        if scope in bound:
            bound[scope].add(object_id)
    has_default = SnmpProfile.objects.filter(tenant=tenant, is_default=True).exists()

    def _is_configured(device) -> bool:
        return (
            has_default
            or device.id in bound[SnmpProfileBinding.SCOPE_DEVICE]
            or device.role_id in bound[SnmpProfileBinding.SCOPE_ROLE]
            or device.device_type_id in bound[SnmpProfileBinding.SCOPE_TYPE]
        )

    states = [s for s in states if _is_configured(s.device)]

    # Pre-fetch every polled device's intended interfaces in one query (grouped
    # by device) so the per-device drift compare below doesn't issue an N+1.
    ifaces_by_device: dict = {}
    for iface in Interface.objects.filter(
        device_id__in=[s.device_id for s in states]
    ).select_related("vlan"):
        ifaces_by_device.setdefault(iface.device_id, []).append(iface)

    want = request.query_params.get("status")
    rows = []
    for state in states:
        # Only a confirmed-reachable poll has observed state worth comparing;
        # reachable False *or* None gets its own bucket, never a misleading
        # "in sync". (A reachable device can't match ?status=unreachable, so skip
        # it before doing the comparison work.)
        if state.reachable is not True:
            if want and want != "unreachable":
                continue
            status_, items = "unreachable", []
        else:
            if want == "unreachable":
                continue
            items = compute_device_drift(
                state.device, tenant, state=state,
                intended_interfaces=ifaces_by_device.get(state.device_id, []),
            )
            status_ = "drift" if items else "in_sync"
            if want and want != status_:
                continue

        by_kind = {k: 0 for k in _DRIFT_KINDS}
        ifaces_drifted = set()
        for it in items:
            k = it.get("kind")
            if k in by_kind:
                by_kind[k] += 1
            # Count distinct interfaces, not items — one interface can drift on
            # both MAC and admin-status (two mismatch items, one interface).
            if k == "interface_missing":
                ifaces_drifted.add(("name", it.get("name")))
            elif k in ("interface_mismatch", "interface_stale"):
                ifaces_drifted.add(("id", it.get("interface_id")))
        rows.append({
            "device": str(state.device_id),
            "device_name": state.device.name,
            "status": status_,
            "reachable": state.reachable,
            "drift_count": len(items),
            "by_kind": by_kind,
            "interfaces_drifted": len(ifaces_drifted),
            "profile_name": state.profile.name if state.profile_id else None,
            "polled_at": state.polled_at,
        })
    return Response({"count": len(rows), "results": rows})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def snmp_topology_ghosts_view(request):
    """LLDP-derived ghost edges (adjacencies with no cable) for the topology map.
    Same edge shape as ``/api/topology/`` with ``type="ghost"``; the frontend
    merges these in and only renders ones whose endpoints are on screen.

    ``?site=`` narrows the device set the same way the topology page does.
    """
    from .snmp_topology import ghost_edges, ghost_graph_for_device

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"nodes": [], "edges": []})
    # Row/site scope every device this endpoint touches — a Site-A viewer must
    # not pull a Site-B device's LLDP graph by id, nor see Site-B ghost edges.
    viewable = rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant),
        request.user, tenant, "device", "view",
    )
    # Device-scoped: return a full mini-graph (nodes + ghost edges) so the device
    # detail map can render LLDP links even when nothing is cabled.
    device_id = request.query_params.get("device")
    if device_id:
        device = viewable.filter(pk=device_id).first()
        if device is None:
            return Response({"nodes": [], "edges": []})
        return Response(
            ghost_graph_for_device(tenant, device, candidates_qs=viewable)
        )
    # Site/tenant-wide: edges only (the topology page already has the nodes).
    devices = viewable
    site = request.query_params.get("site")
    if site:
        devices = devices.filter(site_id=site)
    return Response({"edges": ghost_edges(tenant, list(devices))})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def materialize_cable_view(request):
    """Turn an LLDP ghost link into a real ``Cable``. Body:
    ``{source_device, local_port, remote_device, remote_port, type}``. Both
    interfaces must already exist (accept the interface drift first if not).

    Creating a cable is a source-of-truth write, so it needs ``cable.add``.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if not rbac.has_action(request.user, tenant, "cable", "add"):
        return Response(
            {"detail": "You do not have permission to add cables."}, status=403
        )

    d = request.data
    # Both endpoints must sit on devices the caller may view in their site scope
    # — otherwise a Site-A grant + type-level cable.add could cable two Site-B
    # devices by interface id. Bound the interface lookup to viewable devices.
    viewable_devices = rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant),
        request.user, tenant, "device", "view",
    )
    local = Interface.objects.filter(
        device__in=viewable_devices, device_id=d.get("source_device"),
        name=d.get("local_port"),
    ).select_related("device").first()
    remote = Interface.objects.filter(
        device__in=viewable_devices, device_id=d.get("remote_device"),
        name=d.get("remote_port"),
    ).select_related("device").first()
    if local is None or remote is None:
        missing = []
        if local is None:
            missing.append(f"{d.get('local_port')!r} on the local device")
        if remote is None:
            missing.append(f"{d.get('remote_port')!r} on the remote device")
        return Response(
            {"detail": "Interface not found: " + " and ".join(missing)
             + ". Add it (or accept the interface drift) first."},
            status=400,
        )

    from api.serializers import CableSerializer

    ser = CableSerializer(
        data={
            "type": d.get("type", ""),
            "a": [{"kind": "interface", "id": str(local.id)}],
            "b": [{"kind": "interface", "id": str(remote.id)}],
        },
        context={"request": request},
    )
    ser.is_valid(raise_exception=True)
    from django.db import transaction
    from rest_framework.exceptions import PermissionDenied

    from api.cable_scope import can_act_on_cable

    with transaction.atomic():
        cable = ser.save(tenant=tenant)
        if not can_act_on_cable(request.user, tenant, "add", cable):
            raise PermissionDenied(
                "Your cable-add grant does not cover both endpoint sites."
            )
    return Response({"cable_id": str(cable.id)}, status=201)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def device_snmp_reconcile_view(request, device_id):
    """Accept one drift item → write the observed value into intent (the only
    place discovery mutates the source of truth). Returns the remaining drift."""
    resolved, err = _resolve_device(request, device_id, "change")
    if err is not None:
        return err
    device, tenant = resolved
    # Writing observed values back into intent is a source-of-truth mutation, so
    # it requires the same `device.change` grant the device form does — not just
    # tenant membership (the read-only drift/poll views stay IsAuthenticated).
    if not rbac.has_action(request.user, tenant, "device", "change"):
        return Response(
            {"detail": "You do not have permission to change devices."}, status=403
        )
    action = request.data.get("action") or {}
    if not apply_drift_action(device, tenant, action):
        return Response({"detail": "Could not apply that change."}, status=400)
    return Response({"drift": compute_device_drift(device, tenant)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def device_snmp_sync_view(request, device_id):
    """"Sync from SNMP": in one shot, create observed interfaces Danbyte lacks,
    fix MAC/admin drift, and assign observed IPs (where a containing prefix
    exists). The device name is left alone. Source-of-truth write → device.change.
    """
    resolved, err = _resolve_device(request, device_id, "change")
    if err is not None:
        return err
    device, tenant = resolved
    if not rbac.has_action(request.user, tenant, "device", "change"):
        return Response(
            {"detail": "You do not have permission to change devices."}, status=403
        )
    summary = sync_device_from_snmp(device, tenant)
    return Response({**summary, "drift": compute_device_drift(device, tenant)})


def _binding_payload(tenant, scope, object_id):
    binding = (
        SnmpProfileBinding.objects.filter(
            tenant=tenant, scope=scope, object_id=object_id
        ).select_related("profile").first()
    )
    out = {
        "scope": scope,
        "object_id": str(object_id),
        "profile_id": str(binding.profile_id) if binding else None,
        "profile_name": binding.profile.name if binding else None,
        "effective": None,
    }
    # For a device, also resolve the inherited effective profile (device → role
    # → type → tenant default) so the UI can show where the credential came from.
    if scope == SnmpProfileBinding.SCOPE_DEVICE:
        device = Device.objects.filter(pk=object_id, tenant=tenant).first()
        if device is not None:
            profile, source = resolve_device_profile(device, tenant)
            out["effective"] = {
                "profile_id": str(profile.id) if profile else None,
                "profile_name": profile.name if profile else None,
                "source": source,
            }
    return out


def _device_grant_covers_site(user, tenant, action, site_id) -> bool:
    """One unconstrained device grant must cover an entire binding target."""
    if user.is_superuser:
        return True
    for perm in rbac.applicable_permissions(user, tenant):
        types = perm.object_types or []
        if "device" not in types and "*" not in types:
            continue
        if action not in (perm.actions or []) or perm.constraints:
            continue
        site_ids = {site.pk for site in perm.sites.all()}
        if not site_ids:
            return True
        if site_id is not None and site_id in site_ids:
            return True
    return False


def _binding_target(tenant, scope, object_id):
    models = {
        SnmpProfileBinding.SCOPE_DEVICE: Device,
        SnmpProfileBinding.SCOPE_SITE: Site,
        SnmpProfileBinding.SCOPE_LOCATION: Location,
        SnmpProfileBinding.SCOPE_ROLE: DeviceRole,
        SnmpProfileBinding.SCOPE_TYPE: DeviceType,
    }
    model = models.get(scope)
    return model.objects.filter(tenant=tenant, pk=object_id).first() if model else None


def _can_access_binding_target(user, tenant, scope, target, action) -> bool:
    if user.is_superuser:
        return True
    if scope == SnmpProfileBinding.SCOPE_DEVICE:
        return rbac.can_act_on(user, tenant, "device", action, target)
    if scope == SnmpProfileBinding.SCOPE_SITE:
        return _device_grant_covers_site(user, tenant, action, target.pk)
    if scope == SnmpProfileBinding.SCOPE_LOCATION:
        return _device_grant_covers_site(user, tenant, action, target.site_id)
    return _device_grant_covers_site(user, tenant, action, None)


@api_view(["GET", "PUT", "DELETE"])
@permission_classes([IsAuthenticated])
def snmp_binding_view(request, scope, object_id):
    """Get / set / clear the SNMP profile bound at one level of the hierarchy.

    ``PUT {profile_id}`` sets it (``profile_id: null`` clears); ``DELETE`` clears.
    GET on a ``device`` scope also returns the resolved ``effective`` profile.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    if scope not in dict(SnmpProfileBinding.SCOPE_CHOICES):
        return Response({"detail": "Invalid scope."}, status=400)
    action = "change" if request.method in ("PUT", "DELETE") else "view"
    if not rbac.has_action(request.user, tenant, "device", action):
        return Response(
            {"detail": f"You do not have permission to {action} devices."}, status=403
        )
    target = _binding_target(tenant, scope, object_id)
    if target is None or not _can_access_binding_target(
        request.user, tenant, scope, target, action
    ):
        return Response({"detail": "Not found."}, status=404)

    if request.method == "PUT":
        pid = request.data.get("profile_id")
        if pid in (None, ""):
            SnmpProfileBinding.objects.filter(
                tenant=tenant, scope=scope, object_id=object_id
            ).delete()
        else:
            profile = SnmpProfile.objects.filter(pk=pid, tenant=tenant).first()
            if profile is None:
                return Response({"detail": "SNMP profile not found."}, status=400)
            SnmpProfileBinding.objects.update_or_create(
                tenant=tenant, scope=scope, object_id=object_id,
                defaults={"profile": profile},
            )
    elif request.method == "DELETE":
        SnmpProfileBinding.objects.filter(
            tenant=tenant, scope=scope, object_id=object_id
        ).delete()

    return Response(_binding_payload(tenant, scope, object_id))
