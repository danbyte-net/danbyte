"""Runtime version info for the About / Updates page."""
from __future__ import annotations

import subprocess
from functools import lru_cache

from django.conf import settings

from danbyte import __version__

# The official / default Danbyte release repo. Overridable in Deployment settings.
DEFAULT_RELEASE_REPO = "https://github.com/danbyte-net/danbyte"


def _git(*args) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(settings.BASE_DIR), *args],
            capture_output=True, text=True, timeout=3, check=True,
        )
        return out.stdout.strip()
    except Exception:  # noqa: BLE001 — best-effort, never fatal
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
