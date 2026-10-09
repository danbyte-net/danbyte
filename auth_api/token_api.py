"""API-token self-service - a user manages their own tokens. The full key is
returned exactly once, at creation. Only a signed-in session may manage tokens:
a token can't mint, list or revoke tokens."""
from __future__ import annotations

from rest_framework import serializers, viewsets
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response

from .models import ApiToken, generate_api_key, hash_api_key


class SessionOnly(BasePermission):
    """Refuse a request that authenticated with an API token (#318).

    Nothing legitimately manages tokens with a token: the SPA creates and
    revokes them from the session, and scripts, agents and runners only use
    the one they were given. Letting a token through would let a short-lived,
    read-only or run token mint a permanent full-scope one for any tenant its
    owner can reach, so the check applies to every action on the viewset.
    """

    message = "API tokens are managed from a signed-in session, not with a token."

    def has_permission(self, request, view):
        return not isinstance(getattr(request, "auth", None), ApiToken)


class ApiTokenSerializer(serializers.ModelSerializer):
    tenant = serializers.SerializerMethodField()
    is_expired = serializers.BooleanField(read_only=True)
    tenant_id = serializers.UUIDField(write_only=True)

    def get_tenant(self, obj):
        return {"id": str(obj.tenant_id), "name": obj.tenant.name}

    class Meta:
        model = ApiToken
        fields = ["id", "name", "tenant", "tenant_id", "prefix", "scope", "kind",
                  "last_used_at", "expires_at", "is_expired", "created_at"]
        read_only_fields = ["id", "prefix", "kind", "last_used_at", "is_expired",
                            "created_at"]


class ApiTokenViewSet(viewsets.ModelViewSet):
    serializer_class = ApiTokenSerializer
    permission_classes = [IsAuthenticated, SessionOnly]
    http_method_names = ["get", "post", "delete"]

    def get_queryset(self):
        return (
            ApiToken.objects.filter(user=self.request.user, kind="user")
            .select_related("tenant")
            .order_by("-created_at")
        )

    def create(self, request, *args, **kwargs):
        from auth_api.permissions import user_tenants

        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        tenant_id = ser.validated_data["tenant_id"]
        tenant = user_tenants(request.user).filter(pk=tenant_id).first()
        if tenant is None:
            return Response(
                {"tenant_id": "You don't have access to that tenant."},
                status=400,
            )
        key = generate_api_key()
        token = ApiToken.objects.create(
            user=request.user,
            tenant=tenant,
            name=ser.validated_data["name"],
            key_hash=hash_api_key(key),
            prefix=key[:11],
            expires_at=ser.validated_data.get("expires_at"),
            scope=ser.validated_data.get("scope", "full"),
        )
        data = ApiTokenSerializer(token).data
        data["key"] = key  # shown once, never again
        return Response(data, status=201)
