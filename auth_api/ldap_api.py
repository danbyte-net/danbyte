"""LDAP / Active Directory admin API — settings, connection test, group browse,
and AD-group → Danbyte-group mappings. All gated by ``users.manage``.

The bind password is write-only and stored Fernet-encrypted in
``DeploymentSettings.secrets["ldap_bind_password"]``; reads expose
``bind_password_set`` (a boolean) instead of the secret.
"""
from __future__ import annotations

from django.contrib.auth.models import Group
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers, viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.models import DeploymentSettings

from .models import LDAPGroupMapping
from .permissions import can_manage_deployment


def _require_manage(request):
    # Deployment-directory settings: deployment admins only (a tenant-narrowed
    # grant does not pass). Tenant directories live at /api/tenant-settings/ldap/.
    return can_manage_deployment(request.user)


def _denied():
    return Response({"detail": "users.manage required."}, status=403)


# ─── Connection settings ─────────────────────────────────────────────────────
_LDAP_FIELDS = [
    "ldap_enabled", "ldap_server_uri", "ldap_start_tls", "ldap_ignore_cert",
    "ldap_bind_dn", "ldap_user_search_base", "ldap_user_search_filter",
    "ldap_attr_first_name", "ldap_attr_last_name", "ldap_attr_email",
    "ldap_group_search_base", "ldap_group_type", "ldap_require_group",
]


class LDAPSettingsSerializer(serializers.ModelSerializer):
    ldap_bind_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    bind_password_set = serializers.SerializerMethodField()

    class Meta:
        model = DeploymentSettings
        fields = [*_LDAP_FIELDS, "ldap_bind_password", "bind_password_set",
                  "updated_at"]
        read_only_fields = ["updated_at"]

    def get_bind_password_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("ldap_bind_password"))

    def update(self, instance, validated_data):
        pw = validated_data.pop("ldap_bind_password", None)
        if pw:
            secrets = dict(instance.secrets or {})
            secrets["ldap_bind_password"] = pw
            instance.secrets = secrets
        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save()
        return instance


@extend_schema(
    methods=["GET"],
    summary="Get the deployment LDAP/AD connection settings",
    tags=["ldap"],
    request=None,
    responses=LDAPSettingsSerializer,
)
@extend_schema(
    methods=["PUT"],
    summary="Update the deployment LDAP/AD connection settings",
    tags=["ldap"],
    request=LDAPSettingsSerializer,
    responses=LDAPSettingsSerializer,
)
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def ldap_settings(request):
    if not _require_manage(request):
        return _denied()
    obj = DeploymentSettings.load()
    if request.method == "PUT":
        ser = LDAPSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
    return Response(LDAPSettingsSerializer(obj).data)


# ─── Connection test ─────────────────────────────────────────────────────────
def _bind_connection(dep):
    """Open + bind an ldap connection with the service account. Raises on
    failure; the caller surfaces the message."""
    import ldap

    # SSRF-guard tenant-configured URIs (no-op for the deployment singleton).
    from .ldap import assert_public_ldap_uri

    assert_public_ldap_uri(dep)
    conn = ldap.initialize(dep.ldap_server_uri)
    conn.set_option(ldap.OPT_REFERRALS, 0)
    conn.set_option(ldap.OPT_PROTOCOL_VERSION, 3)
    if dep.ldap_ignore_cert:
        conn.set_option(ldap.OPT_X_TLS_REQUIRE_CERT, ldap.OPT_X_TLS_NEVER)
        conn.set_option(ldap.OPT_X_TLS_NEWCTX, 0)
    if dep.ldap_start_tls:
        conn.start_tls_s()
    pw = (dep.secrets or {}).get("ldap_bind_password", "")
    conn.simple_bind_s(dep.ldap_bind_dn, pw)
    return conn


@extend_schema(
    summary="Test the deployment LDAP service-account bind",
    tags=["ldap"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Bind result: {ok: bool, error?: str}.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def ldap_test(request):
    if not _require_manage(request):
        return _denied()
    from .ldap import ldap_available

    if not ldap_available():
        return Response(
            {"ok": False, "error": "python-ldap is not installed on the server."},
            status=400,
        )
    dep = DeploymentSettings.load()
    if not dep.ldap_server_uri:
        return Response({"ok": False, "error": "No server URI set."}, status=400)
    try:
        conn = _bind_connection(dep)
        conn.unbind_s()
    except Exception as exc:  # noqa: BLE001 — surface the bind error to the admin
        return Response({"ok": False, "error": str(exc)}, status=502)
    return Response({"ok": True})


@extend_schema(
    summary="Dry-run a deployment directory login and report the outcome/trace",
    tags=["ldap"],
    request=inline_serializer(
        name="LDAPTestLoginRequest",
        fields={
            "username": serializers.CharField(),
            "password": serializers.CharField(),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Login outcome: {ok, error?, username?, email?, groups?, trace?}."
        ),
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def ldap_test_login(request):
    """Dry-run a directory login and return the *why* (issue #152).

    The service-account test proves connectivity but not authentication — a
    user login can still die on the user search, referrals, REQUIRE_GROUP, or
    group mapping, all surfaced to the end user as a generic "invalid
    credentials". This endpoint runs the real backend with a username +
    password supplied by the admin, captures django-auth-ldap's debug log for
    the attempt, and reports the outcome plus which Danbyte groups would map.
    Nothing is persisted: no session, no last_login, and the synced groups are
    whatever a real login would have set anyway.
    """
    import logging as _logging

    if not _require_manage(request):
        return _denied()
    from .ldap import DanbyteLDAPBackend, ldap_available

    if not ldap_available():
        return Response(
            {"ok": False, "error": "python-ldap is not installed on the server."},
            status=400,
        )
    dep = DeploymentSettings.load()
    if not (dep.ldap_enabled and dep.ldap_server_uri):
        return Response(
            {"ok": False, "error": "LDAP is not enabled / no server URI set."},
            status=400,
        )
    username = (request.data.get("username") or "").strip()
    password = request.data.get("password") or ""
    if not username or not password:
        return Response(
            {"ok": False, "error": "username and password are required."},
            status=400,
        )

    # Capture django-auth-ldap's debug trail for just this attempt.
    log = _logging.getLogger("django_auth_ldap")
    buf: list[str] = []

    class _Capture(_logging.Handler):
        def emit(self, record):
            buf.append(self.format(record))

    handler = _Capture()
    handler.setFormatter(_logging.Formatter("%(levelname)s %(message)s"))
    old_level = log.level
    log.addHandler(handler)
    log.setLevel(_logging.DEBUG)
    try:
        user = DanbyteLDAPBackend().authenticate(
            request, username=username, password=password
        )
    finally:
        log.removeHandler(handler)
        log.setLevel(old_level)

    if user is None:
        return Response(
            {
                "ok": False,
                "error": "Authentication failed — see the trace for the stage "
                "(user search, bind, or required group).",
                "trace": buf[-40:],
            }
        )
    return Response(
        {
            "ok": True,
            "username": user.get_username(),
            "email": user.email,
            "groups": sorted(g.name for g in user.groups.all()),
            "trace": buf[-40:],
        }
    )


# ─── Browse directory groups ─────────────────────────────────────────────────
@extend_schema(
    summary="Browse groups under the deployment directory group-search base",
    tags=["ldap"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="q",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Optional case-insensitive CN substring filter.",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{groups: [{dn, cn}]} sorted by CN.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def ldap_groups(request):
    """List groups under the configured group-search base so an admin can map
    them without hand-typing DNs. Optional ``?q=`` filters by CN."""
    if not _require_manage(request):
        return _denied()
    from .ldap import ldap_available

    if not ldap_available():
        return Response(
            {"detail": "python-ldap is not installed on the server."}, status=400
        )
    dep = DeploymentSettings.load()
    if not (dep.ldap_server_uri and dep.ldap_group_search_base):
        return Response(
            {"detail": "Set the server URI and group search base first."}, status=400
        )
    import ldap
    import ldap.filter

    q = (request.query_params.get("q") or "").strip()
    # Escape user input before it enters the LDAP filter (injection).
    safe_q = ldap.filter.escape_filter_chars(q) if q else ""
    flt = f"(&(objectClass=group)(cn=*{safe_q}*))" if q else "(objectClass=group)"
    try:
        conn = _bind_connection(dep)
        rows = conn.search_s(
            dep.ldap_group_search_base, ldap.SCOPE_SUBTREE, flt, ["cn"]
        )
        conn.unbind_s()
    except Exception as exc:  # noqa: BLE001
        return Response({"detail": str(exc)}, status=502)

    out = []
    for dn, attrs in rows:
        if not dn:
            continue
        cn = ""
        raw = (attrs or {}).get("cn")
        if raw:
            cn = raw[0].decode("utf-8", "replace") if isinstance(raw[0], bytes) else str(raw[0])
        out.append({"dn": dn, "cn": cn})
    out.sort(key=lambda g: g["cn"].lower())
    return Response({"groups": out})


# ─── AD-group → Danbyte-group mappings ───────────────────────────────────────
class LDAPGroupMappingSerializer(serializers.ModelSerializer):
    group_name = serializers.CharField(source="group.name", read_only=True)
    group_id = serializers.PrimaryKeyRelatedField(
        source="group", queryset=Group.objects.all()
    )

    class Meta:
        model = LDAPGroupMapping
        fields = ["id", "ldap_group_dn", "ldap_group_cn", "group_id",
                  "group_name", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── Tenant directories (per-tenant LDAP overrides) ─────────────────────────
def _tenant_or_denied(request):
    from api.views import _get_active_tenant

    from .permissions import can_manage_admin

    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, Response({"detail": "No active tenant."}, status=400)
    if not can_manage_admin(request.user, tenant):
        return None, Response({"detail": "Tenant admin required."}, status=403)
    return tenant, None


class TenantLDAPSettingsSerializer(serializers.ModelSerializer):
    ldap_bind_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    bind_password_set = serializers.SerializerMethodField()

    class Meta:
        from core.models import TenantSettings as _TS

        model = _TS
        fields = [*_LDAP_FIELDS, "override_ldap", "ldap_login_domains",
                  "ldap_bind_password", "bind_password_set", "updated_at"]
        read_only_fields = ["updated_at"]

    def get_bind_password_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("ldap_bind_password"))

    def validate_ldap_login_domains(self, value):
        if not isinstance(value, list) or any(not isinstance(d, str) for d in value):
            raise serializers.ValidationError("Provide a list of domain strings.")
        return [d.strip().lstrip("@").lower() for d in value if d.strip()]

    def validate(self, attrs):
        # A login domain routes ``user@domain`` straight to one tenant's
        # directory (ldap_directory_chain short-circuits on it). If two tenants
        # claimed the same domain, that routing would be ambiguous and a tenant
        # could siphon another's logins — so a domain may be owned by at most
        # one tenant deployment-wide.
        domains = attrs.get("ldap_login_domains")
        if domains:
            from core.models import TenantSettings

            wanted = set(domains)
            others = TenantSettings.objects.exclude(
                pk=self.instance.pk if self.instance else None
            ).exclude(ldap_login_domains=[])
            for other in others.only("id", "ldap_login_domains"):
                clash = wanted & set(other.ldap_login_domains or [])
                if clash:
                    raise serializers.ValidationError({
                        "ldap_login_domains": (
                            "Already claimed by another tenant: "
                            + ", ".join(sorted(clash))
                        ),
                    })
        return attrs

    def update(self, instance, validated_data):
        pw = validated_data.pop("ldap_bind_password", None)
        if pw:
            secrets = dict(instance.secrets or {})
            secrets["ldap_bind_password"] = pw
            instance.secrets = secrets
        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save()
        return instance


@extend_schema(
    methods=["GET"],
    summary="Get the active tenant's LDAP/AD directory override settings",
    tags=["ldap"],
    request=None,
    responses=TenantLDAPSettingsSerializer,
)
@extend_schema(
    methods=["PUT"],
    summary="Update the active tenant's LDAP/AD directory override settings",
    tags=["ldap"],
    request=TenantLDAPSettingsSerializer,
    responses=TenantLDAPSettingsSerializer,
)
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def tenant_ldap_settings(request):
    """The active tenant's own directory config (override of the deployment
    directory). Tenant-admin gated."""
    from core.models import TenantSettings

    tenant, err = _tenant_or_denied(request)
    if err:
        return err
    obj = TenantSettings.for_tenant(tenant)
    if request.method == "PUT":
        ser = TenantLDAPSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
    return Response(TenantLDAPSettingsSerializer(obj).data)


@extend_schema(
    summary="Test the tenant directory LDAP service-account bind",
    tags=["ldap"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Bind result: {ok: bool, error?: str}.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def tenant_ldap_test(request):
    """Service-account bind test against the TENANT directory."""
    from core.models import TenantSettings

    tenant, err = _tenant_or_denied(request)
    if err:
        return err
    from .ldap import ldap_available

    if not ldap_available():
        return Response(
            {"ok": False, "error": "python-ldap is not installed on the server."},
            status=400,
        )
    ts = TenantSettings.for_tenant(tenant)
    if not ts.ldap_server_uri:
        return Response({"ok": False, "error": "No server URI set."}, status=400)
    try:
        conn = _bind_connection(ts)
        conn.unbind_s()
    except Exception as exc:  # noqa: BLE001 — surface the bind error to the admin
        return Response({"ok": False, "error": str(exc)}, status=502)
    return Response({"ok": True})


@extend_schema(
    summary="Dry-run a login against the tenant directory and report outcome/trace",
    tags=["ldap"],
    request=inline_serializer(
        name="TenantLDAPTestLoginRequest",
        fields={
            "username": serializers.CharField(),
            "password": serializers.CharField(),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Login outcome: {ok, error?, username?, email?, groups?, trace?}."
        ),
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def tenant_ldap_test_login(request):
    """Dry-run a login against THIS tenant's directory only (bypassing the
    chain), with the django-auth-ldap debug trace — same shape as the
    deployment test-login."""
    import logging as _logging

    from core.models import TenantSettings

    tenant, err = _tenant_or_denied(request)
    if err:
        return err
    from .ldap import _candidate_may_bind, _configured_backend, ldap_available

    if not ldap_available():
        return Response(
            {"ok": False, "error": "python-ldap is not installed on the server."},
            status=400,
        )
    ts = TenantSettings.for_tenant(tenant)
    if not (ts.override_ldap and ts.ldap_enabled and ts.ldap_server_uri):
        return Response(
            {"ok": False,
             "error": "This tenant's directory override is not enabled/configured."},
            status=400,
        )
    username = (request.data.get("username") or "").strip()
    password = request.data.get("password") or ""
    if not username or not password:
        return Response(
            {"ok": False, "error": "username and password are required."},
            status=400,
        )
    if not _candidate_may_bind(username, tenant):
        return Response({
            "ok": False,
            "error": "That username already exists and is not owned by this "
                     "tenant's directory — the login would be refused. Use a "
                     "login domain to avoid collisions.",
        })

    log = _logging.getLogger("django_auth_ldap")
    buf: list[str] = []

    class _Capture(_logging.Handler):
        def emit(self, record):
            buf.append(self.format(record))

    handler = _Capture()
    handler.setFormatter(_logging.Formatter("%(levelname)s %(message)s"))
    old_level = log.level
    log.addHandler(handler)
    log.setLevel(_logging.DEBUG)
    try:
        backend = _configured_backend(ts)
        user = backend.authenticate(
            request, username=username, password=password
        ) if backend else None
    finally:
        log.removeHandler(handler)
        log.setLevel(old_level)

    if user is None:
        return Response({
            "ok": False,
            "error": "Authentication failed — see the trace for the stage "
                     "(user search, bind, or required group).",
            "trace": buf[-40:],
        })
    return Response({
        "ok": True,
        "username": user.get_username(),
        "email": user.email,
        "groups": sorted(g.name for g in user.groups.all()),
        "trace": buf[-40:],
    })


@extend_schema(
    summary="Browse groups under the tenant directory group-search base",
    tags=["ldap"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="q",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Optional case-insensitive CN substring filter.",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{groups: [{dn, cn}]} sorted by CN.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def tenant_ldap_groups(request):
    """Browse groups under the TENANT directory's group-search base."""
    from core.models import TenantSettings

    tenant, err = _tenant_or_denied(request)
    if err:
        return err
    from .ldap import ldap_available

    if not ldap_available():
        return Response(
            {"detail": "python-ldap is not installed on the server."}, status=400
        )
    ts = TenantSettings.for_tenant(tenant)
    if not (ts.ldap_server_uri and ts.ldap_group_search_base):
        return Response(
            {"detail": "Set the server URI and group search base first."}, status=400
        )
    import ldap
    import ldap.filter

    q = (request.query_params.get("q") or "").strip()
    # Escape user input before it enters the LDAP filter (injection).
    safe_q = ldap.filter.escape_filter_chars(q) if q else ""
    flt = f"(&(objectClass=group)(cn=*{safe_q}*))" if q else "(objectClass=group)"
    try:
        conn = _bind_connection(ts)
        rows = conn.search_s(
            ts.ldap_group_search_base, ldap.SCOPE_SUBTREE, flt, ["cn"]
        )
        conn.unbind_s()
    except Exception as exc:  # noqa: BLE001
        return Response({"detail": str(exc)}, status=502)

    out = []
    for dn, attrs in rows:
        if not dn:
            continue
        cn = ""
        raw = (attrs or {}).get("cn")
        if raw:
            cn = raw[0].decode("utf-8", "replace") if isinstance(raw[0], bytes) else str(raw[0])
        out.append({"dn": dn, "cn": cn})
    out.sort(key=lambda g: g["cn"].lower())
    return Response({"groups": out})


class TenantLDAPGroupMappingViewSet(viewsets.ModelViewSet):
    """Mappings for the ACTIVE TENANT's directory. Tenant-admin gated, with the
    escalation guard: a mapping may only target a group whose permissions are
    all narrowed to exactly this tenant (see ldap.group_is_tenant_safe)."""

    queryset = LDAPGroupMapping.objects.select_related("group").all()
    serializer_class = LDAPGroupMappingSerializer
    permission_classes = [IsAuthenticated]

    def _tenant(self):
        from api.views import _get_active_tenant

        return _get_active_tenant(self.request)

    def _check(self):
        from rest_framework.exceptions import PermissionDenied

        from .permissions import can_manage_admin

        tenant = self._tenant()
        if tenant is None or not can_manage_admin(self.request.user, tenant):
            raise PermissionDenied("Tenant admin required.")
        return tenant

    def get_queryset(self):
        tenant = self._tenant()
        if tenant is None:
            return LDAPGroupMapping.objects.none()
        return super().get_queryset().filter(tenant=tenant)

    def _validate_group_safe(self, serializer, tenant):
        from rest_framework.exceptions import ValidationError as DRFValidationError

        from .ldap import group_is_tenant_safe

        group = serializer.validated_data.get("group") or (
            serializer.instance.group if serializer.instance else None
        )
        if group is not None and not group_is_tenant_safe(group, tenant):
            raise DRFValidationError({
                "group_id": "This group carries permissions that are not "
                            "narrowed to this tenant — mapping it would grant "
                            "access beyond the tenant.",
            })

    def perform_create(self, serializer):
        tenant = self._check()
        self._validate_group_safe(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        tenant = self._check()
        self._validate_group_safe(serializer, tenant)
        serializer.save(tenant=tenant)

    def list(self, request, *a, **k):
        self._check()
        return super().list(request, *a, **k)

    def retrieve(self, request, *a, **k):
        self._check()
        return super().retrieve(request, *a, **k)

    def destroy(self, request, *a, **k):
        self._check()
        return super().destroy(request, *a, **k)


class LDAPGroupMappingViewSet(viewsets.ModelViewSet):
    """Mappings for the DEPLOYMENT directory only (tenant IS NULL) — tenant
    directories manage their own via TenantLDAPGroupMappingViewSet."""

    queryset = LDAPGroupMapping.objects.select_related("group").filter(
        tenant__isnull=True
    )
    serializer_class = LDAPGroupMappingSerializer
    permission_classes = [IsAuthenticated]

    def perform_create(self, serializer):
        serializer.save(tenant=None)

    def _check(self):
        if not _require_manage(self.request):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("users.manage required.")

    def list(self, request, *a, **k):
        self._check()
        return super().list(request, *a, **k)

    def retrieve(self, request, *a, **k):
        self._check()
        return super().retrieve(request, *a, **k)

    def create(self, request, *a, **k):
        self._check()
        return super().create(request, *a, **k)

    def update(self, request, *a, **k):
        self._check()
        return super().update(request, *a, **k)

    def destroy(self, request, *a, **k):
        self._check()
        return super().destroy(request, *a, **k)
