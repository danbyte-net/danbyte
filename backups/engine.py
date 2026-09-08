"""The backup engine (#27): make an archive, store it, prune old ones.

Runs as an RQ job (``run_backup``) or inline (``manage.py backup_now``, the
upgrade scripts). Each step lands on the :class:`~backups.models.Backup`
row as it finishes so the UI can follow along. Restore lives in
``backups/restore.py``.
"""
from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import tarfile
import tempfile
from datetime import UTC, datetime

from django.conf import settings
from django.db import connection
from django.utils import timezone
from django.utils.text import slugify

from .archive import MANIFEST_NAME, Reader, Writer, sha256_file
from .models import COMPONENTS, Backup, BackupSchedule, BackupTarget

logger = logging.getLogger(__name__)

PG_DUMP_TIMEOUT = 1800
FORMAT = 1


class EngineError(RuntimeError):
    pass


# ─── pieces ─────────────────────────────────────────────────────────────────

def _db_settings() -> dict:
    return settings.DATABASES["default"]


def pg_env() -> dict:
    env = {**os.environ}
    pw = _db_settings().get("PASSWORD") or ""
    if pw:
        env["PGPASSWORD"] = pw
    return env


def pg_args(db: dict) -> list[str]:
    args = []
    if db.get("HOST"):
        args += ["-h", str(db["HOST"])]
    if db.get("PORT"):
        args += ["-p", str(db["PORT"])]
    if db.get("USER"):
        args += ["-U", str(db["USER"])]
    return args


def dump_database(dest: str) -> None:
    """``pg_dump -Fc`` of the configured database into ``dest``. Never a
    shell, never a prompt (``-w``); stderr becomes the error."""
    db = _db_settings()
    if shutil.which("pg_dump") is None:
        raise EngineError("pg_dump is not installed on this host.")
    cmd = ["pg_dump", "-Fc", "-w", "--no-owner", "--no-privileges", *pg_args(db), "-f", dest, db["NAME"]]
    try:
        res = subprocess.run(cmd, env=pg_env(), capture_output=True, text=True, timeout=PG_DUMP_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        raise EngineError(f"pg_dump timed out after {PG_DUMP_TIMEOUT}s") from exc
    if res.returncode != 0 or not os.path.exists(dest) or os.path.getsize(dest) == 0:
        raise EngineError(f"pg_dump failed: {(res.stderr or '').strip()[-500:] or 'empty dump'}")


def media_roots() -> list[tuple[str, str]]:
    """(archive prefix, directory) pairs the media component covers."""
    roots = [("media", str(settings.MEDIA_ROOT))]
    plugin_dir = str(getattr(settings, "PLUGIN_UPLOAD_DIR", ""))
    if plugin_dir:
        roots.append(("plugins_local", plugin_dir))
    return roots


def archive_media(dest: str) -> int:
    """Tar the media tree (and uploaded plugins) into ``dest``; returns the
    file count. Partial uploads (``*.part``) and the backup work dir are
    skipped."""
    count = 0
    with tarfile.open(dest, "w") as tar:
        for prefix, root in media_roots():
            if not os.path.isdir(root):
                continue
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for fn in filenames:
                    if fn.endswith(".part") or fn.startswith("."):
                        continue
                    full = os.path.join(dirpath, fn)
                    arc = os.path.join(prefix, os.path.relpath(full, root))
                    tar.add(full, arcname=arc, recursive=False)
                    count += 1
    return count


_ENV_KEEP_PREFIXES = ("ALLOWED_HOSTS", "DANBYTE_HTTPS", "CORS_", "CSRF_", "MONITORING_", "RQ_REDIS_DB",
                      "DANBYTE_LOG_DIR", "DANBYTE_PLUGIN_DIR", "DANBYTE_BACKUP_DIR", "PLUGINS", "DEBUG",
                      "EMAIL_HOST", "EMAIL_PORT", "EMAIL_USE_TLS", "EMAIL_HOST_USER", "DEFAULT_FROM_EMAIL")
_ENV_NEVER = ("MONITORING_SECRET_KEY", "MONITORING_SECRETS_BACKEND", "EMAIL_HOST_PASSWORD")


def config_snapshot() -> dict:
    """The non-secret deployment configuration. Secrets never enter it -
    the same classifier the audit log uses guards the settings row, and the
    env allow-list is explicit."""
    from core.deployment import DeploymentSettingsSerializer
    from core.models import DeploymentSettings

    ds = DeploymentSettings.load()
    data = dict(DeploymentSettingsSerializer(ds).data)
    for key in list(data):
        if key.endswith("_url") or key.endswith("_set"):
            data.pop(key)
    env = {
        k: v for k, v in os.environ.items()
        if k not in _ENV_NEVER and k.startswith(_ENV_KEEP_PREFIXES)
    }
    plugins = None
    manifest = os.path.join(str(getattr(settings, "PLUGIN_UPLOAD_DIR", "")), "installed.json")
    if os.path.isfile(manifest):
        with open(manifest) as fh:
            plugins = fh.read()
    return {"deployment_settings": data, "env": env, "plugins_installed": plugins,
            "worker_count": getattr(ds, "rq_workers", None)}


def object_counts() -> dict[str, int]:
    from auth_api.object_types import _registry

    out = {}
    for slug, entry in _registry().items():
        try:
            out[slug] = entry["model"]._default_manager.count()
        except Exception:  # noqa: BLE001 - a plugin model without a table
            continue
    return out


def applied_migrations() -> list[str]:
    from django.db.migrations.recorder import MigrationRecorder

    return sorted(f"{a}.{n}" for a, n in MigrationRecorder(connection).applied_migrations())


def _server_version() -> str:
    try:
        with connection.cursor() as c:
            c.execute("SHOW server_version")
            return c.fetchone()[0]
    except Exception:  # noqa: BLE001
        return ""


def build_manifest(kind: str, components: list[str], files: dict, media_files: int) -> dict:
    from core.models import DeploymentSettings
    from core.version import system_version

    return {
        "format": FORMAT,
        "kind": kind,
        "created_at": datetime.now(UTC).isoformat(),
        "deployment_name": DeploymentSettings.load().deployment_name or "Danbyte",
        "hostname": socket.gethostname(),
        **system_version(),
        "db_server_version": _server_version(),
        "applied_migrations": applied_migrations(),
        "components": list(components),
        "files": files,
        "media_files": media_files,
        "counts": object_counts(),
    }


def archive_name(kind: str, backup_id, when: datetime | None = None) -> str:
    """``danbyte-<deployment>-<UTC stamp>-<kind>-<id8>.dbk`` - the id tail
    keeps two backups made in the same second apart."""
    from core.models import DeploymentSettings

    when = when or datetime.now(UTC)
    dep = slugify(DeploymentSettings.load().deployment_name or "danbyte") or "danbyte"
    return f"danbyte-{dep}-{when:%Y%m%d-%H%M%S}-{kind.replace('_', '-')}-{str(backup_id)[:8]}.dbk"


def work_dir() -> str:
    base = os.path.join(str(settings.DANBYTE_BACKUP_DIR), ".work")
    os.makedirs(base, mode=0o700, exist_ok=True)
    return tempfile.mkdtemp(prefix="backup-", dir=base)


# ─── the run ────────────────────────────────────────────────────────────────

def create_backup(*, kind: str, components, target: BackupTarget | None = None,
                  schedule: BackupSchedule | None = None, user=None) -> Backup:
    from .seeds import default_target

    comps = [c for c in COMPONENTS if c in set(components or COMPONENTS)]
    if not comps:
        raise EngineError("Pick at least one component.")
    return Backup.objects.create(
        kind=kind, components=comps, target=target or default_target(), schedule=schedule,
        created_by=user, status="queued",
    )


def enqueue_backup(backup: Backup) -> None:
    from api.devicetype_import_tasks import _enqueue

    _enqueue(run_backup, backup, "backup")


def run_backup(backup_id: str) -> Backup | None:
    """Execute one backup. Never raises into the worker; the row carries
    the outcome."""
    backup = Backup.objects.select_related("target", "schedule").filter(pk=backup_id).first()
    if backup is None:
        logger.warning("backup %s not found in this database", backup_id)
        return None
    backup.status = "running"
    backup.started_at = timezone.now()
    backup.steps = []
    backup.save(update_fields=["status", "started_at", "steps", "updated_at"])
    tmp = work_dir()
    try:
        files: dict[str, dict] = {}
        media_files = 0
        parts: list[tuple[str, str]] = []
        if "db" in backup.components:
            backup.step_start("database")
            dump = os.path.join(tmp, "db.dump")
            dump_database(dump)
            files["db.dump"] = {"size": os.path.getsize(dump), "sha256": sha256_file(dump)}
            parts.append(("db.dump", dump))
            backup.step_end(detail=f"{files['db.dump']['size']} bytes")
        if "media" in backup.components:
            backup.step_start("media")
            mtar = os.path.join(tmp, "media.tar")
            media_files = archive_media(mtar)
            files["media.tar"] = {"size": os.path.getsize(mtar), "sha256": sha256_file(mtar)}
            parts.append(("media.tar", mtar))
            backup.step_end(detail=f"{media_files} files")
        if "config" in backup.components:
            backup.step_start("config")
            cfg = os.path.join(tmp, "config.json")
            import json

            with open(cfg, "w") as fh:
                json.dump(config_snapshot(), fh, indent=1, default=str)
            files["config.json"] = {"size": os.path.getsize(cfg), "sha256": sha256_file(cfg)}
            parts.append(("config.json", cfg))
            backup.step_end()

        backup.step_start("archive")
        manifest = build_manifest(backup.kind, backup.components, files, media_files)
        name = archive_name(backup.kind, backup.id)
        archive = os.path.join(tmp, name)
        with Writer(archive) as w:
            w.add_json(MANIFEST_NAME, manifest)
            for member, path in parts:
                w.add_file(member, path)
        size = os.path.getsize(archive)
        backup.step_end(detail=f"{size} bytes")

        backup.step_start("upload")
        backend = backup.target.backend()
        location = backend.put(archive, name)
        backup.step_end(detail=location)

        backup.step_start("verify")
        check = Reader(lambda: backend.open(name)).read_manifest()
        if check.get("created_at") != manifest["created_at"] or backend.size(name) != size:
            raise EngineError("the stored archive does not read back as written")
        backup.step_end()

        backup.filename = name
        backup.location = location
        backup.size = size
        backup.checksum = sha256_file(archive)
        backup.manifest = manifest
        backup.status = "success"
        backup.finished_at = timezone.now()
        backup.save()
        if backup.schedule_id:
            BackupSchedule.objects.filter(pk=backup.schedule_id).update(last_backup=backup)
            backup.step_start("retention")
            removed = prune_schedule(backup.schedule)
            backup.step_end(detail=f"{removed} removed")
    except Exception as exc:  # noqa: BLE001 - land it on the row
        logger.exception("backup %s failed", backup_id)
        backup.step_end("failed", str(exc))
        backup.status = "failed"
        backup.error = str(exc)[:2000]
        backup.finished_at = timezone.now()
        backup.save()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    try:
        from .notify import notify_backup

        notify_backup(backup)
    except Exception:  # noqa: BLE001 - notification must never fail a backup
        logger.exception("backup notification failed")
    return backup


def prune_schedule(schedule: BackupSchedule, now=None) -> int:
    """Apply the schedule's retention to its own successful, unprotected
    backups. Returns how many were removed."""
    from core.cadence import Retention

    rule = Retention.from_dict(schedule.retention or {})
    if rule.max_count is None and rule.max_age_days is None:
        return 0
    rows = list(Backup.objects.filter(schedule=schedule, status="success", protected=False)
                .select_related("target"))
    gone = rule.expired(rows, when=lambda b: b.finished_at or b.created_at, now=now or timezone.now())
    for b in gone:
        delete_backup(b)
    return len(gone)


def delete_backup(backup: Backup) -> None:
    if backup.status in ("queued", "running"):
        raise EngineError("A backup that is still running cannot be deleted.")
    if backup.filename:
        try:
            backup.target.backend().delete(backup.filename)
        except Exception:  # noqa: BLE001 - the row goes even if the file is already gone
            logger.warning("could not delete archive %s on %s", backup.filename, backup.target)
    backup.delete()
