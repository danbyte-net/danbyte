"""Ephemeral collaborative presence — who is viewing/editing an object.

Backed by Redis (already running for RQ + the Django cache) with a short TTL so a
user's presence auto-expires when they navigate away — no cleanup job, no stale
rows. Strictly best-effort: any Redis failure degrades to "nobody else here"
rather than breaking the page.

Storage: one Redis HASH per object, ``danbyte:presence:<tenant>:<type>:<id>``,
field = user id, value = JSON ``{name, mode, ts}``. A whole-key EXPIRE self-cleans
empty objects; per-field staleness is evicted on read.
"""
from __future__ import annotations

import json
import time

SOFT_TTL = 30  # a heartbeat older than this → the user is considered gone
HARD_TTL = 60  # whole-key expiry so an abandoned object self-cleans


def _conn():
    from django_redis import get_redis_connection

    return get_redis_connection("default")


def _key(tenant_id, object_type: str, object_id: str) -> str:
    return f"danbyte:presence:{tenant_id}:{object_type}:{object_id}"


def heartbeat(tenant_id, object_type, object_id, *, user_id, name, mode) -> None:
    """Record/refresh this user's presence on an object. Best-effort."""
    try:
        conn = _conn()
        key = _key(tenant_id, object_type, object_id)
        conn.hset(
            key,
            str(user_id),
            json.dumps({"name": name, "mode": mode, "ts": time.time()}),
        )
        conn.expire(key, HARD_TTL)
    except Exception:  # noqa: BLE001 — never break the request path
        pass


def leave(tenant_id, object_type, object_id, *, user_id) -> None:
    """Drop this user's presence (called on unmount). Best-effort."""
    try:
        _conn().hdel(_key(tenant_id, object_type, object_id), str(user_id))
    except Exception:  # noqa: BLE001
        pass


def present(tenant_id, object_type, object_id, *, exclude_user_id=None) -> list[dict]:
    """The users currently present on an object (fresh heartbeats only).

    Editing users sort first. Returns ``[]`` on any Redis problem.
    """
    try:
        conn = _conn()
        key = _key(tenant_id, object_type, object_id)
        raw = conn.hgetall(key)
    except Exception:  # noqa: BLE001
        return []
    now = time.time()
    out: list[dict] = []
    stale: list[str] = []
    for field, val in (raw or {}).items():
        uid = field.decode() if isinstance(field, bytes) else field
        try:
            data = json.loads(val)
        except Exception:  # noqa: BLE001
            stale.append(uid)
            continue
        if now - float(data.get("ts", 0)) > SOFT_TTL:
            stale.append(uid)
            continue
        if exclude_user_id is not None and uid == str(exclude_user_id):
            continue
        out.append(
            {
                "user_id": uid,
                "name": data.get("name") or "Someone",
                "mode": data.get("mode") or "viewing",
                "since": data.get("ts"),
            }
        )
    if stale:
        try:
            conn.hdel(key, *stale)
        except Exception:  # noqa: BLE001
            pass
    out.sort(key=lambda p: (p["mode"] != "editing", p["name"].lower()))
    return out
