"""Minimal GitHub release helpers — shared by the Outpost package store and the
Danbyte self-update. Neutral home (``core``) so both apps import in the right
direction.
"""
from __future__ import annotations

import re


def _owner_repo(git_url: str):
    m = re.search(r"github\.com[/:]([^/]+)/([^/.]+)", git_url or "")
    return (m.group(1), m.group(2)) if m else (None, None)


def release_assets(git_url: str, tag: str, token: str = "") -> dict[str, str]:
    """``{asset_name: browser_download_url}`` for one release tag, or ``{}`` if
    the tag/repo isn't found. Used by the self-updater to fetch the offline
    bundle (and its ``.sha256``) for a bundle install that can't ``git pull``."""
    import httpx

    owner, repo = _owner_repo(git_url)
    if not owner:
        return {}
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        r = client.get(
            f"https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}",
            headers=headers,
        )
        if r.status_code == 404:
            return {}
        r.raise_for_status()
        return {
            a["name"]: a["browser_download_url"]
            for a in r.json().get("assets", [])
        }


def list_releases(git_url: str, token: str = "", per_page: int = 30) -> list[dict]:
    """A repo's releases, newest first →
    ``[{tag, name, body, published_at, prerelease, has_binary}]``. ``body`` is the
    release notes (changelog). ``[]`` for a non-GitHub URL."""
    import httpx

    owner, repo = _owner_repo(git_url)
    if not owner:
        return []
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        r = client.get(
            f"https://api.github.com/repos/{owner}/{repo}/releases?per_page={per_page}",
            headers=headers,
        )
        r.raise_for_status()
        out = []
        for rel in r.json():
            assets = rel.get("assets", [])
            out.append({
                "tag": rel["tag_name"],
                "name": rel.get("name") or rel["tag_name"],
                "body": rel.get("body") or "",
                "published_at": rel.get("published_at"),
                "prerelease": bool(rel.get("prerelease")),
                "has_binary": any(
                    not a["name"].endswith((".tar.gz", ".zip", ".whl"))
                    for a in assets
                ),
            })
        return out
