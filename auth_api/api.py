"""Admin API for Users, Groups and Object permissions (the RBAC surface).

These are global (not tenant-scoped) objects; access is gated by
`RBACObjectPermission` over the `user` / `group` / `objectpermission` object
types — so only Administrators (or a custom grant) can manage them. Superusers
bypass, as everywhere.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from django.db import transaction
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .drf import DeploymentAdminForWrites, RBACObjectPermission
from .models import GroupProfile, ObjectPermission, UserProfile
from .permissions import can_manage_deployment, user_tenants
from .object_types import ACTIONS, registry_payload


# ─── Users ───────────────────────────────────────────────────────────────────
class UserSerializer(serializers.ModelSerializer):
    groups = serializers.SerializerMethodField()
    tenants = serializers.SerializerMethodField()
    auth_source = serializers.SerializerMethodField()
    require_mfa = serializers.SerializerMethodField()
    mfa_active = serializers.SerializerMethodField()

    password = serializers.CharField(write_only=True, required=False, allow_blank=True)
    # When True (and no password is given), email the user a link to set their
    # own password instead of the admin choosing one — GDPR-friendly: the admin
    # never handles the credential.
    send_invite = serializers.BooleanField(write_only=True, required=False)
    group_ids = serializers.PrimaryKeyRelatedField(
        source="groups", queryset=Group.objects.all(),
        many=True, write_only=True, required=False,
    )
    tenant_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=False
    )
    # profile-backed writeable fields
    set_auth_source = serializers.ChoiceField(
        choices=["local", "ldap"], write_only=True, required=False
    )
    set_require_mfa = serializers.BooleanField(write_only=True, required=False)
    # One-click site scoping: {role: "editor"|"viewer", site_ids: [...],
    # silo?: bool}. Assembles the ObjectPermission combo in the active tenant
    # so an admin doesn't hand-build permissions for a local-IT user.
    site_role = serializers.JSONField(write_only=True, required=False)

    def get_groups(self, obj):
        return [{"id": g.id, "name": g.name} for g in obj.groups.all()]

    def _profile(self, obj):
        return getattr(obj, "profile", None)

    def get_tenants(self, obj):
        p = self._profile(obj)
        return (
            [{"id": str(t.id), "name": t.name} for t in p.tenants.all()] if p else []
        )

    def get_auth_source(self, obj):
        p = self._profile(obj)
        return p.auth_source if p else "local"

    def get_require_mfa(self, obj):
        p = self._profile(obj)
        return bool(p and p.require_mfa)

    def get_mfa_active(self, obj):
        p = self._profile(obj)
        return bool(p and (p.mfa_totp_confirmed or (p.require_mfa and p.mfa_email)))

    def _apply_profile(self, user, validated):
        prof, _ = UserProfile.objects.get_or_create(user=user)
        tenant_ids = validated.pop("tenant_ids", None)
        src = validated.pop("set_auth_source", None)
        mfa = validated.pop("set_require_mfa", None)
        if src is not None:
            prof.auth_source = src
        if mfa is not None:
            prof.require_mfa = mfa
        prof.save()
        if tenant_ids is not None:
            from core.models import Tenant

            prof.tenants.set(Tenant.objects.filter(id__in=tenant_ids))

    def validate(self, attrs):
        # On create, an admin must either set a password, request an emailed
        # invite, or pick LDAP (the directory holds the credential). An invite
        # needs somewhere to send the link.
        if self.instance is None:
            pwd = attrs.get("password")
            invite = attrs.get("send_invite")
            ldap = attrs.get("set_auth_source") == "ldap"
            if not pwd and invite and not attrs.get("email"):
                raise serializers.ValidationError(
                    {"email": "An email address is required to send an invite."}
                )
            if not pwd and not invite and not ldap:
                raise serializers.ValidationError(
                    {"password": "Set a password or choose to email an invite."}
                )
        # Only an existing superuser may grant the superuser/staff flags.
        # Otherwise any user-admin (RBAC `change` on `user`) could PATCH their
        # own account to Django superuser and bypass all RBAC. Strip the flags
        # for non-superuser actors rather than erroring, so the rest of the edit
        # still applies.
        request = self.context.get("request")
        actor = getattr(request, "user", None)
        if not (actor is not None and actor.is_superuser):
            attrs.pop("is_superuser", None)
            attrs.pop("is_staff", None)
        return attrs

    @transaction.atomic
    def create(self, validated):
        pwd = validated.pop("password", None)
        invite = validated.pop("send_invite", False)
        groups = validated.pop("groups", None)
        site_role = validated.pop("site_role", None)
        profile_writes = {
            k: validated.pop(k)
            for k in ("tenant_ids", "set_auth_source", "set_require_mfa")
            if k in validated
        }
        user = User(**validated)
        if pwd:
            user.set_password(pwd)
        else:
            # No admin-chosen password: the account can't log in until the user
            # follows an invite link (or LDAP authenticates them).
            user.set_unusable_password()
        user.save()
        if groups is not None:
            user.groups.set(groups)
        self._apply_profile(user, profile_writes)
        _apply_site_role(self.context.get("request"), site_role, user_ids=[user.id])

        if not pwd and invite and user.email:
            from .login_api import send_invite_email

            request = self.context.get("request")
            if request is not None:
                send_invite_email(request, user)
        return user

    def update(self, user, validated):
        pwd = validated.pop("password", None)
        invite = validated.pop("send_invite", False)
        groups = validated.pop("groups", None)
        profile_writes = {
            k: validated.pop(k)
            for k in ("tenant_ids", "set_auth_source", "set_require_mfa")
            if k in validated
        }
        for k, v in validated.items():
            setattr(user, k, v)
        if pwd:
            user.set_password(pwd)
        user.save()
        if groups is not None:
            user.groups.set(groups)
        self._apply_profile(user, profile_writes)

        # On edit, `send_invite` doubles as "email a password-reset link".
        if invite and user.email:
            from .login_api import send_invite_email

            request = self.context.get("request")
            if request is not None:
                send_invite_email(request, user)
        return user

    class Meta:
        model = User
        fields = [
            "id", "username", "email", "first_name", "last_name",
            "is_active", "is_superuser", "is_staff", "last_login", "date_joined",
            "groups", "tenants", "auth_source", "require_mfa", "mfa_active",
            "password", "send_invite", "group_ids", "tenant_ids",
            "set_auth_source", "set_require_mfa", "site_role",
        ]
        read_only_fields = ["id", "last_login", "date_joined"]


class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all().prefetch_related("groups", "profile__tenants").order_by("username")
    serializer_class = UserSerializer
    permission_classes = [IsAuthenticated, RBACObjectPermission, DeploymentAdminForWrites]

    def get_queryset(self):
        qs = super().get_queryset()
        # Non-deployment admins may only see users who share one of their
        # tenants — a tenant-scoped `view-user` grant must not enumerate every
        # username/email in the deployment (issue #59+ cross-tenant read).
        u = getattr(self.request, "user", None)
        if u is not None and not (u.is_superuser or can_manage_deployment(u)):
            qs = qs.filter(profile__tenants__in=user_tenants(u)).distinct()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(username__icontains=s) | qs.filter(email__icontains=s)
        return qs

    @action(detail=True, methods=["post"], url_path="send-reset")
    def send_reset(self, request, pk=None):
        """Email this user a set/reset-password link. Does **not** change or
        clear their current password — it only sends the email; the password
        changes only when the user follows the link and chooses a new one.
        """
        user = self.get_object()
        if not user.email:
            return Response(
                {"detail": "This user has no email address to send a link to."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        from .login_api import send_invite_email

        send_invite_email(request, user)
        return Response({"ok": True, "email": user.email})


# ─── Groups ──────────────────────────────────────────────────────────────────
class GroupSerializer(serializers.ModelSerializer):
    description = serializers.SerializerMethodField()
    built_in = serializers.SerializerMethodField()
    user_count = serializers.SerializerMethodField()
    permission_count = serializers.SerializerMethodField()
    set_description = serializers.CharField(write_only=True, required=False, allow_blank=True)
    # Same one-click site scoping as the user serializer — scopes the whole
    # group to a site (everyone in it becomes site editors/viewers).
    site_role = serializers.JSONField(write_only=True, required=False)

    def get_description(self, obj):
        p = getattr(obj, "profile", None)
        return p.description if p else ""

    def get_built_in(self, obj):
        p = getattr(obj, "profile", None)
        return bool(p and p.built_in)

    def get_user_count(self, obj) -> int:
        return obj.user_set.count()

    def get_permission_count(self, obj) -> int:
        return obj.object_permissions.count()

    @transaction.atomic
    def create(self, validated):
        desc = validated.pop("set_description", "")
        site_role = validated.pop("site_role", None)
        group = Group.objects.create(**validated)
        GroupProfile.objects.create(group=group, description=desc or "")
        _apply_site_role(self.context.get("request"), site_role, group_ids=[group.id])
        return group

    def update(self, group, validated):
        desc = validated.pop("set_description", None)
        for k, v in validated.items():
            setattr(group, k, v)
        group.save()
        if desc is not None:
            GroupProfile.objects.update_or_create(
                group=group, defaults={"description": desc}
            )
        return group

    class Meta:
        model = Group
        fields = ["id", "name", "description", "built_in", "user_count",
                  "permission_count", "set_description", "site_role"]
        read_only_fields = ["id"]


class GroupViewSet(viewsets.ModelViewSet):
    queryset = Group.objects.all().select_related("profile").order_by("name")
    serializer_class = GroupSerializer
    permission_classes = [IsAuthenticated, RBACObjectPermission, DeploymentAdminForWrites]
    rbac_object_type = "group"

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        if getattr(getattr(group, "profile", None), "built_in", False):
            from rest_framework import status

            return Response(
                {"detail": "Built-in groups can't be deleted."},
                status=status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


# ─── Object permissions ──────────────────────────────────────────────────────
class ObjectPermissionSerializer(serializers.ModelSerializer):
    groups = serializers.SerializerMethodField()
    users = serializers.SerializerMethodField()
    tenants = serializers.SerializerMethodField()
    group_ids = serializers.PrimaryKeyRelatedField(
        source="groups", queryset=Group.objects.all(), many=True,
        write_only=True, required=False,
    )
    user_ids = serializers.PrimaryKeyRelatedField(
        source="users", queryset=User.objects.all(), many=True,
        write_only=True, required=False,
    )
    tenant_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=False
    )
    sites = serializers.SerializerMethodField()
    site_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=False
    )

    def get_groups(self, obj):
        return [{"id": g.id, "name": g.name} for g in obj.groups.all()]

    def get_users(self, obj):
        return [{"id": u.id, "username": u.username} for u in obj.users.all()]

    def get_tenants(self, obj):
        return [{"id": str(t.id), "name": t.name} for t in obj.tenants.all()]

    def get_sites(self, obj):
        return [{"id": str(s.id), "name": s.name} for s in obj.sites.all()]

    def validate_actions(self, value):
        bad = [a for a in value if a not in ACTIONS]
        if bad:
            raise serializers.ValidationError(f"Unknown actions: {bad}")
        return value

    def _tenants(self, instance, tenant_ids):
        from core.models import Tenant

        instance.tenants.set(Tenant.objects.filter(id__in=tenant_ids))

    def _sites(self, instance, site_ids):
        from api.models import Site

        instance.sites.set(Site.objects.filter(id__in=site_ids))

    def create(self, validated):
        tids = validated.pop("tenant_ids", None)
        sids = validated.pop("site_ids", None)
        obj = super().create(validated)
        if tids is not None:
            self._tenants(obj, tids)
        if sids is not None:
            self._sites(obj, sids)
        return obj

    def update(self, instance, validated):
        tids = validated.pop("tenant_ids", None)
        sids = validated.pop("site_ids", None)
        obj = super().update(instance, validated)
        if tids is not None:
            self._tenants(obj, tids)
        if sids is not None:
            self._sites(obj, sids)
        return obj

    class Meta:
        model = ObjectPermission
        fields = ["id", "name", "description", "enabled", "object_types",
                  "actions", "constraints", "tenants", "sites", "groups", "users",
                  "group_ids", "user_ids", "tenant_ids", "site_ids",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ObjectPermissionViewSet(viewsets.ModelViewSet):
    queryset = (
        ObjectPermission.objects.all()
        .prefetch_related("groups", "users", "tenants")
        .order_by("name")
    )
    serializer_class = ObjectPermissionSerializer
    permission_classes = [IsAuthenticated, RBACObjectPermission, DeploymentAdminForWrites]
    rbac_object_type = "objectpermission"


# ─── Registry (for the permission form pickers) ──────────────────────────────
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def rbac_object_types(request):
    return Response({"object_types": registry_payload(), "actions": ACTIONS})


def _apply_site_role(request, site_role, *, user_ids=None, group_ids=None):
    """Attach a one-click site role during user/group creation. No-op when
    ``site_role`` is absent. Requires an active tenant + admin; raises
    ValidationError on a bad shape so the whole create rolls back cleanly.
    (User/group creation is already deployment-admin gated by the viewset.)
    """
    if not site_role:
        return
    from rest_framework.exceptions import PermissionDenied, ValidationError

    from api.models import Site
    from api.views import _get_active_tenant

    from .permissions import can_manage_admin

    role = (site_role or {}).get("role")
    if role not in ("editor", "viewer"):
        raise ValidationError({"site_role": "role must be 'editor' or 'viewer'."})
    tenant = _get_active_tenant(request) if request is not None else None
    if tenant is None:
        raise ValidationError({"site_role": "No active tenant to scope the role to."})
    user = getattr(request, "user", None)
    if not (user and (user.is_superuser or can_manage_admin(user, tenant))):
        raise PermissionDenied("Admin required to assign a site role.")
    sites = list(Site.objects.filter(
        id__in=(site_role.get("site_ids") or []), tenant=tenant
    ))
    if not sites:
        raise ValidationError({"site_role": "Pick at least one site in this tenant."})
    assemble_site_role(
        tenant, role, sites,
        user_ids=user_ids, group_ids=group_ids,
        silo=bool(site_role.get("silo")), name=site_role.get("name"),
    )
    # Land the user on the tenant their grants live in — a user with several
    # tenants otherwise starts on the FIRST allowed one, which may be an empty
    # tenant where these grants don't apply (looks like "I can see nothing").
    if user_ids:
        UserProfile.objects.filter(
            user_id__in=user_ids, current_tenant__isnull=True
        ).update(current_tenant=tenant)


def assemble_site_role(tenant, role, sites, *, user_ids=None, group_ids=None,
                       silo=False, name=None):
    """Build the ObjectPermission combo for a site role and attach it to the
    given users/groups. The single source of truth for what a "site editor" or
    "site viewer" gets — reused by the one-click endpoint AND by user/group
    creation, so the grants never drift.

    * ``editor`` — site-scoped write on every site-bound type, plus (unless
      ``silo``) an unscoped ``view`` grant so local IT can read the whole
      tenant. Catalog types (tags, device types, zones, …) join the write
      grant when the tenant runs enhanced site separation, so a site editor can
      manage their site-LOCAL catalog entries.
    * ``viewer`` — site-scoped ``view`` only.

    Returns the created ObjectPermission rows. Callers own authorisation.
    """
    from core.effective_settings import separation_enabled

    from .site_paths import CATALOG_SITE_PATHS, SITE_PATHS

    sites = list(sites)
    user_ids = list(user_ids or [])
    group_ids = list(group_ids or [])
    label = (name or ", ".join(s.name for s in sites)).strip() or "Site role"

    # Site-bound object types the role manages *at* the site. Exclude the Site
    # record itself and the sitesettings admin surface. Add the local/global
    # catalog types only when separation is on (else they ignore site scope and
    # a scoped grant would silently apply tenant-wide).
    types = sorted(set(SITE_PATHS) - {"site", "sitesettings"})
    if separation_enabled(tenant):
        types = sorted(set(types) | set(CATALOG_SITE_PATHS))

    created = []

    def make(nm, object_types, actions, scoped):
        p = ObjectPermission.objects.create(
            name=nm[:128], object_types=object_types, actions=actions,
        )
        p.tenants.set([tenant])
        if scoped:
            p.sites.set(sites)
        if user_ids:
            p.users.set(User.objects.filter(id__in=user_ids))
        if group_ids:
            p.groups.set(Group.objects.filter(id__in=group_ids))
        created.append(p)

    if role == "editor":
        make(f"{label} — site edit", types,
             ["view", "add", "change", "delete"], scoped=True)
        if not silo:
            make(f"{label} — read all", ["*"], ["view"], scoped=False)
    else:  # viewer
        make(f"{label} — site view", types, ["view"], scoped=True)
    return created


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def create_site_role(request):
    """One-click site role — assembles the ObjectPermission combo for:

    * ``editor`` — edit *own site* (site-bound types scoped to the sites) **plus**
      read everything (an unscoped view grant). The "local IT" recipe.
    * ``viewer`` — read *own site* only (site-bound types scoped, nothing broader).

    Body: ``{role, site_ids[], name?, user_ids?[], group_ids?[]}``.

    Gated to permission admins — **except** when the deployment enables
    ``allow_site_editor_delegation``: then a local site *editor* may also create
    a **viewer** role, but only for sites they themselves edit. They can never
    mint editors or reach a site outside their own scope.
    """
    from api.models import Site
    from api.views import _get_active_tenant
    from .permissions import can_manage_admin
    from .rbac import editable_sites

    user = request.user
    tenant = _get_active_tenant(request)

    data = request.data or {}
    role = data.get("role")
    if role not in ("editor", "viewer"):
        return Response(
            {"detail": "role must be 'editor' or 'viewer'."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    sites = list(
        Site.objects.filter(id__in=(data.get("site_ids") or []), tenant=tenant)
    ) if tenant else []
    if not sites:
        return Response(
            {"detail": "Pick at least one site in the active tenant."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Authorisation. Permission admins may create any role for any site. A
    # delegated site editor may create *viewers* for sites they edit, only when
    # the deployment allows it.
    is_admin = user.is_superuser or can_manage_admin(user, tenant)
    if not is_admin:
        from core.effective_settings import effective_sharing

        if not effective_sharing(tenant).allow_site_editor_delegation:
            return Response(
                {"detail": "Not allowed."}, status=status.HTTP_403_FORBIDDEN
            )
        if role != "viewer":
            return Response(
                {"detail": "Site editors may only invite viewers."},
                status=status.HTTP_403_FORBIDDEN,
            )
        own = editable_sites(user, tenant)  # None = any site, set() = none
        if own is not None:
            outside = {s.id for s in sites} - own
            if not own or outside:
                return Response(
                    {"detail": "You may only invite viewers to sites you edit."},
                    status=status.HTTP_403_FORBIDDEN,
                )
    user_ids = data.get("user_ids") or []
    group_ids = data.get("group_ids") or []
    # A delegated (non-admin) site editor may only grant to members of the
    # active tenant, and not to global groups — otherwise they could attach a
    # permission to a user in another tenant (issue #59 delegation leak).
    if not is_admin:
        member_ids = set(
            UserProfile.objects.filter(
                tenants=tenant, user_id__in=user_ids
            ).values_list("user_id", flat=True)
        )
        user_ids = [uid for uid in user_ids if uid in member_ids]
        group_ids = []

    created = assemble_site_role(
        tenant, role, sites,
        user_ids=user_ids, group_ids=group_ids,
        silo=bool(data.get("silo")), name=data.get("name"),
    )
    return Response(
        {"created": [ObjectPermissionSerializer(p).data for p in created]},
        status=status.HTTP_201_CREATED,
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_access_summary(request, user_id):
    """A plain-language read of what a user can do in the active tenant, so an
    admin doesn't have to decode ObjectPermission rows. Admin-only.

    ``{is_admin, edit_scope, read_scope, editable_sites:[{id,name}]}`` where
    ``*_scope`` is ``"all"`` | ``"sites"`` | ``"none"``.
    """
    from api.models import Site
    from api.views import _get_active_tenant
    from .permissions import can_manage_admin
    from .rbac import editable_sites, site_scope

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=400)
    if not (request.user.is_superuser or can_manage_admin(request.user, tenant)):
        return Response({"detail": "Admin required."}, status=403)
    target = User.objects.filter(pk=user_id).first()
    if target is None:
        return Response({"detail": "Not found."}, status=404)

    if target.is_superuser or can_manage_admin(target, tenant):
        return Response({
            "is_admin": True, "edit_scope": "all", "read_scope": "all",
            "editable_sites": [],
        })
    edit = editable_sites(target, tenant)   # None=all, set()=none, {ids}
    # Read scope: any unscoped view grant on a site type → sees all.
    read_all = site_scope(target, tenant, "prefix", "view") is None
    site_ids = [] if edit in (None, set()) else sorted(edit, key=str)
    sites = Site.objects.filter(tenant=tenant, id__in=site_ids)
    return Response({
        "is_admin": False,
        "edit_scope": "all" if edit is None else ("sites" if edit else "none"),
        "read_scope": "all" if read_all else ("sites" if edit else "none"),
        "editable_sites": [{"id": str(s.id), "name": s.name} for s in sites],
    })
