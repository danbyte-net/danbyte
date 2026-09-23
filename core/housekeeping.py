"""Housekeeping: the files Danbyte leaves on disk, and removing the stale ones.

What an install accumulates that nothing else removes:

* **Code rollback archives** (``danbyte-backups/code-pre-<version>-<time>.tgz``)
  - a bundle upgrade writes one so it can roll back, and none was ever
  deleted. They also used to pack the downloaded bundle and the media folder.
* **Before-upgrade database backups** - already pruned after each upgrade;
  the number kept is now a setting.
* **Stale wheels** in ``vendor/wheels``. A bundle upgrade copied the new
  wheelhouse over the old one, so every release added a full set.
* **The downloaded bundle** (``.upgrade-bundle.tar.gz``), left after a
  successful upgrade.
* **Abandoned work folders** - a backup or restore whose worker was killed
  mid-run leaves its partial archive behind.
* **Rotated log files** in ``DANBYTE_LOG_DIR`` older than the retention.

``run()`` removes what is stale and says what it freed; ``report()`` only
measures, for Settings -> Backups. Both are safe while Danbyte is running:
nothing here is in use by a live process, and nothing runs during an upgrade.
"""
from __future__ import annotations

import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from django.conf import settings

#: A work folder this old belongs to no running job.
STALE_WORK_SECONDS = 24 * 3600
#: The downloaded bundle is kept this long after its upgrade, for a retry.
BUNDLE_KEEP_SECONDS = 3600

_WHEEL = re.compile(r"^(?P<name>[^-]+)-(?P<version>[^-]+)-.*\.whl$")
_ROTATED = re.compile(r"\.log\.\d+(\.gz)?$")


@dataclass
class Item:
    label: str
    count: int = 0
    bytes: int = 0
    paths: list = field(default_factory=list)

    def add(self, path: Path) -> None:
        self.count += 1
        self.bytes += _size(path)
        self.paths.append(path)

    def as_dict(self) -> dict:
        return {"label": self.label, "count": self.count, "bytes": self.bytes}


def _size(path: Path) -> int:
    try:
        if path.is_dir() and not path.is_symlink():
            return sum(
                f.stat().st_size for f in path.rglob("*")
                if f.is_file() and not f.is_symlink()
            )
        return path.stat().st_size
    except OSError:
        return 0


def _remove(path: Path) -> bool:
    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
        return True
    except OSError:
        return False


def _settings():
    from .models import DeploymentSettings

    return DeploymentSettings.load()


def backup_dir() -> Path:
    return Path(str(settings.DANBYTE_BACKUP_DIR))


def log_dir() -> Path | None:
    raw = os.getenv("DANBYTE_LOG_DIR", "").strip()
    return Path(raw) if raw else None


# ─── what is stale ───────────────────────────────────────────────────────────


def stale_rollback_archives(keep: int) -> Item:
    item = Item("Code rollback archives beyond the newest kept")
    archives = sorted(
        backup_dir().glob("code-pre-*.tgz"),
        key=lambda p: p.stat().st_mtime if p.exists() else 0,
        reverse=True,
    )
    for p in archives[keep:]:
        item.add(p)
    return item


def stale_work_folders(now: float) -> Item:
    item = Item("Abandoned backup and restore work folders")
    base = backup_dir()
    candidates = list((base / ".work").glob("backup-*")) + list(base.glob("restore-*"))
    for p in candidates:
        try:
            old = now - p.stat().st_mtime > STALE_WORK_SECONDS
        except OSError:
            continue
        if p.is_dir() and old:
            item.add(p)
    return item


def stale_bundle(now: float) -> Item:
    from .upgrade import BUNDLE_UPLOAD, _upgrade_running

    item = Item("Downloaded upgrade bundle")
    p = Path(BUNDLE_UPLOAD)
    try:
        old = now - p.stat().st_mtime > BUNDLE_KEEP_SECONDS
    except OSError:
        return item
    if old and not _upgrade_running():
        item.add(p)
    return item


def _installed() -> set[tuple[str, str]]:
    from importlib import metadata

    out = set()
    for dist in metadata.distributions():
        name = (dist.metadata.get("Name") or "").strip()
        if name:
            out.add((re.sub(r"[-_.]+", "_", name).lower(), dist.version))
    return out


def stale_wheels() -> Item:
    """Wheels no installed package came from. Only on a bundle install, which
    is the one with a wheelhouse; the next bundle brings its own."""
    item = Item("Wheels from earlier releases")
    wheels = Path(settings.BASE_DIR) / "vendor" / "wheels"
    if not wheels.is_dir():
        return item
    installed = _installed()
    if not installed:
        return item  # cannot tell what is in use; touch nothing
    for p in wheels.glob("*.whl"):
        m = _WHEEL.match(p.name)
        if not m:
            continue
        key = (re.sub(r"[-_.]+", "_", m["name"]).lower(), m["version"])
        if key not in installed:
            item.add(p)
    return item


def stale_logs(days: int, now: float) -> Item:
    item = Item("Rotated log files past the retention")
    d = log_dir()
    if days <= 0 or d is None or not d.is_dir():
        return item
    for p in d.iterdir():
        if not _ROTATED.search(p.name):
            continue
        try:
            old = now - p.stat().st_mtime > days * 86400
        except OSError:
            continue
        if old:
            item.add(p)
    return item


def _pre_upgrade_beyond(keep: int) -> Item:
    from backups.models import Backup

    item = Item("Before-upgrade backups beyond the newest kept")
    rows = list(
        Backup.objects.filter(kind="pre_upgrade", status="success", protected=False)
        .order_by("-finished_at", "-created_at")
    )
    for b in rows[keep:]:
        item.count += 1
        item.bytes += int(b.size or 0)
        item.paths.append(b)
    return item


def _collect(now: float) -> list[Item]:
    cfg = _settings()
    keep = int(cfg.upgrade_backups_keep)
    return [
        _pre_upgrade_beyond(keep),
        stale_rollback_archives(keep),
        stale_wheels(),
        stale_bundle(now),
        stale_work_folders(now),
        stale_logs(int(cfg.log_retention_days), now),
    ]


# ─── the two entry points ────────────────────────────────────────────────────


def report() -> dict:
    """What would be removed, and what the tracked folders hold in total."""
    now = time.time()
    items = _collect(now)
    d = log_dir()
    return {
        "stale": [i.as_dict() for i in items],
        "stale_bytes": sum(i.bytes for i in items),
        "totals": [
            {"label": "Backups folder", "path": str(backup_dir()),
             "bytes": _size(backup_dir())},
            {"label": "Log folder", "path": str(d) if d else "",
             "bytes": _size(d) if d else 0},
            {"label": "Wheelhouse", "path": str(Path(settings.BASE_DIR) / "vendor" / "wheels"),
             "bytes": _size(Path(settings.BASE_DIR) / "vendor" / "wheels")},
            {"label": "Uploaded media", "path": str(settings.MEDIA_ROOT),
             "bytes": _size(Path(str(settings.MEDIA_ROOT)))},
        ],
    }


def run() -> dict:
    """Remove everything stale. Returns what went, per kind."""
    from backups.engine import delete_backup

    now = time.time()
    done = []
    for item in _collect(now):
        removed = freed = 0
        for target in item.paths:
            if isinstance(target, Path):
                size = _size(target)
                if _remove(target):
                    removed += 1
                    freed += size
            else:  # a Backup row: its archive goes with it
                size = int(target.size or 0)
                delete_backup(target)
                removed += 1
                freed += size
        done.append({"label": item.label, "count": removed, "bytes": freed})
    return {"removed": done, "freed_bytes": sum(d["bytes"] for d in done)}
