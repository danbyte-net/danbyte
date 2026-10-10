from __future__ import annotations

from urllib.parse import urlparse

from rest_framework import serializers

from api.models import Device
from api.serializers import TenantScopedPrimaryKeyRelatedField

from .models import OxidizedConnection, OxidizedNodeLink


def _origin(url: str) -> tuple:
    p = urlparse(url or "")
    return (p.scheme, (p.hostname or "").lower(), p.port)


class OxidizedConnectionSerializer(serializers.ModelSerializer):
    """The password is write-only. The API says whether one is set, never what."""

    password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    password_set = serializers.BooleanField(read_only=True)
    link_count = serializers.SerializerMethodField()
    sync = serializers.SerializerMethodField()

    class Meta:
        model = OxidizedConnection
        fields = [
            "id", "name", "url", "username", "password", "password_set",
            "verify_tls", "enabled", "match_by",
            "last_checked_at", "last_error", "node_count", "last_sync_at",
            "link_count", "sync", "created_at", "updated_at",
        ]
        read_only_fields = [
            "last_checked_at", "last_error", "node_count", "last_sync_at",
            "created_at", "updated_at",
        ]

    def get_link_count(self, obj) -> int:
        return obj.links.count()

    def get_sync(self, obj) -> dict:
        """The last node sync's counts; the unmatched rows have an endpoint."""
        s = obj.last_sync_summary or {}
        return {k: s.get(k) for k in (
            "nodes", "linked", "pinned", "unmatched_count", "missing_pinned", "error",
        )}

    def validate_url(self, value):
        value = (value or "").strip().rstrip("/")
        if not value.startswith(("http://", "https://")):
            raise serializers.ValidationError(
                "Start with http:// or https:// - the address oxidized-web answers on."
            )
        if not urlparse(value).hostname:
            raise serializers.ValidationError("The URL has no host.")
        return value

    def validate(self, attrs):
        password = attrs.pop("password", None)
        creds = dict(self.instance.credentials or {}) if self.instance else {}
        if password:
            creds["password"] = password
        elif self.instance is not None:
            # A stored password is for the server it was typed for. Moving the
            # URL to another origin without retyping it would hand that
            # password to whatever answers there - so it is dropped instead.
            moved = "url" in attrs and _origin(attrs["url"]) != _origin(self.instance.url)
            renamed = "username" in attrs and attrs["username"] != self.instance.username
            if moved or renamed:
                creds.pop("password", None)
        attrs["credentials"] = creds
        return attrs


class _MiniDevice(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class OxidizedNodeLinkSerializer(serializers.ModelSerializer):
    """A link is matched by a node sync or pinned here by hand.

    Only creating (pinning) and deleting go through the API. A pinned link
    replaces whatever the sync had matched for that node or that device.
    """

    connection_id = TenantScopedPrimaryKeyRelatedField(
        source="connection", queryset=OxidizedConnection.objects.all(), write_only=True
    )
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True
    )
    connection = serializers.UUIDField(source="connection_id", read_only=True)
    connection_name = serializers.CharField(source="connection.name", read_only=True)
    device = _MiniDevice(read_only=True)

    class Meta:
        model = OxidizedNodeLink
        fields = [
            "id", "connection", "connection_id", "connection_name", "device", "device_id",
            "full_name", "node_name", "node_group", "node_ip", "node_model",
            "matched_by", "last_seen_at", "created_at",
        ]
        read_only_fields = [
            "node_name", "node_group", "node_ip", "node_model", "matched_by",
            "last_seen_at", "created_at",
        ]

    def validate_full_name(self, value):
        value = (value or "").strip().strip("/")
        if not value:
            raise serializers.ValidationError("Name the Oxidized node.")
        return value

    def validate(self, attrs):
        from auth_api import rbac

        request = self.context.get("request")
        conn, device = attrs["connection"], attrs["device"]
        if conn.tenant_id != device.tenant_id:
            raise serializers.ValidationError("The device is not in the connection's tenant.")
        if request is not None and not rbac.can_act_on(
            request.user, conn.tenant, "device", "view", device
        ):
            raise serializers.ValidationError({"device_id": "No such device."})
        pinned = OxidizedNodeLink.objects.filter(
            connection=conn, matched_by=OxidizedNodeLink.HOW_MANUAL
        )
        if pinned.filter(device=device).exists():
            raise serializers.ValidationError(
                {"device_id": "This device is already pinned to a node."}
            )
        if pinned.filter(full_name=attrs["full_name"]).exists():
            raise serializers.ValidationError(
                {"full_name": "This node is already pinned to a device."}
            )
        return attrs

    def create(self, validated):
        conn, device, full = validated["connection"], validated["device"], validated["full_name"]
        OxidizedNodeLink.objects.filter(connection=conn).filter(
            device=device
        ).delete()
        OxidizedNodeLink.objects.filter(connection=conn, full_name=full).delete()
        known = next(
            (n for n in (conn.last_sync_summary or {}).get("unmatched", [])
             if n.get("full_name") == full),
            {},
        )
        name = full.rpartition("/")[2]
        group = full.rpartition("/")[0]
        return OxidizedNodeLink.objects.create(
            tenant=conn.tenant, connection=conn, device=device, full_name=full,
            node_name=name, node_group=group,
            node_ip=str(known.get("ip") or "")[:64],
            node_model=str(known.get("model") or "")[:64],
            matched_by=OxidizedNodeLink.HOW_MANUAL,
        )
