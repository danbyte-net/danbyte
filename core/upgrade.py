"""In-app upgrade — launch the detached upgrader and report its progress.

The web process can't update itself and restart itself, so the button launches
``scripts/danbyte-upgrade.sh`` as a **transient systemd user unit**
(``systemd-run --user``) that outlives the restart. It writes progress to a JSON
file the UI polls (tolerating the brief window where the backend is down).
"""
from __future__ import annotations

import fcntl
import json
import os
import secrets
import subprocess
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from django.conf import settings
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .deployment import _require_manage

STATUS_FILE = settings.BASE_DIR / ".upgrade-status.json"
UPGRADE_SCRIPT = settings.BASE_DIR / "scripts" / "danbyte-upgrade.sh"
BUNDLE_SCRIPT = settings.BASE_DIR / "scripts" / "danbyte-upgrade-bundle.sh"
BUNDLE_UPLOAD = settings.BASE_DIR / ".upgrade-bundle.tar.gz"
LOCK_FILE = settings.BASE_DIR / ".upgrade.lock"
LOCK_GUARD_FILE = settings.BASE_DIR / ".upgrade.lock.guard"

# A just-launched unit can take a moment to become visible to systemd. Likewise,
# a worker can die between creating the lock and recording the launch details.
# These windows prevent an immediate takeover without leaving a dead lock
# indefinitely. Live preparing and detached processes are tracked by PID.
LOCK_PREPARE_GRACE_SECONDS = 300
LOCK_LAUNCH_GRACE_SECONDS = 120
# v0.8.3 scripts published ``failed`` before rollback/restart completed. When
# reconciling those legacy status files without a trustworthy process identity,
# keep the slot closed long enough for rollback to finish (or for an operator to
# remove the stale marker deliberately).
LEGACY_FAILED_GRACE_SECONDS = 6 * 60 * 60


class UpgradeLaunchUncertain(RuntimeError):
    """The launcher may have created an external process.

    Callers must retain the upgrade lock for this exception. Releasing it could
    permit a second upgrade to start alongside the first.
    """


@contextmanager
def _upgrade_lock_guard() -> Iterator[None]:
    """Serialize lock-file read/compare/replace operations across web workers."""
    fd = os.open(str(LOCK_GUARD_FILE), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _process_identity(pid: int) -> tuple[str | None, str | None]:
    """Return Linux process state and start time, which protects against PID reuse."""
    try:
        tail = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return tail[0], tail[19]
    except (OSError, IndexError):
        return None, None


def _pid_matches(pid: object, started: object = None) -> bool | None:
    """Return whether a PID is the recorded process, or ``None`` if unknown.

    A live PID without a verifiable Linux start time is not a positive match,
    but it also must not be treated as proof that the upgrader is gone.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    state, actual_start = _process_identity(pid)
    if state == "Z":
        return False
    if state is not None:
        if not started or not actual_start:
            return None
        return str(started) == actual_start
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return None
    else:
        # The process exists, but /proc did not provide enough identity data to
        # rule out PID reuse. Keep the caller fail-closed.
        return None


def _lock_identity(path: Path | None = None) -> tuple[int, int, int] | None:
    path = path or LOCK_FILE
    try:
        st = path.stat()
        return st.st_ino, st.st_mtime_ns, st.st_size
    except OSError:
        return None


def _read_lock_unlocked() -> dict | None:
    identity = _lock_identity()
    if identity is None:
        return None
    try:
        lock = json.loads(LOCK_FILE.read_text())
        if not isinstance(lock, dict):
            raise ValueError
    except (OSError, ValueError):
        # Upgrade cleanly from the zero-byte lock used by v0.8.3.
        lock = {"phase": "legacy", "acquired_at": identity[1] / 1_000_000_000}
    lock["_identity"] = identity
    return lock


def _write_lock_unlocked(lock: dict, *, create: bool = False) -> None:
    data = json.dumps({k: v for k, v in lock.items() if not k.startswith("_")})
    if create:
        fd = os.open(str(LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, data.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        return
    tmp = LOCK_FILE.with_name(f"{LOCK_FILE.name}.{lock['owner']}.tmp")
    try:
        fd = os.open(str(tmp), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        try:
            os.write(fd, data.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, LOCK_FILE)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _systemd_unit_active() -> bool | None:
    """Return None when systemd state cannot be determined safely."""
    try:
        result = subprocess.run(
            ["systemctl", "--user", "is-active", "danbyte-upgrade.service"],
            capture_output=True,
            text=True,
            timeout=5,
            env=_systemd_env(),
        )
    except Exception:  # noqa: BLE001
        return None
    state = result.stdout.strip().lower()
    error = result.stderr.strip().lower()
    if state in {
        "active",
        "activating",
        "deactivating",
        "maintenance",
        "refreshing",
        "reloading",
    }:
        return True
    if state in {"inactive", "failed", "unknown"}:
        return False
    if "not found" in error or "could not be found" in error or "unknown unit" in error:
        return False
    return None


def _status_age() -> float | None:
    try:
        return max(0, time.time() - STATUS_FILE.stat().st_mtime)
    except OSError:
        return None


def _legacy_upgrade_running(acquired_at: float = 0) -> bool:
    """Reconcile a v0.8.3 lock, or status/systemd state with no lock.

    A legacy ``running`` status may belong to the detached fallback, so an
    inactive systemd unit cannot disprove it. Legacy ``failed`` may have been
    written before rollback and is held for a conservative transition window.
    """
    st = _read_status()
    state = st.get("state")
    active = _systemd_unit_active()
    if active is True:
        return True
    if state == "running":
        # This could be a detached legacy process. Only a terminal status or
        # explicit operator cleanup can prove it is no longer mutating files.
        return True
    if state == "failed":
        if st.get("launch_attempted") is False:
            return False
        if active is None:
            return True
        age = _status_age()
        if age is None and acquired_at:
            age = max(0, time.time() - acquired_at)
        return age is None or age < LEGACY_FAILED_GRACE_SECONDS
    return False


def _lock_is_active(lock: dict) -> bool:
    phase = lock.get("phase", "legacy")
    acquired_at = float(lock.get("acquired_at") or 0)
    age = max(0, time.time() - acquired_at)
    if phase == "legacy":
        return _legacy_upgrade_running(acquired_at)

    if phase in {"preparing", "launching"}:
        owner_identity = _pid_matches(
            lock.get("owner_pid"), lock.get("owner_pid_start")
        )
        if owner_identity is not False:
            return True
        return age < LOCK_PREPARE_GRACE_SECONDS

    launched_at = float(lock.get("launched_at") or acquired_at)
    launch_age = max(0, time.time() - launched_at)
    if lock.get("via") == "detached":
        child_pid = lock.get("child_pid")
        child_identity = _pid_matches(child_pid, lock.get("child_pid_start"))
        if child_pid is not None and child_identity is not False:
            return True
        if child_pid is not None:
            return launch_age < LOCK_LAUNCH_GRACE_SECONDS
        status_state = _read_status().get("state")
        if status_state == "done":
            return launch_age < LOCK_LAUNCH_GRACE_SECONDS
        if status_state == "failed":
            return launch_age < LEGACY_FAILED_GRACE_SECONDS
        # Popen may have succeeded before its PID could be recorded.
        return True

    active = _systemd_unit_active()
    if active is True:
        return True
    if active is False:
        return launch_age < LOCK_LAUNCH_GRACE_SECONDS
    # A structured systemd handoff with an unavailable bus remains active while
    # status says it is running; elapsed time alone cannot prove completion.
    status_state = _read_status().get("state")
    if status_state == "done":
        return launch_age < LOCK_LAUNCH_GRACE_SECONDS
    if status_state == "failed":
        return launch_age < LEGACY_FAILED_GRACE_SECONDS
    return True


def _acquire_upgrade_lock() -> str | None:
    """Atomically claim the upgrade slot and return its unguessable owner token."""
    owner = secrets.token_urlsafe(24)
    pid = os.getpid()
    _, pid_start = _process_identity(pid)
    lock = {
        "owner": owner,
        "owner_pid": pid,
        "owner_pid_start": pid_start,
        "phase": "preparing",
        "acquired_at": time.time(),
    }
    with _upgrade_lock_guard():
        current = _read_lock_unlocked()
        if current is not None:
            if _lock_is_active(current):
                return None
            # Compare the inode/mtime/size read above before deleting. This is
            # important when replacing a stale v0.8.3 lock during a rollout.
            if _lock_identity() != current.get("_identity"):
                return None
            try:
                LOCK_FILE.unlink()
            except OSError:
                return None
        elif _legacy_upgrade_running():
            # The lock may have been lost during a rollout while either a
            # transient unit or a legacy detached upgrader is still running.
            return None
        try:
            _write_lock_unlocked(lock, create=True)
        except FileExistsError:
            return None
    return owner


def _release_upgrade_lock(owner: str) -> bool:
    """Release only the caller's lock; an old request cannot delete a new one."""
    with _upgrade_lock_guard():
        current = _read_lock_unlocked()
        if current is None or current.get("owner") != owner:
            return False
        if _lock_identity() != current.get("_identity"):
            return False
        try:
            LOCK_FILE.unlink()
        except OSError:
            return False
    return True


def _set_upgrade_lock_phase(owner: str, phase: str, **values: object) -> None:
    with _upgrade_lock_guard():
        current = _read_lock_unlocked()
        if current is None or current.get("owner") != owner:
            raise RuntimeError("upgrade lock ownership was lost")
        current.update({"phase": phase, **values})
        _write_lock_unlocked(current)


def _read_status() -> dict:
    try:
        return json.loads(STATUS_FILE.read_text())
    except Exception:  # noqa: BLE001
        return {"state": "idle"}


def _systemd_env() -> dict:
    """Env the web process needs to reach the *user* systemd — a service context
    often lacks these, which is why `systemd-run --user` silently no-ops."""
    uid = os.getuid()
    env = {**os.environ}
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{uid}")
    env.setdefault(
        "DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus"
    )
    return env


def _upgrade_running() -> bool:
    """Report lock-backed launch state, with legacy status fallback."""
    with _upgrade_lock_guard():
        lock = _read_lock_unlocked()
        if lock is not None:
            return _lock_is_active(lock)
    return _legacy_upgrade_running()


def _next_auto_check() -> float:
    """Unix timestamp of the next scheduled auto-update check. The timer fires
    every 20 min on the :00/:20/:40 boundary (OnCalendar=*:0/20), so compute that
    directly — reliable, and no per-request subprocess."""
    import datetime

    from django.utils import timezone

    now = timezone.now()
    nxt = (now + datetime.timedelta(minutes=20 - (now.minute % 20))).replace(
        second=0, microsecond=0
    )
    return nxt.timestamp()


def system_status() -> dict:
    """Upgrade progress + auto-update schedule, for the Jobs view. The upgrade
    can't be a real RQ job (it restarts the worker pool), so the Jobs page renders
    this as a system entry instead."""
    from .deployment import DeploymentSettings

    st = _read_status()
    dep = DeploymentSettings.load()
    return {
        "upgrade": {
            "state": st.get("state", "idle"),
            "step": st.get("step"),
            "pct": st.get("pct"),
            "version_to": st.get("version_to"),
            "version_from": st.get("version_from"),
            "error": st.get("error") or None,
            "active": _upgrade_running(),
        },
        "auto_update": {
            "enabled": dep.auto_update_enabled,
            "next_check": _next_auto_check() if dep.auto_update_enabled else None,
        },
    }


def _is_git_install() -> bool:
    """True when this deployment is a git checkout (can ``git pull`` to upgrade).
    A release-bundle install has no ``.git`` and must upgrade from a bundle."""
    return (settings.BASE_DIR / ".git").is_dir()


def _valid_target(version: str) -> bool:
    """The version must be a real release in the configured repo (no arbitrary
    refs — an upgrade is remote code execution). Airgapped installs never reach
    the repo, so the repo-version path is refused there (upload a bundle
    instead)."""
    from .deployment import DeploymentSettings
    from .github import list_releases
    from .version import DEFAULT_RELEASE_REPO

    dep = DeploymentSettings.load()
    if dep.disable_update_check:
        return False  # airgapped: no outbound check → repo-version upgrade off
    repo = dep.release_repo_url or DEFAULT_RELEASE_REPO
    token = (dep.secrets or {}).get("release_repo_token", "")
    try:
        tags = {r["tag"] for r in list_releases(repo, token)}
    except Exception:  # noqa: BLE001
        return False
    return version in tags


def _download_release_bundle(version: str):
    """Download the offline bundle for ``version`` from the release repo and
    verify its published SHA-256 before use — for a bundle install (no git) that
    still wants one-click / automatic upgrades. Returns the local path, or
    raises RuntimeError with a user-facing reason (missing asset, checksum
    mismatch, network error)."""
    import hashlib

    import httpx

    from .deployment import DeploymentSettings
    from .github import release_assets
    from .version import DEFAULT_RELEASE_REPO

    dep = DeploymentSettings.load()
    repo = dep.release_repo_url or DEFAULT_RELEASE_REPO
    token = (dep.secrets or {}).get("release_repo_token", "")
    assets = release_assets(repo, version, token)
    # The build publishes danbyte-<version>-linux-x86_64.tar.gz + a .sha256.
    bundle_name = next(
        (n for n in assets if n.endswith(".tar.gz") and not n.endswith(".sha256")),
        None,
    )
    if not bundle_name:
        raise RuntimeError(
            f"release {version} has no offline bundle to download — "
            "upgrade by uploading a bundle instead."
        )
    sha_name = f"{bundle_name}.sha256"
    if sha_name not in assets:
        raise RuntimeError(
            f"release {version} bundle has no published checksum — refusing to "
            "install an unverifiable download."
        )
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with httpx.Client(timeout=300, follow_redirects=True) as client:
        want = client.get(assets[sha_name], headers=headers)
        want.raise_for_status()
        expected = want.text.strip().split()[0].lower()
        h = hashlib.sha256()
        with client.stream("GET", assets[bundle_name], headers=headers) as resp:
            resp.raise_for_status()
            with open(BUNDLE_UPLOAD, "wb") as out:
                for chunk in resp.iter_bytes(chunk_size=1 << 20):
                    h.update(chunk)
                    out.write(chunk)
    got = h.hexdigest().lower()
    if got != expected:
        try:
            BUNDLE_UPLOAD.unlink()
        except OSError:
            pass
        raise RuntimeError(
            "downloaded bundle failed checksum verification — aborting "
            f"(expected {expected[:12]}…, got {got[:12]}…)."
        )
    return BUNDLE_UPLOAD


def _write_status_fields(**values: object) -> None:
    status = _read_status()
    status.update(values)
    STATUS_FILE.write_text(json.dumps(status))


def _record_launch_failure(exc: Exception) -> None:
    """Publish a retryable failure that happened before any external launch."""
    try:
        status = _read_status()
        status.update({
            "state": "failed",
            "step": status.get("step") or "launch",
            "pct": 0,
            "error": str(exc),
            "launch_attempted": False,
        })
        STATUS_FILE.write_text(json.dumps(status))
    except Exception:  # noqa: BLE001 - lock release must still happen
        pass


def _raise_launch_uncertain(
    lock_owner: str,
    message: str,
    *,
    via: str,
    launched_at: float,
) -> None:
    """Retain an ambiguous handoff in the lock, then stop normal cleanup."""
    try:
        _set_upgrade_lock_phase(
            lock_owner,
            "launched",
            via=via,
            launch_confirmed=False,
            launched_at=launched_at,
        )
    except Exception:  # noqa: BLE001 - the earlier attempt marker may remain
        pass
    raise UpgradeLaunchUncertain(message)


def _confirm_systemd_launch(lock_owner: str, launched_at: float) -> str:
    try:
        _set_upgrade_lock_phase(
            lock_owner,
            "launched",
            via="systemd-run",
            launch_confirmed=True,
            launched_at=launched_at,
        )
    except Exception as exc:  # the unit exists; cleanup must retain the lock
        _raise_launch_uncertain(
            lock_owner,
            f"systemd accepted the upgrade, but lock metadata could not be finalized: {exc}",
            via="systemd-run",
            launched_at=launched_at,
        )
    return "systemd-run"


def _launch_detached(
    cmd: list[str],
    env: dict[str, str],
    lock_owner: str,
) -> str:
    launched_at = time.time()
    # Record the possibility of a child before Popen. A worker crash after Popen
    # returns but before the PID write must not leave a reclaimable owner phase.
    _set_upgrade_lock_phase(
        lock_owner,
        "launched",
        via="detached",
        launch_confirmed=False,
        child_pid=None,
        child_pid_start=None,
        launched_at=launched_at,
    )
    child = subprocess.Popen(
        cmd,
        env=env,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _, child_start = _process_identity(child.pid)
    try:
        _set_upgrade_lock_phase(
            lock_owner,
            "launched",
            via="detached",
            launch_confirmed=True,
            child_pid=child.pid,
            child_pid_start=child_start,
            launched_at=launched_at,
        )
    except Exception as exc:
        _raise_launch_uncertain(
            lock_owner,
            f"the detached upgrader started, but its lock metadata could not be finalized: {exc}",
            via="detached",
            launched_at=launched_at,
        )
    return "detached"


def _launch_command(cmd: list[str], lock_owner: str) -> str:
    """Launch once and attach the surviving process identity to the lock."""
    env = {**_systemd_env(), "DANBYTE_DIR": str(settings.BASE_DIR)}
    launched_at = time.time()
    # Record the external launcher before invoking it. If this web worker dies
    # after systemd accepts the unit but before subprocess.run returns, the next
    # worker still probes that unit instead of reclaiming a "preparing" lock.
    _set_upgrade_lock_phase(
        lock_owner,
        "launched",
        via="systemd-run",
        launch_confirmed=False,
        launched_at=launched_at,
    )
    _write_status_fields(launch_attempted=True)
    try:
        result = subprocess.run(
            [
                "systemd-run",
                "--user",
                "--collect",
                "--unit",
                "danbyte-upgrade",
                f"--setenv=DANBYTE_DIR={settings.BASE_DIR}",
                *cmd,
            ],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
    except subprocess.TimeoutExpired:
        active = _systemd_unit_active()
        if active is True:
            return _confirm_systemd_launch(lock_owner, launched_at)
        if active is None:
            _raise_launch_uncertain(
                lock_owner,
                "systemd-run timed out and the unit state cannot be determined; "
                "the upgrade slot remains locked.",
                via="systemd-run",
                launched_at=launched_at,
            )
        return _launch_detached(cmd, env, lock_owner)
    except OSError:
        # Popen failed before systemd-run itself could exist.
        return _launch_detached(cmd, env, lock_owner)
    except Exception as exc:  # noqa: BLE001 - an unknown handoff is not retryable
        _raise_launch_uncertain(
            lock_owner,
            f"systemd-run returned an indeterminate launch result: {exc}",
            via="systemd-run",
            launched_at=launched_at,
        )
    if result.returncode == 0:
        return _confirm_systemd_launch(lock_owner, launched_at)

    active = _systemd_unit_active()
    if active is True:
        return _confirm_systemd_launch(lock_owner, launched_at)
    if active is None:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown error"
        _raise_launch_uncertain(
            lock_owner,
            f"systemd-run failed ({detail}) and the unit state cannot be determined; "
            "the upgrade slot remains locked.",
            via="systemd-run",
            launched_at=launched_at,
        )
    return _launch_detached(cmd, env, lock_owner)


def _launch(version: str, lock_owner: str) -> str:
    """Start the git upgrader in a process that outlives the web restart."""
    return _launch_command(["/bin/sh", str(UPGRADE_SCRIPT), version], lock_owner)


def _launch_bundle(path: str, lock_owner: str) -> str:
    """Same detached-launch as `_launch`, but runs the offline-bundle upgrader
    against an uploaded tarball (for installs with no git checkout to pull)."""
    return _launch_command(["/bin/sh", str(BUNDLE_SCRIPT), path], lock_owner)


def _write_start_status(version: str, lock_owner: str) -> None:
    started_at = time.time()
    _set_upgrade_lock_phase(
        lock_owner, "launching", status_started_at=started_at
    )
    STATUS_FILE.write_text(json.dumps({
        "state": "running", "step": "launching", "pct": 0,
        "version_to": version, "started_at": started_at,
        "launch_attempted": False,
    }))


def start_upgrade(version: str, lock_owner: str) -> str:
    """Seed the status + launch the upgrader. Shared by the button and the
    scheduled auto-upgrade. Caller must have checked _upgrade_running()/validity.

    A git checkout upgrades in place (``git pull``). A bundle install has no
    ``.git``, so we download the release's verified offline bundle and run the
    bundle upgrader — otherwise the git script would just fail on it."""
    _write_start_status(version, lock_owner)
    if _is_git_install():
        return _launch(version, lock_owner)
    # Bundle install: fetch + verify the bundle for this version, then apply it.
    try:
        path = _download_release_bundle(version)
    except Exception as exc:  # noqa: BLE001 — surface a readable reason
        STATUS_FILE.write_text(json.dumps({
            "state": "failed", "step": "download", "pct": 0,
            "version_to": version, "error": str(exc),
            "launch_attempted": False,
        }))
        raise
    return _launch_bundle(str(path), lock_owner)


def _store_uploaded_bundle(upload) -> None:
    with open(BUNDLE_UPLOAD, "wb") as out:
        for chunk in upload.chunks():
            out.write(chunk)


@extend_schema(
    summary="Start an upgrade to a release tag (users.manage only)",
    tags=["system"],
    request=inline_serializer(
        name="SystemUpgradeRequest",
        fields={"version": serializers.CharField(help_text="Release tag to upgrade to.")},
    ),
    responses={
        200: inline_serializer(
            name="SystemUpgradeResponse",
            fields={
                "launched": serializers.BooleanField(),
                "version": serializers.CharField(),
                "via": serializers.CharField(),
            },
        ),
        400: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="Missing or invalid version."
        ),
        403: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="users.manage permission required."
        ),
        409: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="An upgrade is already running."
        ),
        502: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="Launch failed or is uncertain."
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def system_upgrade(request):
    """Kick off an upgrade to ``{version}`` (a release tag). users.manage only."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    version = (request.data.get("version") or "").strip()
    if not version:
        return Response({"detail": "version is required."}, status=400)
    if not _valid_target(version):
        return Response(
            {"detail": f"'{version}' is not a release in the configured repo."},
            status=400,
        )
    # Atomic single-slot lock — blocks a concurrent request even during the
    # bundle-download window (before the systemd unit is active).
    lock_owner = _acquire_upgrade_lock()
    if lock_owner is None:
        return Response({"detail": "An upgrade is already running."}, status=409)
    try:
        how = start_upgrade(version, lock_owner)
    except UpgradeLaunchUncertain as exc:
        return Response({"detail": str(exc)}, status=502)
    except Exception as exc:  # noqa: BLE001 — bundle download / verify failure
        _record_launch_failure(exc)
        _release_upgrade_lock(lock_owner)
        return Response({"detail": str(exc)}, status=502)
    return Response({"launched": True, "version": version, "via": how})


@extend_schema(
    summary="Upgrade from an uploaded offline bundle tarball (users.manage only)",
    tags=["system"],
    request=inline_serializer(
        name="SystemUpgradeUploadRequest",
        fields={
            "bundle": serializers.FileField(
                help_text="Offline bundle produced by the release build (.tar.gz/.tgz)."
            )
        },
    ),
    responses={
        200: inline_serializer(
            name="SystemUpgradeUploadResponse",
            fields={
                "launched": serializers.BooleanField(),
                "via": serializers.CharField(),
                "file": serializers.CharField(),
            },
        ),
        400: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="Missing or invalid bundle file."
        ),
        403: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="users.manage permission required."
        ),
        409: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="An upgrade is already running."
        ),
        500: OpenApiResponse(response=OpenApiTypes.OBJECT, description="Launch failed."),
        502: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="Launch is uncertain."
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def system_upgrade_upload(request):
    """Upgrade from an uploaded offline bundle (danbyte-<ver>-linux-x86_64.tar.gz).
    For tarball installs that can't `git pull`. users.manage only."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    f = request.FILES.get("bundle")
    if not f:
        return Response({"detail": "bundle file is required."}, status=400)
    if not f.name.endswith((".tar.gz", ".tgz")):
        return Response(
            {"detail": "bundle must be a .tar.gz produced by the release build."},
            status=400,
        )
    # Claim the slot before writing the bundle path, so two concurrent uploads
    # can't stream over the same file and both launch.
    lock_owner = _acquire_upgrade_lock()
    if lock_owner is None:
        return Response({"detail": "An upgrade is already running."}, status=409)
    try:
        _store_uploaded_bundle(f)
        _write_start_status(f.name, lock_owner)
        how = _launch_bundle(str(BUNDLE_UPLOAD), lock_owner)
    except UpgradeLaunchUncertain as exc:
        return Response({"detail": str(exc)}, status=502)
    except Exception as exc:  # noqa: BLE001
        _record_launch_failure(exc)
        _release_upgrade_lock(lock_owner)
        return Response({"detail": str(exc)}, status=500)
    return Response({"launched": True, "via": how, "file": f.name})


@extend_schema(
    summary="Read the current upgrade progress status (users.manage only)",
    tags=["system"],
    request=None,
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Upgrade status document (state, step, pct, version, error).",
        ),
        403: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="users.manage permission required."
        ),
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def system_upgrade_status(request):
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    return Response(_read_status())


def _upgrade_process_alive() -> bool:
    """True only when the lock names a process that is *verifiably* still alive.

    Used by the cancel action to refuse clearing a genuinely-running upgrade.
    Unlike ``_lock_is_active`` (which stays True under ambiguity so a second
    upgrade can't race a maybe-running one), this returns True only on a
    positive identity match — so a stuck lock left by a dead/interrupted
    upgrade is correctly reported as not-alive and can be cleared.
    """
    lock = _read_lock_unlocked()
    if lock is None:
        return False
    for pid_key, start_key in (
        ("child_pid", "child_pid_start"),
        ("owner_pid", "owner_pid_start"),
    ):
        pid = lock.get(pid_key)
        if pid is not None and _pid_matches(pid, lock.get(start_key)) is True:
            return True
    if lock.get("via") not in (None, "detached") and _systemd_unit_active() is True:
        return True
    return False


def _force_clear_upgrade_lock() -> None:
    """Remove the lock + transient upgrade files regardless of owner. The
    guarded caller must first confirm no real upgrade process is alive."""
    with _upgrade_lock_guard():
        for path in (LOCK_FILE, STATUS_FILE, BUNDLE_UPLOAD):
            try:
                path.unlink()
            except OSError:
                pass


@extend_schema(
    summary="Clear a stuck upgrade lock so a new upgrade can start (users.manage only)",
    tags=["system"],
    request=None,
    responses={
        200: inline_serializer(
            name="SystemUpgradeCancelResponse",
            fields={
                "cleared": serializers.BooleanField(),
                "had_lock": serializers.BooleanField(),
            },
        ),
        403: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="users.manage permission required."
        ),
        409: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="An upgrade process is genuinely still running.",
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def system_upgrade_cancel(request):
    """Clear a STUCK upgrade lock so a new upgrade can start. users.manage only.

    Refuses (409) if an upgrade process is genuinely still alive — otherwise
    removes the lock + stale status so the next attempt isn't blocked by "An
    upgrade is already running." (A dead/interrupted upgrade, or a lock left
    un-expirable by a missing status file, is the case this fixes.)"""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    if _upgrade_process_alive():
        return Response(
            {"detail": "An upgrade is genuinely still running — wait for it to "
                       "finish or fail before cancelling."},
            status=409,
        )
    had_lock = LOCK_FILE.exists()
    _force_clear_upgrade_lock()
    return Response({"cleared": True, "had_lock": had_lock})
