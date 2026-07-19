"""Alerting engine — turn status transitions into stateful alerts.

Called from the worker after each batch with the transitions it produced. A
transition into a *bad* status opens (or updates) a single firing ``Alert`` for
that (IP, check) condition; a recovery (or skip) resolves it.

**Rules (A2).** Which failures alert, and at what severity, is decided by
``AlertRule``s: matchers (kinds / statuses / IP tags / prefix) ANDed, evaluated
in ``weight`` order, first match wins. If a tenant has no enabled rules the
engine falls back to a sensible default so alerting works out of the box.
"""
from __future__ import annotations

import ipaddress
import logging

from .models import Alert, AlertRule, AlertSeverity, AlertStatus

log = logging.getLogger("monitoring.alerts")

# Default severity per bad status when no rules are configured.
_SEVERITY = {
    "down": AlertSeverity.CRITICAL,
    "stale": AlertSeverity.CRITICAL,
    "degraded": AlertSeverity.WARNING,
}
_BAD = set(_SEVERITY)
_CLEARS = {"up", "skipped"}


def _dedup_key(target_ip_id, template_id) -> str:
    return f"{target_ip_id}:{template_id}"


def _ip_matches(rule: AlertRule, ip) -> bool:
    if rule.match_tag_slugs:
        ip_slugs = {t.slug for t in ip.tags.all()}
        if not set(rule.match_tag_slugs) & ip_slugs:
            return False
    if rule.match_prefix_id:
        net = rule.match_prefix.network
        try:
            if net is None or ipaddress.ip_address(ip.ip_address) not in net:
                return False
        except (ValueError, TypeError):
            return False
    return True


def _match_rule(rules: list[AlertRule], ip, kind: str, to_status: str):
    """First enabled rule (weight order) whose matchers all pass, or None."""
    for r in rules:
        if r.match_kinds and kind not in r.match_kinds:
            continue
        if r.match_statuses and to_status not in r.match_statuses:
            continue
        if ip is not None and not _ip_matches(r, ip):
            continue
        return r
    return None


def _resolve_severity(rules, ip, kind, to_status):
    """Return (severity, rule_id, should_open). With rules configured, only a
    matching rule opens an alert; without rules, fall back to the default map."""
    if rules:
        rule = _match_rule(rules, ip, kind, to_status)
        if rule is None:
            return None, None, False
        return rule.severity, rule.id, True
    return _SEVERITY[to_status], None, True


def process_transitions(transitions, now) -> dict:
    """Open / update / resolve alerts from a batch of StateTransitions.

    Alerts are the single notification source: each opened/resolved alert is
    routed to the tenant's channels via ``notify_alert``. (The legacy raw
    ``dispatch_transitions`` path is no longer called from the worker.)
    """
    from api.models import IPAddress
    from .notify import notify_alert

    bad = [tr for tr in transitions if tr.to_status in _BAD]
    clears = [tr for tr in transitions if tr.to_status in _CLEARS]

    # Per-tenant enabled rules + the IPs we'll need to match against.
    rules_by_tenant: dict = {}
    for tid in {tr.tenant_id for tr in bad}:
        rules_by_tenant[tid] = list(
            AlertRule.objects.filter(tenant_id=tid, enabled=True)
            .select_related("match_prefix")
            .order_by("weight")
        )
    ip_map = {
        ip.id: ip
        for ip in IPAddress.objects.filter(
            id__in={tr.target_ip_id for tr in bad}
        ).prefetch_related("tags")
    }

    opened = updated = resolved = 0
    # Newly-opened alerts are grouped per tenant (a burst → one digest);
    # updates + resolves stay individual.
    opened_by_tenant: dict = {}
    individual: list[tuple] = []  # (alert, "firing" | "resolved")
    for tr in bad:
        rules = rules_by_tenant.get(tr.tenant_id, [])
        ip = ip_map.get(tr.target_ip_id)
        severity, rule_id, should_open = _resolve_severity(
            rules, ip, tr.kind, tr.to_status
        )
        if not should_open:
            continue

        key = _dedup_key(tr.target_ip_id, tr.template_id)
        alert, created = Alert.objects.get_or_create(
            tenant_id=tr.tenant_id,
            dedup_key=key,
            status=AlertStatus.FIRING,
            defaults={
                "target_ip_id": tr.target_ip_id,
                "template_id": tr.template_id,
                "rule_id": rule_id,
                "kind": tr.kind,
                "severity": severity,
                "check_status": tr.to_status,
                "opened_at": now,
                "last_status_at": now,
                "detail": tr.detail or {},
                "last_notified_at": now,
                "notify_count": 1,
            },
        )
        if created:
            opened += 1
            opened_by_tenant.setdefault(tr.tenant_id, []).append(alert)
        elif alert.check_status != tr.to_status or alert.severity != severity:
            alert.check_status = tr.to_status
            alert.severity = severity
            alert.rule_id = rule_id
            alert.last_status_at = now
            alert.last_notified_at = now
            alert.notify_count = (alert.notify_count or 0) + 1
            alert.save(
                update_fields=[
                    "check_status",
                    "severity",
                    "rule_id",
                    "last_status_at",
                    "last_notified_at",
                    "notify_count",
                ]
            )
            updated += 1
            individual.append((alert, "firing"))

    for tr in clears:
        key = _dedup_key(tr.target_ip_id, tr.template_id)
        firing = list(
            Alert.objects.filter(
                tenant_id=tr.tenant_id, dedup_key=key, status=AlertStatus.FIRING
            ).select_related("target_ip", "template")
        )
        for alert in firing:
            alert.status = AlertStatus.RESOLVED
            alert.resolved_at = now
            alert.last_notified_at = now
            alert.save(
                update_fields=["status", "resolved_at", "last_notified_at"]
            )
            resolved += 1
            individual.append((alert, "resolved"))

    _dispatch_notifications(opened_by_tenant, individual)

    if opened or resolved:
        log.info("alerts: %s opened, %s updated, %s resolved", opened, updated, resolved)
    return {"opened": opened, "updated": updated, "resolved": resolved}


def _dispatch_notifications(opened_by_tenant: dict, individual: list) -> None:
    """Route freshly-opened alerts (grouped per tenant when a burst exceeds the
    tenant's threshold) and the individual update/resolve notifications."""
    from .models import MonitoringSettings
    from .notify import notify_alert, notify_alert_group

    settings_by_tenant = {
        s.tenant_id: s
        for s in MonitoringSettings.objects.filter(
            tenant_id__in=list(opened_by_tenant)
        )
    }
    for tid, alerts in opened_by_tenant.items():
        ms = settings_by_tenant.get(tid)
        group = ms and ms.group_notifications and len(alerts) >= ms.group_threshold
        if group:
            try:
                notify_alert_group(tid, alerts, "firing")
            except Exception:  # noqa: BLE001
                log.exception("grouped notify failed for tenant %s", tid)
        else:
            individual = [(a, "firing") for a in alerts] + individual

    for alert, event in individual:
        try:
            notify_alert(alert, event)
        except Exception:  # noqa: BLE001 — notification must not break the engine
            log.exception("notify_alert failed for %s", alert.dedup_key)
