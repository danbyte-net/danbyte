"""Discovery endpoints (#451 B2). Every one but ``status/`` answers 404
while Discovery is off for the active tenant (``gate.require``).

``discovery/status/``                       GET: the two switches
``discovery/deployment/``                   PATCH (deployment admin): the stored
                                            deployment switch
``discovery/settings/``                     GET, PATCH (tenant admin): deny subnets
``discovery/profiles/``                     inventory profiles, CRUD
``discovery/profiles/<id>/run/``            POST: Run now (``scan``)
``discovery/profiles/<id>/hosts/``          GET: the scope as it resolves now
``discovery/policy-scopes/[<id>/]``         GET: monitoring policy scopes as profile
                                            fields, to copy into a profile
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
import json
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

from api.models import (
    VRF,
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Platform,
    Prefix,
    Region,
    Site,
    VirtualMachine,
)
from api.serializers import TenantScopedPrimaryKeyRelatedField
from api.viewsets import StandardPagination, TenantScopedViewSet
from auth_api import rbac
from auth_api.permissions import can_manage_admin, can_manage_deployment
from danbyte_checks import nmap as danbyte_nmap
from danbyte_checks import service_scan
from monitoring.models import MonitoringEngine, MonitoringPolicy, SharedCredential
from monitoring.policy_scopes import BY_VALUE as POLICY_SCOPES

from . import gate, outposts, runner, scope, services, shared_scope
from . import nmap as nmap_engine
from .models import (
    PROFILE_KINDS,
    RUNS_ON,
    DiscoverySettings,
    HostOsFact,
    HostPackage,
    InventoryHostResult,
    InventoryProfile,
    InventoryRun,
)

DENY_MAX = 500
#: Transport switch → DiscoverySettings field, most secure first.
TRANSPORT_FIELDS = {"ssh_key": "ssh_key_enabled", "ssh_password": "ssh_password_enabled",
                    "winrm": "winrm_enabled"}
ID_FIELDS = {"sites": "site_ids", "prefixes": "prefix_ids", "devices": "device_ids",
             "virtual_machines": "virtual_machine_ids", "regions": "region_ids",
             "vrfs": "vrf_ids", "platforms": "platform_ids",
             "device_types": "device_type_ids", "device_roles": "device_role_ids"}
#: Profile scope field → (model, RBAC slug). The monitoring kinds take
#: their slug from the policy scope registry, as the policy form does.
SCOPE_MEMBERS = {
    "sites": (Site, "site"),
    "prefixes": (Prefix, "prefix"),
    "devices": (Device, "device"),
    "virtual_machines": (VirtualMachine, "virtualmachine"),
    **{field: (model, POLICY_SCOPES[kind].rbac_slug)
       for kind, field, model in (("region", "regions", Region), ("vrf", "vrfs", VRF),
                                  ("platform", "platforms", Platform),
                                  ("device_type", "device_types", DeviceType),
                                  ("device_role", "device_roles", DeviceRole))},
}
#: The profile fields that name a monitoring policy scope kind, by field.
WIDE_FIELDS = {f: k for k, f in shared_scope.RESOLVED_FIELDS.items()}


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
        "kind": r.kind,
        "started_by_name": r.started_by_name,
        "authorisation": r.authorisation,
        "authorised_by_name": r.authorised_by_name,
        "engine": r.engine,
        "status": r.status,
        "created_at": r.created_at,
        "started_at": r.started_at,
        "finished_at": r.finished_at,
        "counts": r.counts or {},
        "summary": runner.summary(r.counts or {}),
        "accept_new_host_keys": r.accept_new_host_keys,
        "errors": r.errors or [],
        # A run on Outposts: hosts still waiting for or with their Outpost.
        "outstanding": r.work_items.filter(status__in=outposts.OPEN).count()
        if r.engine != "server" and r.status == "running" else 0,
    }


# ─── status, settings ────────────────────────────────────────────────────────


def _deployment(request, tenant=None) -> dict:
    """The deployment switch as the Discovery card shows it: on or off,
    whether the environment locks it, and - for tenant and deployment
    admins - the last change of the stored setting (who, when) from the
    change log."""
    from audit.models import ChangeLogEntry

    source = gate.deployment_source()
    out = {"enabled": gate.deployment_enabled(), "source": source, "changed_by": "",
           "changed_at": None,
           "can_change": source == "setting" and can_manage_deployment(request.user)}
    if source == "setting" and (out["can_change"]
                                or can_manage_admin(request.user, tenant)):
        last = ChangeLogEntry.objects.filter(
            object_type="core.deploymentsettings",
            changes__has_key="discovery_enabled").order_by("-timestamp").first()
        if last is not None:
            out["changed_by"], out["changed_at"] = last.user_name, last.timestamp
    return out


def _status(request, tenant) -> dict:
    from integrations.models import IntegrationSettings

    toggle = IntegrationSettings.objects.filter(
        tenant=tenant, discovery_enabled=True).exists()
    deployment = _deployment(request, tenant)
    return {"deployment_enabled": deployment["enabled"], "deployment": deployment,
            "enabled": toggle, "active": gate.active(tenant),
            "can_manage": can_manage_admin(request.user, tenant),
            "first_use_keys_allowed": gate.first_use_keys_allowed()}


@extend_schema(summary="Whether discovery is on", tags=["discovery"],
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discovery_status(request):
    """The deployment switch (``deployment``: on/off, ``source`` env or
    setting, the last change), the tenant's Discovery toggle, and whether
    both are on. Any tenant member."""
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    return Response(_status(request, tenant))


@extend_schema(summary="Allow discovery on this deployment", tags=["discovery"],
               request=OpenApiTypes.OBJECT,
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["PATCH"])
@permission_classes([IsAuthenticated])
def discovery_deployment(request):
    """``{enabled: bool}``: the stored deployment switch. Deployment admins
    only (``can_manage_deployment``: a tenant admin is refused). Refused
    with 409 while ``DANBYTE_DISCOVERY_ENABLED`` decides. Change-logged on
    the deployment settings. Answers the status, as ``status/`` does."""
    from api.views import _get_active_tenant
    from core.models import DeploymentSettings

    if not can_manage_deployment(request.user):
        raise PermissionDenied("Deployment admin required.")
    if gate.deployment_source() == "env":
        return Response({"detail": "Locked by DANBYTE_DISCOVERY_ENABLED in the server "
                                   "environment."}, status=409)
    data = request.data if isinstance(request.data, dict) else {}
    if not isinstance(data.get("enabled"), bool):
        raise ValidationError({"enabled": "true or false."})
    row = DeploymentSettings.load()
    if row.discovery_enabled != data["enabled"]:
        row.discovery_enabled = data["enabled"]
        row.save(update_fields=["discovery_enabled", "updated_at"])
        transaction.on_commit(_rematch_all)
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"deployment": _deployment(request)})
    return Response(_status(request, tenant))


def _rematch_all() -> None:
    """Package matches exist only while discovery is on: the deployment
    switch flipping re-matches every tenant with the Discovery toggle on."""
    from integrations.models import IntegrationSettings
    from vulnerabilities import jobs
    from vulnerabilities.models import VulnerabilitySettings

    if not VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists():
        return
    for tenant_id in IntegrationSettings.objects.filter(
            discovery_enabled=True).values_list("tenant_id", flat=True):
        jobs.enqueue_recompute(tenant_id)


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
    contacts, and the transport switches (``transports``: ``ssh_key``,
    ``ssh_password``, ``winrm``; WinRM only while ``winrm.available``). Read
    by tenant admins and whoever may view profiles; changed by tenant
    admins."""
    tenant = gate.require(request)
    admin = can_manage_admin(request.user, tenant)
    if not admin and not rbac.has_action(request.user, tenant, "inventoryprofile", "view"):
        raise PermissionDenied("inventoryprofile.view required.")
    row = DiscoverySettings.for_tenant(tenant)
    winrm_ok, winrm_label, winrm_reason = gate.winrm_state()
    nmap_state = nmap_engine.state()
    if request.method == "PATCH":
        if not admin:
            raise PermissionDenied("Tenant admin required.")
        if not isinstance(request.data, dict):
            raise ValidationError({"detail": "A JSON object."})
        fields = []
        if "deny_subnets" in request.data:
            row.deny_subnets = _clean_cidrs(request.data["deny_subnets"])
            fields.append("deny_subnets")
        if "transports" in request.data:
            t = request.data["transports"]
            if not isinstance(t, dict) or set(t) - set(TRANSPORT_FIELDS) or not all(
                    isinstance(v, bool) for v in t.values()):
                raise ValidationError({"transports": "An object of ssh_key, ssh_password "
                                                     "and winrm, each true or false."})
            if t.get("winrm") and not winrm_ok:
                raise ValidationError({"transports": f"WinRM: {winrm_reason}"})
            for key, value in t.items():
                setattr(row, TRANSPORT_FIELDS[key], value)
                fields.append(TRANSPORT_FIELDS[key])
        if "nmap" in request.data:
            on = request.data["nmap"]
            if not isinstance(on, bool):
                raise ValidationError({"nmap": "true or false."})
            if on and not nmap_state["available"] and not _outposts_with_nmap(tenant):
                raise ValidationError({"nmap": f"nmap: {nmap_state['label']}."})
            row.nmap_enabled = on
            fields.append("nmap_enabled")
        if fields:
            row.save(update_fields=[*fields, "updated_at"])
    return Response({
        "deny_subnets": row.deny_subnets,
        "transports": {key: getattr(row, f) for key, f in TRANSPORT_FIELDS.items()},
        "winrm": {"available": winrm_ok, "label": winrm_label, "reason": winrm_reason},
        "nmap": {**nmap_state,
                 "enabled": row.nmap_enabled and (nmap_state["available"]
                                                  or bool(_outposts_with_nmap(tenant))),
                 "outposts": _outposts_with_nmap(tenant)},
        "can_change": admin, "updated_at": row.updated_at})


def _outposts_with_nmap(tenant) -> list[str]:
    """The names of the tenant's Outposts whose agent found an nmap it may
    run (as their last hello said)."""
    if not nmap_engine.allowed():
        return []
    return sorted(e.name for e in MonitoringEngine.objects.filter(
        tenant=tenant, kind=MonitoringEngine.REMOTE, enabled=True)
        if (outposts.capabilities(e).get("nmap") or {}).get("version"))


def outpost_dict(engine, now=None) -> dict:
    """An Outpost as the Runs on picker shows it: online, agent, and per
    work kind whether it can take it now and why not."""
    caps = outposts.capabilities(engine)
    can = {}
    for key, kind, scan_engine in (("inventory", "inventory", "builtin"),
                                   ("service_scan", "service_scan", "builtin"),
                                   ("nmap", "service_scan", "nmap")):
        status, message = outposts.why_not(engine, kind, scan_engine, now=now)
        can[key] = {"ok": not status, "status": status, "reason": message}
    return {"id": str(engine.pk), "name": engine.name, "enabled": engine.enabled,
            "transport": engine.transport, "online": outposts.online(engine, now),
            "last_seen_at": engine.last_seen_at, "agent_version": engine.agent_version,
            "kinds": caps.get("kinds") or [],
            "nmap_version": (caps.get("nmap") or {}).get("version", ""),
            "can": can}


@extend_schema(summary="Outposts discovery can run on", tags=["discovery"],
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discovery_outposts(request):
    """The tenant's Outposts with what each can run now (``can``: inventory,
    service_scan, nmap - ``ok`` or the reason), for the Runs on picker.
    Whoever may view profiles. Filter: ``search``."""
    tenant = gate.require(request)
    if not request.user.is_superuser and not rbac.has_action(
            request.user, tenant, "inventoryprofile", "view"):
        raise PermissionDenied("inventoryprofile.view required.")
    qs = MonitoringEngine.objects.filter(tenant=tenant, kind=MonitoringEngine.REMOTE)
    q = (request.query_params.get("search") or "").strip()
    if q:
        qs = qs.filter(name__icontains=q)
    now = timezone.now()
    rows = [outpost_dict(e, now) for e in qs.select_related("tenant").order_by("name", "pk")[:500]]
    return Response({"results": rows, "count": len(rows),
                     "agent_version": outposts.AGENT_VERSION})


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
    region_ids = TenantScopedPrimaryKeyRelatedField(
        source="regions", many=True, required=False, queryset=Region.objects.all())
    vrf_ids = TenantScopedPrimaryKeyRelatedField(
        source="vrfs", many=True, required=False, queryset=VRF.objects.all())
    platform_ids = TenantScopedPrimaryKeyRelatedField(
        source="platforms", many=True, required=False, queryset=Platform.objects.all())
    device_type_ids = TenantScopedPrimaryKeyRelatedField(
        source="device_types", many=True, required=False, queryset=DeviceType.objects.all())
    device_role_ids = TenantScopedPrimaryKeyRelatedField(
        source="device_roles", many=True, required=False, queryset=DeviceRole.objects.all())
    scope_global = serializers.BooleanField(required=False)
    shared_credential_id = TenantScopedPrimaryKeyRelatedField(
        source="shared_credential", required=False, allow_null=True,
        queryset=SharedCredential.objects.all())
    shared_credential = serializers.SerializerMethodField()
    runs_on = serializers.ChoiceField(choices=[k for k, _l in RUNS_ON], required=False)
    outpost_id = TenantScopedPrimaryKeyRelatedField(
        source="outpost", required=False, allow_null=True,
        queryset=MonitoringEngine.objects.filter(kind=MonitoringEngine.REMOTE))
    outpost = serializers.SerializerMethodField()
    scope = serializers.SerializerMethodField()
    authorised = serializers.BooleanField(read_only=True)
    kind = serializers.ChoiceField(choices=[k for k, _l in PROFILE_KINDS], required=False)
    ports = serializers.JSONField(required=False)
    rate_cap = serializers.SerializerMethodField()
    blocked_reason = serializers.SerializerMethodField()
    last_run = serializers.SerializerMethodField()

    class Meta:
        model = InventoryProfile
        fields = [
            "id", "numid", "name", "description", "enabled", "kind",
            "site_ids", "prefix_ids", "device_ids", "virtual_machine_ids",
            "region_ids", "vrf_ids", "platform_ids", "device_type_ids", "device_role_ids",
            "scope_global", "scope",
            "shared_credential_id", "shared_credential",
            "interval_hours", "window_start", "window_end", "max_concurrency",
            "timeout_seconds", "ports", "connects_per_second", "rate_cap",
            "scan_engine", "nmap_version_intensity", "nmap_timing",
            "runs_on", "outpost_id", "outpost",
            "authorisation", "authorised", "authorised_by_name",
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
            "regions": [_ref(r) for r in obj.regions.all()],
            "vrfs": [_ref(v) for v in obj.vrfs.all()],
            "platforms": [_ref(p) for p in obj.platforms.all()],
            "device_types": [_ref(t) for t in obj.device_types.all()],
            "device_roles": [_ref(r) for r in obj.device_roles.all()],
            "global": obj.scope_global,
        }

    def get_outpost(self, obj) -> dict | None:
        return None if obj.outpost is None else outpost_dict(obj.outpost)

    def get_shared_credential(self, obj) -> dict | None:
        c = obj.shared_credential
        return None if c is None else {"id": str(c.pk), "name": c.name, "kind": c.kind}

    def get_rate_cap(self, obj) -> int:
        return services.rate_cap()

    def validate_kind(self, value):
        if self.instance is not None and value != self.instance.kind:
            raise ValidationError("A profile's kind does not change.")
        return value

    def validate_ports(self, value):
        try:
            service_scan.parse_ports(value)
        except ValueError as exc:
            raise ValidationError(str(exc)) from None
        return value or []

    def validate_connects_per_second(self, value):
        cap = services.rate_cap()
        if not 1 <= value <= cap:
            raise ValidationError(f"From 1 to {cap} (this deployment's cap).")
        return value

    def validate_nmap_version_intensity(self, value):
        lo, hi = danbyte_nmap.INTENSITY_RANGE
        if not lo <= value <= hi:
            raise ValidationError(f"From {lo} to {hi}.")
        return value

    def validate_nmap_timing(self, value):
        lo, hi = danbyte_nmap.TIMING_RANGE
        if not lo <= value <= hi:
            raise ValidationError(f"From {lo} to {hi} (-T{lo} to -T{hi}).")
        return value

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
        kind = attrs.get("kind") or (self.instance.kind if self.instance else "inventory")
        self._check_wide_scope(attrs, tenant, user, kind)
        runs_on = attrs.get("runs_on") or (self.instance.runs_on if self.instance else "server")
        if runs_on == "outpost":
            outpost = attrs["outpost"] if "outpost" in attrs else (
                self.instance.outpost if self.instance else None)
            if outpost is None:
                raise ValidationError({"outpost_id": "Pick the Outpost it runs on."})
        else:
            attrs["outpost"] = None
        engine = attrs.get("scan_engine")
        moved = self.instance is not None and runs_on != self.instance.runs_on
        if engine == "nmap" and (self.instance is None or moved
                                 or self.instance.scan_engine != "nmap"):
            if kind != "service_scan":
                raise ValidationError({"scan_engine": "Only a service scan has an engine."})
            # On the server, the server's nmap; on Outposts, theirs (a run
            # says per host when one has none).
            reason = nmap_engine.why_not(tenant) if runs_on == "server" \
                else outposts.nmap_why_not(tenant)
            if reason:
                raise ValidationError({"scan_engine": reason})
        pinned = attrs.get("shared_credential")
        if pinned is not None:
            if pinned.kind not in (*scope.SSH_KINDS, scope.WINRM_KIND):
                raise ValidationError({"shared_credential_id":
                                       "Pick an SSH key, SSH password or WinRM certificate."})
            if not user.is_superuser and not rbac.restrict_queryset(
                    SharedCredential.objects.filter(tenant=tenant, pk=pinned.pk), user,
                    tenant, "sharedcredential", "view").exists():
                raise ValidationError({"shared_credential_id": "Not found."})
        return attrs

    def _check_wide_scope(self, attrs, tenant, user, kind):
        """Global is chosen on purpose, and the kinds not tied to one site are
        added only by someone who sees every host they can reach: a site
        role may add a region only when every site in it is theirs."""
        inst = self.instance
        if attrs.get("scope_global") and not (inst and inst.scope_global):
            confirm = self.context["request"].data.get("confirm_global")
            if confirm is not True:
                raise ValidationError({"scope_global": "Confirm scanning everything in "
                                                       "the tenant (confirm_global)."})
        added = {}
        if attrs.get("scope_global") and not (inst and inst.scope_global):
            added["scope_global"] = True
        for field in WIDE_FIELDS:
            if field not in attrs:
                continue
            before = set(getattr(inst, field).values_list("pk", flat=True)) if inst else set()
            new = [o for o in attrs[field] if o.pk not in before]
            if new:
                added[field] = new
        if not added or user.is_superuser:
            return
        slugs = ["device", "virtualmachine"] + (["ipaddress"] if kind == "service_scan" else [])
        if all(rbac.row_filter(user, tenant, s, "view") is True for s in slugs):
            return
        for field in added:
            if field == "regions":
                sites = set(shared_scope.region_site_ids(tenant, [r.pk for r in added[field]]))
                scopes = [rbac.site_scope(user, tenant, s, "view") for s in slugs]
                # Every granting permission is site-scoped and those sites
                # cover the region (site_scope None = unscoped or no site).
                if all(sc is not None and sites <= sc for sc in scopes) and all(
                        rbac.row_filter(user, tenant, s, "view") is not None for s in slugs):
                    continue
                raise ValidationError({"region_ids": "Only a region whose sites are all "
                                                     "yours."})
            key = "scope_global" if field == "scope_global" else ID_FIELDS[field]
            raise ValidationError({key: "Needs access to every site."})


def _scope_ids(profile) -> tuple:
    """What an authorisation covers: the scope, and for a service scan the
    ports too (a wider port list is a new authorisation)."""
    ids = (*(frozenset(getattr(profile, f).values_list("pk", flat=True))
             for f in SCOPE_MEMBERS), profile.scope_global)
    # Where it runs is part of what was authorised: another vantage point
    # reaches other networks.
    ids = (*ids, profile.runs_on, str(profile.outpost_id or ""))
    if profile.kind == "service_scan":
        # The engine decides what is sent to each host (built-in connects or
        # nmap's probes), so a change of engine is a new authorisation too.
        return (*ids, json.dumps(profile.ports or [], sort_keys=True), profile.scan_engine)
    return ids


def _nmap_rose(profile, before: tuple | None) -> bool:
    """Whether an nmap service scan now probes harder than when it was
    authorised: a higher version intensity or a faster timing template."""
    if before is None or profile.kind != "service_scan" or profile.scan_engine != "nmap":
        return False
    intensity, timing = before
    return (profile.nmap_version_intensity or 0) > (intensity or 0) \
        or (profile.nmap_timing or 0) > (timing or 0)


class InventoryProfileViewSet(TenantScopedViewSet):
    """Inventory profiles of the active tenant: what discovery reads, when,
    and who authorised it. Writing ``authorisation`` (a non-empty statement)
    records the caller and the time as the authoriser; a change to what it
    covers without one - the scope, Runs on, for a service scan the ports,
    the engine, or a higher nmap intensity or timing - clears the
    authorisation, and a profile without one never runs. Filters:
    ``enabled``, ``search``."""

    queryset = InventoryProfile.objects.select_related(
        "shared_credential", "outpost").prefetch_related(
        "sites", "prefixes", "devices", "virtual_machines", "regions", "vrfs", "platforms",
        "device_types", "device_roles")
    serializer_class = InventoryProfileSerializer
    rbac_action_map = {"run": "scan", "hosts": "view", "host_keys": "view"}

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
        kind = (p.get("kind") or "").strip()
        if kind:
            qs = qs.filter(kind__in=[k for k in kind.split(",") if k])
        policy = (p.get("policy") or "").strip()
        if policy:
            # Profiles whose own scope names what this monitoring policy is
            # about - the policy page's Discovery line.
            target = _visible_policy(self.request, gate.require(self.request), policy)
            q = shared_scope.covered_by_policy_q(target) if target is not None else None
            qs = qs.filter(q).distinct() if q is not None else qs.none()
        return qs.order_by("name", "pk")

    def _stamp(self, profile, data, before_scope, before_nmap=None):
        """The authorisation rule (see the class doc)."""
        user = self.request.user
        given = "authorisation" in data
        text = (data.get("authorisation") or "").strip() if given else profile.authorisation
        changed_scope = (before_scope is not None and before_scope != _scope_ids(profile)) \
            or _nmap_rose(profile, before_nmap)
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
        nmap = (serializer.instance.nmap_version_intensity, serializer.instance.nmap_timing)
        try:
            with transaction.atomic():
                super().perform_update(serializer)
                self._stamp(serializer.instance, self.request.data, before, nmap)
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
        scan = profile.kind == "service_scan"
        # A service scan sends no credential; an inventory run logs in.
        if not scan and not request.user.is_superuser and not rbac.has_action(
                request.user, tenant, "devicecredential", "view"):
            raise PermissionDenied("devicecredential.view required.")
        data = request.data if isinstance(request.data, dict) else {}
        first_use = data.get("accept_new_host_keys", False)
        if not isinstance(first_use, bool):
            raise ValidationError({"accept_new_host_keys": "true or false."})
        if first_use and scan:
            raise ValidationError({"accept_new_host_keys": "A service scan logs in nowhere."})
        if first_use:
            if not gate.first_use_keys_allowed():
                raise ValidationError({"accept_new_host_keys":
                                       "This deployment does not allow it."})
            if not request.user.is_superuser and not rbac.has_action(
                    request.user, tenant, "sshhostkey", "change"):
                raise PermissionDenied("sshhostkey.change required to accept host keys.")
        try:
            r = runner.start(profile, user=request.user, accept_new_host_keys=first_use)
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
        remote = profile.runs_on != "server"
        if profile.kind == "service_scan":
            targets = services.resolve(profile, user=user, outpost=remote)
            where = outposts.preview(profile, targets) if remote else {}
            rows = [{
                "kind": t.kind or "ipaddress", "id": str(t.host.pk if t.host else t.ip.pk),
                "name": str(t.host) if t.host is not None else t.address,
                "ip_address": {"id": str(t.ip.pk), "address": t.address},
                "address": t.address, "status": t.skip or "ready", "message": t.message,
                "credential": None, "credential_source": "",
                "scan_exempt": bool(t.host.scan_exempt if t.host else t.ip.scan_exempt),
                "engine": where.get(id(t), "server"),
            } for t in targets]
            return Response({"results": rows, "count": len(rows),
                             "truncated": services.truncated(profile, user=user)})
        out = []
        targets = scope.resolve(profile, user=user, outpost=remote)
        where = outposts.preview(profile, targets) if remote else {}
        for t in targets:
            out.append({
                "kind": t.kind, "id": str(t.host.pk), "name": str(t.host),
                "address": t.address, "status": t.skip or "ready", "message": t.message,
                "credential": _ref(t.credential), "scan_exempt": t.host.scan_exempt,
                "credential_source": t.logins[0].source if t.logins else "",
                "engine": where.get(id(t), "server"),
            })
        return Response({"results": out, "count": len(out),
                         "truncated": scope.truncated(profile, user=user)})

    @extend_schema(summary="Host keys to review for a profile's hosts", tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=True, methods=["get"], url_path="host-keys")
    def host_keys(self, request, pk=None):
        """Observed, not yet accepted SSH host keys of the hosts in scope."""
        profile = self.get_object()
        user = None if request.user.is_superuser else request.user
        devices, vms = scope._host_querysets(profile, user)
        rows = pending_host_keys(request, profile.tenant, devices.values("pk"),
                                 vms.values("pk"))
        return Response({"results": rows, "count": len(rows)})


def _visible_policy(request, tenant, pk):
    """The monitoring policy ``pk`` if the caller may view it - by the policy
    list's own rules (grant, site scope, target visibility)."""
    from monitoring.viewsets import MonitoringPolicyViewSet

    try:
        uuid.UUID(str(pk))
    except ValueError:
        return None
    view = MonitoringPolicyViewSet()
    view.request, view.format_kwarg, view.kwargs, view.action = request, None, {}, "retrieve"
    qs = MonitoringPolicy.objects.filter(tenant=tenant, pk=pk).select_related(
        "vrf", "device_type", "device_role", "device", "prefix", "target_site", "region",
        "platform")
    return view._scope_configuration_queryset(qs, action="view").first()


def policy_scope_dict(policy) -> dict:
    """What copying ``policy``'s scope into a profile gives: the profile
    field, the member, and why it cannot be copied when it cannot."""
    spec = POLICY_SCOPES.get(policy.scope)
    field = shared_scope.COPY_FIELDS.get(policy.scope)
    target = getattr(policy, spec.field) if spec is not None and spec.field else None
    label = "cidr" if policy.scope == "prefix" else "name"
    out = {"id": str(policy.pk), "scope": policy.scope,
           "scope_label": spec.label if spec else policy.scope,
           "target": _ref(target, label), "global": policy.scope == shared_scope.GLOBAL,
           "field": ID_FIELDS.get(field) if field else None,
           "filters": bool(policy.match_tags or policy.match_name or policy.match_interface
                           or policy.match_hardware or policy.target != "all"),
           "copyable": True, "reason": ""}
    if spec is None or (spec.field and target is None):
        out["copyable"] = False
        out["reason"] = ("A Global VRF policy names no VRF to copy." if policy.scope == "vrf"
                         else "This policy names nothing to copy.")
    return out


def _may_shape_profiles(request, tenant) -> None:
    user = request.user
    if not user.is_superuser and not (
            rbac.has_action(user, tenant, "inventoryprofile", "add")
            or rbac.has_action(user, tenant, "inventoryprofile", "change")):
        raise PermissionDenied("inventoryprofile.add or change required.")


@extend_schema(summary="Monitoring policy scopes, to copy into a profile",
               tags=["discovery"], responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discovery_policy_scopes(request):
    """The monitoring policies the caller may view, each as the profile
    fields copying its scope gives (see ``policy-scopes/<id>/``), for the
    profile dialog's picker. Whoever may add or change profiles. Filter:
    ``search`` (scope or target name)."""
    from monitoring.viewsets import MonitoringPolicyViewSet

    tenant = gate.require(request)
    _may_shape_profiles(request, tenant)
    view = MonitoringPolicyViewSet()
    view.request, view.format_kwarg, view.kwargs, view.action = request, None, {}, "list"
    qs = view._scope_configuration_queryset(
        MonitoringPolicy.objects.filter(tenant=tenant).select_related(
            "vrf", "device_type", "device_role", "device", "prefix", "target_site", "region",
            "platform"), action="view")
    q = (request.query_params.get("search") or "").strip().lower()
    rows = []
    for policy in qs.order_by("scope", "created_at")[:2000]:
        row = policy_scope_dict(policy)
        text = f"{row['scope_label']} {(row['target'] or {}).get('name', '')}".lower()
        if q and q not in text:
            continue
        rows.append(row)
        if len(rows) >= 500:
            break
    return Response({"results": rows, "count": len(rows)})


@extend_schema(summary="A monitoring policy's scope, to copy into a profile",
               tags=["discovery"], responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discovery_policy_scope(request, pk):
    """The scope of monitoring policy ``pk`` as profile fields (``field`` and
    ``target``, or ``global``), for the profile dialog's copy. Whoever may
    add or change profiles, for a policy they may view. A copy, never a
    link: nothing here changes when the policy does."""
    tenant = gate.require(request)
    _may_shape_profiles(request, tenant)
    policy = _visible_policy(request, tenant, pk)
    if policy is None:
        raise NotFound()
    return Response(policy_scope_dict(policy))


# ─── runs ────────────────────────────────────────────────────────────────────


def _visible_profiles(request, tenant):
    qs = InventoryProfile.objects.filter(tenant=tenant)
    if request.user.is_superuser:
        return qs
    return rbac.restrict_queryset(qs, request.user, tenant, "inventoryprofile", "view")


def _visible_hosts_q(request, tenant, prefix="", *, addresses=False):
    """Rows whose device or VM the caller may view; with ``addresses``
    (service-scan rows), also rows of an address with no host that the
    caller may view."""
    if request.user.is_superuser:
        return Q()
    devices = rbac.restrict_queryset(Device.objects.filter(tenant=tenant), request.user,
                                     tenant, "device", "view")
    vms = rbac.restrict_queryset(VirtualMachine.objects.filter(tenant=tenant), request.user,
                                 tenant, "virtualmachine", "view")
    q = (Q(**{f"{prefix}device__in": devices.values("pk")})
         | Q(**{f"{prefix}virtual_machine__in": vms.values("pk")}))
    if addresses:
        ips = rbac.restrict_queryset(IPAddress.objects.filter(tenant=tenant), request.user,
                                     tenant, "ipaddress", "view")
        q |= Q(**{f"{prefix}device__isnull": True, f"{prefix}virtual_machine__isnull": True,
                  f"{prefix}ip_address__in": ips.values("pk")})
    return q


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
        kind = (p.get("kind") or "").strip()
        if kind:
            qs = qs.filter(kind__in=[k for k in kind.split(",") if k])
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
        """One run; ``advisories`` says whether the vulnerability store has
        advisory data for the packages it brought (``discovery.advisories``),
        null when that does not apply."""
        from .advisories import run_state

        r = self._get(request, pk)
        return Response({**run_dict(r), "advisories": run_state(r, request)})

    @extend_schema(summary="Per-host results of a run", tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=True, methods=["get"], url_path="hosts")
    def hosts(self, request, pk=None):
        """The hosts the run considered that the caller may view: status,
        transport, address, package counts. Filter: ``status``."""
        r = self._get(request, pk)
        qs = InventoryHostResult.objects.filter(run=r).filter(
            _visible_hosts_q(request, r.tenant, addresses=r.kind == "service_scan")
        ).select_related("device", "virtual_machine")
        status = (request.query_params.get("status") or "").strip()
        if status:
            qs = qs.filter(status__in=[s for s in status.split(",") if s])

        def rows(page):
            return [{
                "id": str(h.pk),
                "device": _ref(h.device), "virtual_machine": _ref(h.virtual_machine),
                "address": h.address, "status": h.status, "transport": h.transport,
                "credential_source": h.credential_source, "key_first_use": h.key_first_use,
                "attempts": h.attempts or [],
                "message": h.message, "packages": h.packages, "added": h.added,
                "removed": h.removed, "updated": h.updated, "finished_at": h.finished_at,
                "ip_address": str(h.ip_address_id) if h.ip_address_id else None,
                "services": h.services, "connects": h.connects, "engine": h.engine,
            } for h in page]

        return _paginate(request, qs.order_by("status", "address", "pk"), rows)

    @extend_schema(summary="Host keys to review for a run's hosts", tags=["discovery"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=True, methods=["get"], url_path="host-keys")
    def host_keys(self, request, pk=None):
        """Observed, not yet accepted SSH host keys of the hosts this run
        considered."""
        r = self._get(request, pk)
        hosts = InventoryHostResult.objects.filter(run=r)
        rows = pending_host_keys(
            request, r.tenant,
            hosts.filter(device__isnull=False).values("device_id"),
            hosts.filter(virtual_machine__isnull=False).values("virtual_machine_id"))
        return Response({"results": rows, "count": len(rows)})


# ─── host keys to review ─────────────────────────────────────────────────────

ACCEPT_MAX = 500


def pending_host_keys(request, tenant, dev_ids, vm_ids) -> list[dict]:
    """Observed host keys not yet accepted, on the given hosts, that the
    caller may view (``sshhostkey`` view, site scope included). ``mismatch``:
    the host already has an accepted key of the same type - this one
    differs, so it is never bulk-accepted."""
    from monitoring.models import SSHHostKey

    user = request.user
    if not user.is_superuser and not rbac.has_action(user, tenant, "sshhostkey", "view"):
        raise PermissionDenied("sshhostkey.view required.")
    host_q = Q(device_id__in=dev_ids) | Q(virtual_machine_id__in=vm_ids)
    keys = SSHHostKey.objects.filter(tenant=tenant).filter(host_q).filter(
        _visible_hosts_q(request, tenant)).select_related("device", "virtual_machine")
    if not user.is_superuser:
        keys = rbac.restrict_queryset(keys, user, tenant, "sshhostkey", "view")
        changeable = set(rbac.restrict_queryset(
            SSHHostKey.objects.filter(tenant=tenant).filter(host_q), user, tenant,
            "sshhostkey", "change").values_list("pk", flat=True)) if rbac.has_action(
            user, tenant, "sshhostkey", "change") else set()
    else:
        changeable = None
    keys = list(keys)
    accepted = {(k.device_id, k.virtual_machine_id, k.key_type) for k in keys if k.uploaded}
    # Accepted keys the caller cannot see still make a new one a mismatch.
    accepted |= set(SSHHostKey.objects.filter(tenant=tenant, uploaded=True).filter(
        host_q).values_list("device_id", "virtual_machine_id", "key_type"))
    out = []
    for k in keys:
        if k.uploaded or not k.observed:
            continue
        mismatch = (k.device_id, k.virtual_machine_id, k.key_type) in accepted
        host = k.device or k.virtual_machine
        ip = getattr(host, "primary_ip", None)
        out.append({
            "id": str(k.pk),
            "device": _ref(k.device), "virtual_machine": _ref(k.virtual_machine),
            "address": str(ip.ip_address).split("/")[0] if ip is not None else "",
            "key_type": k.key_type, "fingerprint": k.fingerprint_sha256,
            "first_seen": k.first_seen, "last_seen": k.last_seen,
            "mismatch": mismatch,
            "can_accept": not mismatch and (changeable is None or k.pk in changeable),
        })
    out.sort(key=lambda r: (r["mismatch"], (r["device"] or r["virtual_machine"])["name"],
                            r["key_type"]))
    return out


@extend_schema(summary="Accept observed SSH host keys", tags=["discovery"],
               request=OpenApiTypes.OBJECT,
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def discovery_accept_host_keys(request):
    """``{ids: [...]}``: mark observed host keys accepted, as **accept
    observed** on the host-key list does one at a time. Needs ``change`` on
    SSH host keys (row and site scope included). A key that differs from an
    accepted key of the same type on its host is refused, never accepted in
    bulk; ids of another tenant or out of the caller's scope count as not
    found. Each acceptance is change-logged."""
    from monitoring.models import SSHHostKey
    from monitoring.ssh_host_keys import accept_observed

    tenant = gate.require(request)
    user = request.user
    data = request.data if isinstance(request.data, dict) else {}
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > ACCEPT_MAX:
        raise ValidationError({"ids": f"A list of 1 to {ACCEPT_MAX} ids."})
    try:
        ids = [uuid.UUID(str(i)) for i in ids]
    except ValueError:
        raise ValidationError({"ids": "Not a valid id."}) from None
    qs = SSHHostKey.objects.filter(tenant=tenant, pk__in=ids)
    if not user.is_superuser:
        if not rbac.has_action(user, tenant, "sshhostkey", "change"):
            raise PermissionDenied("sshhostkey.change required.")
        qs = rbac.restrict_queryset(qs, user, tenant, "sshhostkey", "change")
    seen = qs.count()
    accepted, refused = [], []
    with transaction.atomic():
        for k in qs.select_for_update(of=("self",)):
            if k.uploaded:
                continue
            if SSHHostKey.objects.filter(
                    tenant=tenant, device_id=k.device_id, virtual_machine_id=k.virtual_machine_id,
                    key_type=k.key_type, uploaded=True).exclude(pk=k.pk).exists():
                refused.append({"id": str(k.pk),
                                "reason": "Differs from the host's accepted key."})
                continue
            accept_observed(k)
            accepted.append(str(k.pk))
    return Response({"accepted": accepted, "refused": refused,
                     "not_found": len(set(ids)) - seen})


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
            "package_manager": f.package_manager, "build": f.build, "ubr": f.ubr,
            "edition": f.edition, "display_version": f.display_version,
            "installation_type": f.installation_type, "architecture": f.architecture,
            "hotfixes": f.hotfixes or [], "features": f.features or [],
            "transport": f.transport, "collected_at": f.collected_at}


_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1, "none": 0, "": -1}


class _PackageLinks:
    """Per page of a host's packages: the application each one is
    (``Application.package_names``) and its open vulnerability matches - two
    queries per page whatever its size (the tenant's applications that name
    packages, the page's open matches grouped by package and severity)."""

    def __init__(self, request, tenant, kind, host):
        from vulnerabilities.models import VulnerabilitySettings

        self.request, self.tenant, self.kind, self.host = request, tenant, kind, host
        self.vulns_on = VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists()
        user = request.user
        self.apps_visible = user.is_superuser or rbac.has_action(user, tenant, "application",
                                                                 "view")
        self.matcher = None
        self.apps: dict = {}
        self.cves: dict = {}

    def load(self, page) -> None:
        from django.db.models import Count

        from api.models import Application
        from api.package_names import matcher_for

        if self.apps_visible and self.matcher is None:
            self.matcher = matcher_for(self.tenant)
            if self.matcher:
                self.apps = {a.pk: a for a in Application.objects.filter(
                    tenant=self.tenant, pk__in=list(self.matcher.app_ids)).only("pk", "name")}
        self.cves = {}
        if not self.vulns_on or not page:
            return
        from vulnerabilities.models import VulnerabilityMatch

        for pkg, severity, n in VulnerabilityMatch.objects.filter(
                tenant=self.tenant, resolved_at__isnull=True, excepted__isnull=True,
                host_package_id__in=[p.pk for p in page], **{self.kind: self.host}).values_list(
                "host_package_id", "cve__cvss_severity").annotate(n=Count("pk")).order_by():
            have = self.cves.setdefault(pkg, {"count": 0, "severity": ""})
            have["count"] += n
            if _SEVERITY_RANK.get(severity or "", -1) > _SEVERITY_RANK.get(have["severity"], -1):
                have["severity"] = severity or ""

    def row(self, p) -> dict:
        app = None
        if self.matcher:
            hits = sorted(self.matcher.match(p.purl_type, p.name), key=lambda h: h[1])
            for app_id, _rank in hits:
                a = self.apps.get(app_id)
                if a is not None:
                    app = {"id": str(a.pk), "name": a.name}
                    break
        cves = self.cves.get(p.pk) if self.vulns_on else None
        return {"application": app,
                "cves": (cves or {"count": 0, "severity": ""}) if self.vulns_on else None}


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
        rows = rows.filter(Q(name__icontains=q) | Q(source_name__icontains=q)
                           | Q(publisher__icontains=q))
    fact = HostOsFact.objects.filter(**{kind: host}).first()
    links = _PackageLinks(request, tenant, kind, host)

    def page_rows(page):
        page = list(page)
        links.load(page)
        return [{
            "id": str(p.pk), "name": p.name, "version": p.version, "arch": p.arch,
            "source_name": p.source_name, "source_version": p.source_version,
            "type": p.purl_type, "ecosystem": p.ecosystem, "purl": p.purl,
            "publisher": p.publisher,
            "first_seen": p.first_seen, "last_seen": p.last_seen,
            **links.row(p),
        } for p in page]

    response = _paginate(request, rows.order_by("name", "arch", "pk"), page_rows)
    response.data["os"] = os_dict(fact)
    from .advisories import host_state

    # Whether the store holds advisory data for these packages yet.
    response.data["advisories"] = host_state(tenant, kind, host, request)
    from vulnerabilities.matching import os_build_summary

    # Windows: the Microsoft product it matches as and its open OS-build CVEs.
    response.data["os_build"] = os_build_summary(tenant, kind, host, fact)
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
