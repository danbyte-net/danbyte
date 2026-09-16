"""Live monitoring - a check's latest word pushed to whoever is looking.

An address's Monitoring tab opens a WebSocket (``/ws/monitoring/?ip=<id>``)
and from then on every result the workers or the fast lane write for that
address reaches it the moment it is written: the status pill, the latency,
"last checked" and the strips move on their own instead of on the next
reload.

Only for addresses somebody is looking at. A page registers **interest** in
Redis (a key per address with a short TTL, refreshed by the page's pings)
and the publishers check it before sending - so a thousand-check estate
with nobody watching costs the channel layer nothing, and the fast lane can
say something every second about the three addresses that are open.

The message is the state's own columns, not a second shape: the page patches
its cached checks with it and re-reads the history when a change happened.
"""
from __future__ import annotations

import hashlib
import json
import logging

from asgiref.sync import async_to_sync
from django.utils import timezone

log = logging.getLogger("monitoring.live")

INTEREST_TTL = 90  # seconds; the page pings every 30


def _redis():
    from django_redis import get_redis_connection

    return get_redis_connection("default")


def group_for(tenant_id, ip_id) -> str:
    """Channels caps group names; a hash keeps them fixed-length and clean."""
    return "mon_" + hashlib.md5(f"{tenant_id}:{ip_id}".encode()).hexdigest()


def _interest_key(ip_id) -> str:
    return f"danbyte:live:ip:{ip_id}"


def register_interest(ip_id) -> None:
    try:
        _redis().set(_interest_key(ip_id), "1", ex=INTEREST_TTL)
    except Exception:  # noqa: BLE001 - never let the page fail on this
        log.debug("live interest failed", exc_info=True)


def interested(ip_ids) -> set:
    """Which of ``ip_ids`` somebody is looking at right now - one pipelined
    round trip for a whole batch."""
    ids = list({str(i) for i in ip_ids})
    if not ids:
        return set()
    try:
        r = _redis()
        pipe = r.pipeline()
        for ip_id in ids:
            pipe.exists(_interest_key(ip_id))
        hits = pipe.execute()
    except Exception:  # noqa: BLE001
        return set()
    return {ip_id for ip_id, hit in zip(ids, hits, strict=False) if hit}


#: Raw probes are not rows - the fast lane keeps one aggregate per window
#: in the database - but the last few minutes of them are worth a look
#: while somebody is looking. A short ring per watched check, in Redis.
PROBES_KEEP = 600
PROBES_TTL = 600


def _probes_key(state_id) -> str:
    return f"danbyte:probes:{state_id}"


def push_probes(samples: dict) -> None:
    """``{state_id: [{status, latency_ms, at}, ...]}`` (oldest first) for
    watched states only - the caller has already checked interest. One
    pipelined round trip."""
    if not samples:
        return
    try:
        pipe = _redis().pipeline()
        for sid, batch in samples.items():
            if isinstance(batch, dict):
                batch = [batch]
            if not batch:
                continue
            key = _probes_key(sid)
            # LPUSH with several values pushes them in order, so the newest
            # of the batch ends up at the head.
            pipe.lpush(key, *(json.dumps(sm) for sm in batch))
            pipe.ltrim(key, 0, PROBES_KEEP - 1)
            pipe.expire(key, PROBES_TTL)
        pipe.execute()
    except Exception:  # noqa: BLE001
        log.debug("probe ring push failed", exc_info=True)


def recent_probes(state_id, limit: int = PROBES_KEEP) -> list[dict]:
    """Newest first. Empty for a check nobody has watched lately."""
    try:
        raw = _redis().lrange(_probes_key(state_id), 0, max(limit, 1) - 1)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for item in raw:
        try:
            out.append(json.loads(item))
        except (TypeError, ValueError):
            continue
    return out


def state_payload(state, *, transition=None, sample=None) -> dict:
    """What a page needs to redraw one check row."""
    out = {
        "state_id": str(state.id),
        "template_id": str(state.template_id),
        "status": state.status,
        "since": state.since.isoformat() if state.since else None,
        "last_checked": state.last_checked.isoformat() if state.last_checked else None,
        "last_latency_ms": state.last_latency_ms,
        "consecutive_success": state.consecutive_success,
        "consecutive_fail": state.consecutive_fail,
        "flapping_since": state.flapping_since.isoformat() if state.flapping_since else None,
        "last_detail": state.last_detail or {},
    }
    if transition is not None:
        out["transition"] = {
            "from_status": transition.from_status,
            "to_status": transition.to_status,
            "at": transition.at.isoformat(),
        }
    if isinstance(sample, list):
        # A flush's whole batch: the row moves on the newest, the page's
        # probe ring keeps them all.
        if sample:
            out["sample"] = sample[-1]
            out["probes"] = sample
    elif sample is not None:
        out["sample"] = sample
    return out


def publish(states, transitions=(), samples=None) -> int:
    """Push the latest word on ``states`` to the pages watching their
    addresses. ``transitions`` are matched to states by (ip, template);
    ``samples`` is ``{state_id: [{status, latency_ms, at}, ...]}`` (oldest
    first; a lone dict is accepted) for the probes that did not become a row
    (the fast lane's) so the page still moves.
    Returns how many messages went out."""
    if not states:
        return 0
    watched = interested(s.target_ip_id for s in states)
    if not watched:
        return 0
    from channels.layers import get_channel_layer

    layer = get_channel_layer()
    if layer is None:
        return 0
    by_pair = {(t.target_ip_id, t.template_id): t for t in transitions}
    samples = samples or {}
    sent = 0
    now = timezone.now().isoformat()
    for state in states:
        ip_id = str(state.target_ip_id)
        if ip_id not in watched:
            continue
        payload = state_payload(
            state,
            transition=by_pair.get((state.target_ip_id, state.template_id)),
            sample=samples.get(str(state.id)),
        )
        try:
            async_to_sync(layer.group_send)(
                group_for(state.tenant_id, ip_id),
                {"type": "monitoring.update", "payload": payload, "at": now},
            )
            sent += 1
        except Exception:  # noqa: BLE001 - a push is a nicety, a write is not
            log.debug("live publish failed", exc_info=True)
    return sent
