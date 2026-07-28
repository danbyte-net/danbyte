"""Certificate expiry alerting (X2) — feed the existing alert engine.

An inventory that only *records* expiry dates is a spreadsheet with extra steps.
This module turns the observed bindings into ordinary :class:`Alert` rows on the
same path :mod:`monitoring.alerts` uses, so certificate expiry inherits ack,
silence/maintenance windows, renotify, escalation, grouping and every configured
notification channel for free. There is no second notification mechanism.

The one idea that makes it work
-------------------------------
**The alert is about the endpoint, not the certificate row.**

A renewal is a *new* :class:`Certificate` (new bytes → new fingerprint → new
row). If the alert were keyed on the certificate, every renewal would strand a
firing alert on a row nobody serves any more, and nothing would ever resolve it
— the expiry inventory would fill with permanent noise within one renewal cycle.

So the dedup key is the **endpoint** — ``(IP, port, SNI)``, which is exactly
what a renewal does *not* change. Evaluation asks "what is this endpoint
serving *now*?", which after a renewal is the new certificate, which is healthy,
which resolves the same alert row that was firing for the old one.

States
------
Four, because "expired" is not just "very urgent":

``expired``
    Past ``not_after``. Anything that validates is already failing. Critical,
    and recorded with ``check_status="down"`` — it is a failure, not a warning.
``expiring_critical``
    Inside ``cert_expiry_critical_days`` (default 7).
``expiring_warning``
    Inside ``cert_expiry_warning_days`` (default 30).
``ok``
    Beyond the warning window — resolves a firing alert.

Silence, not noise
------------------
A binding whose ``last_seen`` is older than ``cert_binding_stale_days`` is
**not** alerted on: nobody is served by a certificate we can no longer see, and
an inventory that pages about decommissioned endpoints gets muted wholesale. An
endpoint that has gone unreachable is already covered by its own check alert,
which is the honest place for "we cannot reach this".

Only end-entity (leaf, ``chain_depth == 0``) certificates are alerted on. An
intermediate or root in the presented chain is the CA's renewal problem and
would double every alert.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

from .models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    CertificateBinding,
    MonitoringSettings,
)

log = logging.getLogger("monitoring.cert_expiry")

# Dedup-key namespace. Ordinary check alerts key on "<ip uuid>:<template uuid>";
# this prefix makes a collision with them impossible.
DEDUP_PREFIX = "cert-expiry:"

EXPIRED = "expired"
EXPIRING_CRITICAL = "expiring_critical"
EXPIRING_WARNING = "expiring_warning"
OK = "ok"

# Used when a tenant has no MonitoringSettings row — alerting works out of the
# box, exactly as the check-alert engine falls back to a default severity map.
DEFAULTS = {
    "enabled": True,
    "warning_days": 30,
    "critical_days": 7,
    "stale_days": 7,
}

_SEVERITY = {
    EXPIRED: AlertSeverity.CRITICAL,
    EXPIRING_CRITICAL: AlertSeverity.CRITICAL,
    EXPIRING_WARNING: AlertSeverity.WARNING,
}
# An expired certificate is a failure, not an impairment; an approaching expiry
# is an impairment. This is what channel `on_statuses` filters see.
_CHECK_STATUS = {
    EXPIRED: "down",
    EXPIRING_CRITICAL: "degraded",
    EXPIRING_WARNING: "degraded",
}


def dedup_key(endpoint_key: str) -> str:
    return f"{DEDUP_PREFIX}{endpoint_key}"


def thresholds(settings_row: MonitoringSettings | None) -> dict:
    """Per-tenant thresholds, falling back to :data:`DEFAULTS`.

    ``critical_days`` is clamped to ``warning_days`` so a misconfiguration
    (critical above warning) degrades to "everything is critical" rather than
    silently swallowing the warning state.
    """
    if settings_row is None:
        return dict(DEFAULTS)
    warning = int(settings_row.cert_expiry_warning_days)
    critical = min(int(settings_row.cert_expiry_critical_days), warning)
    return {
        "enabled": bool(settings_row.cert_expiry_alerts_enabled),
        "warning_days": warning,
        "critical_days": critical,
        "stale_days": int(settings_row.cert_binding_stale_days),
    }


def classify(certificate, limits: dict, now) -> str:
    """Which of the four states this certificate is in, right now.

    Derived from ``not_after`` at call time — never from a stored flag, so a row
    that has not been re-observed cannot report itself healthy.
    """
    if certificate.not_after <= now:
        return EXPIRED
    remaining = certificate.not_after - now
    if remaining <= timedelta(days=limits["critical_days"]):
        return EXPIRING_CRITICAL
    if remaining <= timedelta(days=limits["warning_days"]):
        return EXPIRING_WARNING
    return OK


def current_bindings(*, tenant_ids=None, endpoint_keys=None):
    """The newest leaf binding per endpoint — i.e. what each endpoint serves now.

    After a renewal this is the *new* certificate's binding: the old one is
    still on file (history is never deleted) but it is no longer current, so it
    no longer drives the endpoint's alert.
    """
    qs = CertificateBinding.objects.filter(chain_depth=0).select_related(
        "certificate", "target_ip"
    )
    if tenant_ids is not None:
        qs = qs.filter(tenant_id__in=list(tenant_ids))
    if endpoint_keys is not None:
        qs = qs.filter(endpoint_key__in=list(endpoint_keys))

    newest: dict[tuple, CertificateBinding] = {}
    for binding in qs.order_by("tenant_id", "endpoint_key", "-last_seen", "-created_at"):
        newest.setdefault((binding.tenant_id, binding.endpoint_key), binding)
    return list(newest.values())


def _detail(binding, state: str, limits: dict, now) -> dict:
    cert = binding.certificate
    return {
        "cert_state": state,
        "endpoint": binding.endpoint_label,
        "endpoint_key": binding.endpoint_key,
        "port": binding.port,
        "server_name": binding.server_name,
        "certificate_id": str(cert.id),
        "fingerprint_sha256": cert.fingerprint_sha256,
        "subject_cn": cert.subject_cn,
        "issuer_cn": cert.issuer_cn,
        "not_after": cert.not_after.isoformat(),
        "days_until_expiry": round(
            (cert.not_after - now).total_seconds() / 86400, 2
        ),
        "binding_id": str(binding.id),
        "binding_last_seen": binding.last_seen.isoformat(),
        "warning_days": limits["warning_days"],
        "critical_days": limits["critical_days"],
    }


def _resolve(tenant_id: str, endpoint_key: str, reason: str, now) -> int:
    """Resolve the endpoint's firing expiry alert, if it has one.

    The same row that fired for the old certificate resolves once the endpoint
    serves a healthy one — which is the whole point of keying on the endpoint.
    """
    from .notify import notify_alert

    firing = list(
        Alert.objects.filter(
            tenant_id=tenant_id,
            dedup_key=dedup_key(endpoint_key),
            status=AlertStatus.FIRING,
        ).select_related("target_ip", "template")
    )
    for alert in firing:
        alert.status = AlertStatus.RESOLVED
        alert.resolved_at = now
        alert.last_notified_at = now
        alert.detail = {**(alert.detail or {}), "resolution": reason}
        alert.save(
            update_fields=["status", "resolved_at", "last_notified_at", "detail"]
        )
        try:
            notify_alert(alert, "resolved")
        except Exception:  # noqa: BLE001 — notification must not break the engine
            log.exception("resolve notify failed for %s", alert.dedup_key)
    return len(firing)


def _open_or_update(binding, state: str, limits: dict, now) -> str:
    """Open the endpoint's alert, or move it between states. Returns the action."""
    from .notify import notify_alert

    detail = _detail(binding, state, limits, now)
    alert, created = Alert.objects.get_or_create(
        tenant_id=binding.tenant_id,
        dedup_key=dedup_key(binding.endpoint_key),
        status=AlertStatus.FIRING,
        defaults={
            "target_ip_id": binding.target_ip_id,
            "template_id": None,
            "kind": "tls_cert",
            "severity": _SEVERITY[state],
            "check_status": _CHECK_STATUS[state],
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
            log.exception("open notify failed for %s", alert.dedup_key)
        return "opened"

    previous = (alert.detail or {}).get("cert_state")
    if previous == state and alert.severity == _SEVERITY[state]:
        # Same state — refresh the payload silently so it points at whatever the
        # endpoint serves now (a renewal *into* the warning window keeps the
        # alert open but must not keep naming the retired certificate), without
        # re-paging anyone.
        if alert.detail != detail:
            alert.detail = detail
            alert.save(update_fields=["detail"])
        return "unchanged"

    alert.severity = _SEVERITY[state]
    alert.check_status = _CHECK_STATUS[state]
    alert.detail = detail
    alert.last_status_at = now
    alert.last_notified_at = now
    alert.notify_count = (alert.notify_count or 0) + 1
    alert.save(
        update_fields=[
            "severity", "check_status", "detail", "last_status_at",
            "last_notified_at", "notify_count",
        ]
    )
    try:
        notify_alert(alert, "firing")
    except Exception:  # noqa: BLE001
        log.exception("update notify failed for %s", alert.dedup_key)
    return "updated"


def evaluate_endpoints(*, tenant_ids=None, endpoint_keys=None, now=None) -> dict:
    """Evaluate expiry for the endpoints in scope and reconcile their alerts.

    Called reactively after every ``tls_cert`` observation (scoped to the
    endpoints just seen, so a renewal resolves immediately) and by the nightly
    sweep with no scope at all (so time passing is enough to open an alert).
    """
    now = now or timezone.now()
    bindings = current_bindings(tenant_ids=tenant_ids, endpoint_keys=endpoint_keys)
    if not bindings:
        return {"opened": 0, "updated": 0, "resolved": 0, "stale": 0, "checked": 0}

    settings_by_tenant = {
        s.tenant_id: s
        for s in MonitoringSettings.objects.filter(
            tenant_id__in={b.tenant_id for b in bindings}
        )
    }

    counts = {"opened": 0, "updated": 0, "resolved": 0, "stale": 0,
              "checked": len(bindings)}
    for binding in bindings:
        limits = thresholds(settings_by_tenant.get(binding.tenant_id))
        if not limits["enabled"]:
            # Turning alerting off leaves no un-resolvable strays behind.
            counts["resolved"] += _resolve(
                binding.tenant_id, binding.endpoint_key,
                "certificate expiry alerting disabled", now,
            )
            continue

        stale_after = now - timedelta(days=limits["stale_days"])
        if binding.last_seen < stale_after:
            counts["stale"] += 1
            counts["resolved"] += _resolve(
                binding.tenant_id, binding.endpoint_key,
                "endpoint no longer observed serving this certificate", now,
            )
            continue

        state = classify(binding.certificate, limits, now)
        if state == OK:
            counts["resolved"] += _resolve(
                binding.tenant_id, binding.endpoint_key,
                "endpoint now serves a certificate outside the warning window",
                now,
            )
            continue

        action = _open_or_update(binding, state, limits, now)
        if action in counts:
            counts[action] += 1

    if counts["opened"] or counts["updated"] or counts["resolved"]:
        log.info(
            "certificate expiry: %s opened, %s updated, %s resolved (%s stale)",
            counts["opened"], counts["updated"], counts["resolved"], counts["stale"],
        )

    # Assignment drift (S1) rides the same endpoint pass — reactive after an
    # observation, and the nightly sweep — so a served-vs-declared mismatch
    # opens/resolves on the same schedule as expiry. Isolated: a drift problem
    # must never lose the expiry reconciliation above.
    try:
        from .cert_drift import evaluate_mismatch

        evaluate_mismatch(
            tenant_ids=tenant_ids, endpoint_keys=endpoint_keys, now=now
        )
    except Exception:  # noqa: BLE001 — mismatch drift must not break expiry
        log.exception("certificate mismatch evaluation failed")

    return counts


def sweep(now=None) -> dict:
    """Full pass over every endpoint — the timer entry point.

    Also resolves any firing expiry alert whose endpoint has no leaf binding
    left at all (the certificate row was deleted out from under it), so the
    alert list can never accumulate rows nothing can ever clear.
    """
    now = now or timezone.now()
    counts = evaluate_endpoints(now=now)

    live = {
        f"{DEDUP_PREFIX}{key}"
        for key in CertificateBinding.objects.filter(chain_depth=0)
        .values_list("endpoint_key", flat=True)
        .distinct()
    }
    orphans = Alert.objects.filter(
        status=AlertStatus.FIRING, dedup_key__startswith=DEDUP_PREFIX
    ).exclude(dedup_key__in=live)
    for alert in orphans.select_related("target_ip", "template"):
        counts["resolved"] += _resolve(
            alert.tenant_id, alert.dedup_key[len(DEDUP_PREFIX):],
            "no binding remains for this endpoint", now,
        )

    # Same orphan cleanup for mismatch drift alerts (endpoint's leaf binding
    # gone). Isolated so an issue here can't lose the expiry sweep above.
    try:
        from .cert_drift import sweep_orphans

        counts["resolved"] += sweep_orphans(now)
    except Exception:  # noqa: BLE001 — mismatch sweep must not break expiry
        log.exception("certificate mismatch orphan sweep failed")

    return counts
