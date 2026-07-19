"""CRUD viewsets for monitoring templates + assignments.

Both are tenant-scoped via the shared ``TenantScopedViewSet`` base (active
tenant stamped on create, cross-tenant rows hidden). Assignments validate that
every referenced IP/prefix belongs to the active tenant.
"""
from __future__ import annotations

from secrets import token_urlsafe

from django.core.exceptions import FieldError
from django.db.models import Exists, OuterRef, Q
from rest_framework import permissions, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api.permissions import can_manage_admin

from .models import (
    AlertRule,
    CheckAssignment,
    CheckTemplate,
    MonitoringDenySubnet,
    MonitoringEngine,
    MonitoringPolicy,
    MonitoringProfile,
    NotificationChannel,
    OutpostRelease,
    Silence,
    SnmpProfile,
)
from .serializers import (
    AlertRuleSerializer,
    CheckAssignmentSerializer,
    CheckTemplateSerializer,
    MonitoringDenySubnetSerializer,
    MonitoringEngineSerializer,
    MonitoringPolicySerializer,
    MonitoringProfileSerializer,
    NotificationChannelSerializer,
    OutpostReleaseSerializer,
    SilenceSerializer,
    SnmpProfileSerializer,
)


class _EnginePermission(permissions.BasePermission):
    """Anyone signed into the tenant may *read* the engine list (the site /
    location forms need it for the assignment dropdown); only admins may create,
    edit, enroll, or delete — a deployment-admin surface like Users / Email."""

    message = "Admin access required."

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in permissions.SAFE_METHODS:
            return True
        return can_manage_admin(request.user, _get_active_tenant(request))


class MonitoringEngineViewSet(viewsets.ModelViewSet):
    """Monitoring engines (Outposts) — admin-gated, tenant-scoped. The built-in
    local engine is ensured on read; it can't be created or deleted here."""

    serializer_class = MonitoringEngineSerializer
    permission_classes = [_EnginePermission]

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return MonitoringEngine.objects.none()
        MonitoringEngine.local_for(tenant)  # ensure the built-in row exists
        return MonitoringEngine.objects.filter(tenant=tenant)

    def perform_create(self, serializer):
        # Only remote Outposts are created here; ``kind`` is read-only.
        serializer.save(
            tenant=_get_active_tenant(self.request), kind=MonitoringEngine.REMOTE
        )

    def perform_destroy(self, instance):
        if instance.is_local:
            raise ValidationError("The built-in local engine can't be deleted.")
        instance.delete()

    @action(detail=True, methods=["post"])
    def enroll(self, request, pk=None):
        """(Re)generate this Outpost's token — returned **once**; afterwards the
        API exposes only ``token_set``."""
        engine = self.get_object()
        if engine.is_local:
            raise ValidationError("The local engine has no token.")
        token = token_urlsafe(32)
        engine.token = {"secret": token}
        engine.save(update_fields=["token", "updated_at"])
        return Response({"token": token, "engine_id": str(engine.id)})

    @action(detail=True, methods=["get"])
    def stats(self, request, pk=None):
        """Detail-page stats for one engine: what it monitors + how it's doing."""
        from django.db.models import Count

        from api.models import Location, Site

        from .models import (
            CheckState,
            MonitoringEngineBinding,
            MonitoringSettings,
            StateTransition,
        )

        engine = self.get_object()
        default_id = MonitoringSettings.for_tenant(engine.tenant).default_engine_id
        states = CheckState.objects.filter(engine=engine)
        by_status = {
            r["status"]: r["n"]
            for r in states.values("status").annotate(n=Count("id"))
        }
        bindings = list(
            MonitoringEngineBinding.objects.filter(engine=engine)
        )
        site_ids = [b.object_id for b in bindings if b.scope == "site"]
        loc_ids = [b.object_id for b in bindings if b.scope == "location"]
        sites = list(Site.objects.filter(id__in=site_ids).values("id", "name"))
        locations = list(
            Location.objects.filter(id__in=loc_ids).values("id", "name")
        )
        recent = (
            StateTransition.objects.filter(
                target_ip_id__in=states.values("target_ip_id")
            )
            .select_related("target_ip")
            .order_by("-at")[:12]
        )
        return Response({
            "total_checks": states.count(),
            "is_default": str(default_id) == str(engine.id),
            "by_status": by_status,
            "sites": [{"id": str(s["id"]), "name": s["name"]} for s in sites],
            "locations": [
                {"id": str(l["id"]), "name": l["name"]} for l in locations
            ],
            "recent": [
                {
                    "ip": t.target_ip.ip_address if t.target_ip_id else None,
                    "from_status": t.from_status,
                    "to_status": t.to_status,
                    "at": t.at,
                }
                for t in recent
            ],
        })


class SnmpProfileViewSet(TenantScopedViewSet):
    queryset = SnmpProfile.objects.all().order_by("name")
    serializer_class = SnmpProfileSerializer


class CheckTemplateViewSet(TenantScopedViewSet):
    queryset = CheckTemplate.objects.all().order_by("name")
    serializer_class = CheckTemplateSerializer

    def get_queryset(self):
        from django.db.models import Count

        qs = super().get_queryset().annotate(assignment_count=Count("assignments"))
        kind = self.request.query_params.get("kind")
        if kind:
            qs = qs.filter(kind=kind)
        return qs


class _TargetScopedConfigurationMixin:
    """Scope polymorphic monitoring configuration through its inventory target.

    These models have no single ORM site path, so their ObjectPermission site
    scope cannot be expressed in ``SITE_PATHS``. Compose each granting
    permission's constraints with a model-specific target-site predicate here,
    then intersect it with the target rows the caller may view.
    """

    def _site_target_q(self, site_ids) -> Q:
        raise NotImplementedError

    def _filter_visible_targets(self, qs, tenant, user):
        raise NotImplementedError

    def _scope_configuration_queryset(self, qs, action: str | None = None):
        from auth_api import rbac
        from auth_api.drf import _action_for

        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return qs.none()
        user = self.request.user
        action = action or _action_for(self, self.request)

        if not user.is_superuser:
            slug = qs.model._meta.model_name
            grant_q = None
            grant_opens_all = False
            for perm in rbac._granting_perms(user, tenant, slug, action):
                # Reuse the canonical constraint parser, but map the permission's
                # sites through this configuration model's effective target.
                permission_q = rbac._perm_q(perm, None, action)
                site_ids = [site.pk for site in perm.sites.all()]
                if site_ids:
                    permission_q &= self._site_target_q(site_ids)
                if not permission_q:
                    grant_opens_all = True
                    break
                grant_q = permission_q if grant_q is None else grant_q | permission_q
            if not grant_opens_all:
                if grant_q is None:
                    return qs.none()
                try:
                    qs = qs.filter(grant_q)
                except FieldError:
                    return qs.none()

        return self._filter_visible_targets(qs, tenant, user).distinct()

    def _assert_saved_configuration_scope(self, instance, action: str):
        tenant = self._tenant_or_403()
        base = type(instance)._default_manager.filter(pk=instance.pk, tenant=tenant)
        if not self._scope_configuration_queryset(base, action=action).exists():
            raise PermissionDenied(
                "The configuration target is outside your tenant or site scope."
            )

    @staticmethod
    def _effective_value(serializer, field_name, *, many=False):
        if field_name in serializer.validated_data:
            return serializer.validated_data[field_name]
        instance = serializer.instance
        if instance is None:
            return [] if many else None
        value = getattr(instance, field_name)
        return list(value.all()) if many else value


class CheckAssignmentViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        CheckAssignment.objects.select_related("template", "ip_address", "prefix")
        .prefetch_related("exclusions")
        .all()
    )
    serializer_class = CheckAssignmentSerializer

    def _site_target_q(self, site_ids):
        return Q(ip_address__site_id__in=site_ids) | Q(prefix__site_id__in=site_ids)

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import IPAddress, Prefix
        from auth_api import rbac

        visible_ips = rbac.restrict_queryset(
            IPAddress.objects.filter(tenant=tenant), user, tenant, "ipaddress", "view"
        ).values("pk")
        visible_prefixes = rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant), user, tenant, "prefix", "view"
        ).values("pk")
        inaccessible_exclusion = IPAddress.objects.filter(
            check_assignment_exclusions=OuterRef("pk")
        ).exclude(pk__in=visible_ips)
        return (
            qs.filter(
                Q(ip_address_id__in=visible_ips) | Q(prefix_id__in=visible_prefixes)
            )
            .annotate(_has_inaccessible_exclusion=Exists(inaccessible_exclusion))
            .filter(_has_inaccessible_exclusion=False)
        )

    def get_queryset(self):
        qs = self._scope_configuration_queryset(super().get_queryset())
        for key, field in (("ip", "ip_address_id"), ("prefix", "prefix_id"),
                           ("template", "template_id")):
            v = self.request.query_params.get(key)
            if v:
                qs = qs.filter(**{field: v})
        return qs

    def _validate_targets(self, serializer):
        """Every target the assignment references — the IP/prefix it monitors,
        its template, and each exclusion IP — must be in the caller's row/site
        VIEW scope, not merely the same tenant. Otherwise a Site-A user could
        attach a check to a Site-B IP/prefix, and the ``exclusions`` list (which
        was queryset=IPAddress.objects.all()) could pull in a foreign-tenant IP
        by id entirely unchecked."""
        from auth_api import rbac

        tenant = self._tenant_or_403()
        user = self.request.user
        ip = self._effective_value(serializer, "ip_address")
        prefix = self._effective_value(serializer, "prefix")
        template = self._effective_value(serializer, "template")
        exclusions = self._effective_value(serializer, "exclusions", many=True) or []
        if template is not None and template.tenant_id != tenant.id:
            raise ValidationError({"template": "Not in the active tenant."})
        # Tenant ownership is absolute (rejected even for superusers); site scope
        # is the extra row-level gate for non-superusers.
        if ip is not None:
            if ip.tenant_id != tenant.id:
                raise ValidationError({"ip_address": "Not in the active tenant."})
            if not rbac.can_act_on(user, tenant, "ipaddress", "view", ip):
                raise ValidationError({"ip_address": "Not in your scope."})
        if prefix is not None:
            if prefix.tenant_id != tenant.id:
                raise ValidationError({"prefix": "Not in the active tenant."})
            if not rbac.can_act_on(user, tenant, "prefix", "view", prefix):
                raise ValidationError({"prefix": "Not in your scope."})
        for ex in exclusions:
            if ex.tenant_id != tenant.id:
                raise ValidationError(
                    {"exclusions": "Contains an IP from another tenant."}
                )
            if not rbac.can_act_on(user, tenant, "ipaddress", "view", ex):
                raise ValidationError(
                    {"exclusions": "Contains an IP outside your scope."}
                )

    def perform_create(self, serializer):
        self._validate_targets(serializer)
        super().perform_create(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._validate_targets(serializer)
        super().perform_update(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "change")


def _assert_tenant_objects(tenant, **objects):
    for name, value in objects.items():
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        for obj in values:
            if hasattr(obj, "tenant_id") and obj.tenant_id != tenant.id:
                raise ValidationError({name: "Not in the active tenant."})


class MonitoringProfileViewSet(TenantScopedViewSet):
    queryset = MonitoringProfile.objects.prefetch_related("templates").all().order_by("name")
    serializer_class = MonitoringProfileSerializer

    def _validate_tenant(self, serializer):
        tenant = self._tenant_or_403()
        _assert_tenant_objects(
            tenant,
            templates=list(serializer.validated_data.get("templates", [])),
        )

    def perform_create(self, serializer):
        self._validate_tenant(serializer)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._validate_tenant(serializer)
        serializer.save()


class MonitoringPolicyViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        MonitoringPolicy.objects.select_related(
            "vrf", "device_type", "device_role", "device", "prefix"
        )
        .prefetch_related("profiles", "templates")
        .all()
    )
    serializer_class = MonitoringPolicySerializer

    _TARGET_FIELDS = ("vrf", "device_type", "device_role", "device", "prefix")

    def _site_target_q(self, site_ids):
        from core.effective_settings import separation_enabled

        q = (
            Q(scope=MonitoringPolicy.SCOPE_DEVICE, device__site_id__in=site_ids)
            | Q(scope=MonitoringPolicy.SCOPE_PREFIX, prefix__site_id__in=site_ids)
        )
        if separation_enabled(_get_active_tenant(self.request)):
            q |= Q(
                scope=MonitoringPolicy.SCOPE_VRF,
                vrf__owning_site_id__in=site_ids,
            ) | Q(
                scope=MonitoringPolicy.SCOPE_DEVICE_TYPE,
                device_type__owning_site_id__in=site_ids,
            )
        # Global and device-role policies, plus policies on global catalog rows,
        # can affect every site and therefore require a site-unscoped grant.
        return q

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import Device, DeviceRole, DeviceType, Prefix, VRF
        from auth_api import rbac

        target_models = {
            "vrf": (VRF, "vrf"),
            "device_type": (DeviceType, "devicetype"),
            "device_role": (DeviceRole, "devicerole"),
            "device": (Device, "device"),
            "prefix": (Prefix, "prefix"),
        }
        visible = {
            field: rbac.restrict_queryset(
                model.objects.filter(tenant=tenant), user, tenant, slug, "view"
            ).values("pk")
            for field, (model, slug) in target_models.items()
        }

        global_q = Q(scope=MonitoringPolicy.SCOPE_GLOBAL)
        for field in self._TARGET_FIELDS:
            global_q &= Q(**{f"{field}__isnull": True})
        visibility_q = global_q
        for field in self._TARGET_FIELDS:
            scope_q = Q(scope=field, **{f"{field}_id__in": visible[field]})
            for other in self._TARGET_FIELDS:
                if other != field:
                    scope_q &= Q(**{f"{other}__isnull": True})
            visibility_q |= scope_q
        return qs.filter(visibility_q)

    def get_queryset(self):
        qs = self._scope_configuration_queryset(super().get_queryset())
        scope = self.request.query_params.get("scope")
        if scope:
            qs = qs.filter(scope=scope)
        for key in ("vrf", "device_type", "device_role", "device", "prefix"):
            value = self.request.query_params.get(key)
            if value:
                qs = qs.filter(**{f"{key}_id": value})
        return qs

    def _validate_tenant(self, serializer):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        _assert_tenant_objects(
            tenant,
            vrf=self._effective_value(serializer, "vrf"),
            device_type=self._effective_value(serializer, "device_type"),
            device_role=self._effective_value(serializer, "device_role"),
            device=self._effective_value(serializer, "device"),
            prefix=self._effective_value(serializer, "prefix"),
            profiles=list(serializer.validated_data.get("profiles", [])),
            templates=list(serializer.validated_data.get("templates", [])),
        )
        targets = {
            "vrf": ("vrf", self._effective_value(serializer, "vrf")),
            "device_type": (
                "devicetype",
                self._effective_value(serializer, "device_type"),
            ),
            "device_role": (
                "devicerole",
                self._effective_value(serializer, "device_role"),
            ),
            "device": ("device", self._effective_value(serializer, "device")),
            "prefix": ("prefix", self._effective_value(serializer, "prefix")),
        }
        for field, (slug, target) in targets.items():
            if target is not None and not rbac.can_act_on(
                self.request.user, tenant, slug, "view", target
            ):
                raise ValidationError({field: "Not in your scope."})

    def perform_create(self, serializer):
        self._validate_tenant(serializer)
        super().perform_create(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._validate_tenant(serializer)
        serializer.save()
        self._assert_saved_configuration_scope(serializer.instance, "change")


class MonitoringDenySubnetViewSet(TenantScopedViewSet):
    queryset = MonitoringDenySubnet.objects.select_related("vrf").all().order_by("cidr")
    serializer_class = MonitoringDenySubnetSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        vrf = self.request.query_params.get("vrf")
        if vrf:
            qs = qs.filter(vrf_id=vrf)
        return qs

    def _validate_tenant(self, serializer):
        tenant = self._tenant_or_403()
        _assert_tenant_objects(tenant, vrf=serializer.validated_data.get("vrf"))

    def perform_create(self, serializer):
        self._validate_tenant(serializer)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._validate_tenant(serializer)
        serializer.save()


class NotificationChannelViewSet(TenantScopedViewSet):
    queryset = NotificationChannel.objects.all().order_by("name")
    serializer_class = NotificationChannelSerializer

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Send a synthetic test alert through this channel."""
        from rest_framework.response import Response

        from .notify import send_test

        channel = self.get_object()
        try:
            send_test(channel)
        except Exception as exc:  # noqa: BLE001 — surface the transport error
            return Response({"ok": False, "error": str(exc)}, status=502)
        return Response({"ok": True})


class AlertRuleViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        AlertRule.objects.select_related("match_prefix")
        .all()
        .order_by("weight", "name")
    )
    serializer_class = AlertRuleSerializer

    def _site_target_q(self, site_ids):
        return Q(match_prefix__site_id__in=site_ids)

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import Prefix
        from auth_api import rbac

        visible_prefixes = rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant), user, tenant, "prefix", "view"
        ).values("pk")
        return qs.filter(
            Q(match_prefix__isnull=True) | Q(match_prefix_id__in=visible_prefixes)
        )

    def get_queryset(self):
        return self._scope_configuration_queryset(super().get_queryset())

    def _check_prefix(self, serializer):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        prefix = self._effective_value(serializer, "match_prefix")
        # Tenant ownership (absolute) + row/site scope (a Site-A user must not
        # target a Site-B prefix in an alert rule).
        if prefix is not None:
            if prefix.tenant_id != tenant.id:
                raise ValidationError({"match_prefix": "Not in the active tenant."})
            if not rbac.can_act_on(self.request.user, tenant, "prefix", "view", prefix):
                raise ValidationError({"match_prefix": "Not in your scope."})

    def perform_create(self, serializer):
        self._check_prefix(serializer)
        super().perform_create(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._check_prefix(serializer)
        serializer.save()
        self._assert_saved_configuration_scope(serializer.instance, "change")


class SilenceViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        Silence.objects.select_related("match_prefix", "match_ip", "created_by")
        .all()
        .order_by("-starts_at")
    )
    serializer_class = SilenceSerializer

    def _site_target_q(self, site_ids):
        return (
            (Q(match_prefix__isnull=True) | Q(match_prefix__site_id__in=site_ids))
            & (Q(match_ip__isnull=True) | Q(match_ip__site_id__in=site_ids))
            & (Q(match_prefix__isnull=False) | Q(match_ip__isnull=False))
        )

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import IPAddress, Prefix
        from auth_api import rbac

        visible_prefixes = rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant), user, tenant, "prefix", "view"
        ).values("pk")
        visible_ips = rbac.restrict_queryset(
            IPAddress.objects.filter(tenant=tenant), user, tenant, "ipaddress", "view"
        ).values("pk")
        return qs.filter(
            (Q(match_prefix__isnull=True) | Q(match_prefix_id__in=visible_prefixes))
            & (Q(match_ip__isnull=True) | Q(match_ip_id__in=visible_ips))
        )

    def get_queryset(self):
        qs = self._scope_configuration_queryset(super().get_queryset())
        when = self.request.query_params.get("active")
        if when == "true":
            from django.utils import timezone

            now = timezone.now()
            qs = qs.filter(starts_at__lte=now, ends_at__gt=now)
        return qs

    def _check_targets(self, serializer):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        prefix = self._effective_value(serializer, "match_prefix")
        ip = self._effective_value(serializer, "match_ip")
        # Tenant ownership (absolute) + row/site scope (no Site-B targets).
        if prefix is not None:
            if prefix.tenant_id != tenant.id:
                raise ValidationError({"match_prefix": "Not in the active tenant."})
            if not rbac.can_act_on(self.request.user, tenant, "prefix", "view", prefix):
                raise ValidationError({"match_prefix": "Not in your scope."})
        if ip is not None:
            if ip.tenant_id != tenant.id:
                raise ValidationError({"match_ip": "Not in the active tenant."})
            if not rbac.can_act_on(self.request.user, tenant, "ipaddress", "view", ip):
                raise ValidationError({"match_ip": "Not in your scope."})

    def perform_create(self, serializer):
        self._check_targets(serializer)
        user = self.request.user if self.request.user.is_authenticated else None
        # TenantScopedViewSet stamps tenant; add the creator.
        super().perform_create(serializer)
        if user is not None and serializer.instance.created_by_id is None:
            serializer.instance.created_by = user
            serializer.instance.save(update_fields=["created_by"])
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._check_targets(serializer)
        serializer.save()
        self._assert_saved_configuration_scope(serializer.instance, "change")


class _IsAdminOnly(permissions.BasePermission):
    message = "Admin access required."

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and can_manage_admin(request.user, _get_active_tenant(request))
        )


class _IsDeploymentAdminOnly(permissions.BasePermission):
    """Deployment-wide admin, for GLOBAL (tenant-less) resources. A
    tenant-scoped ``change-user`` grant does NOT pass — otherwise a tenant
    admin could upload/select the software distributed to every outpost
    (fleet RCE / supply-chain escalation)."""

    message = "Deployment admin required."

    def has_permission(self, request, view):
        from auth_api.permissions import can_manage_deployment

        return bool(
            request.user
            and request.user.is_authenticated
            and can_manage_deployment(request.user)
        )


def _fetch_github_binary(git_url, ref, token="", asset_name="danbyte-outpost"):
    """Download a release asset (the CI-built binary) from a GitHub repo's
    release for ``ref``. Returns ``(filename, bytes)``. Works for private repos
    with a token. Factored out (module-level) so it's mockable in tests."""
    import re

    import httpx

    m = re.search(r"github\.com[/:]([^/]+)/([^/.]+)", git_url or "")
    if not m:
        raise ValidationError("Only github.com repositories are supported here.")
    owner, repo = m.group(1), m.group(2)
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    api = f"https://api.github.com/repos/{owner}/{repo}/releases/tags/{ref}"
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        r = client.get(api, headers=headers)
        if r.status_code == 404:
            raise ValidationError(f"No release tagged '{ref}' (or repo is private — add a token).")
        r.raise_for_status()
        assets = r.json().get("assets", [])
        # Prefer the named binary; else the first non-source-archive asset.
        asset = next((a for a in assets if a["name"] == asset_name), None)
        if asset is None:
            asset = next(
                (a for a in assets
                 if not a["name"].endswith((".tar.gz", ".zip", ".whl"))),
                None,
            )
        if asset is None:
            raise ValidationError("That release has no binary asset to fetch.")
        # httpx strips Authorization on the cross-host redirect to storage.
        dl = client.get(
            asset["url"],
            headers={**headers, "Accept": "application/octet-stream"},
        )
        dl.raise_for_status()
        return asset["name"], dl.content


def _list_github_releases(git_url, token=""):
    """A repo's releases (newest first) — thin wrapper over the shared helper."""
    from core.github import list_releases

    return list_releases(git_url, token)


class OutpostReleaseViewSet(viewsets.ModelViewSet):
    """Deployment-wide Outpost builds (admin) — the package store. Upload a
    build file, point at a git repo + ref, or fetch the repo's built binary."""

    queryset = OutpostRelease.objects.all()
    serializer_class = OutpostReleaseSerializer
    # Global resource: DEPLOYMENT admin only. A tenant-scoped change-user
    # grant must not let a tenant admin push software to every outpost.
    permission_classes = [_IsDeploymentAdminOnly]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def perform_create(self, serializer):
        self._stamp_size(serializer.save())

    def perform_update(self, serializer):
        self._stamp_size(serializer.save())

    def _stamp_size(self, obj):
        size = obj.artifact.size if obj.artifact else 0
        if obj.size_bytes != size:
            obj.size_bytes = size
            obj.save(update_fields=["size_bytes"])

    @action(detail=False, methods=["get"])
    def available(self, request):
        """Releases in the tenant's configured Outpost repo — for the version
        dropdown. Marks which tags are already imported."""
        from .models import MonitoringSettings

        s = MonitoringSettings.for_tenant(_get_active_tenant(request))
        if not s.outpost_repo_url:
            return Response({"repo_url": "", "versions": []})
        token = (s.outpost_repo_token or {}).get("token", "")
        try:
            rels = _list_github_releases(s.outpost_repo_url, token)
        except Exception as e:  # noqa: BLE001 — surface a friendly reason
            return Response(
                {"repo_url": s.outpost_repo_url, "versions": [], "error": str(e)}
            )
        imported = set(OutpostRelease.objects.values_list("version", flat=True))
        for r in rels:
            r["imported"] = r["tag"] in imported or r["tag"].lstrip("v") in imported
        return Response({"repo_url": s.outpost_repo_url, "versions": rels})

    @action(detail=False, methods=["post"])
    def fetch_binary(self, request):
        """Grab the CI-built binary from a GitHub release and store it as a
        version — so a repo link becomes a served binary, no manual download.
        The git URL + token default to the tenant's configured Outpost repo."""
        from django.core.files.base import ContentFile

        from .models import MonitoringSettings

        git_url = (request.data.get("git_url") or "").strip()
        ref = (request.data.get("ref") or "").strip()
        token = (request.data.get("token") or "").strip()
        if not git_url:  # fall back to the configured repo
            s = MonitoringSettings.for_tenant(_get_active_tenant(request))
            git_url = s.outpost_repo_url
            token = token or (s.outpost_repo_token or {}).get("token", "")
        if not git_url or not ref:
            raise ValidationError("A git URL and a ref (tag) are required.")
        version = request.data.get("version") or ref
        if OutpostRelease.objects.filter(version=version).exists():
            raise ValidationError(f"Version '{version}' already exists.")
        name, content = _fetch_github_binary(git_url, ref, token)
        release = OutpostRelease(
            version=version, source=OutpostRelease.FILE,
            git_url=git_url, git_ref=ref,
            is_default=not OutpostRelease.objects.exists(),
        )
        release.artifact.save(name, ContentFile(content), save=False)
        release.size_bytes = len(content)
        release.save()
        return Response(
            OutpostReleaseSerializer(release).data, status=201
        )
