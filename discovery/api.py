"""Discovery endpoints (#451 B2). Every one but ``status/`` answers 404
while Discovery is off for the active tenant (``gate.require``).

``discovery/status/``                       GET: the two switches
``discovery/settings/``                     GET, PATCH (tenant admin): deny subnets
``discovery/profiles/``                     inventory profiles, CRUD
``discovery/profiles/<id>/run/``            POST: Run now (``scan``)
``discovery/profiles/<id>/hosts/``          GET: the scope as it resolves now
``discovery/runs/``                         runs (``?profile=``), read-only
``discovery/runs/<id>/hosts/``              per-host results of one run
``discovery/exempt/``                       POST: set ``scan_exempt`` on a host,
                                            address or prefix (``change`` on it)
``devices|virtual-machines/<id>/packages/`` the host's inventoried packages

Profiles are an RBAC type (``inventoryprofile``) with a ``scan`` verb that
no built-in role holds. Runs and host results read with the profile's
``view``; a host result, a scope host and a package list show only hosts
the caller may view, and packages need ``installedsoftware`` view as well.
"""
from __future__ import annotations

import ipaddress
import uuid

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import Device, IPAddress, Prefix, Site, VirtualMachine
from api.serializers import TenantScopedPrimaryKeyRelatedField
from api.viewsets import StandardPagination, TenantScopedViewSet
from auth_api import rbac
from auth_api.permissions import can_manage_admin

from . import gate, runner, scope
from .models import (
    DiscoverySettings,
    HostOsFact,
    HostPackage,
    InventoryHostResult,
    InventoryProfile,
    InventoryRun,
)

DENY_MAX = 500
ID_FIELDS = {"sites": "site_ids", "prefixes": "prefix_ids", "devices": "device_ids",
             "virtual_machines": "virtual_machine_ids"}
SCOPE_MEMBERS = {
    "sites": (Site, "site"),
    "prefixes": (Prefix, "prefix"),
    "devices": (Device, "device"),
    "virtual_machines": (VirtualMachine, "virtualmachine"),
}


def _ref(obj, label="name") -> dict | None:
    if obj is None:
        return None
    return {"id": str(obj.pk), "name": str(getattr(obj, label))}


def _paginate(request, qs, rows):
    pager = StandardPagination()
    page = pager.paginate_queryset(qs, request)
    return pager.get_paginated_response(rows(page))


def run_dict(r: InventoryRun) -> dict:
    return {
        "id": str(r.pk),
        "profile": {"id": str(r.profile_id), "name": r.profile.name},
        "trigger": r.trigger,
        "started_by_name": r.started_by_name,
        "engine": r.engine,
        "status": r.status,
        "created_at": r.created_at,
        "started_at": r.started_at,
        "finished_at": r.finished_at,
        "counts": r.counts or {},
        "errors": r.errors or [],
    }


# ─── status, settings ────────────────────────────────────────────────────────


@extend_schema(summary="Whether discovery is on", tags=["discovery"],
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discovery_status(request):
    """The deployment switch (``DANBYTE_DISCOVERY_ENABLED``), the tenant's
    Discovery toggle, and whether both are on. Any tenant member."""
    from api.views import _get_active_tenant
    from integrations.models import IntegrationSettings

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    toggle = IntegrationSettings.objects.filter(
        tenant=tenant, discovery_enabled=True).exists()
    return Response({"deployment_enabled": gate.deployment_enabled(), "enabled": toggle,
                     "active": gate.active(tenant),
                     "can_manage": can_manage_admin(request.user, tenant)})


def _clean_cidrs(value) -> list[str]:
    if not isinstance(value, list) or len(value) > DENY_MAX:
        raise ValidationError({"deny_subnets": f"A list of at most {DENY_MAX} CIDRs."})
    out, bad = [], []
    for raw in value:
        try:
            net = ipaddress.ip_network(str(raw).strip(), strict=False)
        except (ValueError, TypeError):
            bad.append(str(raw)[:64])
            continue
        if str(net) not in out:
            out.append(str(net))
    if bad:
        raise ValidationError({"deny_subnets": f"Not a CIDR: {', '.join(bad[:5])}."})
    return out


@extend_schema(summary="The tenant's discovery settings", tags=["discovery"],
               request=OpenApiTypes.OBJECT,
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def discovery_settings(request):
    """Deny subnets (CIDRs, any VRF) nothing in the tenant's discovery
    contacts. Read by tenant admins and whoever may view profiles; changed
    by tenant admins."""
    tenant = gate.require(request)
    admin = can_manage_admin(request.user, tenant)
    if not admin and not rbac.has_action(request.user, tenant, "inventoryprofile", "view"):
        raise PermissionDenied("inventoryprofile.view required.")
    row = DiscoverySettings.for_tenant(tenant)
    if request.method == "PATCH":
        if not admin:
            raise PermissionDenied("Tenant admin required.")
        if not isinstance(request.data, dict):
            raise ValidationError({"detail": "A JSON object."})
        if "deny_subnets" in request.data:
            row.deny_subnets = _clean_cidrs(request.data["deny_subnets"])
            row.save()
    return Response({"deny_subnets": row.deny_subnets, "can_change": admin,
                     "updated_at": row.updated_at})


# ─── profiles ────────────────────────────────────────────────────────────────


class InventoryProfileSerializer(serializers.ModelSerializer):
    site_ids = TenantScopedPrimaryKeyRelatedField(
        source="sites", many=True, required=False, queryset=Site.objects.all())
    prefix_ids = TenantScopedPrimaryKeyRelatedField(
        source="prefixes", many=True, required=False, queryset=Prefix.objects.all())
    device_ids = TenantScopedPrimaryKeyRelatedField(
        source="devices", many=True, required=False, queryset=Device.objects.all())
    virtual_machine_ids = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machines", many=True, required=False,
        queryset=VirtualMachine.objects.all())
    scope = serializers.SerializerMethodField()
    authorised = serializers.BooleanField(read_only=True)
    blocked_reason = serializers.SerializerMethodField()
    last_run = serializers.SerializerMethodField()

    class Meta:
        model = InventoryProfile
        fields = [
            "id", "numid", "name", "description", "enabled",
            "site_ids", "prefix_ids", "device_ids", "virtual_machine_ids", "scope",
            "interval_hours", "window_start", "window_end", "max_concurrency",
            "timeout_seconds", "authorisation", "authorised", "authorised_by_name",
            "authorised_at", "blocked_reason", "last_run_at", "last_run",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "numid", "authorised_by_name", "authorised_at",
                            "last_run_at", "created_at", "updated_at"]

    def get_scope(self, obj) -> dict:
        return {
            "sites": [_ref(s) for s in obj.sites.all()],
            "prefixes": [_ref(p, "cidr") for p in obj.prefixes.all()],
            "devices": [_ref(d) for d in obj.devices.all()],
            "virtual_machines": [_ref(v) for v in obj.virtual_machines.all()],
        }

    def get_blocked_reason(self, obj) -> str:
        return runner.can_run(obj)

    def get_last_run(self, obj) -> dict | None:
        r = obj.runs.order_by("-created_at").first()
        if r is None:
            return None
        return {"id": str(r.pk), "status": r.status, "created_at": r.created_at,
                "finished_at": r.finished_at, "counts": r.counts or {}}

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise ValidationError("Required.")
        return value

    def validate_interval_hours(self, value):
        if not 0 <= value <= 24 * 90:
            raise ValidationError("From 0 to 2160 hours.")
        return value

    def validate_max_concurrency(self, value):
        if not 1 <= value <= runner.CONCURRENCY_MAX:
            raise ValidationError(f"From 1 to {runner.CONCURRENCY_MAX}.")
        return value

    def validate_timeout_seconds(self, value):
        lo, hi = runner.TIMEOUT_RANGE
        if not lo <= value <= hi:
            raise ValidationError(f"From {lo} to {hi} seconds.")
        return value

    def validate_authorisation(self, value):
        value = (value or "").strip()
        if len(value) > 2000:
            raise ValidationError("At most 2000 characters.")
        return value

    def validate(self, attrs):
        request = self.context["request"]
        tenant = gate.require(request)
        user = request.user
        # Every scope member must be one the caller may view: a site role
        # scopes a profile only to what it can see (its own sites).
        if not user.is_superuser:
            for field, (model, slug) in SCOPE_MEMBERS.items():
                picked = attrs.get(field)
                if not picked:
                    continue
                visible = rbac.restrict_queryset(
                    model.objects.filter(tenant=tenant), user, tenant, slug, "view")
                ids = {o.pk for o in picked}
                if visible.filter(pk__in=ids).count() != len(ids):
                    raise ValidationError({ID_FIELDS[field]: "Not found."})
        return attrs


def _scope_ids(profile) -> tuple:
    return tuple(frozenset(getattr(profile, f).values_list("pk", flat=True))
                 for f in SCOPE_MEMBERS)


class InventoryProfileViewSet(TenantScopedViewSet):
    """Inventory profiles of the active tenant: what discovery reads, when,
    and who authorised it. Writing ``authorisation`` (a non-empty statement)
    records the caller and the time as the authoriser; a change to the scope
    without one clears the authorisation, and a profile without one never
    runs. Filters: ``enabled``, ``search``."""

    queryset = InventoryProfile.objects.prefetch_related(
        "sites", "prefixes", "devices", "virtual_machines")
    serializer_class = InventoryProfileSerializer
    rbac_action_map = {"run": "scan", "hosts": "view"}

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        gate.require(request)

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        enabled = (p.get("enabled") or "").strip().lower()
        if enabled in ("true", "1"):
            qs = qs.filter(enabled=True)
        elif enabled in ("false", "0"):
            qs = qs.filter(enabled=False)
        q = (p.get("search") or "").strip()
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(description__icontains=q))
        return qs.order_by("name", "pk")

    def _stamp(self, profile, data, before_scope):
        """The authorisation rule (see the class doc)."""
        user = self.request.user
        given = "authorisation" in data
        text = (data.get("authorisation") or "").strip() if given else profile.authorisation
        changed_scope = before_scope is not None and before_scope != _scope_ids(profile)
        fields = []
        if given and text:
            profile.authorised_by = user
            profile.authorised_by_name = user.get_username()[:150]
            profile.authorised_at = timezone.now()
            fields = ["authorised_by", "authorised_by_name", "authorised_at"]
        elif (given and not text) or changed_scope:
            profile.authorised_by = None
            profile.authorised_by_name = ""
            profile.authorised_at = None
            fields = ["authorised_by", "authorised_by_name", "authorised_at"]
        if fields:
            profile.save(update_fields=fields)

    def perform_create(self, serializer):
        try:
            with transaction.atomic():
                super().perform_create(serializer)
                self._stamp(serializer.instance, self.request.data, None)
        except IntegrityError:
            raise ValidationError({"name": "A profile with this name exists."}) from None

    def perform_update(self, serializer):
        before = _scope_ids(serializer.instance)
        try:
            with transaction.atomic():
                super().perform_update(serializer)
                self._stamp(serializer.instance, self.request.data, before)
        except IntegrityError:
            raise ValidationError({"name": "A profile with this name exists."}) from None

    @extend_schema(summary="Run a profile now", tags=["discovery"], request=None,
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=True, methods=["post"], url_path="run")
    def run(self, request, pk=None):
        """Queue a run. Needs ``scan`` on the profile and ``view`` on device
        credentials: the run logs in only with credentials the caller may
        view, to hosts they may view."""
        profile = self.get_object()
        tenant = profile.tenant
        if not request.user.is_superuser and not rbac.has_action(
                request.user, tenant, "devicecredential", "view"):
            raise PermissionDenied("devicecredential.view required.")
        try:
            r = runner.start(profile, user=request.user)
        except runner.RunRefused as exc:
            return Response({"detail": exc.message}, status=exc.status)
        r.profile = profile
        return Response(run_dict(r), status=202)

    @extend_schema(summary="The hosts a profile reads", tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=True, methods=["get"], url_path="hosts")
    def hosts(self, request, pk=None):
        """The scope as it resolves now, as the caller may see it: each host,
        its address, the credential it would use, and why it would be left
        alone. Nothing is contacted."""
        profile = self.get_object()
        user = None if request.user.is_superuser else request.user
        out = []
        for t in scope.resolve(profile, user=user):
            out.append({
                "kind": t.kind, "id": str(t.host.pk), "name": str(t.host),
                "address": t.address, "status": t.skip or "ready", "message": t.message,
                "credential": _ref(t.credential), "scan_exempt": t.host.scan_exempt,
            })
        return Response({"results": out, "count": len(out),
                         "truncated": scope.truncated(profile, user=user)})


# ─── runs ────────────────────────────────────────────────────────────────────


def _visible_profiles(request, tenant):
    qs = InventoryProfile.objects.filter(tenant=tenant)
    if request.user.is_superuser:
        return qs
    return rbac.restrict_queryset(qs, request.user, tenant, "inventoryprofile", "view")


def _visible_hosts_q(request, tenant, prefix=""):
    """Rows whose device or VM the caller may view."""
    if request.user.is_superuser:
        return Q()
    devices = rbac.restrict_queryset(Device.objects.filter(tenant=tenant), request.user,
                                     tenant, "device", "view")
    vms = rbac.restrict_queryset(VirtualMachine.objects.filter(tenant=tenant), request.user,
                                 tenant, "virtualmachine", "view")
    return (Q(**{f"{prefix}device__in": devices.values("pk")})
            | Q(**{f"{prefix}virtual_machine__in": vms.values("pk")}))


class InventoryRunViewSet(viewsets.ViewSet):
    """Runs of the profiles the caller may view, newest first. Filters:
    ``profile``, ``status``."""

    permission_classes = [IsAuthenticated]

    def _qs(self, request):
        tenant = gate.require(request)
        if not request.user.is_superuser and not rbac.has_action(
                request.user, tenant, "inventoryprofile", "view"):
            raise PermissionDenied("inventoryprofile.view required.")
        return tenant, InventoryRun.objects.filter(
            tenant=tenant, profile__in=_visible_profiles(request, tenant).values("pk")
        ).select_related("profile")

    @extend_schema(summary="Discovery runs", tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def list(self, request):
        _tenant, qs = self._qs(request)
        p = request.query_params
        profile = (p.get("profile") or "").strip()
        status = (p.get("status") or "").strip()
        if profile:
            try:
                qs = qs.filter(profile_id=uuid.UUID(profile))
            except ValueError:
                raise ValidationError({"profile": "Not a valid id."}) from None
        if status:
            qs = qs.filter(status__in=[s for s in status.split(",") if s])
        return _paginate(request, qs.order_by("-created_at", "pk"),
                         lambda page: [run_dict(r) for r in page])

    def _get(self, request, pk):
        _tenant, qs = self._qs(request)
        try:
            r = qs.filter(pk=pk).first()
        except (ValueError, DjangoValidationError):
            r = None
        if r is None:
            raise NotFound("Not found.")
        return r

    @extend_schema(summary="One discovery run", tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def retrieve(self, request, pk=None):
        return Response(run_dict(self._get(request, pk)))

    @extend_schema(summary="Per-host results of a run", tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=True, methods=["get"], url_path="hosts")
    def hosts(self, request, pk=None):
        """The hosts the run considered that the caller may view: status,
        transport, address, package counts. Filter: ``status``."""
        r = self._get(request, pk)
        qs = InventoryHostResult.objects.filter(run=r).filter(
            _visible_hosts_q(request, r.tenant)).select_related("device", "virtual_machine")
        status = (request.query_params.get("status") or "").strip()
        if status:
            qs = qs.filter(status__in=[s for s in status.split(",") if s])

        def rows(page):
            return [{
                "id": str(h.pk),
                "device": _ref(h.device), "virtual_machine": _ref(h.virtual_machine),
                "address": h.address, "status": h.status, "transport": h.transport,
                "message": h.message, "packages": h.packages, "added": h.added,
                "removed": h.removed, "updated": h.updated, "finished_at": h.finished_at,
            } for h in page]

        return _paginate(request, qs.order_by("status", "address", "pk"), rows)


# ─── exempt flag ─────────────────────────────────────────────────────────────

_EXEMPT_KINDS = {
    "device": (Device, "device"),
    "virtual_machine": (VirtualMachine, "virtualmachine"),
    "ipaddress": (IPAddress, "ipaddress"),
    "prefix": (Prefix, "prefix"),
}


@extend_schema(summary="Exempt a host, address or prefix from discovery",
               tags=["discovery"], request=OpenApiTypes.OBJECT,
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def discovery_exempt(request):
    """``{kind: device|virtual_machine|ipaddress|prefix, id, exempt}``. Needs
    ``change`` on the object (row and site scope included). Change-logged
    like any edit of it."""
    tenant = gate.require(request)
    data = request.data if isinstance(request.data, dict) else {}
    kind = data.get("kind")
    if kind not in _EXEMPT_KINDS:
        raise ValidationError({"kind": f"One of: {', '.join(_EXEMPT_KINDS)}."})
    if not isinstance(data.get("exempt"), bool):
        raise ValidationError({"exempt": "true or false."})
    model, slug = _EXEMPT_KINDS[kind]
    qs = model.objects.filter(tenant=tenant)
    if not request.user.is_superuser:
        if not rbac.has_action(request.user, tenant, slug, "change"):
            raise PermissionDenied(f"{slug}.change required.")
        qs = rbac.restrict_queryset(qs, request.user, tenant, slug, "change")
    try:
        obj = qs.filter(pk=data.get("id")).first()
    except (ValueError, DjangoValidationError):
        obj = None
    if obj is None:
        raise NotFound("Not found.")
    if obj.scan_exempt != data["exempt"]:
        obj.scan_exempt = data["exempt"]
        obj.save(update_fields=["scan_exempt", "updated_at"])
    return Response({"kind": kind, "id": str(obj.pk), "scan_exempt": obj.scan_exempt})


# ─── packages ────────────────────────────────────────────────────────────────

_HOSTS = {"device": (Device, "device"), "virtual_machine": (VirtualMachine, "virtualmachine")}


def os_dict(f: HostOsFact | None) -> dict | None:
    if f is None:
        return None
    return {"os_id": f.os_id, "version_id": f.version_id, "codename": f.codename,
            "pretty_name": f.pretty_name, "ecosystem": f.ecosystem,
            "package_manager": f.package_manager, "collected_at": f.collected_at}


def host_packages(request, kind: str, pk):
    tenant = gate.require(request)
    model, slug = _HOSTS[kind]
    qs = model.objects.filter(tenant=tenant)
    if not request.user.is_superuser:
        if not rbac.has_action(request.user, tenant, "installedsoftware", "view"):
            raise PermissionDenied("installedsoftware.view required.")
        qs = rbac.restrict_queryset(qs, request.user, tenant, slug, "view")
    host = qs.filter(pk=pk).first()
    if host is None:
        raise NotFound("Not found.")
    rows = HostPackage.objects.filter(tenant=tenant, removed_at__isnull=True, **{kind: host})
    q = (request.query_params.get("search") or "").strip()
    if q:
        rows = rows.filter(Q(name__icontains=q) | Q(source_name__icontains=q))
    fact = HostOsFact.objects.filter(**{kind: host}).first()

    def page_rows(page):
        return [{
            "id": str(p.pk), "name": p.name, "version": p.version, "arch": p.arch,
            "source_name": p.source_name, "source_version": p.source_version,
            "type": p.purl_type, "ecosystem": p.ecosystem, "purl": p.purl,
            "first_seen": p.first_seen, "last_seen": p.last_seen,
        } for p in page]

    response = _paginate(request, rows.order_by("name", "arch", "pk"), page_rows)
    response.data["os"] = os_dict(fact)
    return response


def _packages_view(kind: str):
    @extend_schema(summary=f"Inventoried packages of one {kind.replace('_', ' ')}",
                   tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @api_view(["GET"])
    @permission_classes([IsAuthenticated])
    def view(request, pk):
        return host_packages(request, kind, pk)

    view.__name__ = f"{kind}_packages"
    return view


device_packages = _packages_view("device")
virtual_machine_packages = _packages_view("virtual_machine")
