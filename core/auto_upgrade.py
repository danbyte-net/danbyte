"""Scheduled auto-upgrade - check the release repo for a newer version and, if
auto-update is on and we're inside the maintenance window, upgrade to it.

A **blank window** (no days, no start/end) means *anytime* - i.e. real-time:
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


#: A failure before any service stopped (a download, a resolver, a full
#: disk, a lock) is tried again this long after the previous attempt ended -
#: three more times at most. A failure after that point was rolled back and
#: waits for a person or a newer release.
RETRY_DELAYS = (3600, 4 * 3600, 12 * 3600)


def _retry_decision(last: dict, target: str) -> tuple[int, dict | None]:
    """``(attempt, skip)``: the attempt number for ``target``, or why not now."""
    import time

    from .upgrade import STATUS_FILE
    from .version import compare_versions

    if last.get("state") != "failed" or not last.get("version_to"):
        return 1, None
    try:
        same = compare_versions(str(last["version_to"]), target) == 0
    except Exception:  # noqa: BLE001 - an uploaded file name as the version
        same = False
    if not same:
        return 1, None
    attempt = int(last.get("attempt") or 1)
    info = {"target": target, "error": last.get("error", ""), "attempts": attempt}
    if not last.get("retryable") or attempt > len(RETRY_DELAYS):
        # Every retry would take another full backup and fail the same way;
        # a person retries from the Updates page, or the next release moves
        # the target.
        return attempt, {"skipped": "failed_before", **info}
    ended = last.get("finished_at")
    if not isinstance(ended, (int, float)):
        try:
            ended = STATUS_FILE.stat().st_mtime
        except OSError:
            ended = 0
    retry_at = float(ended) + RETRY_DELAYS[attempt - 1]
    if time.time() < retry_at:
        return attempt, {"skipped": "retry_later", "retry_at": retry_at, **info}
    return attempt + 1, None


def check_and_upgrade(now=None) -> dict:
    """One scheduled tick: report how the last upgrade ended, then upgrade to
    the newest applicable release, or say why not."""
    from functools import cmp_to_key

    from .deployment import DeploymentSettings
    from .github import list_releases
    from .upgrade import (
        UpgradeLaunchUncertain,
        _acquire_upgrade_lock,
        _read_status,
        _record_launch_failure,
        _release_upgrade_lock,
        _upgrade_running,
        start_upgrade,
    )
    from .upgrade_report import report_finished
    from .version import (
        DEFAULT_RELEASE_REPO,
        compare_versions,
        is_newer,
        is_prerelease,
        self_upgrade_supported,
        system_version,
    )

    # Whoever started the last upgrade, the admins hear how it ended - even
    # with auto-update off.
    try:
        report_finished()
    except Exception:  # noqa: BLE001 - a report must never stop the tick
        import logging

        logging.getLogger(__name__).exception("upgrade report failed")

    s = DeploymentSettings.load()
    # A container can't upgrade itself (see version.deployment_method), so the
    # scheduled tick never even tries - it would only ever half-apply.
    if not self_upgrade_supported():
        return {"skipped": "containerized"}
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
    except Exception:  # noqa: BLE001 - a repo hiccup shouldn't crash the timer
        return {"skipped": "repo_unreachable"}
    if s.update_channel == "stable":
        rels = [r for r in rels if not r["prerelease"] and not is_prerelease(r["tag"])]
    newer = [r["tag"] for r in rels if is_newer(r["tag"], cur)]
    if not newer:
        return {"skipped": "up_to_date", "current": cur}
    # The newest by version, not by the repo's list order; never a downgrade.
    target = max(newer, key=cmp_to_key(compare_versions))

    attempt, skip = _retry_decision(_read_status(), target)
    if skip is not None:
        return skip
    # Take the same atomic slot the manual endpoints use, so a scheduled tick
    # can't race a hand-triggered upgrade.
    lock_owner = _acquire_upgrade_lock()
    if lock_owner is None:
        return {"skipped": "already_running"}
    try:
        start_upgrade(target, lock_owner, trigger="auto", attempt=attempt)
    except UpgradeLaunchUncertain as exc:
        return {"skipped": "launch_uncertain", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        _record_launch_failure(exc)
        _release_upgrade_lock(lock_owner)
        return {"skipped": "launch_failed", "error": str(exc)}
    return {"upgrading": target, "from": cur, "attempt": attempt}
