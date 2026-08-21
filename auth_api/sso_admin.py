"""SSO configuration API - deployment-admin CRUD for identity providers and
their group mappings. The OIDC client secret is write-only (Fernet-encrypted on
the model); reads expose only ``client_secret_set``.
"""
from __future__ import annotations

from rest_framework import permissions, serializers, viewsets

from .models import IdentityProvider, SsoGroupMapping
from .permissions import can_manage_deployment


class DeploymentAdmin(permissions.BasePermission):
    """Only deployment admins (superuser / global users.manage) manage SSO -
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
    login_url = serializers.SerializerMethodField()
    acs_url = serializers.SerializerMethodField()
    metadata_url = serializers.SerializerMethodField()
    sp_entity_id = serializers.SerializerMethodField()

    def get_client_secret_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("client_secret"))

    def _abs(self, path) -> str:
        req = self.context.get("request")
        return req.build_absolute_uri(path) if req else path

    def get_callback_url(self, obj) -> str:
        # OIDC redirect URI to register at the IdP.
        return self._abs(f"/api/auth/sso/{obj.slug}/callback/")

    def get_login_url(self, obj) -> str:
        # SP-initiated sign-on entry point (the SAML "Sign on URL").
        return self._abs(f"/api/auth/sso/{obj.slug}/login/")

    def get_acs_url(self, obj) -> str:
        # SAML Assertion Consumer Service (Reply URL) to register at the IdP.
        return self._abs(f"/api/auth/sso/{obj.slug}/acs/")

    def get_metadata_url(self, obj) -> str:
        return self._abs(f"/api/auth/sso/{obj.slug}/metadata/")

    def get_sp_entity_id(self, obj) -> str:
        # SAML SP entity id / Identifier - matches auth_api.saml.sp_entity_id.
        return self._abs(f"/api/auth/sso/{obj.slug}/metadata/")

    class Meta:
        model = IdentityProvider
        fields = [
            "id", "name", "slug", "protocol", "enabled", "tenant",
            "oidc_issuer", "oidc_client_id", "oidc_scopes",
            "saml_idp_entity_id", "saml_idp_sso_url", "saml_idp_x509",
            "saml_idp_metadata_url",
            "claim_email", "claim_username", "claim_first_name",
            "claim_last_name", "claim_groups",
            "jit_provisioning", "default_tenant", "default_group",
            "client_secret", "client_secret_set", "callback_url",
            "login_url", "acs_url", "metadata_url", "sp_entity_id",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "client_secret_set", "callback_url", "login_url",
            "acs_url", "metadata_url", "sp_entity_id", "created_at",
            "updated_at",
        ]

    def _store_secret(self, obj, secret):
        if secret is not None:  # blank on edit → leave the stored one untouched
            if secret == "":
                return
            obj.secrets = {**(obj.secrets or {}), "client_secret": secret}
            obj.save(update_fields=["secrets"])

    def _apply_metadata(self, obj):
        """If a SAML metadata URL is set, fetch it and fill the IdP entity id,
        SSO URL, and signing cert(s) so the operator doesn't hand-pick a cert."""
        if obj.protocol != IdentityProvider.Protocol.SAML:
            return
        url = (obj.saml_idp_metadata_url or "").strip()
        if not url:
            return
        from .saml import SamlError, fetch_idp_metadata

        try:
            md = fetch_idp_metadata(url, use_cache=False)
        except SamlError as exc:
            raise serializers.ValidationError(
                {"saml_idp_metadata_url": str(exc)}
            ) from exc
        fields = []
        if md.get("entity_id"):
            obj.saml_idp_entity_id = md["entity_id"]
            fields.append("saml_idp_entity_id")
        if md.get("sso_url"):
            obj.saml_idp_sso_url = md["sso_url"]
            fields.append("saml_idp_sso_url")
        if md.get("certs"):
            obj.saml_idp_x509 = "\n".join(md["certs"])
            fields.append("saml_idp_x509")
        if fields:
            obj.save(update_fields=fields)

    def create(self, validated_data):
        secret = validated_data.pop("client_secret", None)
        obj = super().create(validated_data)
        self._store_secret(obj, secret)
        self._apply_metadata(obj)
        return obj

    def update(self, instance, validated_data):
        secret = validated_data.pop("client_secret", None)
        obj = super().update(instance, validated_data)
        self._store_secret(obj, secret)
        self._apply_metadata(obj)
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
            "grants_superuser",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "group_name", "created_at", "updated_at"]

    def validate(self, attrs):
        # Superuser is global - a tenant-scoped provider may not mint one.
        provider = attrs.get(
            "provider", getattr(self.instance, "provider", None)
        )
        grants = attrs.get(
            "grants_superuser",
            getattr(self.instance, "grants_superuser", False),
        )
        if grants and provider is not None and provider.tenant_id:
            raise serializers.ValidationError(
                {"grants_superuser":
                 "Not available on a tenant-scoped provider."}
            )
        return attrs


class SsoGroupMappingViewSet(viewsets.ModelViewSet):
    queryset = SsoGroupMapping.objects.select_related("group").all()
    serializer_class = SsoGroupMappingSerializer
    permission_classes = [DeploymentAdmin]

    def get_queryset(self):
        qs = super().get_queryset()
        provider = self.request.query_params.get("provider")
        return qs.filter(provider_id=provider) if provider else qs
