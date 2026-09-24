"""Named dashboards - serializer, viewset and the home-dashboard pick.

Like saved views: any tenant member may make one, only its owner changes it,
and sharing is a visibility setting. A dashboard holds a layout and a scope;
the data behind each widget is fetched with the viewer's own permissions, so
sharing a board never widens what anyone can see.
"""
from __future__ import annotations

import uuid

from django.contrib.auth.models import Group
from django.db.models import Q
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant
from auth_api.dashboard_prefs import clean_layout

from .models import Dashboard

SCOPE_KEYS = ("site", "region", "role", "device_type", "tag", "sla")
REFRESH_CHOICES = (0, 30, 60, 300, 900)
HOME_PREF = "home-dashboard"


class DashboardSerializer(serializers.ModelSerializer):
    owner_name = serializers.CharField(source="owner.username", read_only=True)
    groups = serializers.PrimaryKeyRelatedField(
        queryset=Group.objects.all(), many=True, required=False
    )
    mine = serializers.SerializerMethodField()

    class Meta:
        model = Dashboard
        fields = [
            "id", "name", "description", "owner_name", "mine", "visibility", "groups",
            "layout", "scope", "frame", "refresh_seconds", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def get_mine(self, obj) -> bool:
        request = self.context.get("request")
        return bool(request and obj.owner_id == request.user.id)

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Give the dashboard a name.")
        return value

    def validate_layout(self, value):
        if value in (None, {}):
            return {"v": 2, "items": []}
        try:
            return clean_layout(value)
        except ValueError as e:
            raise serializers.ValidationError(str(e)) from None

    def validate_scope(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected {dimension: [ids]}.")
        out = {}
        for key, vals in value.items():
            if key not in SCOPE_KEYS:
                raise serializers.ValidationError(f"«{key}»: one of {', '.join(SCOPE_KEYS)}.")
            if not isinstance(vals, list) or len(vals) > 200:
                raise serializers.ValidationError(f"«{key}»: a list of up to 200.")
            clean = []
            for v in vals:
                v = str(v).strip()
                if key != "tag":
                    try:
                        v = str(uuid.UUID(v))
                    except ValueError:
                        raise serializers.ValidationError(f"«{key}»: «{v}» is not an id.") from None
                if v:
                    clean.append(v)
            if clean:
                out[key] = clean
        return out

    def validate_refresh_seconds(self, value):
        if value not in REFRESH_CHOICES:
            raise serializers.ValidationError(
                f"One of {', '.join(str(c) for c in REFRESH_CHOICES)}."
            )
        return value

    def validate_groups(self, groups):
        # Share only with groups the caller is in, unless they manage users:
        # otherwise a board could be pushed onto strangers' lists.
        request = self.context.get("request")
        if request is None or request.user.is_superuser:
            return groups
        from auth_api.permissions import can_manage_admin

        if can_manage_admin(request.user, _get_active_tenant(request)):
            return groups
        own = set(request.user.groups.values_list("pk", flat=True))
        for g in groups:
            if g.pk not in own:
                raise serializers.ValidationError(f"You are not in «{g.name}».")
        return groups


class DashboardViewSet(viewsets.ModelViewSet):
    """Mine, the tenant's, and those shared with a group I am in."""

    serializer_class = DashboardSerializer
    permission_classes = [IsAuthenticated]

    def _tenant(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant.")
        return tenant

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return Dashboard.objects.none()
        user = self.request.user
        return (
            Dashboard.objects.filter(tenant=tenant)
            .filter(
                Q(owner=user)
                | Q(visibility="tenant")
                | Q(visibility="groups", groups__in=user.groups.all())
            )
            .distinct()
            .select_related("owner")
            .prefetch_related("groups")
            .order_by("name")
        )

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant(), owner=self.request.user)

    def _mine_or_403(self, instance):
        if instance.owner_id != self.request.user.id:
            raise PermissionDenied("This dashboard belongs to someone else; duplicate it to change it.")

    def perform_update(self, serializer):
        self._mine_or_403(serializer.instance)
        serializer.save(tenant=serializer.instance.tenant, owner=serializer.instance.owner)

    def perform_destroy(self, instance):
        self._mine_or_403(instance)
        instance.delete()

    @action(detail=True, methods=["post"])
    def duplicate(self, request, pk=None):
        """A private copy owned by the caller - how a shared board is changed."""
        src = self.get_object()
        copy = Dashboard.objects.create(
            tenant=src.tenant, owner=request.user, name=f"{src.name} (copy)"[:120],
            description=src.description, layout=src.layout, scope=src.scope,
            frame=src.frame, refresh_seconds=src.refresh_seconds,
        )
        return Response(self.get_serializer(copy).data, status=201)

    @action(detail=False, methods=["get"], url_path="share-groups")
    def share_groups(self, request):
        """The groups the caller may share a dashboard with: their own, or
        every group for someone who manages users."""
        from auth_api.permissions import can_manage_admin

        tenant = self._tenant()
        if request.user.is_superuser or can_manage_admin(request.user, tenant):
            qs = Group.objects.all()
        else:
            qs = request.user.groups.all()
        return Response([{"id": g.pk, "name": g.name} for g in qs.order_by("name")])

    @action(detail=False, methods=["get", "put"])
    def home(self, request):
        """The dashboard ``/`` opens for this user; null = their own layout."""
        from auth_api.models import UserPreference

        tenant = self._tenant()
        if request.method == "PUT":
            want = request.data.get("id")
            if want is not None and not self.get_queryset().filter(pk=want).exists():
                raise PermissionDenied("No such dashboard for you.")
            UserPreference.objects.update_or_create(
                user=request.user, tenant=tenant, table_id=HOME_PREF,
                defaults={"data": {"id": str(want) if want else None}},
            )
        row = UserPreference.objects.filter(
            user=request.user, tenant=tenant, table_id=HOME_PREF
        ).first()
        want = (row.data or {}).get("id") if row else None
        board = self.get_queryset().filter(pk=want).first() if want else None
        return Response({"id": str(board.id) if board else None})
