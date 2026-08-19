"""SSH host-key inventory + drift.

The collector (:mod:`danbyte_checks.ssh`) captures the host key a device presents;
this reconciles it into a tenant-scoped :class:`~monitoring.models.SSHHostKey`
and, when the presented key doesn't match one the operator declared, raises
``ssh_host_key_mismatch`` through the **same Alert engine** as certificate drift
- ack, silence, renotify and every channel come for free.

Identity is the OpenSSH ``SHA256:…`` fingerprint (see
:func:`danbyte_checks.ssh_hostkey.fingerprint_from_blob`), so an uploaded key
and the same key observed on the wire converge to one row. Observation never
writes intent: a device is only *expected* to present a key once someone uploads
it or accepts an observed one.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from .models import Alert, AlertSeverity, AlertStatus, SSHHostKey

log = logging.getLogger(__name__)

DEDUP_PREFIX = "ssh-hostkey-mismatch:"


class HostKeyUploadError(ValueError):
    """The pasted text is not a usable SSH public key (surfaced as a 400)."""


def upload_host_key(tenant, device, line, *, now=None):
    """Declare an expected host key for a device from a pasted OpenSSH line.

    Parses public data only (private keys and PEM certs are refused). Dedupes on
    the fingerprint: if the key already exists (e.g. already observed), it is
    marked ``uploaded`` and returned rather than duplicated. Returns
    ``(row, created)``. Re-evaluates drift so accepting-by-upload clears at once.
    """
    from danbyte_checks.ssh_hostkey import SSHKeyParseError, parse_public_key_line

    try:
        parsed = parse_public_key_line(line)
    except SSHKeyParseError as e:
        raise HostKeyUploadError(str(e)) from e

    now = now or timezone.now()
    row, created = SSHHostKey.objects.get_or_create(
        tenant=tenant,
        device=device,
        fingerprint_sha256=parsed["fingerprint"],
        defaults={
            "key_type": parsed["key_type"],
            "public_key": parsed["public_key"],
            "comment": parsed["comment"],
            "bits": parsed["bits"],
            "uploaded": True,
            "first_seen": now,
            "last_seen": now,
        },
    )
    if not created and not row.uploaded:
        row.uploaded = True
        if parsed["comment"] and not row.comment:
            row.comment = parsed["comment"]
        row.save(update_fields=["uploaded", "comment"])
    evaluate_mismatch(
        tenant_id=tenant.id, device_id=row.device_id, key_type=row.key_type
    )
    return row, created


def dedup_key(device_id, key_type: str) -> str:
    return f"{DEDUP_PREFIX}{device_id}:{key_type}"


# ─── Reconcile an observation ────────────────────────────────────────────────

def record_host_key(tenant, device, hk: dict, *, now=None) -> SSHHostKey | None:
    """Upsert the observed host key for a device. Returns the row, or None when
    the payload is unusable. Marks it ``observed`` and refreshes ``last_seen``;
    never sets ``uploaded`` (that is intent, only a human sets it)."""
    fp = (hk or {}).get("fingerprint")
    key_type = (hk or {}).get("key_type")
    blob = (hk or {}).get("public_key")
    if not (fp and key_type and blob):
        return None
    now = now or timezone.now()
    row, created = SSHHostKey.objects.get_or_create(
        tenant=tenant,
        device=device,
        fingerprint_sha256=fp,
        defaults={
            "key_type": key_type,
            "public_key": blob,
            "observed": True,
            "first_seen": now,
            "last_seen": now,
        },
    )
    if not created:
        fields = ["last_seen"]
        row.last_seen = now
        if not row.observed:
            row.observed = True
            fields.append("observed")
        if row.first_seen is None:
            row.first_seen = now
            fields.append("first_seen")
        row.save(update_fields=fields)
    return row


def record_ssh_results(results) -> int:
    """Fold ``ssh`` check results carrying a host key into the inventory, then
    re-evaluate drift for each device touched. Called from both persistence seams
    (``runner.record_results``, ``worker._finalise``); a no-op for other kinds
    and it never raises into the check pipeline."""
    touched = 0
    # (tenant_id, device_id, key_type) → the IP the check hit, so the mismatch
    # alert attaches to the endpoint that was actually probed.
    seen: dict = {}
    for result in results:
        if result.kind != "ssh":
            continue
        hk = (result.detail or {}).get("host_key")
        if not hk or result.target_ip_id is None:
            continue
        try:
            device = getattr(result.target_ip, "assigned_device", None)
            if device is None:
                continue  # a host key belongs to a device; loose IPs are skipped
            row = record_host_key(result.tenant, device, hk)
            if row is not None:
                touched += 1
                seen[(result.tenant_id, device.id, row.key_type)] = result.target_ip_id
        except Exception:  # noqa: BLE001 - inventory must not break monitoring
            log.exception("ssh host-key reconcile failed for result %s", result.pk)
    for (tenant_id, device_id, key_type), target_ip_id in seen.items():
        try:
            evaluate_mismatch(
                tenant_id=tenant_id, device_id=device_id, key_type=key_type,
                target_ip_id=target_ip_id,
            )
        except Exception:  # noqa: BLE001 - alerting must not break monitoring
            log.exception("ssh host-key drift eval failed for device %s", device_id)
    return touched


# ─── Drift ───────────────────────────────────────────────────────────────────

def _detail(device, key_type, served, expected, now) -> dict:
    return {
        "drift": "ssh_host_key_mismatch",
        "device": str(device.id),
        "device_name": device.name,
        "key_type": key_type,
        "served": served,
        "expected": sorted(expected),
    }


def _resolve(tenant_id, device_id, key_type, reason, now) -> int:
    from .notify import notify_alert

    firing = list(Alert.objects.filter(
        tenant_id=tenant_id,
        dedup_key=dedup_key(device_id, key_type),
        status=AlertStatus.FIRING,
    ))
    for alert in firing:
        alert.status = AlertStatus.RESOLVED
        alert.resolved_at = now
        alert.last_notified_at = now
        alert.detail = {**(alert.detail or {}), "resolution": reason}
        alert.save(update_fields=["status", "resolved_at", "last_notified_at", "detail"])
        try:
            notify_alert(alert, "resolved")
        except Exception:  # noqa: BLE001
            log.exception("ssh host-key resolve notify failed for %s", alert.dedup_key)
    return len(firing)


def _open(device, target_ip_id, key_type, served, expected, now) -> str:
    from .notify import notify_alert

    detail = _detail(device, key_type, served, expected, now)
    alert, created = Alert.objects.get_or_create(
        tenant_id=device.tenant_id,
        dedup_key=dedup_key(device.id, key_type),
        status=AlertStatus.FIRING,
        defaults={
            "target_ip_id": target_ip_id,
            "kind": "ssh",  # an SSH condition; the drift marker in detail scopes it
            "severity": AlertSeverity.WARNING,
            "check_status": "degraded",
            "opened_at": now,
            "last_status_at": now,
            "detail": detail,
            "last_notified_at": now,
            "notify_count": 1,
        },
    )
    if created:
        try:
            notify_alert(alert, "firing")
        except Exception:  # noqa: BLE001
            log.exception("ssh host-key open notify failed for %s", alert.dedup_key)
        return "opened"
    if alert.detail != detail:
        alert.detail = detail
        alert.save(update_fields=["detail"])
    return "unchanged"


def evaluate_mismatch(*, tenant_id, device_id, key_type, target_ip_id=None) -> str:
    """Reconcile ``ssh_host_key_mismatch`` for one (device, key_type).

    Fires only when the device has ≥1 **uploaded** (expected) key of that type
    and the most-recently-observed key of that type matches none of them. No
    expected key on file, or a match → resolve. Read-only; never writes intent.
    ``target_ip_id`` is the endpoint the observation came from; when omitted (the
    accept/upload path) it falls back to the device's primary/any IP.
    """
    now = timezone.now()
    keys = list(SSHHostKey.objects.filter(
        tenant_id=tenant_id, device_id=device_id, key_type=key_type
    ).select_related("device"))
    expected = {k.fingerprint_sha256 for k in keys if k.uploaded}
    observed = [k for k in keys if k.observed]
    if not expected or not observed:
        _resolve(tenant_id, device_id, key_type,
                 "no expected key to compare, or nothing observed", now)
        return "resolved"
    latest = max(observed, key=lambda k: (k.last_seen or k.created_at))
    if latest.fingerprint_sha256 in expected:
        _resolve(tenant_id, device_id, key_type, "served key matches an expected key", now)
        return "ok"
    device = latest.device
    target_ip_id = target_ip_id or _device_target_ip_id(device)
    if target_ip_id is None:
        # An alert must attach to an IP; a device with none can't carry one.
        # Record nothing rather than crash - the mismatch is still visible on
        # the device's key rows (uploaded vs observed differ).
        log.warning(
            "ssh host-key mismatch on device %s has no IP to alert on", device_id
        )
        return "no-target"
    return _open(device, target_ip_id, key_type, latest.fingerprint_sha256, expected, now)


def _device_target_ip_id(device):
    """Best-effort IP to hang the alert on (primary IP, else any)."""
    if device.primary_ip_id:
        return device.primary_ip_id
    from api.models import IPAddress

    ip = IPAddress.objects.filter(assigned_device=device).values_list("id", flat=True).first()
    return ip


# ─── Accept ──────────────────────────────────────────────────────────────────

def accept_observed(key: SSHHostKey) -> SSHHostKey:
    """Declare an observed host key as expected (mark it ``uploaded``) and
    re-evaluate so any mismatch for its (device, key_type) clears at once."""
    if not key.uploaded:
        key.uploaded = True
        key.save(update_fields=["uploaded"])
    evaluate_mismatch(
        tenant_id=key.tenant_id, device_id=key.device_id, key_type=key.key_type
    )
    return key
