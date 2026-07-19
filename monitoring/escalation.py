"""Periodic alert maintenance (A5) — renotify, escalate, flap-dampen.

The check engine opens/resolves alerts *reactively* (per scan batch). This
module runs *on a timer* (``danbyte-alert-maintenance``) over the alerts that
are already firing and applies the time-based policies a per-batch pass can't:

* **Flap dampening** — an alert whose condition has opened many times in a short
  window is marked ``flapping`` and excluded from renotify until it settles, so
  a flapping host can't page on a loop.
* **Escalation** — an alert left firing + unacknowledged past the threshold is
  bumped to ``critical`` and re-notified once (``escalated`` event).
* **Renotify** — a still-firing, unacknowledged, un-silenced, non-flapping alert
  whose last notification is older than the renotify interval gets a reminder.

All three respect ack + silence: acknowledging or silencing an alert stops the
reminders. Policy is per-tenant (``MonitoringSettings``); a tenant with the
defaults off is a no-op.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

from .models import Alert, AlertSeverity, AlertStatus, MonitoringSettings, StateTransition

log = logging.getLogger("monitoring.escalation")

_BAD = {"down", "stale", "degraded"}


def _flap_count(alert, since) -> int:
    """How many times this alert's condition has opened (transitioned *into* a
    bad status) since ``since`` — the flap signal."""
    return StateTransition.objects.filter(
        tenant_id=alert.tenant_id,
        target_ip_id=alert.target_ip_id,
        template_id=alert.template_id,
        to_status__in=_BAD,
        at__gte=since,
    ).count()


def run_alert_maintenance(now=None) -> dict:
    """Sweep firing alerts and apply renotify / escalation / flap policy."""
    from .notify import notify_alert

    now = now or timezone.now()
    firing = list(
        Alert.objects.filter(status=AlertStatus.FIRING).select_related(
            "target_ip", "template"
        )
    )
    if not firing:
        return {"flapping": 0, "escalated": 0, "renotified": 0}

    settings_by_tenant = {
        s.tenant_id: s
        for s in MonitoringSettings.objects.filter(
            tenant_id__in={a.tenant_id for a in firing}
        )
    }

    flapping = escalated = renotified = 0
    for alert in firing:
        ms = settings_by_tenant.get(alert.tenant_id)
        if ms is None:
            continue

        # ── flap detection ──────────────────────────────────────────────
        is_flapping = False
        if ms.flap_threshold:
            window = now - timedelta(minutes=ms.flap_window_minutes)
            is_flapping = _flap_count(alert, window) >= ms.flap_threshold
        if is_flapping != alert.flapping:
            alert.flapping = is_flapping
            alert.save(update_fields=["flapping"])
            if is_flapping:
                flapping += 1

        acked = alert.acknowledged_at is not None
        age = now - alert.opened_at

        # ── escalation (once) ───────────────────────────────────────────
        if (
            ms.escalate_enabled
            and not acked
            and not alert.escalated
            and not is_flapping
            and alert.severity != AlertSeverity.CRITICAL
            and age >= timedelta(minutes=ms.escalate_after_minutes)
        ):
            alert.severity = AlertSeverity.CRITICAL
            alert.escalated = True
            alert.last_notified_at = now
            alert.notify_count = (alert.notify_count or 0) + 1
            alert.save(
                update_fields=["severity", "escalated", "last_notified_at", "notify_count"]
            )
            escalated += 1
            try:
                notify_alert(alert, "escalated")
            except Exception:  # noqa: BLE001
                log.exception("escalation notify failed for %s", alert.dedup_key)
            continue  # escalation already re-notified; skip renotify this pass

        # ── renotify ────────────────────────────────────────────────────
        if (
            ms.renotify_enabled
            and not acked
            and not is_flapping
            and (
                alert.last_notified_at is None
                or alert.last_notified_at
                <= now - timedelta(minutes=ms.renotify_interval_minutes)
            )
        ):
            alert.last_notified_at = now
            alert.notify_count = (alert.notify_count or 0) + 1
            alert.save(update_fields=["last_notified_at", "notify_count"])
            renotified += 1
            try:
                notify_alert(alert, "reminder")
            except Exception:  # noqa: BLE001
                log.exception("renotify failed for %s", alert.dedup_key)

    if escalated or renotified or flapping:
        log.info(
            "alert maintenance: %s flapping, %s escalated, %s renotified",
            flapping,
            escalated,
            renotified,
        )
    return {"flapping": flapping, "escalated": escalated, "renotified": renotified}
