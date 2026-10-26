"""API shapes for PRTG registration: sensor profiles, their definitions and
the policies that pick devices and VMs."""
from __future__ import annotations

import re

from rest_framework import serializers

from api.models import DeviceRole, DeviceType, Location, Platform, Region, Site
from api.serializers import TenantScopedPrimaryKeyRelatedField

from . import sensor_kinds as sk
from .models import PrtgConnection, PrtgPolicy, PrtgSensorDefinition, PrtgSensorProfile


def _active_tenant(serializer):
    from api.views import _get_active_tenant

    request = serializer.context.get("request")
    return _get_active_tenant(request) if request is not None else None


def _object_id(value: str) -> str:
    value = (value or "").strip()
    if value and not value.isdigit():
        raise serializers.ValidationError("A PRTG object id is a number.")
    return value


class PrtgSensorDefinitionSerializer(serializers.ModelSerializer):
    """One sensor of a profile. ``params`` are checked against the kind and
    stored typed, with the kind's defaults filled in."""

    id = serializers.UUIDField(required=False)
    kind_label = serializers.SerializerMethodField()

    def get_kind_label(self, obj) -> str:
        return sk.label(obj.kind)

    class Meta:
        model = PrtgSensorDefinition
        fields = [
            "id", "position", "kind", "kind_label", "name", "params",
            "interval_seconds", "required", "tags",
        ]
        read_only_fields = ["kind_label", "position"]

    def validate_kind(self, value):
        if value not in sk.BY_VALUE:
            raise serializers.ValidationError(f"'{value}' is not a sensor kind.")
        return value

    def validate_interval_seconds(self, value):
        if value is not None and value not in sk.INTERVALS:
            raise serializers.ValidationError(
                "One of PRTG's intervals: "
                + ", ".join(str(v) for v in sk.INTERVALS) + " seconds."
            )
        return value

    def validate_tags(self, value):
        if not isinstance(value, list) or not all(isinstance(t, str) for t in value):
            raise serializers.ValidationError("A list of tags.")
        out = []
        for tag in value:
            tag = tag.strip()
            if not tag:
                continue
            if re.search(r"[\s,]", tag):
                raise serializers.ValidationError(
                    f"'{tag}': a PRTG tag has no spaces or commas."
                )
            if tag.lower().startswith("danbyte-"):
                raise serializers.ValidationError(
                    "Tags starting with danbyte- are Danbyte's own."
                )
            out.append(tag[:64])
        return out

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", None))
        params = attrs.get("params", getattr(self.instance, "params", {}))
        try:
            attrs["params"] = sk.clean_params(kind, params)
        except ValueError as exc:
            raise serializers.ValidationError(exc.args[0]) from exc
        return attrs


class PrtgSensorProfileSerializer(serializers.ModelSerializer):
    """A profile with its definitions, in order. Writing ``definitions``
    replaces the list: a row naming the ``id`` of one of this profile's
    definitions updates it, any other row makes a new one, and definitions
    left out are deleted."""

    connection = TenantScopedPrimaryKeyRelatedField(queryset=PrtgConnection.objects.all())
    definitions = PrtgSensorDefinitionSerializer(many=True, required=False)
    policy_count = serializers.SerializerMethodField()

    def get_policy_count(self, obj) -> int:
        return obj.policies.count()

    class Meta:
        model = PrtgSensorProfile
        fields = [
            "id", "connection", "name", "description", "definitions", "policy_count",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "policy_count", "created_at", "updated_at"]

    def validate_connection(self, value):
        tenant = _active_tenant(self)
        if tenant is not None and value.tenant_id != tenant.id:
            raise serializers.ValidationError("Not in the active tenant.")
        if self.instance is not None and value.id != self.instance.connection_id:
            raise serializers.ValidationError("A profile stays with its connection.")
        return value

    def validate(self, attrs):
        conn = attrs.get("connection", getattr(self.instance, "connection", None))
        name = (attrs.get("name", getattr(self.instance, "name", "")) or "").strip()
        if not name:
            raise serializers.ValidationError({"name": "A name is needed."})
        clash = PrtgSensorProfile.objects.filter(connection=conn, name=name)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError({"name": "A profile with this name exists."})
        attrs["name"] = name
        return attrs

    @staticmethod
    def _write_definitions(profile, rows):
        keep = []
        existing = {d.id: d for d in profile.definitions.all()}
        for position, row in enumerate(rows):
            row = dict(row)
            current = existing.get(row.pop("id", None))
            if current is None:
                current = PrtgSensorDefinition(profile=profile)
            for key, value in row.items():
                setattr(current, key, value)
            current.position = position
            current.save()
            keep.append(current.id)
        profile.definitions.exclude(id__in=keep).delete()

    def create(self, validated_data):
        rows = validated_data.pop("definitions", [])
        validated_data["tenant"] = validated_data["connection"].tenant
        profile = PrtgSensorProfile.objects.create(**validated_data)
        self._write_definitions(profile, rows)
        return profile

    def update(self, instance, validated_data):
        rows = validated_data.pop("definitions", None)
        instance = super().update(instance, validated_data)
        if rows is not None:
            self._write_definitions(instance, rows)
        return instance


def _scoped(model):
    return TenantScopedPrimaryKeyRelatedField(
        queryset=model.objects.all(), required=False, allow_null=True
    )


class PrtgPolicySerializer(serializers.ModelSerializer):
    """Which devices and VMs PRTG should have. Every target must be the
    active tenant's, and the profile one of this connection's."""

    connection = TenantScopedPrimaryKeyRelatedField(queryset=PrtgConnection.objects.all())
    region = _scoped(Region)
    target_site = _scoped(Site)
    location = _scoped(Location)
    platform = _scoped(Platform)
    device_type = _scoped(DeviceType)
    device_role = _scoped(DeviceRole)
    profile = serializers.PrimaryKeyRelatedField(
        queryset=PrtgSensorProfile.objects.all(), required=False, allow_null=True
    )
    scope_display = serializers.CharField(source="get_scope_display", read_only=True)
    target_name = serializers.SerializerMethodField()
    profile_name = serializers.CharField(source="profile.name", read_only=True, default="")

    def get_target_name(self, obj) -> str:
        field = PrtgPolicy.TARGET_FIELDS.get(obj.scope)
        target = getattr(obj, field, None) if field else None
        if target is None:
            return ""
        return getattr(target, "model", None) or getattr(target, "name", "") or str(target)

    class Meta:
        model = PrtgPolicy
        fields = [
            "id", "connection", "name", "enabled", "priority", "scope", "scope_display",
            "region", "target_site", "location", "platform", "device_type", "device_role",
            "target_name", "match_tags", "match_name", "match_hardware",
            "applies_to_devices", "applies_to_vms", "profile", "profile_name",
            "group_id", "group_path", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "scope_display", "target_name", "profile_name", "created_at", "updated_at",
        ]

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A name is needed.")
        return value

    def validate_match_tags(self, value):
        if not isinstance(value, list) or not all(isinstance(t, str) for t in value):
            raise serializers.ValidationError("A list of tag slugs.")
        return [t.strip() for t in value if t.strip()]

    def validate_group_id(self, value):
        return _object_id(value)

    def validate(self, attrs):
        def get(name):
            if name in attrs:
                return attrs[name]
            return getattr(self.instance, name, None) if self.instance else None

        conn = get("connection")
        tenant = _active_tenant(self) or (conn.tenant if conn else None)
        errors: dict = {}
        if conn is not None and tenant is not None and conn.tenant_id != tenant.id:
            errors["connection"] = "Not in the active tenant."
        if self.instance is not None and conn is not None and (
            conn.id != self.instance.connection_id
        ):
            errors["connection"] = "A policy stays with its connection."
        scope = get("scope") or "global"
        field = PrtgPolicy.TARGET_FIELDS.get(scope)
        if field and get(field) is None:
            errors[field] = "Pick what this policy applies to."
        # Only the scope's own target is kept: a stale one would read as a
        # second condition nobody can see in the form.
        for other in PrtgPolicy.TARGET_FIELDS.values():
            if other != field:
                attrs[other] = None
        for name in PrtgPolicy.TARGET_FIELDS.values():
            value = attrs.get(name)
            if value is not None and tenant is not None and value.tenant_id != tenant.id:
                errors[name] = "Not in the active tenant."
        profile = get("profile")
        if profile is None:
            errors["profile"] = "Pick a sensor profile."
        elif conn is not None and profile.connection_id != conn.id:
            errors["profile"] = "Pick a profile of this connection."
        if not get("group_id"):
            errors["group_id"] = "Pick the PRTG group or probe new devices go under."
        devices = get("applies_to_devices")
        vms = get("applies_to_vms")
        if devices is False and vms is False:
            errors["applies_to_devices"] = "Apply it to devices, VMs or both."
        if errors:
            raise serializers.ValidationError(errors)
        if conn is not None:
            attrs["tenant"] = conn.tenant
        return attrs
