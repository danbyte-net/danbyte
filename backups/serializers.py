"""Backup API serializers - deployment tier, so no tenant field anywhere."""
from __future__ import annotations

from rest_framework import serializers

from core.cadence import Cadence, CadenceError, Retention
from monitoring.models import NotificationChannel

from .models import COMPONENTS, Backup, BackupSchedule, BackupTarget, RestoreRun
from .schedules import next_run
from .storage import storage_kinds


def _components(value):
    comps = [c for c in COMPONENTS if c in set(value or [])]
    if not comps:
        raise serializers.ValidationError("Pick at least one of db, media, config.")
    return comps


class BackupTargetSerializer(serializers.ModelSerializer):
    credentials = serializers.JSONField(write_only=True, required=False)
    has_credentials = serializers.SerializerMethodField()
    location = serializers.CharField(read_only=True)
    backups_count = serializers.SerializerMethodField()

    class Meta:
        model = BackupTarget
        fields = [
            "id", "name", "kind", "config", "credentials", "has_credentials", "location",
            "is_default", "enabled", "last_error", "backups_count", "created_at", "updated_at",
        ]
        read_only_fields = ["last_error", "created_at", "updated_at"]

    def get_has_credentials(self, obj) -> bool:
        return bool(obj.credentials)

    def get_backups_count(self, obj) -> int:
        return obj.backups.count()

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", "local"))
        if kind not in {k["kind"] for k in storage_kinds()}:
            raise serializers.ValidationError({"kind": "Unknown storage kind."})
        config = attrs.get("config", getattr(self.instance, "config", {}) or {})
        if kind == "local" and not str(config.get("path") or "").strip():
            raise serializers.ValidationError({"config": "A local target needs a path."})
        if kind == "s3" and not str(config.get("bucket") or "").strip():
            raise serializers.ValidationError({"config": "An S3 target needs a bucket."})
        creds = attrs.get("credentials")
        if creds is not None and not isinstance(creds, dict):
            raise serializers.ValidationError({"credentials": "Expected an object."})
        return attrs

    def save(self, **kwargs):
        creds = self.validated_data.get("credentials")
        if creds is not None and self.instance is not None:
            # blank values keep the stored secret, so an edit form need not resend it
            merged = dict(self.instance.credentials or {})
            for k, v in creds.items():
                if v not in ("", None):
                    merged[k] = v
            self.validated_data["credentials"] = merged
        obj = super().save(**kwargs)
        if obj.is_default:
            BackupTarget.objects.exclude(pk=obj.pk).filter(is_default=True).update(is_default=False)
        return obj


class BackupScheduleSerializer(serializers.ModelSerializer):
    target_name = serializers.CharField(source="target.name", read_only=True)
    notify_channels = serializers.PrimaryKeyRelatedField(
        many=True, queryset=NotificationChannel.objects.all(), required=False
    )
    cadence_label = serializers.SerializerMethodField()
    next_run_at = serializers.SerializerMethodField()
    last_backup_status = serializers.CharField(source="last_backup.status", read_only=True, default=None)

    class Meta:
        model = BackupSchedule
        fields = [
            "id", "name", "components", "target", "target_name", "cadence", "cadence_label",
            "retention", "notify_channels", "enabled", "last_run_at", "next_run_at",
            "last_backup", "last_backup_status", "created_at", "updated_at",
        ]
        read_only_fields = ["last_run_at", "last_backup", "created_at", "updated_at"]

    def get_cadence_label(self, obj) -> str:
        try:
            return Cadence.from_dict(obj.cadence).label
        except CadenceError:
            return ""

    def get_next_run_at(self, obj):
        if not obj.enabled:
            return None
        try:
            return next_run(obj)
        except CadenceError:
            return None

    def validate_components(self, value):
        return _components(value)

    def validate_cadence(self, value):
        try:
            return Cadence.from_dict(value).to_dict()
        except CadenceError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate_retention(self, value):
        try:
            return Retention.from_dict(value).to_dict()
        except CadenceError as exc:
            raise serializers.ValidationError(str(exc)) from exc


class BackupSerializer(serializers.ModelSerializer):
    schedule_name = serializers.CharField(source="schedule.name", read_only=True, default=None)
    target_name = serializers.CharField(source="target.name", read_only=True)
    target_kind = serializers.CharField(source="target.kind", read_only=True)
    created_by_name = serializers.CharField(source="created_by.username", read_only=True, default=None)
    summary = serializers.SerializerMethodField()

    class Meta:
        model = Backup
        fields = [
            "id", "kind", "schedule", "schedule_name", "target", "target_name", "target_kind",
            "components", "status", "steps", "filename", "location", "size", "checksum",
            "summary", "error", "protected", "created_by_name", "started_at", "finished_at",
            "created_at",
        ]
        read_only_fields = fields

    def get_summary(self, obj) -> dict:
        m = obj.manifest or {}
        return {
            "version": m.get("version"),
            "created_at": m.get("created_at"),
            "deployment_name": m.get("deployment_name"),
            "hostname": m.get("hostname"),
            "media_files": m.get("media_files"),
            "counts": m.get("counts") or {},
        }


class RestoreRunSerializer(serializers.ModelSerializer):
    backup_filename = serializers.CharField(source="backup.filename", read_only=True)
    created_by_name = serializers.CharField(source="created_by.username", read_only=True, default=None)

    class Meta:
        model = RestoreRun
        fields = [
            "id", "backup", "backup_filename", "components", "status", "steps", "safety_backup",
            "error", "created_by_name", "started_at", "finished_at", "created_at",
        ]
        read_only_fields = fields
