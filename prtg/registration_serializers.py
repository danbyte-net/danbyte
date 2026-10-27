"""API shapes for PRTG registration: sensor profiles, their definitions and
the policies that pick devices and VMs."""
from __future__ import annotations

import re

from rest_framework import serializers

from api.models import DeviceRole, DeviceType, Location, Platform, Region, Site
from api.serializers import TenantScopedPrimaryKeyRelatedField

from . import sensor_kinds as sk
from .models import (
    PrtgConnection,
    PrtgCredential,
    PrtgPolicy,
    PrtgSensorDefinition,
    PrtgSensorProfile,
)


def _active_tenant(serializer):
    from api.views import _get_active_tenant

    request = serializer.context.get("request")
    return _get_active_tenant(request) if request is not None else None


def _object_id(value: str) -> str:
    value = (value or "").strip()
    if value and not value.isdigit():
        raise serializers.ValidationError("A PRTG object id is a number.")
    return value


#: A PRTG kind id as its sensor list names one.
_KINDID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")
_SCALAR = (str, int, float, bool)


def _generic_shape(params) -> dict:
    """A PRTG-only kind's ``section.field`` params, shape-checked; the
    profile types them against PRTG's schema."""
    if params in (None, ""):
        return {}
    if not isinstance(params, dict):
        raise serializers.ValidationError({"params": "Expected an object."})
    out = {}
    for key, value in params.items():
        section, _, name = str(key).partition(".")
        if not (section and name) or len(str(key)) > 120:
            raise serializers.ValidationError({"params": f"'{key}' is not a PRTG setting."})
        if value is None or isinstance(value, _SCALAR) or (
            isinstance(value, list) and all(isinstance(v, _SCALAR) for v in value)
        ):
            out[str(key)] = value
        else:
            raise serializers.ValidationError({"params": f"{key}: a value or a list."})
    return out


class PrtgSensorDefinitionSerializer(serializers.ModelSerializer):
    """One sensor of a profile. A Danbyte kind's ``params`` are checked
    against the kind and stored typed, with the kind's defaults filled in;
    any other kind is a PRTG kind id whose params the profile checks
    against PRTG's schema (:meth:`PrtgSensorProfileSerializer.validate`)."""

    id = serializers.UUIDField(required=False)
    kind_label = serializers.SerializerMethodField()
    #: ``danbyte`` (Danbyte's own form) or ``generic`` (PRTG's schema).
    form = serializers.SerializerMethodField()

    def get_kind_label(self, obj) -> str:
        if obj.kind in sk.BY_VALUE:
            return sk.label(obj.kind)
        from .manual import cached_kind

        conn = obj.profile.connection if obj.profile_id else None
        row = cached_kind(conn, obj.kind) if conn is not None else None
        return str((row or {}).get("name") or obj.kind)

    def get_form(self, obj) -> str:
        return "danbyte" if obj.kind in sk.BY_VALUE else "generic"

    class Meta:
        model = PrtgSensorDefinition
        fields = [
            "id", "position", "kind", "kind_label", "form", "name", "params",
            "interval_seconds", "required", "tags",
        ]
        read_only_fields = ["kind_label", "form", "position"]

    def validate_kind(self, value):
        from .manual import BY_KINDID

        value = (value or "").strip()
        if value in sk.BY_VALUE:
            return value
        # PRTG's id for a kind Danbyte has a form for is that kind.
        if value in BY_KINDID:
            return BY_KINDID[value]
        if not _KINDID.match(value):
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
        if kind not in sk.BY_VALUE:
            attrs["params"] = _generic_shape(params)
            return attrs
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
    #: The credential sections the definitions need: ``[{section, label,
    #: writable, kinds}]`` (:func:`prtg.credentials.profile_sections`).
    credential_sections = serializers.SerializerMethodField()

    def get_policy_count(self, obj) -> int:
        return obj.policies.count()

    def get_credential_sections(self, obj) -> list:
        from .credentials import profile_sections

        return profile_sections(obj)

    class Meta:
        model = PrtgSensorProfile
        fields = [
            "id", "connection", "name", "description", "definitions", "policy_count",
            "credential_placement", "credential_sections", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "policy_count", "credential_sections", "created_at",
                            "updated_at"]

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
        if conn is not None and attrs.get("definitions"):
            self._check_generic(conn, attrs["definitions"])
        if conn is not None and "credential_placement" in attrs:
            attrs["credential_placement"] = _placement(conn, attrs["credential_placement"])
        return attrs

    @staticmethod
    def _check_generic(conn, rows) -> None:
        """A PRTG-only kind's params, typed by PRTG's form when one is
        already kept on the connection (:func:`prtg.manual.type_generic`).
        A profile is not tied to any device, so saving never asks PRTG and
        never needs the form: PRTG checks the settings when the sensor is
        created on a matched device, and a refusal shows on that row of the
        review queue."""
        from .manual import cached_schema, type_generic

        for row in rows:
            kind = row.get("kind")
            if kind in sk.BY_VALUE or not row.get("params"):
                continue
            form = cached_schema(conn, kind)
            if form and form.get("fields"):
                row["params"] = type_generic(form["fields"], row["params"])

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


def _placement(conn, value) -> dict:
    from .credentials import clean_placement

    try:
        return clean_placement(conn, value)
    except ValueError as exc:
        raise serializers.ValidationError({"credential_placement": str(exc)}) from None


class PrtgCredentialSerializer(serializers.ModelSerializer):
    """A login Danbyte can place on a PRTG group or device. Secrets are
    write-only: ``password``, ``token_secret``, ``private_key``; the API
    answers ``password_set`` and so on, never a value. A blank secret on an
    update keeps the stored one."""

    connection = TenantScopedPrimaryKeyRelatedField(queryset=PrtgConnection.objects.all())
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    password = serializers.CharField(write_only=True, required=False, allow_blank=True,
                                     trim_whitespace=False)
    token_secret = serializers.CharField(write_only=True, required=False, allow_blank=True)
    private_key = serializers.CharField(write_only=True, required=False, allow_blank=True,
                                        trim_whitespace=False)
    password_set = serializers.SerializerMethodField()
    token_secret_set = serializers.SerializerMethodField()
    private_key_set = serializers.SerializerMethodField()

    SECRETS = ("password", "token_secret", "private_key")
    #: What each kind keeps in ``params``.
    PARAMS = {
        "proxmox": ("user", "realm", "token_id", "port"),
        "vmware": ("user", "port"),
        "windows_login": ("domain", "user"),
        "ssh": ("user", "port"),
    }

    def _set(self, obj, name) -> bool:
        return bool((obj.secret_params or {}).get(name))

    def get_password_set(self, obj) -> bool:
        return self._set(obj, "password")

    def get_token_secret_set(self, obj) -> bool:
        return self._set(obj, "token_secret")

    def get_private_key_set(self, obj) -> bool:
        return self._set(obj, "private_key")

    class Meta:
        model = PrtgCredential
        fields = [
            "id", "connection", "name", "kind", "kind_display", "params", "description",
            "password", "token_secret", "private_key", "password_set", "token_secret_set",
            "private_key_set", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "kind_display", "password_set", "token_secret_set",
                            "private_key_set", "created_at", "updated_at"]

    def validate(self, attrs):
        def get(name):
            return attrs[name] if name in attrs else getattr(self.instance, name, None)

        conn = get("connection")
        tenant = _active_tenant(self)
        if conn is not None and tenant is not None and conn.tenant_id != tenant.id:
            raise serializers.ValidationError({"connection": "Not in the active tenant."})
        if self.instance is not None and conn is not None and (
            conn.id != self.instance.connection_id
        ):
            raise serializers.ValidationError({"connection": "A credential stays with its "
                                                             "connection."})
        name = (get("name") or "").strip()
        if not name:
            raise serializers.ValidationError({"name": "A name is needed."})
        clash = PrtgCredential.objects.filter(connection=conn, name=name)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError({"name": "A credential with this name exists."})
        attrs["name"] = name
        kind = get("kind")
        raw = attrs.get("params", getattr(self.instance, "params", None)) or {}
        if not isinstance(raw, dict):
            raise serializers.ValidationError({"params": "Expected an object."})
        params = {}
        for key in self.PARAMS.get(kind, ()):
            value = raw.get(key)
            if value in (None, ""):
                continue
            if key == "port":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    raise serializers.ValidationError({"params": "The port is a number."}) from None
                if not 0 < value < 65536:
                    raise serializers.ValidationError({"params": "The port is 1 to 65535."})
            else:
                value = str(value).strip()[:255]
            params[key] = value
        if not params.get("user"):
            raise serializers.ValidationError({"params": "A user is needed."})
        attrs["params"] = params
        secrets = dict(self.instance.secret_params or {}) if self.instance else {}
        if self.instance is not None and self.instance.kind != kind:
            secrets = {}
        for key in self.SECRETS:
            value = attrs.pop(key, None)
            if value:
                secrets[key] = value
        if kind == "proxmox" and not (secrets.get("token_secret") or secrets.get("password")):
            raise serializers.ValidationError({"token_secret": "The API token secret is "
                                                               "needed."})
        if kind == "proxmox" and not params.get("token_id") and "!" not in params["user"]:
            raise serializers.ValidationError({"params": "PRTG takes a Proxmox API token: "
                                                         "give its token id."})
        if kind in ("vmware", "windows_login") and not secrets.get("password"):
            raise serializers.ValidationError({"password": "A password is needed."})
        if kind == "ssh" and not (secrets.get("password") or secrets.get("private_key")):
            raise serializers.ValidationError({"password": "A password or private key is "
                                                           "needed."})
        if kind == "proxmox" and not secrets.get("token_secret") and secrets.get("password"):
            # PRTG 26.3's Proxmox sensors take only an API token.
            raise serializers.ValidationError({"token_secret": "PRTG takes the Proxmox "
                                                               "API token secret, not a "
                                                               "password."})
        attrs["secret_params"] = secrets
        if conn is not None:
            attrs["tenant"] = conn.tenant
        return attrs


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
            "group_id", "group_path", "use_layout", "credential_placement",
            "created_at", "updated_at",
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
        if not get("group_id") and not get("use_layout"):
            errors["group_id"] = "Pick the PRTG group or probe new devices go under."
        if conn is not None and "credential_placement" in attrs:
            try:
                from .credentials import clean_placement

                attrs["credential_placement"] = clean_placement(
                    conn, attrs["credential_placement"])
            except ValueError as exc:
                errors["credential_placement"] = str(exc)
        devices = get("applies_to_devices")
        vms = get("applies_to_vms")
        if devices is False and vms is False:
            errors["applies_to_devices"] = "Apply it to devices, VMs or both."
        if errors:
            raise serializers.ValidationError(errors)
        if conn is not None:
            attrs["tenant"] = conn.tenant
        return attrs
