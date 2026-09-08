"""Operator steps a release needs after the upgrade itself.

Some changes cannot ride a migration: an nginx location, a new volume, a
system package. Each such step is an :class:`UpgradeNote` here, shipped
with the code on every path (git, bundle, image). After an upgrade the
notes for the running version are *pending* until a deployment admin marks
them done; ``DeploymentSettings.upgrade_notes_done`` holds the ids. A
fresh install seeds that list with everything up to its own version, so it
never sees steps for what it started on.

Add a note in the same change as the feature that needs it.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .version import deployment_method, is_newer, system_version

PLATFORMS = ("systemd", "docker")


@dataclass(frozen=True)
class UpgradeNote:
    id: str
    version: str
    title: str
    body: str
    snippet: str = ""
    docs: str = ""
    platforms: tuple[str, ...] = PLATFORMS
    # Returns True when the step is already done; such a note is never shown.
    check: Callable[[], bool] | None = None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "body": self.body,
            "snippet": self.snippet,
            "docs": self.docs,
            "platforms": list(self.platforms),
        }


_NGINX_BACKUPS = """\
location ^~ /api/backups/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 8g;
}
# then: sudo nginx -t && sudo systemctl reload nginx"""

# Newest first.
NOTES: tuple[UpgradeNote, ...] = (
    UpgradeNote(
        id="0.16.0-nginx-backups",
        version="0.16.0",
        title="Add the backup upload location to nginx",
        body=(
            "Backup archives stream through /api/backups/ and can be several "
            "gigabytes. The installer's nginx templates carry the location; a "
            "hand-managed config does not, and uploads over the default body "
            "limit fail. Add this block before the existing /api/ location."
        ),
        snippet=_NGINX_BACKUPS,
        docs="getting-started/backup-restore/#reverse-proxy",
        platforms=("systemd",),
    ),
)


def _done(note: UpgradeNote) -> bool:
    if note.check is None:
        return False
    try:
        return bool(note.check())
    except Exception:  # noqa: BLE001 - a broken check must not hide the note
        return False


def applicable(version: str | None = None, platform: str | None = None) -> list[UpgradeNote]:
    """Notes that apply to this install: not newer than the running
    version, for this platform, and not already satisfied."""
    version = version or system_version()["version"]
    platform = platform or deployment_method()
    return [
        n for n in NOTES
        if not is_newer(n.version, version) and platform in n.platforms and not _done(n)
    ]


def ids_up_to(version: str) -> list[str]:
    """Every note id a fresh install at ``version`` starts with as done."""
    return [n.id for n in NOTES if not is_newer(n.version, version)]


def pending(dep, version: str | None = None, platform: str | None = None) -> list[UpgradeNote]:
    done = set(dep.upgrade_notes_done or [])
    return [n for n in applicable(version, platform) if n.id not in done]


def acknowledge(dep, ids: list[str] | None = None) -> list[str]:
    """Mark notes done; ``None`` means every pending one. Unknown ids are
    ignored. Returns the ids that were added."""
    known = {n.id for n in NOTES}
    wanted = [n.id for n in pending(dep)] if ids is None else [i for i in ids if i in known]
    current = list(dep.upgrade_notes_done or [])
    added = [i for i in wanted if i not in current]
    if added:
        dep.upgrade_notes_done = current + added
        dep.save(update_fields=["upgrade_notes_done", "updated_at"])
    return added


def payload(dep) -> dict:
    return {
        "version": system_version()["version"],
        "deployment": deployment_method(),
        "pending": [n.as_dict() for n in pending(dep)],
        "done": list(dep.upgrade_notes_done or []),
    }
