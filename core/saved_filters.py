"""Saved list filters.

Deliberately *not* RBAC-gated the way domain objects are: a saved filter is a
view preference, like a bookmark, and making people ask an administrator for a
grant before they can name their own working set would be absurd. What it is
gated on is ownership and tenancy - you see your own filters plus the ones
shared into the tenant you are in, and only the author can change one. A shared
filter therefore cannot be redefined under the people using it.

The stored ``query`` is the list page's own filter state, so it carries object
ids the author could see. That is not a leak: applying a filter re-runs the
reader's own list request, which is scoped to *them*, so a shared filter shows
each person only the rows they may already view - it can select fewer rows for
one reader than another, never more.

A list opens with its *default* view (#523): the one you pinned, else the one
an administrator pinned for the tenant. Pins are per list - pinning another
view moves the pin. The tenant's pin must be a shared view, only
administrators (``can_manage_admin``) set it, and each change is
change-logged. Unsharing a view drops the pins other people had on it.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import Q
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant

from .models import SavedFilter, SavedFilterDefault

#: Whose default a pin sets: yours, or the tenant's.
PIN_SCOPES = ("me", "tenant")


class SavedFilterSerializer(serializers.ModelSerializer):
    owner = serializers.CharField(source="created_by.username", read_only=True)
    mine = serializers.SerializerMethodField()
    is_default = serializers.SerializerMethodField()
    is_tenant_default = serializers.SerializerMethodField()

    class Meta:
        model = SavedFilter
        fields = [
            "id",
            "object_type",
            "name",
            "description",
            "query",
            "shared",
            "owner",
            "mine",
            "is_default",
            "is_tenant_default",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id", "owner", "mine", "is_default", "is_tenant_default",
            "created_at", "updated_at",
        ]

    def get_mine(self, obj) -> bool:
        request = self.context.get("request")
        return bool(request and obj.created_by_id == request.user.id)

    def _pins(self) -> dict:
        """``{(object_type, "me" | "tenant"): view id}`` for the caller, read
        once per response."""
        cached = self.context.get("_pins")
        if cached is None:
            cached = {}
            request = self.context.get("request")
            tenant = _get_active_tenant(request) if request else None
            if tenant is not None:
                rows = SavedFilterDefault.objects.filter(tenant=tenant).filter(
                    Q(user=request.user) | Q(user__isnull=True)
                ).values_list("object_type", "user_id", "saved_filter_id")
                for object_type, user_id, view_id in rows:
                    cached[(object_type, "tenant" if user_id is None else "me")] = view_id
            self.context["_pins"] = cached
        return cached

    def get_is_default(self, obj) -> bool:
        return self._pins().get((obj.object_type, "me")) == obj.pk

    def get_is_tenant_default(self, obj) -> bool:
        return self._pins().get((obj.object_type, "tenant")) == obj.pk

    def validate_query(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected the filter state object.")
        return value

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Give the view a name.")
        return value


class SavedFilterViewSet(viewsets.ModelViewSet):
    """Your saved views, plus the ones shared into the active tenant."""

    serializer_class = SavedFilterSerializer
    permission_classes = [IsAuthenticated]

    def _tenant(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant.")
        return tenant

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return SavedFilter.objects.none()
        qs = SavedFilter.objects.filter(tenant=tenant).filter(
            Q(created_by=self.request.user) | Q(shared=True)
        )
        object_type = self.request.query_params.get("object_type")
        if object_type:
            qs = qs.filter(object_type=object_type)
        return qs.select_related("created_by")

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant(), created_by=self.request.user)

    def _mine_or_403(self, instance):
        if instance.created_by_id != self.request.user.id:
            raise PermissionDenied("This view belongs to someone else.")

    def perform_update(self, serializer):
        self._mine_or_403(serializer.instance)
        was_shared = serializer.instance.shared
        with transaction.atomic():
            # Ownership and tenancy are not the caller's to move.
            view = serializer.save(
                tenant=serializer.instance.tenant,
                created_by=serializer.instance.created_by,
            )
            if was_shared and not view.shared:
                # Nobody but the owner can open it now: the pins others had
                # on it, and the tenant's, go with the sharing.
                for pin in view.defaults.exclude(user_id=view.created_by_id):
                    _unpin(pin)

    def perform_destroy(self, instance):
        self._mine_or_403(instance)
        with transaction.atomic():
            for pin in instance.defaults.filter(user__isnull=True):
                _unpin(pin)
            instance.delete()

    @extend_schema(
        summary="Pin or unpin a saved view as its list's default",
        parameters=[OpenApiParameter(
            "scope", str, enum=list(PIN_SCOPES),
            description="DELETE only: whose pin to remove, `me` (default) or `tenant`.",
        )],
        request={"application/json": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": list(PIN_SCOPES)},
        }}},
        responses=SavedFilterSerializer,
    )
    @action(detail=True, methods=["post", "delete"])
    def pin(self, request, pk=None):
        """POST pins the view as its list's default - ``{"scope": "me"}`` for
        you (the default), ``"tenant"`` for everyone in the tenant without a
        pin of their own. Pinning another view moves the pin. DELETE
        ``?scope=`` unpins it. Any view you can open can be yours; the
        tenant's must be shared, and setting it needs administrator rights."""
        view = self.get_object()
        tenant = self._tenant()
        if request.method == "POST":
            body = request.data if isinstance(request.data, dict) else {}
            scope = body.get("scope", "me")
        else:
            scope = request.query_params.get("scope", "me")
        if scope not in PIN_SCOPES:
            raise ValidationError({"scope": "One of: me, tenant."})
        if scope == "tenant":
            from auth_api.permissions import can_manage_admin

            if not can_manage_admin(request.user, tenant):
                raise PermissionDenied("Pinning a view for everyone needs administrator rights.")
            if request.method == "POST" and not view.shared:
                raise ValidationError({"scope": "Share the view before pinning it for everyone."})
        user = request.user if scope == "me" else None
        with transaction.atomic():
            current = (
                SavedFilterDefault.objects.select_for_update()
                .filter(tenant=tenant, object_type=view.object_type, user=user).first()
            )
            if request.method == "POST":
                old = current.saved_filter_id if current else None
                if current is None:
                    current = SavedFilterDefault(
                        tenant=tenant, object_type=view.object_type, user=user,
                    )
                if old != view.pk:
                    current.saved_filter = view
                    current.save()
                    if user is None:
                        _log_tenant_pin(current, old, view.pk)
            elif current is not None and current.saved_filter_id == view.pk:
                _unpin(current)
        return Response(self.get_serializer(view).data)


def _unpin(pin: SavedFilterDefault) -> None:
    if pin.user_id is None:
        _log_tenant_pin(pin, pin.saved_filter_id, None)
    pin.delete()


def _log_tenant_pin(pin: SavedFilterDefault, old, new) -> None:
    """The tenant's pin in the change log: who pinned which view for everyone.
    Personal pins are preferences, like the views themselves, so the model is
    not audited by signal."""
    from audit.bulk import _entry
    from audit.context import current_request_id, current_user
    from audit.models import ChangeAction

    if old is None:
        verb = ChangeAction.CREATE
    elif new is None:
        verb = ChangeAction.DELETE
    else:
        verb = ChangeAction.UPDATE
    names = dict(
        SavedFilter.objects.filter(pk__in=[v for v in (old, new) if v])
        .values_list("pk", "name")
    )
    changes = {"saved_filter": {"old": names.get(old), "new": names.get(new)}}
    _entry(pin, verb, changes, current_user(), current_request_id()).save()
