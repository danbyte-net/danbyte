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
"""
from __future__ import annotations

from django.db.models import Q
from rest_framework import serializers, viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated

from api.views import _get_active_tenant

from .models import SavedFilter


class SavedFilterSerializer(serializers.ModelSerializer):
    owner = serializers.CharField(source="created_by.username", read_only=True)
    mine = serializers.SerializerMethodField()

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
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "owner", "mine", "created_at", "updated_at"]

    def get_mine(self, obj) -> bool:
        request = self.context.get("request")
        return bool(request and obj.created_by_id == request.user.id)

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
        # Ownership and tenancy are not the caller's to move.
        serializer.save(
            tenant=serializer.instance.tenant,
            created_by=serializer.instance.created_by,
        )

    def perform_destroy(self, instance):
        self._mine_or_403(instance)
        instance.delete()
