"""Read a device's configuration out of Oxidized, briefly cached.

Nothing here writes config text to the database. A read is cached in Redis
for :data:`CURRENT_TTL` seconds (a version addressed by its git oid, which
never changes, for :data:`VERSION_TTL`), keyed by tenant, connection and
node, so opening the tab twice does not fetch twice. Every caller has already
checked ``device.view_config`` before it gets here - the cache is behind the
permission check, never in front of it.
"""
from __future__ import annotations

import difflib
import hashlib
import logging
from datetime import datetime

from django.core.cache import cache

from .client import OxidizedClient

log = logging.getLogger("oxidized")

CURRENT_TTL = 60
VERSION_TTL = 300
#: Past this many lines on either side the diff is refused rather than
#: computed: difflib is quadratic in the worst case.
DIFF_MAX_LINES = 50_000


def _key(link, kind: str, extra: str = "") -> str:
    conn = link.connection
    # The connection's address is part of the key, so re-pointing it at
    # another server cannot serve the old server's text for the TTL.
    where = hashlib.sha256(
        f"{conn.url}|{conn.username}|{conn.verify_tls}".encode()
    ).hexdigest()[:16]
    node = hashlib.sha256(f"{link.full_name}|{extra}".encode()).hexdigest()[:32]
    return f"oxidized:v1:{link.tenant_id}:{conn.id}:{where}:{kind}:{node}"


def _cached(key: str, ttl: int, load, *, refresh=False):
    if not refresh:
        try:
            hit = cache.get(key)
        except Exception:  # noqa: BLE001 - Redis down: just fetch
            hit = None
        if hit is not None:
            return hit, True
    value = load()
    try:
        cache.set(key, value, ttl)
    except Exception:  # noqa: BLE001
        log.warning("oxidized: could not cache %s", key)
    return value, False


def forget(link) -> None:
    """Drop the cached current config and history, after a fetch-now."""
    try:
        cache.delete_many([_key(link, "current"), _key(link, "versions")])
    except Exception:  # noqa: BLE001
        pass


def _client(link) -> OxidizedClient:
    return OxidizedClient.for_connection(link.connection)


def current(link, *, refresh=False) -> tuple[str, bool]:
    return _cached(
        _key(link, "current"), CURRENT_TTL,
        lambda: _client(link).fetch(link.node_name, link.node_group),
        refresh=refresh,
    )


def _when(value) -> str | None:
    """oxidized-web serialises Ruby ``Time`` as ``2026-10-01 12:00:00 +0200``."""
    if not value:
        return None
    text = str(value)
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            return datetime.strptime(text, fmt).isoformat()
        except ValueError:
            continue
    return None


def _normalise(row: dict) -> dict:
    author = row.get("author")
    name = email = ""
    if isinstance(author, dict):
        name = str(author.get("name") or "")
        email = str(author.get("email") or "")
    elif author:
        name = str(author)
    return {
        "oid": str(row.get("oid") or ""),
        "date": _when(row.get("time")) or _when(row.get("date")),
        "author": name,
        "email": email,
        "message": str(row.get("message") or "").strip(),
    }


def versions(link, *, refresh=False) -> tuple[list[dict], bool]:
    def load():
        rows = _client(link).versions(link.node_name, link.node_group)
        return [_normalise(r) for r in rows]

    return _cached(_key(link, "versions"), CURRENT_TTL, load, refresh=refresh)


def version(link, oid: str) -> tuple[str, bool]:
    return _cached(
        _key(link, "version", oid), VERSION_TTL,
        lambda: _client(link).version(link.node_name, link.node_group, oid),
    )


def unified_diff(old: str, new: str, old_label: str, new_label: str) -> dict:
    a, b = old.splitlines(), new.splitlines()
    if len(a) > DIFF_MAX_LINES or len(b) > DIFF_MAX_LINES:
        return {"diff": "", "too_large": True, "added": 0, "removed": 0}
    lines = list(difflib.unified_diff(a, b, old_label, new_label, lineterm=""))
    added = sum(1 for ln in lines if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in lines if ln.startswith("-") and not ln.startswith("---"))
    return {"diff": "\n".join(lines), "too_large": False, "added": added, "removed": removed}
