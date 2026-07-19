"""Scheduled auto-upgrade — check the release repo for a newer version and, if
auto-update is on and we're inside the maintenance window, upgrade to it.

A **blank window** (no days, no start/end) means *anytime* — i.e. real-time:
upgrade as soon as a newer release appears. Run on a timer (management command
``auto_upgrade``).
"""
from __future__ import annotations

from django.utils import timezone


def in_update_window(s, now=None) -> bool:
    """Is ``now`` inside the configured maintenance window? Fully blank = always
    (real-time). ``update_window_days`` is a comma/space list (mon, tue, sun…);
    start/end are ``HH:MM`` local, and may wrap past midnight."""
    now = now or timezone.localtime()
    days = (s.update_window_days or "").strip()
    start = (s.update_window_start or "").strip()
    end = (s.update_window_end or "").strip()
    if not days and not start and not end:
        return True
    if days:
        allowed = {
            d.strip().lower()[:3]
            for d in days.replace(",", " ").split()
            if d.strip()
        }
        if allowed and now.strftime("%a").lower() not in allowed:
            return False
    if start and end:
        cur = now.strftime("%H:%M")
        if start <= end:
            if not (start <= cur <= end):
                return False
        elif not (cur >= start or cur <= end):  # window crosses midnight
            return False
    return True


def check_and_upgrade(now=None) -> dict:
    """One scheduled tick: upgrade to the newest applicable release, or a reason
    it was skipped."""
    from .deployment import DeploymentSettings
    from .github import list_releases
    from .upgrade import (
        UpgradeLaunchUncertain,
        _acquire_upgrade_lock,
        _record_launch_failure,
        _release_upgrade_lock,
        _upgrade_running,
        start_upgrade,
    )
    from .version import DEFAULT_RELEASE_REPO, is_newer, system_version

    s = DeploymentSettings.load()
    if s.disable_update_check:
        return {"skipped": "airgapped"}
    if not s.auto_update_enabled:
        return {"skipped": "disabled"}
    if not in_update_window(s, now):
        return {"skipped": "outside_window"}
    if _upgrade_running():
        return {"skipped": "already_running"}

    cur = system_version()["version"]
    repo = s.release_repo_url or DEFAULT_RELEASE_REPO
    token = (s.secrets or {}).get("release_repo_token", "")
    try:
        rels = list_releases(repo, token)
    except Exception:  # noqa: BLE001 — a repo hiccup shouldn't crash the timer
        return {"skipped": "repo_unreachable"}
    if s.update_channel == "stable":
        rels = [r for r in rels if not r["prerelease"]]
    newer = [r for r in rels if is_newer(r["tag"], cur)]
    if not newer:
        return {"skipped": "up_to_date", "current": cur}

    target = newer[0]["tag"]  # list is newest-first
    # Take the same atomic slot the manual endpoints use, so a scheduled tick
    # can't race a hand-triggered upgrade.
    lock_owner = _acquire_upgrade_lock()
    if lock_owner is None:
        return {"skipped": "already_running"}
    try:
        start_upgrade(target, lock_owner)
    except UpgradeLaunchUncertain as exc:
        return {"skipped": "launch_uncertain", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        _record_launch_failure(exc)
        _release_upgrade_lock(lock_owner)
        return {"skipped": "launch_failed", "error": str(exc)}
    return {"upgrading": target, "from": cur}
