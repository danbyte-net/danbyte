from __future__ import annotations

from urllib.parse import urlparse

from django.db.models import Q
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied

from api.models import Device, VirtualMachine
from api.serializers import TenantScopedPrimaryKeyRelatedField

from .models import OxidizedConnection, OxidizedNode, OxidizedNodeLink


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
    next_sync_at = serializers.SerializerMethodField()

    class Meta:
        model = OxidizedConnection
        fields = [
            "id", "name", "url", "username", "password", "password_set",
            "verify_tls", "enabled", "match_by",
            "auto_sync", "sync_interval_minutes",
            "last_checked_at", "last_error", "node_count", "last_sync_at",
            "last_sync_attempt_at", "next_sync_at",
            "link_count", "sync", "created_at", "updated_at",
        ]
        read_only_fields = [
            "last_checked_at", "last_error", "node_count", "last_sync_at",
            "last_sync_attempt_at", "created_at", "updated_at",
        ]

    def get_link_count(self, obj) -> int:
        return obj.links.count()

    def get_next_sync_at(self, obj) -> str | None:
        """When the scheduler syncs next (#385); null while auto sync is off."""
        from .schedule import next_sync_at

        when = next_sync_at(obj)
        return when.isoformat() if when else None

    def get_sync(self, obj) -> dict:
        """The last node sync's counts; the unmatched rows have an endpoint."""
        s = obj.last_sync_summary or {}
        return {k: s.get(k) for k in (
            "nodes", "linked", "pinned", "proposed", "unmatched_count", "warning_count",
            "missing_pinned", "error",
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


def require_connection_change(user, conn) -> None:
    """Which node backs which object decides whose config an object's Config
    tab shows, so pinning and unlinking are connection management: they need
    ``change`` on the connection as well as the link grant (#386)."""
    from auth_api import rbac

    if not rbac.can_act_on(user, conn.tenant, "oxidizedconnection", "change", conn):
        raise PermissionDenied(
            "Pinning or unlinking a node needs the change permission on its "
            "Oxidized connection."
        )


class _MiniDevice(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class OxidizedNodeLinkSerializer(serializers.ModelSerializer):
    """A link is matched by a node sync or pinned here by hand.

    Only creating (pinning) and deleting go through the API. A pin names
    exactly one of ``device_id`` or ``virtual_machine_id`` (#384), and
    replaces whatever the sync had matched for that node or that target.
    """

    connection_id = TenantScopedPrimaryKeyRelatedField(
        source="connection", queryset=OxidizedConnection.objects.all(), write_only=True
    )
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
        required=False, allow_null=True,
    )
    virtual_machine_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machine", queryset=VirtualMachine.objects.all(), write_only=True,
        required=False, allow_null=True,
    )
    connection = serializers.UUIDField(source="connection_id", read_only=True)
    connection_name = serializers.CharField(source="connection.name", read_only=True)
    device = _MiniDevice(read_only=True, allow_null=True)
    virtual_machine = _MiniDevice(read_only=True, allow_null=True)

    class Meta:
        model = OxidizedNodeLink
        fields = [
            "id", "connection", "connection_id", "connection_name", "device", "device_id",
            "virtual_machine", "virtual_machine_id",
            "full_name", "node_name", "node_group", "node_ip", "node_model",
            "matched_by", "proposed", "last_seen_at", "created_at",
        ]
        read_only_fields = [
            "node_name", "node_group", "node_ip", "node_model", "matched_by",
            "proposed", "last_seen_at", "created_at",
        ]
        # The model's unique constraints are not the pin's rules: a pin
        # replaces the matched link on its node or target (``create``), and
        # names exactly one target (``validate``). The generated validators
        # would make both target fields required.
        validators: list = []

    def validate_full_name(self, value):
        value = (value or "").strip().strip("/")
        if not value:
            raise serializers.ValidationError("Name the Oxidized node.")
        return value

    def validate(self, attrs):
        from auth_api import rbac

        request = self.context.get("request")
        conn = attrs["connection"]
        if request is not None:
            require_connection_change(request.user, conn)
        device, vm = attrs.get("device"), attrs.get("virtual_machine")
        if (device is None) == (vm is None):
            raise serializers.ValidationError(
                {"device_id": "Pick a device or a virtual machine, not both."}
                if device is not None
                else {"device_id": "Pick a device or a virtual machine."}
            )
        target, slug, field = (
            (device, "device", "device_id") if device is not None
            else (vm, "virtualmachine", "virtual_machine_id")
        )
        if conn.tenant_id != target.tenant_id:
            raise serializers.ValidationError({field: "Not in the connection's tenant."})
        if request is not None and not rbac.can_act_on(
            request.user, conn.tenant, slug, "view", target
        ):
            raise serializers.ValidationError({field: "No such object."})
        pinned = OxidizedNodeLink.objects.filter(
            connection=conn, matched_by=OxidizedNodeLink.HOW_MANUAL
        )
        mine = pinned.filter(device=device) if device is not None else pinned.filter(
            virtual_machine=vm
        )
        if mine.exists():
            raise serializers.ValidationError({field: "Already pinned to a node."})
        if pinned.filter(full_name=attrs["full_name"]).exists():
            raise serializers.ValidationError(
                {"full_name": "This node is already pinned."}
            )
        if request is not None:
            self._check_pin_scope(request.user, conn, attrs["full_name"], target, slug)
        return attrs

    @staticmethod
    def _check_pin_scope(user, conn, full_name, target, slug):
        """A pin must never show its author a configuration they could not
        already read (#386).

        The config endpoints serve whichever node is linked to the object in
        the URL, so pinning node N to an object T where the author holds
        ``view_config`` hands them N's config. That is allowed only when N's
        config is already theirs to read: N's confirmed link points at an
        object they hold ``view`` and ``view_config`` on; or N has no confirmed
        link and its last one pointed at such an object, so unlinking first
        gains nothing (#398); or N never had a confirmed link and their
        ``view_config`` on that kind is not limited by site or row. The same
        rule confirms a proposed link (#399).
        An author without ``view_config`` on T gains nothing to read, so an
        admin's mapping work is unchanged.

        Separately, a pin deletes the node's previous link; that link must be
        inside the sites the author may add links in.
        """
        from auth_api import rbac

        from .sync import last_target

        tenant = conn.tenant
        existing = (
            OxidizedNodeLink.objects.filter(connection=conn, full_name=full_name)
            .select_related("device", "virtual_machine")
            .first()
        )
        if (
            existing is not None
            and existing.target != target
            and not rbac.restrict_queryset(
                OxidizedNodeLink.objects.filter(pk=existing.pk),
                user, tenant, "oxidizednodelink", "add",
            ).exists()
        ):
            raise serializers.ValidationError(
                {"full_name": "This node is linked to an object outside your scope."}
            )
        if not rbac.can_act_on(user, tenant, slug, "view_config", target):
            return
        # Whose config the node is: its confirmed link's object, or, once
        # unlinked, the object its last confirmed link pointed at (#398). A
        # proposed link proves nothing - a sync made it, not a reader (#399).
        if existing is not None and not existing.proposed:
            was = existing.target
        else:
            was = last_target(conn, full_name)
        if was is None:
            if rbac.row_filter(user, tenant, slug, "view_config") is True:
                return
        else:
            was_slug = "device" if isinstance(was, Device) else "virtualmachine"
            if rbac.can_act_on(user, tenant, was_slug, "view", was) and rbac.can_act_on(
                user, tenant, was_slug, "view_config", was
            ):
                return
        raise serializers.ValidationError(
            {"full_name": "You cannot read this node's configuration."}
        )

    def create(self, validated):
        from .sync import remember_unlinked

        conn, full = validated["connection"], validated["full_name"]
        device, vm = validated.get("device"), validated.get("virtual_machine")
        replaced = OxidizedNodeLink.objects.filter(connection=conn).filter(
            Q(device=device) if device is not None else Q(virtual_machine=vm)
        ) | OxidizedNodeLink.objects.filter(connection=conn, full_name=full)
        replaced = list(replaced)
        remember_unlinked(replaced)
        OxidizedNodeLink.objects.filter(id__in=[lk.id for lk in replaced]).delete()
        OxidizedNode.objects.get_or_create(
            connection=conn, full_name=full, defaults={"tenant": conn.tenant}
        )
        known = next(
            (n for n in (conn.last_sync_summary or {}).get("unmatched", [])
             if n.get("full_name") == full),
            {},
        )
        name = full.rpartition("/")[2]
        group = full.rpartition("/")[0]
        return OxidizedNodeLink.objects.create(
            tenant=conn.tenant, connection=conn, device=device, virtual_machine=vm,
            full_name=full, node_name=name, node_group=group,
            node_ip=str(known.get("ip") or "")[:64],
            node_model=str(known.get("model") or "")[:64],
            matched_by=OxidizedNodeLink.HOW_MANUAL,
        )
