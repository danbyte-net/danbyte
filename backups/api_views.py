"""Backup and restore API - ``/api/backups/``, deployment admins only."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
from wsgiref.util import FileWrapper

from django.conf import settings
from django.http import StreamingHttpResponse
from django.utils import timezone
from rest_framework import permissions, serializers, viewsets
from rest_framework.decorators import action, api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from auth_api.permissions import can_manage_deployment
from core.models import DeploymentSettings

from . import maintenance
from .archive import ArchiveError, KeyMismatch, Reader
from .engine import EngineError, create_backup, delete_backup, enqueue_backup, work_dir
from .models import Backup, BackupSchedule, BackupTarget, RestoreRun
from .restore import RestoreError, create_restore, enqueue_restore, preview
from .schedules import fire_schedule
from .seeds import default_target
from .serializers import (
    BackupScheduleSerializer,
    BackupSerializer,
    BackupTargetSerializer,
    RestoreRunSerializer,
)
from .storage import StorageError, storage_kinds


class DeploymentAdmin(permissions.BasePermission):
    message = "Deployment admin required."

    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and can_manage_deployment(u))


def _restore_in_progress() -> bool:
    return RestoreRun.objects.filter(status__in=("queued", "running")).exists()


# ─── status ─────────────────────────────────────────────────────────────────

@api_view(["GET"])
@permission_classes([DeploymentAdmin])
def backups_status(request):
    return Response({
        "deployment_name": DeploymentSettings.load().deployment_name or "Danbyte",
        "backup_dir": str(settings.DANBYTE_BACKUP_DIR),
        "storage_kinds": storage_kinds(),
        "maintenance": maintenance.active(),
        "restore_in_progress": _restore_in_progress(),
        "backup_in_progress": Backup.objects.filter(status__in=("queued", "running")).exists(),
    })


# ─── targets ────────────────────────────────────────────────────────────────

class BackupTargetViewSet(viewsets.ModelViewSet):
    queryset = BackupTarget.objects.all()
    serializer_class = BackupTargetSerializer
    permission_classes = [DeploymentAdmin]

    def perform_destroy(self, instance):
        if instance.backups.exists() or instance.schedules.exists():
            raise serializers.ValidationError(
                {"detail": "This target still has backups or schedules. Move or delete them first."}
            )
        if instance.is_default:
            raise serializers.ValidationError({"detail": "Pick another default target first."})
        instance.delete()

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        target = self.get_object()
        try:
            target.backend().probe()
        except StorageError as exc:
            target.last_error = str(exc)[:2000]
            target.save(update_fields=["last_error", "updated_at"])
            return Response({"ok": False, "detail": str(exc)}, status=400)
        target.last_error = ""
        target.save(update_fields=["last_error", "updated_at"])
        return Response({"ok": True, "detail": f"Wrote and removed a marker on {target.location}."})


# ─── schedules ──────────────────────────────────────────────────────────────

class BackupScheduleViewSet(viewsets.ModelViewSet):
    queryset = BackupSchedule.objects.select_related("target", "last_backup").prefetch_related("notify_channels")
    serializer_class = BackupScheduleSerializer
    permission_classes = [DeploymentAdmin]

    @action(detail=True, methods=["post"])
    def run(self, request, pk=None):
        schedule = self.get_object()
        if maintenance.active() or _restore_in_progress():
            return Response({"detail": "A restore is in progress."}, status=409)
        backup = fire_schedule(schedule, user=request.user, kind="manual")
        return Response(BackupSerializer(backup).data, status=201)


# ─── backups ────────────────────────────────────────────────────────────────

class BackupCreateSerializer(serializers.Serializer):
    components = serializers.ListField(child=serializers.CharField(), required=False)
    target = serializers.PrimaryKeyRelatedField(queryset=BackupTarget.objects.filter(enabled=True), required=False)


class RestoreRequestSerializer(serializers.Serializer):
    components = serializers.ListField(child=serializers.CharField(), required=False)
    confirm = serializers.CharField()


class BackupViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Backup.objects.select_related("target", "schedule", "created_by")
    serializer_class = BackupSerializer
    permission_classes = [DeploymentAdmin]

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("kind"):
            qs = qs.filter(kind=p["kind"])
        if p.get("status"):
            qs = qs.filter(status=p["status"])
        if p.get("target"):
            qs = qs.filter(target_id=p["target"])
        return qs

    def create(self, request):
        if maintenance.active() or _restore_in_progress():
            return Response({"detail": "A restore is in progress."}, status=409)
        ser = BackupCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            backup = create_backup(
                kind="manual", components=ser.validated_data.get("components") or None,
                target=ser.validated_data.get("target"), user=request.user,
            )
        except EngineError as exc:
            return Response({"detail": str(exc)}, status=400)
        enqueue_backup(backup)
        return Response(BackupSerializer(backup).data, status=201)

    def destroy(self, request, pk=None):
        backup = self.get_object()
        if backup.protected:
            return Response({"detail": "This backup is protected. Unprotect it first."}, status=400)
        if backup.restores.filter(status__in=("queued", "running")).exists():
            return Response({"detail": "A restore from this backup is running."}, status=409)
        try:
            delete_backup(backup)
        except EngineError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(status=204)

    @action(detail=True, methods=["post"])
    def protect(self, request, pk=None):
        backup = self.get_object()
        backup.protected = bool(request.data.get("protected", True))
        backup.save(update_fields=["protected", "updated_at"])
        return Response(BackupSerializer(backup).data)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        backup = self.get_object()
        if backup.status != "success" or not backup.filename:
            return Response({"detail": "This backup has no archive."}, status=404)
        try:
            fh = backup.target.backend().open(backup.filename)
        except (StorageError, OSError) as exc:
            return Response({"detail": f"The archive could not be opened: {exc}"}, status=502)
        resp = StreamingHttpResponse(FileWrapper(fh, 1024 * 1024), content_type="application/octet-stream")
        resp["Content-Disposition"] = f'attachment; filename="{backup.filename}"'
        if backup.size:
            resp["Content-Length"] = str(backup.size)
        return resp

    @action(detail=True, methods=["get"])
    def preview(self, request, pk=None):
        backup = self.get_object()
        if backup.status != "success":
            return Response({"detail": "Only a finished backup can be restored."}, status=400)
        return Response(preview(backup))

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        backup = self.get_object()
        if backup.status != "success":
            return Response({"detail": "Only a finished backup can be restored."}, status=400)
        ser = RestoreRequestSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        expected = DeploymentSettings.load().deployment_name or "Danbyte"
        if ser.validated_data["confirm"].strip() != expected:
            return Response({"confirm": [f"Type the deployment name, {expected}, to confirm."]}, status=400)
        if maintenance.active() or _restore_in_progress():
            return Response({"detail": "A restore is already in progress."}, status=409)
        if Backup.objects.filter(status__in=("queued", "running")).exists():
            return Response({"detail": "Wait for the running backup to finish."}, status=409)
        pv = preview(backup)
        if not pv["can_restore"]:
            failed = [c["detail"] for c in pv["checks"] if not c["ok"]]
            return Response({"detail": "; ".join(failed), "preview": pv}, status=400)
        try:
            run = create_restore(backup, ser.validated_data.get("components") or None, user=request.user)
        except RestoreError as exc:
            return Response({"detail": str(exc)}, status=400)
        enqueue_restore(run)
        return Response(RestoreRunSerializer(run).data, status=201)


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@api_view(["POST"])
@permission_classes([DeploymentAdmin])
@parser_classes([MultiPartParser, FormParser])
def backup_upload(request):
    """Take a ``.dbk`` made elsewhere into the default local target so it can
    be previewed and restored. The manifest is read on arrival; an archive
    made under another key is refused here rather than at restore time."""
    up = request.FILES.get("file")
    if up is None:
        return Response({"file": ["Choose a .dbk archive."]}, status=400)
    if maintenance.active():
        return Response({"detail": "A restore is in progress."}, status=409)
    target = default_target()
    if target.kind != "local":
        target = BackupTarget.objects.filter(kind="local", enabled=True).first() or target
    tmp = work_dir()
    try:
        path = os.path.join(tmp, "upload.dbk")
        digest = hashlib.sha256()
        with open(path, "wb") as fh:
            for chunk in up.chunks():
                fh.write(chunk)
                digest.update(chunk)
        try:
            manifest = Reader(lambda: open(path, "rb")).read_manifest()
        except KeyMismatch as exc:
            return Response({"file": [str(exc)]}, status=400)
        except ArchiveError as exc:
            return Response({"file": [f"Not a Danbyte backup: {exc}"]}, status=400)
        base = _SAFE_NAME.sub("-", os.path.basename(up.name or "upload.dbk")).strip("-") or "upload.dbk"
        if not base.endswith(".dbk"):
            base += ".dbk"
        backup = Backup.objects.create(
            kind="uploaded", target=target, components=list(manifest.get("components") or []),
            status="success", manifest=manifest, size=os.path.getsize(path),
            checksum=digest.hexdigest(), created_by=request.user,
            started_at=timezone.now(), finished_at=timezone.now(),
        )
        name = f"{base[:-4]}-{str(backup.id)[:8]}.dbk"
        try:
            location = target.backend().put(path, name)
        except (StorageError, OSError) as exc:
            backup.delete()
            return Response({"detail": f"Could not store the archive: {exc}"}, status=502)
        backup.filename = name
        backup.location = location
        backup.steps = [{"name": "upload", "status": "success", "started_at": backup.started_at.isoformat(),
                         "finished_at": backup.finished_at.isoformat(), "detail": f"{backup.size} bytes"}]
        backup.save(update_fields=["filename", "location", "steps", "updated_at"])
        return Response(BackupSerializer(backup).data, status=201)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ─── restore runs ───────────────────────────────────────────────────────────

class RestoreRunViewSet(viewsets.ReadOnlyModelViewSet):
    """Readable while the maintenance flag is up - the restore dialog polls it."""

    queryset = RestoreRun.objects.select_related("backup", "created_by")
    serializer_class = RestoreRunSerializer
    permission_classes = [DeploymentAdmin]
