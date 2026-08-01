"""SSO configuration API — deployment-admin CRUD for identity providers and
their group mappings. The OIDC client secret is write-only (Fernet-encrypted on
the model); reads expose only ``client_secret_set``.
"""
from __future__ import annotations

from rest_framework import permissions, serializers, viewsets

from .models import IdentityProvider, SsoGroupMapping
from .permissions import can_manage_deployment


class DeploymentAdmin(permissions.BasePermission):
    """Only deployment admins (superuser / global users.manage) manage SSO —
    a tenant-narrowed admin grant does not qualify, same as the LDAP config."""

    message = "Deployment admin (users.manage) required."

    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and can_manage_deployment(u))


class IdentityProviderSerializer(serializers.ModelSerializer):
    client_secret = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    client_secret_set = serializers.SerializerMethodField()
    callback_url = serializers.SerializerMethodField()

    def get_client_secret_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("client_secret"))

    def get_callback_url(self, obj) -> str:
        # What the operator registers at the IdP as the redirect/ACS URL.
        path = f"/api/auth/sso/{obj.slug}/callback/"
        req = self.context.get("request")
        return req.build_absolute_uri(path) if req else path

    class Meta:
        model = IdentityProvider
        fields = [
            "id", "name", "slug", "protocol", "enabled", "tenant",
            "oidc_issuer", "oidc_client_id", "oidc_scopes",
            "saml_idp_entity_id", "saml_idp_sso_url", "saml_idp_x509",
            "claim_email", "claim_username", "claim_first_name",
            "claim_last_name", "claim_groups",
            "jit_provisioning", "default_tenant", "default_group",
            "client_secret", "client_secret_set", "callback_url",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "client_secret_set", "callback_url", "created_at", "updated_at",
        ]

    def _store_secret(self, obj, secret):
        if secret is not None:  # blank on edit → leave the stored one untouched
            if secret == "":
                return
            obj.secrets = {**(obj.secrets or {}), "client_secret": secret}
            obj.save(update_fields=["secrets"])

    def create(self, validated_data):
        secret = validated_data.pop("client_secret", None)
        obj = super().create(validated_data)
        self._store_secret(obj, secret)
        return obj

    def update(self, instance, validated_data):
        secret = validated_data.pop("client_secret", None)
        obj = super().update(instance, validated_data)
        self._store_secret(obj, secret)
        return obj


class IdentityProviderViewSet(viewsets.ModelViewSet):
    queryset = IdentityProvider.objects.all()
    serializer_class = IdentityProviderSerializer
    permission_classes = [DeploymentAdmin]


class SsoGroupMappingSerializer(serializers.ModelSerializer):
    group_name = serializers.CharField(source="group.name", read_only=True)

    class Meta:
        model = SsoGroupMapping
        fields = [
            "id", "provider", "idp_group", "group", "group_name",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "group_name", "created_at", "updated_at"]


class SsoGroupMappingViewSet(viewsets.ModelViewSet):
    queryset = SsoGroupMapping.objects.select_related("group").all()
    serializer_class = SsoGroupMappingSerializer
    permission_classes = [DeploymentAdmin]

    def get_queryset(self):
        qs = super().get_queryset()
        provider = self.request.query_params.get("provider")
        return qs.filter(provider_id=provider) if provider else qs
