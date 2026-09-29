"""Script API shapes, and the parameter schema a Run dialog is built from."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework import serializers

from api.serializers import ObjectPermsSerializerMixin
from core.cadence import Cadence, CadenceError, Retention

from .models import MAX_TIMEOUT, Script, ScriptOutput, ScriptRun

PARAM_TYPES = ("string", "text", "integer", "decimal", "boolean", "choice", "object")

#: What the script does and whose access it does it with. Only the owner (or a
#: superuser) changes these: a colleague the script is shared with could
#: otherwise rewrite code that runs as the owner.
OWNER_ONLY_FIELDS = (
    "source", "language", "params_schema", "run_as", "token_scope",
    "schedule_enabled", "cadence", "schedule_params",
)
#: A schedule runs the code unattended, as the owner. Turning one on, or
#: changing any of these while one is on, needs the run permission.
SCHEDULE_FIELDS = (
    "schedule_enabled", "cadence", "schedule_params", "source", "run_as",
    "token_scope",
)


def validate_params_schema(value):
    """One flat list of parameter definitions, each with a name and type."""
    if not isinstance(value, list):
        raise serializers.ValidationError("Expected a list of parameters.")
    seen: set[str] = set()
    clean = []
    for i, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise serializers.ValidationError(f"Parameter {i + 1} is not an object.")
        name = str(raw.get("name") or "").strip()
        if not name.isidentifier():
            raise serializers.ValidationError(
                f"Parameter {i + 1}: '{name}' is not a usable name (letters, digits, underscore)."
            )
        if name in seen:
            raise serializers.ValidationError(f"Two parameters are named '{name}'.")
        seen.add(name)
        kind = str(raw.get("type") or "string")
        if kind not in PARAM_TYPES:
            raise serializers.ValidationError(
                f"Parameter '{name}': unknown type '{kind}'. One of {', '.join(PARAM_TYPES)}."
            )
        choices = raw.get("choices") or []
        if kind == "choice" and not choices:
            raise serializers.ValidationError(f"Parameter '{name}': a choice needs its options.")
        clean.append({
            "name": name,
            "label": str(raw.get("label") or name.replace("_", " ").capitalize()),
            "type": kind,
            "required": bool(raw.get("required")),
            "default": raw.get("default"),
            "choices": [str(c) for c in choices],
            "help": str(raw.get("help") or ""),
            "object_type": str(raw.get("object_type") or ""),
        })
    return clean


def coerce_params(schema, values: dict) -> dict:
    """Turn what the Run dialog sent into what the script receives.
    Raises ``serializers.ValidationError`` with per-field messages."""
    values = values or {}
    errors: dict[str, list[str]] = {}
    out: dict = {}
    for spec in schema or []:
        name, kind = spec["name"], spec.get("type", "string")
        raw = values.get(name, spec.get("default"))
        if raw in (None, ""):
            if spec.get("required"):
                errors[name] = ["This parameter is required."]
            else:
                out[name] = spec.get("default")
            continue
        try:
            if kind == "integer":
                out[name] = int(raw)
            elif kind == "decimal":
                out[name] = float(raw)
            elif kind == "boolean":
                out[name] = raw if isinstance(raw, bool) else str(raw).lower() in ("1", "true", "yes")
            elif kind == "choice":
                if str(raw) not in spec.get("choices", []):
                    raise ValueError("not one of the options")
                out[name] = str(raw)
            else:
                out[name] = str(raw)
        except (TypeError, ValueError) as exc:
            errors[name] = [f"Not a valid {kind}: {exc}."]
    if errors:
        raise serializers.ValidationError(errors)
    return out


class ScriptSerializer(ObjectPermsSerializerMixin, serializers.ModelSerializer):
    rbac_extra_actions = ("run", "trust")

    owner_name = serializers.CharField(source="owner.username", read_only=True, default=None)
    shared_users = serializers.PrimaryKeyRelatedField(
        many=True, queryset=get_user_model().objects.all(), required=False
    )
    shared_groups = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Group.objects.all(), required=False
    )
    cadence_label = serializers.SerializerMethodField()
    next_run_at = serializers.SerializerMethodField()
    # Annotated by the viewset (one subquery, not one query per row). The
    # model's own last_run_at belongs to the schedule, so the newest run is
    # reported separately.
    last_run_status = serializers.CharField(source="last_run_state", read_only=True, default=None)
    last_run_time = serializers.DateTimeField(read_only=True, default=None)
    run_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Script
        fields = [
            "id", "name", "slug", "description", "language", "source", "params_schema",
            "token_scope", "timeout_seconds", "trusted", "run_as", "owner", "owner_name",
            "visibility", "shared_users", "shared_groups", "schedule_enabled", "cadence",
            "cadence_label", "next_run_at", "retention", "schedule_params",
            "last_run_at", "last_run_time", "last_run_status", "run_count", "enabled",
            "permissions",
            "created_at", "updated_at",
        ]
        read_only_fields = ["owner", "last_run_at", "created_at", "updated_at", "trusted"]

    def get_cadence_label(self, obj) -> str:
        if not obj.schedule_enabled:
            return ""
        try:
            return Cadence.from_dict(obj.cadence).label
        except CadenceError:
            return ""

    def get_next_run_at(self, obj):
        if not (obj.schedule_enabled and obj.enabled):
            return None
        from .schedules import next_run

        try:
            return next_run(obj)
        except CadenceError:
            return None

    def validate_params_schema(self, value):
        return validate_params_schema(value)

    def validate_timeout_seconds(self, value):
        if not 5 <= int(value) <= MAX_TIMEOUT:
            raise serializers.ValidationError(f"Between 5 and {MAX_TIMEOUT} seconds.")
        return value

    def validate_cadence(self, value):
        if not value:
            return {}
        try:
            return Cadence.from_dict(value).to_dict()
        except CadenceError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate_retention(self, value):
        try:
            return Retention.from_dict(value).to_dict()
        except CadenceError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate(self, attrs):
        instance = self.instance
        visibility = attrs.get("visibility", getattr(instance, "visibility", "owner"))
        schedule_on = attrs.get(
            "schedule_enabled", getattr(instance, "schedule_enabled", False)
        )
        if schedule_on:
            cadence = attrs.get("cadence", getattr(instance, "cadence", {}) or {})
            if not cadence:
                raise serializers.ValidationError(
                    {"cadence": ["A scheduled script needs a cadence."]}
                )
        # Publishing to the whole tenant is its own permission.
        request = self.context.get("request")
        if visibility == "global" and request is not None:
            from auth_api.permissions import user_has_perm

            was_global = getattr(instance, "visibility", "") == "global"
            if not was_global and not user_has_perm(request.user, "scripts.publish"):
                raise serializers.ValidationError(
                    {"visibility": ["You cannot publish a script to everyone."]}
                )
        user = getattr(request, "user", None)
        if user is not None and not getattr(user, "is_superuser", False):
            self._check_execution_fields(attrs, request, user, schedule_on)
        return attrs

    def _changed(self, attrs, fields):
        instance = self.instance
        if instance is None:
            return [f for f in fields if f in attrs]
        return [f for f in fields if f in attrs and attrs[f] != getattr(instance, f)]

    def _check_execution_fields(self, attrs, request, user, schedule_on):
        """Who may change what a script runs and whose access it runs with."""
        from api.views import _get_active_tenant
        from auth_api import rbac

        instance = self.instance
        tenant = getattr(instance, "tenant", None) or _get_active_tenant(request)
        if instance is not None and instance.owner_id != user.pk:
            touched = self._changed(attrs, OWNER_ONLY_FIELDS)
            if touched:
                raise serializers.ValidationError({
                    f: ["Only the script's owner can change this."] for f in touched
                })
        if schedule_on and (instance is None or self._changed(attrs, SCHEDULE_FIELDS)):
            if not rbac.has_action(user, tenant, "script", "run"):
                raise serializers.ValidationError({
                    "schedule_enabled": [
                        "Scheduling a script needs the run permission."
                    ],
                })
        # A trusted script reaches the database directly; whoever marked it
        # trusted vouched for the code as it was. New code without the trust
        # permission loses the mark.
        if (
            instance is not None
            and instance.trusted
            and self._changed(attrs, ("source",))
            and not rbac.has_action(user, tenant, "script", "trust")
        ):
            attrs["trusted"] = False


class ScriptOutputSerializer(serializers.ModelSerializer):
    class Meta:
        model = ScriptOutput
        fields = ["id", "name", "content_type", "size", "created_at"]
        read_only_fields = fields


class ScriptRunSerializer(serializers.ModelSerializer):
    script_name = serializers.CharField(source="script.name", read_only=True)
    started_by_name = serializers.CharField(
        source="started_by.username", read_only=True, default=None
    )
    run_as_name = serializers.CharField(
        source="run_as_user.username", read_only=True, default=None
    )
    outputs = ScriptOutputSerializer(many=True, read_only=True)
    duration_seconds = serializers.FloatField(read_only=True)

    class Meta:
        model = ScriptRun
        fields = [
            "id", "script", "script_name", "status", "params", "exit_code", "error",
            "scheduled", "trusted", "started_by_name", "run_as_name", "rq_job_id",
            "started_at", "finished_at", "duration_seconds", "truncated", "outputs",
            "created_at",
        ]
        read_only_fields = fields


class ScriptRunDetailSerializer(ScriptRunSerializer):
    """The run page: everything above plus the log and the code that ran."""

    class Meta(ScriptRunSerializer.Meta):
        fields = [*ScriptRunSerializer.Meta.fields, "log", "source"]
        read_only_fields = fields
