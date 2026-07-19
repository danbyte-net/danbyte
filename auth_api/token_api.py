"""API-token self-service — a user manages their own tokens. The full key is
returned exactly once, at creation."""
from __future__ import annotations

from rest_framework import serializers, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import ApiToken, generate_api_key, hash_api_key


class ApiTokenSerializer(serializers.ModelSerializer):
    tenant = serializers.SerializerMethodField()
    is_expired = serializers.BooleanField(read_only=True)
    tenant_id = serializers.UUIDField(write_only=True)

    def get_tenant(self, obj):
        return {"id": str(obj.tenant_id), "name": obj.tenant.name}

    class Meta:
        model = ApiToken
        fields = ["id", "name", "tenant", "tenant_id", "prefix", "last_used_at",
                  "expires_at", "is_expired", "created_at"]
        read_only_fields = ["id", "prefix", "last_used_at", "is_expired",
                            "created_at"]


class ApiTokenViewSet(viewsets.ModelViewSet):
    serializer_class = ApiTokenSerializer
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "post", "delete"]

    def get_queryset(self):
        return (
            ApiToken.objects.filter(user=self.request.user)
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
        )
        data = ApiTokenSerializer(token).data
        data["key"] = key  # shown once, never again
        return Response(data, status=201)
