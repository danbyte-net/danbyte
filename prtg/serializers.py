"""API shapes for the PRTG integration."""
from __future__ import annotations

from urllib.parse import urlparse

from rest_framework import serializers

from .models import PrtgConnection


def _host(url: str) -> str:
    return (urlparse(url or "").hostname or "").lower()


def _origin(url: str) -> tuple:
    p = urlparse(url or "")
    return (p.scheme, (p.hostname or "").lower(), p.port)


def _clean_url(value: str, what: str) -> str:
    value = (value or "").strip().rstrip("/")
    if not value.startswith(("http://", "https://")):
        raise serializers.ValidationError(f"Start with http:// or https:// - {what}.")
    if not urlparse(value).hostname:
        raise serializers.ValidationError("The URL has no host.")
    return value


class PrtgConnectionSerializer(serializers.ModelSerializer):
    """The API key is write-only. The API says whether one is set, never what."""

    api_key = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=True
    )
    api_key_set = serializers.BooleanField(read_only=True)
    supported = serializers.BooleanField(read_only=True)
    v2_base = serializers.CharField(read_only=True)

    class Meta:
        model = PrtgConnection
        fields = [
            "id", "name", "url", "api_v2_url", "v2_base", "api_key", "api_key_set",
            "verify_tls", "enabled", "status_interval_seconds", "provision_scope",
            "version", "supported", "v2_available", "last_checked_at", "last_error",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "v2_base", "api_key_set", "version", "supported", "v2_available",
            "last_checked_at", "last_error", "created_at", "updated_at",
        ]

    def validate_name(self, value):
        from api.views import _get_active_tenant

        value = (value or "").strip()
        request = self.context.get("request")
        tenant = (
            self.instance.tenant if self.instance is not None
            else (_get_active_tenant(request) if request is not None else None)
        )
        if tenant is not None:
            clash = PrtgConnection.objects.filter(tenant=tenant, name=value)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError("A PRTG connection with this name exists.")
        return value

    def validate_url(self, value):
        value = _clean_url(value, "the address of the PRTG web interface")
        if urlparse(value).path.rstrip("/").endswith("/api"):
            raise serializers.ValidationError(
                "Give the web interface URL, not the API path - Danbyte adds /api/ itself."
            )
        return value

    def validate_api_v2_url(self, value):
        if not (value or "").strip():
            return ""
        return _clean_url(value, "where API v2 answers, or leave blank")

    def validate_status_interval_seconds(self, value):
        # Every read walks the whole sensors table on the PRTG core server.
        if not 60 <= value <= 3600:
            raise serializers.ValidationError("Between 1 minute and 1 hour.")
        return value

    def validate(self, attrs):
        url = attrs.get("url", self.instance.url if self.instance else "")
        v2 = attrs.get("api_v2_url", self.instance.api_v2_url if self.instance else "")
        # The key travels to both addresses, so both name the same server.
        if v2 and _host(v2) != _host(url):
            raise serializers.ValidationError({
                "api_v2_url": "Use the same host as the web interface URL.",
            })

        api_key = attrs.pop("api_key", None)
        creds = dict(self.instance.credentials or {}) if self.instance else {}
        if api_key:
            creds["api_key"] = api_key
        elif self.instance is not None:
            # A stored key is for the server it was typed for. Moving the URL
            # to another origin without retyping it would hand the key to
            # whatever answers there - so it is dropped instead.
            if "url" in attrs and _origin(attrs["url"]) != _origin(self.instance.url):
                creds.pop("api_key", None)
        attrs["credentials"] = creds
        return attrs
