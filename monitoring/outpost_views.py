"""Outpost API — the remote agent's endpoints (HTTPS **pull** transport).

An Outpost authenticates with its Bearer token, pulls its due checks
(``GET /api/outpost/work`` — claiming them so nothing double-runs), runs them
locally with the shared ``monitoring/checkers`` code, and posts results back
(``POST /api/outpost/results`` → ``worker.ingest_results``, the same finalise
path the core uses). ``POST /api/outpost/hello`` is a heartbeat.

Everything is scoped to the authenticating engine's tenant — an Outpost only
ever sees and reports its own tenant's checks.
"""
from __future__ import annotations

import hmac

from django.http import FileResponse, Http404, HttpResponse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.authentication import (
    BaseAuthentication,
    SessionAuthentication,
)
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
)
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .checkers import CheckOutcome
from .models import CheckState, MonitoringEngine, OutpostRelease
from .worker import ingest_results

WORK_BATCH = 500
_STATUSES = {"up", "down", "degraded", "unknown"}


def claim_and_build_work(engine, now=None, limit: int = WORK_BATCH) -> list[dict]:
    """Claim this engine's due checks (``in_flight``, so nothing double-runs) and
    build the work payload. Shared by the HTTPS-pull ``/work`` endpoint and the
    SSH driver — both transports hand the Outpost the same shape."""
    from datetime import timedelta

    from django.utils import timezone

    from .worker import _resolved_from_state, effective_interval

    now = now or timezone.now()
    due = list(
        CheckState.objects.filter(
            engine=engine, next_run__lte=now, in_flight=False
        ).select_related("target_ip", "template", "assignment")[:limit]
    )
    checks = []
    for s in due:
        s.in_flight = True
        s.in_flight_since = now
        interval = effective_interval(s) or 300
        s.next_run = now + timedelta(seconds=interval)
        rc = _resolved_from_state(s)
        checks.append(
            {
                "state_id": str(s.id),
                "kind": rc.kind,
                "target": s.target_ip.ip_address,
                "params": rc.params,
                "secret_params": rc.secret_params,
                "timeout_ms": rc.timeout_ms,
            }
        )
    if due:
        CheckState.objects.bulk_update(
            due, ["in_flight", "in_flight_since", "next_run"], batch_size=2000
        )
    return checks


class _OutpostIdentity:
    """A minimal ``request.user`` so DRF's ``IsAuthenticated`` passes; the real
    identity (the engine) is on ``request.auth``."""

    is_authenticated = True

    def __init__(self, engine):
        self.engine = engine


def engine_for_token(presented: str, *, pull_only: bool = True):
    """The enabled remote engine whose token matches (constant-time), or None."""
    if not presented:
        return None
    qs = MonitoringEngine.objects.filter(
        kind=MonitoringEngine.REMOTE, enabled=True
    ).select_related("tenant")
    if pull_only:
        qs = qs.filter(transport=MonitoringEngine.PULL)
    for eng in qs:
        secret = (eng.token or {}).get("secret")
        if secret and hmac.compare_digest(str(secret), presented):
            return eng
    return None


def _bearer(request) -> str:
    header = request.META.get("HTTP_AUTHORIZATION", "")
    return header[7:].strip() if header.startswith("Bearer ") else ""


class OutpostAuthentication(BaseAuthentication):
    """``Authorization: Bearer <token>`` → the matching enabled remote engine
    (constant-time compare). Only ``pull``-transport engines authenticate here."""

    keyword = "Bearer"

    def authenticate(self, request):
        presented = _bearer(request)
        if not presented:
            return None
        eng = engine_for_token(presented)
        if eng is None:
            raise AuthenticationFailed("Invalid or unknown Outpost token.")
        return (_OutpostIdentity(eng), eng)

    def authenticate_header(self, request):
        # Makes DRF answer 401 (not 403) on a bad/missing token.
        return self.keyword


def _client_ip(request) -> str:
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "") or ""


@extend_schema(
    summary="Outpost heartbeat: record agent facts, return poll interval + work summary",
    tags=["outpost"],
    request=inline_serializer(
        name="OutpostHelloRequest",
        fields={
            "version": serializers.CharField(required=False),
            "hostname": serializers.CharField(required=False),
            "ip": serializers.CharField(required=False),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Engine identity, poll interval, assigned check count, and an "
            "optional self-update target version."
        ),
    ),
)
@api_view(["POST"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_hello_view(request):
    """Heartbeat + agent facts; returns the poll interval and a work summary."""
    eng = request.auth
    now = timezone.now()
    eng.last_seen_at = now
    eng.agent_version = str(request.data.get("version", ""))[:40]
    eng.agent_hostname = str(request.data.get("hostname", ""))[:255]
    eng.agent_ip = str(request.data.get("ip", "") or _client_ip(request))[:45]
    eng.save(
        update_fields=[
            "last_seen_at", "agent_version", "agent_hostname", "agent_ip",
            "updated_at",
        ]
    )
    return Response(
        {
            "engine": {"id": str(eng.id), "name": eng.name},
            "poll_interval_seconds": eng.poll_interval_seconds,
            "assigned_checks": CheckState.objects.filter(engine=eng).count(),
            # Non-null → the agent should self-update to this version.
            "update_to": _update_target(eng, eng.agent_version),
        }
    )


def _update_target(engine, agent_version):
    """The version an auto-updating Outpost should move to — the default
    ("golden") **binary** release, when the agent isn't already on it. None
    otherwise (auto-update off, no default, non-binary, or already current)."""
    if not engine.auto_update:
        return None
    default = OutpostRelease.default()
    if default is None or not default.artifact or not _is_binary_release(default):
        return None
    cur = (agent_version or "").lstrip("v")
    if default.version.lstrip("v") == cur:
        return None
    # Honour the same maintenance window as the core (blank = real-time).
    from core.auto_upgrade import in_update_window
    from core.models import DeploymentSettings

    if not in_update_window(DeploymentSettings.load()):
        return None
    return default.version


@extend_schema(
    methods=["GET"],
    summary="Claim and return this Outpost's due checks",
    tags=["outpost"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "The claimed due checks, the poll interval, and whether a "
            "discovery sweep is pending."
        ),
    ),
)
@extend_schema(
    methods=["POST"],
    summary="Claim and return this Outpost's due checks",
    tags=["outpost"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "The claimed due checks, the poll interval, and whether a "
            "discovery sweep is pending."
        ),
    ),
)
@api_view(["GET", "POST"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_work_view(request):
    """Claim + return this Outpost's due checks. Claiming (``in_flight``) stops a
    second poll double-running them; the reaper reclaims if the Outpost dies."""
    eng = request.auth
    now = timezone.now()
    eng.last_seen_at = now
    eng.save(update_fields=["last_seen_at"])
    checks = claim_and_build_work(eng, now)
    return Response({
        "checks": checks,
        "poll_interval_seconds": eng.poll_interval_seconds,
        # Tells the agent to run a discovery sweep now (a "Discover now" click).
        "sweep_pending": eng.sweep_requested_at is not None,
    })


@extend_schema(
    summary="Ingest check results the Outpost ran (same finalise path as the core)",
    tags=["outpost"],
    request=inline_serializer(
        name="OutpostResultsRequest",
        fields={
            "results": serializers.ListField(
                child=inline_serializer(
                    name="OutpostResultItem",
                    fields={
                        "state_id": serializers.CharField(),
                        "status": serializers.ChoiceField(
                            choices=sorted(_STATUSES)
                        ),
                        "latency_ms": serializers.FloatField(required=False),
                        "detail": serializers.JSONField(required=False),
                    },
                ),
                required=False,
            ),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="The number of results ingested.",
    ),
)
@api_view(["POST"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_results_view(request):
    """Ingest results the Outpost ran — the same finalise path as the core."""
    eng = request.auth
    outcome_by_id: dict = {}
    for r in request.data.get("results") or []:
        sid = str(r.get("state_id", ""))
        status = r.get("status")
        if not sid or status not in _STATUSES:
            continue
        outcome_by_id[sid] = CheckOutcome(
            status=status,
            latency_ms=r.get("latency_ms"),
            detail=r.get("detail") or {},
        )
    n = ingest_results(
        outcome_by_id, engine_id=eng.id, tenant_id=eng.tenant_id
    )
    return Response({"ingested": n})


SNMP_POLL_INTERVAL_SECONDS = 900  # how often an Outpost re-runs SNMP discovery
SWEEP_INTERVAL_SECONDS = 600  # how often an Outpost re-runs subnet discovery


def build_snmp_work(engine) -> list[dict]:
    """The SNMP devices this engine should poll, each with its resolved (now
    site/location-scoped) credentials. No claiming — SNMP discovery is periodic
    and idempotent (last write wins), so a re-poll is harmless."""
    from .engines import devices_for_engine
    from .snmp_poll import _device_target
    from .snmp_resolve import resolve_device_profile

    work = []
    for device in devices_for_engine(engine):
        profile, _source = resolve_device_profile(device, engine.tenant)
        if profile is None:
            continue
        target = _device_target(device)
        if not target:
            continue
        work.append({
            "device_id": str(device.id),
            "target": target,
            "version": profile.version,
            "params": profile.params or {},
            "secret_params": profile.secret_params or {},
            "timeout_ms": profile.timeout_ms,
        })
    return work


@extend_schema(
    summary="This Outpost's SNMP discovery targets and resolved credentials",
    tags=["outpost"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="The SNMP devices to poll and the re-poll interval.",
    ),
)
@api_view(["GET"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_snmp_work_view(request):
    """This Outpost's SNMP discovery targets + credentials (its tenant/scope
    only). The agent fetches facts/interfaces/topology for each and posts back."""
    eng = request.auth
    eng.last_seen_at = timezone.now()
    eng.save(update_fields=["last_seen_at"])
    return Response({
        "devices": build_snmp_work(eng),
        "interval_seconds": SNMP_POLL_INTERVAL_SECONDS,
    })


@extend_schema(
    summary="Ingest SNMP results the Outpost fetched (same persistence as a local poll)",
    tags=["outpost"],
    request=inline_serializer(
        name="OutpostSnmpResultsRequest",
        fields={
            "results": serializers.ListField(
                child=inline_serializer(
                    name="OutpostSnmpResultItem",
                    fields={
                        "device_id": serializers.CharField(),
                    },
                ),
                required=False,
            ),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="The number of SNMP results ingested.",
    ),
)
@api_view(["POST"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_snmp_results_view(request):
    """Ingest SNMP results the Outpost fetched → the same persistence as a local
    poll (``persist_snmp_result``). Scoped to the engine's tenant."""
    from api.models import Device

    from .snmp_poll import persist_snmp_result
    from .snmp_resolve import resolve_device_profile

    eng = request.auth
    rows = request.data.get("results") or []
    ids = [r.get("device_id") for r in rows if r.get("device_id")]
    devices = {
        str(d.id): d
        for d in Device.objects.filter(tenant=eng.tenant, id__in=ids)
    }
    ingested = 0
    for r in rows:
        device = devices.get(str(r.get("device_id", "")))
        if device is None:  # unknown / other tenant → ignore
            continue
        profile, _ = resolve_device_profile(device, eng.tenant)
        persist_snmp_result(device, eng.tenant, profile, r)
        ingested += 1
    return Response({"ingested": ingested})


@extend_schema(
    summary="Discovery prefixes this Outpost should ICMP-sweep",
    tags=["outpost"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="The prefixes to sweep and the re-sweep interval.",
    ),
)
@api_view(["GET"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_sweep_work_view(request):
    """Discovery prefixes this Outpost should ICMP-sweep (its scope, due, sized).
    The agent sweeps each locally and posts live IPs to ``/discovered``."""
    from .discovery import sweep_work_for_engine

    eng = request.auth
    # Clear the on-demand request — the agent is handling it now.
    eng.last_seen_at = timezone.now()
    eng.sweep_requested_at = None
    eng.save(update_fields=["last_seen_at", "sweep_requested_at"])
    return Response({
        "prefixes": sweep_work_for_engine(eng),
        "interval_seconds": SWEEP_INTERVAL_SECONDS,
    })


@extend_schema(
    summary="Ingest an Outpost's sweep results (create IPs for new responders)",
    tags=["outpost"],
    request=inline_serializer(
        name="OutpostDiscoveredRequest",
        fields={
            "results": serializers.ListField(
                child=inline_serializer(
                    name="OutpostDiscoveredItem",
                    fields={
                        "prefix_id": serializers.CharField(),
                        "alive": serializers.ListField(
                            child=serializers.CharField(), required=False
                        ),
                    },
                ),
                required=False,
            ),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="The number of IP addresses created.",
    ),
)
@api_view(["POST"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_discovered_view(request):
    """Ingest an Outpost's sweep results — create IPs for new responders through
    the same path as a local sweep. Scoped to the engine's tenant."""
    from .discovery import ingest_discovered

    eng = request.auth
    created = 0
    for row in request.data.get("results") or []:
        pid = row.get("prefix_id")
        if pid:
            created += ingest_discovered(pid, row.get("alive") or [], eng.tenant)
    return Response({"created": created})


# ─── package store: install script + artifact download ──────────────────────

def _is_binary_release(release: OutpostRelease) -> bool:
    """A file release whose artifact isn't a Python package = a single binary."""
    return release.source == OutpostRelease.FILE and not (
        release.artifact and release.artifact.name.endswith((".whl", ".tar.gz"))
    )


def _render_install_script(base: str, release: OutpostRelease) -> str:
    """A POSIX-sh installer: install the Outpost (single binary, a Python
    package, or a git ref), drop a systemd unit wired to this instance + the
    token, and start it. Run as
    `curl -fsSL <base>/api/outpost/install.sh?v=<ver> | sudo sh -s -- --token=X`."""
    # $CURLK / $RUNARGS are set at runtime from --insecure (self-signed TLS).
    download = (
        f'curl -fsSL $CURLK "$OUTPOST_URL/api/outpost/download/{release.version}/" '
        f'-H "Authorization: Bearer $TOKEN"'
    )
    if _is_binary_release(release):
        # No Python needed — drop the binary and run it directly. Download to a
        # temp name and atomically `mv` it into place, so **updating a running
        # Outpost doesn't hit "text file busy"** (curl -o can't truncate a binary
        # that's currently executing; rename swaps the dir entry instead).
        install = (
            'echo "Fetching the Outpost binary"\n'
            f'{download} -o "$PREFIX/danbyte-outpost.new"\n'
            'chmod +x "$PREFIX/danbyte-outpost.new"\n'
            'mv -f "$PREFIX/danbyte-outpost.new" "$PREFIX/danbyte-outpost"'
        )
        exec_start = "$PREFIX/danbyte-outpost run $RUNARGS"
    else:
        if release.source == OutpostRelease.GIT:
            fetch, pkg = "", f'"git+{release.git_url}@{release.git_ref or "main"}"'
        else:
            fetch = f'{download} -o /tmp/danbyte-outpost.pkg\n'
            pkg = "/tmp/danbyte-outpost.pkg"
        install = (
            'python3 -m venv "$PREFIX/venv"\n'
            '"$PREFIX/venv/bin/pip" install --quiet --upgrade pip\n'
            f'{fetch}'
            f'"$PREFIX/venv/bin/pip" install --quiet {pkg}'
        )
        exec_start = "$PREFIX/venv/bin/danbyte-outpost run $RUNARGS"
    return f"""#!/bin/sh
# Danbyte Outpost installer — version {release.version}
# Self-signed Danbyte? add --insecure (and fetch this script with `curl -k`).
set -eu
OUTPOST_URL="{base}"
TOKEN="${{OUTPOST_TOKEN:-}}"
INSECURE=""
for a in "$@"; do
  case "$a" in
    --token=*) TOKEN="${{a#--token=}}" ;;
    --url=*)   OUTPOST_URL="${{a#--url=}}" ;;
    --insecure) INSECURE=1 ;;
  esac
done
[ -n "$TOKEN" ] || {{ echo "install: --token=<TOKEN> is required" >&2; exit 1; }}
PREFIX="${{OUTPOST_PREFIX:-/opt/danbyte-outpost}}"
mkdir -p "$PREFIX"

CURLK=""
RUNARGS=""
if [ -n "$INSECURE" ]; then CURLK="-k"; RUNARGS="--insecure"; fi

echo "Installing Danbyte Outpost {release.version} into $PREFIX"
{install}

# Credentials go in a root-only env file, never on the command line — the
# agent reads OUTPOST_URL / OUTPOST_TOKEN from the environment.
install -d -m 700 /etc/danbyte-outpost
umask 077
cat >/etc/danbyte-outpost/env <<ENVFILE
OUTPOST_URL=$OUTPOST_URL
OUTPOST_TOKEN=$TOKEN
ENVFILE
chmod 600 /etc/danbyte-outpost/env

# ExecStart still needs $PREFIX/$RUNARGS expanded at install time; the unit
# no longer contains any secret (URL + token live in the 0600 env file).
cat >/etc/systemd/system/danbyte-outpost.service <<UNIT
[Unit]
Description=Danbyte Outpost
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/etc/danbyte-outpost/env
ExecStart={exec_start}
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable danbyte-outpost >/dev/null 2>&1 || true
# `restart` (not `enable --now`) so a re-install always picks up the new binary
# **and the new token** — an already-running unit wouldn't otherwise reload.
systemctl restart danbyte-outpost
echo "Danbyte Outpost {release.version} installed and started."
"""


@extend_schema(
    summary="Generated POSIX-sh Outpost installer script",
    tags=["outpost"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="v",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Release version to install; defaults to the default release.",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.STR,
        description="The rendered shell installer script (text/x-shellscript).",
    ),
)
@api_view(["GET"])
@permission_classes([AllowAny])
def outpost_install_script_view(request):
    """`GET /outpost/install.sh?v=<version>` → the generated installer (the
    version, or the default). The token is supplied by the operator at run time,
    so the script itself isn't secret."""
    v = request.GET.get("v")
    release = (
        OutpostRelease.objects.filter(version=v).first()
        if v
        else OutpostRelease.default()
    )
    if release is None:
        return HttpResponse(
            "# No Outpost release is configured on this Danbyte instance.\n"
            "# Upload one under Governance -> Monitoring engines -> Versions.\n",
            content_type="text/plain",
            status=404,
        )
    base = request.build_absolute_uri("/").rstrip("/")
    return HttpResponse(
        _render_install_script(base, release),
        content_type="text/x-shellscript",
    )


@extend_schema(
    summary="Download the stored Outpost build artifact for a version",
    tags=["outpost"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.BINARY,
        description=(
            "The build artifact as a file download (valid Outpost token or "
            "signed-in admin required)."
        ),
    ),
)
@api_view(["GET"])
# Session only, so the default JWT auth doesn't reject the Outpost's raw Bearer
# token; the token is checked inline below.
@authentication_classes([SessionAuthentication])
@permission_classes([AllowAny])  # auth handled inline (Outpost token OR admin)
def outpost_download_view(request, version):
    """`GET /outpost/download/<version>/` → the stored build artifact. Allowed
    for a valid Outpost token or a signed-in admin."""
    from auth_api.permissions import can_manage_admin

    release = OutpostRelease.objects.filter(
        version=version, source=OutpostRelease.FILE
    ).first()
    if release is None or not release.artifact:
        raise Http404("No such Outpost build.")

    token_ok = engine_for_token(_bearer(request), pull_only=False) is not None
    admin_ok = (
        getattr(request.user, "is_authenticated", False)
        and can_manage_admin(request.user, None)
    )
    if not (token_ok or admin_ok):
        return Response({"detail": "Outpost token or admin required."}, status=401)

    return FileResponse(
        release.artifact.open("rb"),
        as_attachment=True,
        filename=f"danbyte-outpost-{version}{_ext(release.artifact.name)}",
    )


def _ext(name: str) -> str:
    for e in (".tar.gz", ".whl", ".tar", ".zip"):
        if name.endswith(e):
            return e
    return ""
