"""Restore (#27): preview an archive, then replace the database, media and
uploaded plugins in place while the site sits behind the maintenance flag.

Runs inside the RQ worker on every platform. Nothing is restarted: Django
holds no schema state between requests, the worker closes its own
connection before the schema is replaced, and every other session is
terminated so the drop can proceed. A safety backup of the current state
is always taken first.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tarfile
import tempfile

from django.conf import settings
from django.core.management import call_command
from django.db import connection, connections
from django.utils import timezone

from core.upgrade import _acquire_upgrade_lock, _release_upgrade_lock, _upgrade_running

from . import maintenance
from .archive import ArchiveError, KeyMismatch, Reader
from .engine import (
    COMPONENTS,
    adopt_orphans,
    create_backup,
    media_roots,
    pg_args,
    pg_env,
    run_backup,
    work_dir,
)
from .models import Backup, BackupSchedule, BackupTarget, RestoreRun

logger = logging.getLogger(__name__)

PG_RESTORE_TIMEOUT = 3600


class RestoreError(RuntimeError):
    pass


# ─── preview ────────────────────────────────────────────────────────────────

def _reader(backup: Backup) -> Reader:
    backend = backup.target.backend()
    return Reader(lambda: backend.open(backup.filename))


def _known_migrations() -> set[str]:
    from django.db.migrations.loader import MigrationLoader

    loader = MigrationLoader(connection, ignore_no_migrations=True)
    known = {f"{a}.{n}" for a, n in loader.disk_migrations}
    for replaced in loader.replacements.values():
        known.update(f"{a}.{n}" for a, n in replaced.replaces)
    return known


def _db_ownership() -> tuple[bool, str]:
    """Can this role drop and recreate the public schema?"""
    try:
        with connection.cursor() as c:
            c.execute("SELECT current_user, pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")
            me, owner = c.fetchone()
            c.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
            superuser = bool(c.fetchone()[0])
            c.execute("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'")
            row = c.fetchone()
            schema_owner = row[0] if row else ""
    except Exception as exc:  # noqa: BLE001
        return False, f"could not read ownership: {exc}"
    if superuser or owner == me:
        return True, f"{me} owns the database"
    if schema_owner == me:
        return True, f"{me} owns the public schema"
    return False, f"{me} owns neither the database ({owner}) nor the public schema ({schema_owner})"


def preview(backup: Backup, *, holding_lock: bool = False) -> dict:
    """What a restore of ``backup`` would do, and whether it may proceed."""
    checks: list[dict] = []

    def check(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    manifest = backup.manifest or {}
    key_ok = True
    try:
        manifest = _reader(backup).read_manifest()
        check("key", True, "the archive opens with this host's key")
    except KeyMismatch as exc:
        key_ok = False
        check("key", False, str(exc))
    except ArchiveError as exc:
        key_ok = False
        check("archive", False, str(exc))
    except Exception as exc:  # noqa: BLE001 - storage unreachable
        key_ok = False
        check("archive", False, f"could not read the archive: {exc}")

    comps = list(manifest.get("components") or backup.components or [])
    check("components", bool(comps), ", ".join(comps) or "nothing to restore")

    applied = set(manifest.get("applied_migrations") or [])
    unknown = sorted(applied - _known_migrations()) if applied else []
    check("migrations", not unknown,
          "every migration in the archive is known to this version"
          if not unknown else f"the archive is from a newer Danbyte: {len(unknown)} unknown migration(s), e.g. {unknown[0]}")

    ok, why = _db_ownership()
    check("database", ok, why)

    need = sum(int(f.get("size") or 0) for f in (manifest.get("files") or {}).values()) * 2 + (backup.size or 0)
    probe = str(settings.DANBYTE_BACKUP_DIR)
    while probe and not os.path.isdir(probe):  # the dir is made on first backup; measure its parent
        probe = os.path.dirname(probe.rstrip(os.sep))
    free = shutil.disk_usage(probe or os.sep).free
    check("disk", free >= need, f"{free // 2**20} MB free, about {need // 2**20} MB needed")

    check("upgrade", holding_lock or not _upgrade_running(), "no upgrade is running")

    return {
        "backup": str(backup.id),
        "manifest": manifest,
        "components": comps,
        "checks": checks,
        "can_restore": key_ok and all(c["ok"] for c in checks),
        "counts": manifest.get("counts") or {},
        "media_files": manifest.get("media_files"),
    }


# ─── the run ────────────────────────────────────────────────────────────────

def create_restore(backup: Backup, components, *, user=None) -> RestoreRun:
    comps = [c for c in COMPONENTS if c in set(components or backup.components)]
    if not comps:
        raise RestoreError("Pick at least one component.")
    missing = [c for c in comps if c not in (backup.manifest.get("components") or backup.components)]
    if missing:
        raise RestoreError(f"The archive has no {', '.join(missing)} component.")
    return RestoreRun.objects.create(backup=backup, components=comps, created_by=user)


def enqueue_restore(run: RestoreRun) -> None:
    from api.devicetype_import_tasks import _enqueue

    _enqueue(run_restore, run, "restore")


def terminate_other_sessions() -> int:
    with connection.cursor() as c:
        c.execute(
            "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid()"
        )
        return int(c.fetchone()[0])


def replace_schema() -> None:
    with connection.cursor() as c:
        c.execute("DROP SCHEMA public CASCADE")
        c.execute("CREATE SCHEMA public")


def pg_restore(dump: str) -> None:
    db = settings.DATABASES["default"]
    if shutil.which("pg_restore") is None:
        raise RestoreError("pg_restore is not installed on this host.")
    cmd = ["pg_restore", "-w", "--no-owner", "--no-privileges", "--exit-on-error",
           *pg_args(db), "-d", db["NAME"], dump]
    try:
        res = subprocess.run(cmd, env=pg_env(), capture_output=True, text=True, timeout=PG_RESTORE_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        raise RestoreError(f"pg_restore timed out after {PG_RESTORE_TIMEOUT}s") from exc
    if res.returncode != 0:
        raise RestoreError(f"pg_restore failed: {(res.stderr or '').strip()[-800:]}")


def replace_database(dump: str) -> None:
    """Drop and recreate the public schema, then load the dump - with the
    worker's own connection closed first and every other session ended."""
    for conn in connections.all():
        conn.close()
    terminate_other_sessions()
    replace_schema()
    for conn in connections.all():
        conn.close()
    pg_restore(dump)
    for conn in connections.all():
        conn.close()
    from django.contrib.contenttypes.models import ContentType

    ContentType.objects.clear_cache()


def swap_tree(new_dir: str, live_dir: str, keep_as: str) -> None:
    """Move ``new_dir`` into place at ``live_dir``, keeping the previous tree
    at ``keep_as`` until the caller decides."""
    if os.path.isdir(live_dir):
        os.replace(live_dir, keep_as)
    os.makedirs(os.path.dirname(live_dir) or "/", exist_ok=True)
    os.replace(new_dir, live_dir)


def restore_media(media_tar: str, run_id: str) -> list[tuple[str, str]]:
    """Extract the media tar next to the live trees and swap them in.
    Returns the (kept old tree, live) pairs to delete on success."""
    staging = tempfile.mkdtemp(prefix=f"restore-{run_id[:8]}-", dir=str(settings.DANBYTE_BACKUP_DIR))
    with tarfile.open(media_tar) as tar:
        tar.extractall(staging, filter="data")
    kept = []
    for prefix, live in media_roots():
        src = os.path.join(staging, prefix)
        if not os.path.isdir(src):
            os.makedirs(src, exist_ok=True)  # the archive had none: restore an empty tree
        keep_as = f"{live.rstrip('/')}.pre-restore-{run_id[:8]}"
        swap_tree(src, live, keep_as)
        kept.append((keep_as, live))
    shutil.rmtree(staging, ignore_errors=True)
    return kept


def flush_queues() -> None:
    """Jobs enqueued against the old data mean nothing now."""
    try:
        import django_rq

        for name in getattr(settings, "RQ_QUEUES", {}):
            django_rq.get_queue(name).empty()
    except Exception:  # noqa: BLE001 - Redis down: nothing to flush
        logger.warning("could not flush RQ queues after restore", exc_info=True)


def _row(obj) -> dict:
    return {f.attname: getattr(obj, f.attname) for f in obj._meta.concrete_fields}


def _reinstate(snapshot: dict) -> None:
    """The restored database predates this restore, so the rows that
    describe it - the target, the archive, the safety backup and the run -
    are written back. Users and schedules that no longer exist are unset."""
    from django.contrib.auth import get_user_model

    users = set(get_user_model().objects.values_list("pk", flat=True))
    schedules = set(BackupSchedule.objects.values_list("pk", flat=True))

    def put(model, row: dict | None) -> None:
        if not row:
            return
        row = dict(row)
        pk = row.pop("id")
        if "created_by_id" in row and row["created_by_id"] not in users:
            row["created_by_id"] = None
        if "schedule_id" in row and row["schedule_id"] not in schedules:
            row["schedule_id"] = None
        created_at = row.get("created_at")
        model.objects.update_or_create(pk=pk, defaults=row)
        if created_at:
            model.objects.filter(pk=pk).update(created_at=created_at)

    put(BackupTarget, snapshot.get("target"))
    put(Backup, snapshot.get("backup"))
    put(Backup, snapshot.get("safety"))
    put(RestoreRun, snapshot.get("run"))


def run_restore(restore_id: str) -> RestoreRun | None:
    run = RestoreRun.objects.select_related("backup__target").filter(pk=restore_id).first()
    if run is None:
        logger.warning("restore %s not found in this database", restore_id)
        return None
    backup = run.backup
    run.status = "running"
    run.started_at = timezone.now()
    run.steps = []
    run.save(update_fields=["status", "started_at", "steps", "updated_at"])

    owner = _acquire_upgrade_lock()
    if owner is None:
        run.status = "failed"
        run.error = "An upgrade or another restore is running."
        run.finished_at = timezone.now()
        run.save()
        return run

    tmp = work_dir()
    kept_trees: list[tuple[str, str]] = []
    in_maintenance = False
    try:
        run.step_start("preview")
        pv = preview(backup, holding_lock=True)
        if not pv["can_restore"]:
            failed = [c["detail"] for c in pv["checks"] if not c["ok"]]
            raise RestoreError("; ".join(failed) or "the archive cannot be restored")
        run.step_end()

        run.step_start("safety-backup")
        safety = create_backup(kind="pre_restore", components=run.components,
                               target=backup.target, user=run.created_by)
        safety = run_backup(str(safety.id))
        if safety is None or safety.status != "success":
            raise RestoreError(f"safety backup failed: {safety.error if safety else 'no row'}")
        Backup.objects.filter(pk=safety.pk).update(protected=True)
        safety.protected = True
        run.safety_backup = safety
        run.save(update_fields=["safety_backup", "updated_at"])
        run.step_end(detail=safety.filename)

        run.step_start("download")
        reader = _reader(backup)
        paths = {}
        for comp, member in (("db", "db.dump"), ("media", "media.tar"), ("config", "config.json")):
            if comp in run.components:
                dest = os.path.join(tmp, member)
                reader.extract(member, dest)
                paths[comp] = dest
        run.step_end(detail=", ".join(paths))

        maintenance.enter("restore in progress", str(run.id))
        in_maintenance = True

        if "db" in run.components:
            run.step_start("database")
            snapshot = {"target": _row(backup.target), "backup": _row(backup),
                        "safety": _row(safety), "run": _row(run)}
            replace_database(paths["db"])
            call_command("migrate", interactive=False, verbosity=0)
            _reinstate(snapshot)
            run.step_end(detail="restored and migrated")

            run.step_start("reconcile")
            adopted = adopt_orphans(backup.target)
            run.step_end(detail=f"{adopted} archive(s) adopted")

        if "media" in run.components:
            run.step_start("media")
            kept_trees = restore_media(paths["media"], str(run.id))
            run.step_end(detail=f"{len(kept_trees)} tree(s)")

        if "config" in run.components:
            run.step_start("config")
            # The settings row came back with the database; the env file is
            # the operator's. Nothing to write - recorded for the log.
            run.step_end(detail="deployment settings restored with the database")

        run.step_start("finish")
        if "db" in run.components:
            try:
                call_command("rebuild_search_index", verbosity=0)
            except Exception:  # noqa: BLE001 - the nightly rebuild catches up
                logger.warning("search reindex after restore failed", exc_info=True)
        flush_queues()
        for keep_as, _live in kept_trees:
            shutil.rmtree(keep_as, ignore_errors=True)
        kept_trees = []
        run.step_end()

        run.status = "success"
        run.finished_at = timezone.now()
        run.save()
        run.mirror()
    except Exception as exc:  # noqa: BLE001 - land it on the row
        logger.exception("restore %s failed", restore_id)
        try:
            run.step_end("failed", str(exc))
        except Exception:  # noqa: BLE001 - the row itself may be gone mid-restore
            pass
        run.status = "failed"
        run.error = str(exc)[:2000]
        run.finished_at = timezone.now()
        try:
            run.save()
        except Exception:  # noqa: BLE001
            logger.exception("could not record restore failure")
        run.mirror()
    finally:
        if in_maintenance:
            maintenance.leave()
        _release_upgrade_lock(owner)
        shutil.rmtree(tmp, ignore_errors=True)
    try:
        from .notify import notify_restore

        notify_restore(run)
    except Exception:  # noqa: BLE001
        logger.exception("restore notification failed")
    return run
