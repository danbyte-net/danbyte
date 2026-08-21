"""Runtime version info for the About / Updates page."""
from __future__ import annotations

import subprocess
from functools import lru_cache

from django.conf import settings

from danbyte import __version__

# The official / default Danbyte release repo. Overridable in Deployment settings.
DEFAULT_RELEASE_REPO = "https://github.com/danbyte-net/danbyte"


def deployment_method() -> str:
    """How this install runs, which decides whether it can upgrade itself.

    * ``"docker"`` - a container. The upgrade machinery drives ``systemd-run``
      + ``docker compose`` from the *host*, and a process inside a container
      can neither rebuild its own image nor recreate the container it runs in.
      So in-app upgrade is refused here; the host runs ``docker compose build``.
    * ``"systemd"`` - a bare-metal/systemd install, where the web process can
      hand the upgrade to a transient user unit that outlives the restart.

    Detection prefers an explicit build-time marker (``DANBYTE_DEPLOYMENT``),
    then the container runtime's own tell-tales, so it is right even when the
    marker is missing on an older image.
    """
    import os

    declared = (os.environ.get("DANBYTE_DEPLOYMENT") or "").strip().lower()
    if declared in ("docker", "container", "compose"):
        return "docker"
    if declared in ("systemd", "bare", "baremetal", "host"):
        return "systemd"
    # No marker: fall back to runtime tell-tales. Docker writes /.dockerenv;
    # Podman writes /run/.containerenv.
    if os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv"):
        return "docker"
    return "systemd"


def self_upgrade_supported() -> bool:
    """Whether the in-app upgrade can actually complete in this environment.

    False in a container: see :func:`deployment_method`. The Updates page reads
    this to disable the button and show the compose commands instead, and the
    upgrade endpoints refuse rather than half-apply an upgrade.
    """
    return deployment_method() != "docker"


def _git(*args) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(settings.BASE_DIR), *args],
            capture_output=True, text=True, timeout=3, check=True,
        )
        return out.stdout.strip()
    except Exception:  # noqa: BLE001 - best-effort, never fatal
        return ""


@lru_cache(maxsize=1)
def git_commit() -> str:
    """Short commit of the running checkout, or "" if not a git install."""
    return _git("rev-parse", "--short", "HEAD")


def system_version() -> dict:
    """The running version. Prefers the git tag (`v0.2.1` → `0.2.1`) so it's
    always accurate on a deployed checkout, falling back to the packaged
    ``__version__`` when git isn't available."""
    # Only real release tags (vX.Y.Z), so a stray tag on a dev branch is ignored.
    tag = _git("describe", "--tags", "--match", "v[0-9]*")
    version = tag.lstrip("vV").split("-")[0] if tag else __version__
    return {"version": version, "commit": git_commit(), "tag": tag}


def _postgres_version() -> str:
    """PostgreSQL server version (e.g. "16.2"), or "" if unavailable."""
    try:
        from django.db import connection

        with connection.cursor() as cur:
            cur.execute("SHOW server_version")
            return ((cur.fetchone() or [""])[0] or "").split()[0]
    except Exception:  # noqa: BLE001 - best-effort, never fatal
        return ""


def _redis_version() -> str:
    """Redis server version behind the RQ/cache connection, or "" if down."""
    try:
        import django_rq

        conn = django_rq.get_connection("default")
        return str(conn.info("server").get("redis_version", "") or "")
    except Exception:  # noqa: BLE001 - best-effort, never fatal
        return ""


_drift_logged = False
_drift_cache: tuple[float, list] | None = None


def migration_drift() -> list[str]:
    """Applied migrations the RUNNING CODE has never heard of - the signature
    of a database upgraded past the processes executing against it (a
    half-finished upgrade that migrated but never restarted the app).

    Cheap: the loader knows the code's migrations, the recorder knows the
    applied ones. Squashed history is respected (originals replaced by a
    squash the code ships still count as known), and apps that are no longer
    installed are ignored rather than flagged.
    """
    global _drift_logged, _drift_cache
    import time

    # Health probes hit this every few seconds; the answer only changes on a
    # deploy or a migrate, so one loader build per minute is plenty.
    if _drift_cache is not None and time.monotonic() - _drift_cache[0] < 60:
        return _drift_cache[1]
    try:
        from django.db import connection
        from django.db.migrations.loader import MigrationLoader
        from django.db.migrations.recorder import MigrationRecorder

        loader = MigrationLoader(connection, ignore_no_migrations=True)
        known = set(loader.disk_migrations)
        for replacement, migration in (loader.replacements or {}).items():
            known.update(migration.replaces)
            known.add(replacement)
        known_apps = {app for app, _ in known}
        applied = MigrationRecorder(connection).applied_migrations()
        drift = sorted(
            f"{app}.{name}"
            for app, name in applied
            if app in known_apps and (app, name) not in known
        )
    except Exception:  # noqa: BLE001 - a probe must never take the app down
        return []
    _drift_cache = (time.monotonic(), drift)
    if drift and not _drift_logged:
        _drift_logged = True
        import logging

        logging.getLogger("core.version").error(
            "Running code is BEHIND the database: %d applied migration(s) "
            "this code does not ship (%s). Finish the upgrade and restart "
            "every app process (web + workers).",
            len(drift), ", ".join(drift[:5]),
        )
    return drift


def system_info() -> dict:
    """Local, network-free runtime facts for the Updates/About page.

    Never contacts the release repo, so it renders **instantly** - even on an
    airgapped or offline install where the release check times out. Pairs the
    running version with the component versions operators ask for when
    diagnosing (Python, Django, PostgreSQL, Redis)."""
    import platform

    import django

    return {
        **system_version(),  # version, commit, tag
        "git_install": bool(git_commit()),
        "python": platform.python_version(),
        "django": django.get_version(),
        "postgres": _postgres_version(),
        "redis": _redis_version(),
        "platform": platform.platform(terse=True),
        "deployment": deployment_method(),
        "self_upgrade_supported": self_upgrade_supported(),
        # Non-empty = the database is ahead of this process's code (issue
        # #45); the Updates page turns it into a loud banner.
        "migration_drift": migration_drift(),
    }


def _norm(tag: str) -> tuple:
    """A comparable tuple for `vX.Y.Z` / `X.Y.Z` (non-numeric parts ignored)."""
    parts = (tag or "").lstrip("vV").split("-")[0].split(".")
    nums = []
    for p in parts:
        try:
            nums.append(int(p))
        except ValueError:
            break
    return tuple(nums)


def is_newer(candidate: str, current: str) -> bool:
    """Is release ``candidate`` newer than ``current`` (semver-ish)?"""
    c, cur = _norm(candidate), _norm(current)
    return bool(c) and c > cur
