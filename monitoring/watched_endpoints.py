"""Watched-endpoint polling - the "just give me a host:port" TLS-cert monitor.

Isolated from the IP-anchored check engine on purpose: each
:class:`monitoring.models.WatchedEndpoint` is read on its own schedule by
reusing :func:`monitoring.certificates.observe_endpoint` (which folds the
observed chain into the Certificates inventory). Status is derived exactly like
the ``tls_cert`` checker so a watched endpoint reads the same as a check on an IP.

Fired from the minute-beat ``dispatch_checks`` command (guarded), so it needs no
new systemd timer; each endpoint respects its own ``interval_seconds``.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from danbyte_checks.tls_cert import ERR_POLICY, UNKNOWN, VERIFIED

from .certificates import observe_endpoint
from .models import WatchedEndpoint

log = logging.getLogger("monitoring.watched_endpoints")

# Kept small - a summary of the last read, mirrored to the API/UI.
_DETAIL_KEYS = (
    "validity", "expired", "not_yet_valid", "self_signed",
    "expires_in_days", "tls_version", "error",
)


def _status(obs: dict, *, allow_self_signed: bool = False) -> str:
    """Same mapping as ``danbyte_checks.tls_cert``'s checker ``run``.

    ``allow_self_signed`` accepts a chain that only failed trust verification
    *because the leaf is self-signed* (self-signed by design) - it reads ``up``
    instead of ``degraded``. Expiry / not-yet-valid still degrade, and an
    untrusted chain that is **not** self-signed (e.g. an unknown CA or a
    hostname mismatch) still degrades, so this never blesses a real trust gap.
    """
    if obs.get("validity") == UNKNOWN:
        # A policy refusal is a config problem, not an outage.
        return "unknown" if obs.get("error_kind") == ERR_POLICY else "down"
    if obs.get("expired") or obs.get("not_yet_valid"):
        return "degraded"
    if obs.get("validity") != VERIFIED:
        if allow_self_signed and obs.get("self_signed"):
            return "up"
        return "degraded"
    return "up"


def run_watched_endpoint(ep: WatchedEndpoint, now=None) -> str:
    """Read one endpoint's certificate now, fold it into the inventory, and
    stamp the endpoint's last status. Returns the derived status."""
    now = now or timezone.now()
    obs, rows = observe_endpoint(
        ep.tenant, ep.host, ep.port, server_name=ep.server_name or None
    )
    status = _status(obs, allow_self_signed=ep.allow_self_signed)

    leaf_fp = (obs.get("chain") or [{}])[0].get("fingerprint_sha256")
    leaf = next((r for r in rows if r.fingerprint_sha256 == leaf_fp), None)

    # Mismatch = the endpoint now serves a different leaf than last poll. Only
    # meaningful once we've seen one before (the first read isn't a change).
    prev_fp = ep.last_certificate.fingerprint_sha256 if ep.last_certificate_id else None
    changed = bool(prev_fp and leaf_fp and leaf_fp != prev_fp)

    ep.last_run_at = now
    ep.last_status = status
    ep.last_detail = {k: obs.get(k) for k in _DETAIL_KEYS if obs.get(k) is not None}
    if changed:
        ep.last_detail["fingerprint_changed"] = True
        ep.last_detail["previous_fingerprint"] = prev_fp
    ep.last_certificate = leaf
    ep.save(
        update_fields=[
            "last_run_at", "last_status", "last_detail",
            "last_certificate", "updated_at",
        ]
    )
    return status


def run_due_watched_endpoints(now=None) -> dict:
    """Poll every enabled endpoint whose interval has elapsed. Never raises -
    one bad endpoint must not stop the rest (or the dispatch beat that calls us)."""
    now = now or timezone.now()
    ran = 0
    for ep in WatchedEndpoint.objects.filter(enabled=True).select_related("tenant"):
        due = (
            ep.last_run_at is None
            or (now - ep.last_run_at).total_seconds() >= ep.interval_seconds
        )
        if not due:
            continue
        try:
            run_watched_endpoint(ep, now=now)
            ran += 1
        except Exception:  # noqa: BLE001 - isolate a bad endpoint
            log.exception("watched endpoint poll failed: %s", ep.pk)
    return {"ran": ran}
