"""Retention / pruning for the time-series tables.

``CheckResult`` grows fast (one row per check per run), so old rows are deleted
on a schedule. ``StateTransition`` is the audit timeline and is kept much
longer. SNMP interface samples feed the utilisation sparklines and are kept
for days. The windows are settings (``MONITORING_RESULT_RETENTION_DAYS`` /
``MONITORING_TRANSITION_RETENTION_DAYS`` /
``MONITORING_SNMP_SAMPLE_RETENTION_DAYS``).

Deletes run in bounded batches so pruning a huge backlog never holds one giant
transaction or blocks writers. A native monthly RANGE partition on
``CheckResult.timestamp`` is the next scaling step (then pruning becomes a cheap
``DROP PARTITION`` instead of a bulk delete) - see the model docstring.

Learned MACs and ARP entries (#284) follow each tenant's **Forget MACs unseen
for** setting instead of a deployment setting: a sighting nobody has seen for
that long is closed (``gone_at = last_seen`` - a switch that died must not keep
locating MACs forever) and closed rows older than the window are deleted.
"""
from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.db.models import F
from django.utils import timezone

from .models import CheckResult, SnmpInterfaceSample, StateTransition

_BATCH = 5000


def _prune_older_than(model, field: str, cutoff, batch: int = _BATCH, *, qs=None) -> int:
    """Delete rows where ``field < cutoff`` in batches; return the count.
    ``qs`` narrows the candidates (one tenant's rows, say)."""
    base = model.objects.all() if qs is None else qs
    total = 0
    while True:
        ids = list(
            base.filter(**{f"{field}__lt": cutoff}).values_list("pk", flat=True)[:batch]
        )
        if not ids:
            break
        deleted, _ = model.objects.filter(pk__in=ids).delete()
        total += deleted
        if len(ids) < batch:
            break
    return total


def _close_unseen(model, tenant_id, cutoff, batch: int = _BATCH) -> int:
    """Close a tenant's present sightings unseen since ``cutoff``, in batches:
    ``gone_at = last_seen``, the last moment anything saw them."""
    total = 0
    while True:
        ids = list(
            model.objects.filter(
                tenant_id=tenant_id, gone_at__isnull=True, last_seen__lt=cutoff
            ).values_list("pk", flat=True)[:batch]
        )
        if not ids:
            break
        total += model.objects.filter(pk__in=ids, gone_at__isnull=True).update(
            gone_at=F("last_seen")
        )
        if len(ids) < batch:
            break
    return total


def prune_mac_sightings(now=None) -> dict:
    """Age learned MACs and ARP entries by each tenant's retention (§5.3)."""
    from core.models import Tenant

    from .mac_tables import MAC_SETTING_DEFAULTS
    from .models import ArpSighting, MacSighting, MonitoringSettings

    now = now or timezone.now()
    days_by_tenant = dict(
        MonitoringSettings.objects.values_list("tenant_id", "mac_retention_days")
    )
    default_days = MAC_SETTING_DEFAULTS["mac_retention_days"]
    out = {"mac_closed": 0, "mac_deleted": 0, "arp_closed": 0, "arp_deleted": 0}
    for tenant_id in Tenant.objects.values_list("pk", flat=True):
        days = max(1, int(days_by_tenant.get(tenant_id) or default_days))
        cutoff = now - timedelta(days=days)
        for model, key in ((MacSighting, "mac"), (ArpSighting, "arp")):
            out[f"{key}_closed"] += _close_unseen(model, tenant_id, cutoff)
            out[f"{key}_deleted"] += _prune_older_than(
                model, "gone_at", cutoff, qs=model.objects.filter(tenant_id=tenant_id)
            )
    return out


def prune(now=None) -> dict:
    now = now or timezone.now()
    result_days = int(getattr(settings, "MONITORING_RESULT_RETENTION_DAYS", 90))
    transition_days = int(getattr(settings, "MONITORING_TRANSITION_RETENTION_DAYS", 365))

    results_deleted = _prune_older_than(
        CheckResult, "timestamp", now - timedelta(days=result_days)
    )
    transitions_deleted = _prune_older_than(
        StateTransition, "at", now - timedelta(days=transition_days)
    )
    sample_days = int(getattr(settings, "MONITORING_SNMP_SAMPLE_RETENTION_DAYS", 3))
    samples_deleted = _prune_older_than(
        SnmpInterfaceSample, "sampled_at", now - timedelta(days=sample_days)
    )
    from .rollups import prune as prune_rollups

    rollups_deleted = prune_rollups(now)
    sightings = prune_mac_sightings(now)
    return {
        "results_deleted": results_deleted,
        "hourly_rollups_deleted": rollups_deleted,
        "transitions_deleted": transitions_deleted,
        "snmp_samples_deleted": samples_deleted,
        "result_retention_days": result_days,
        "transition_retention_days": transition_days,
        "snmp_sample_retention_days": sample_days,
        "mac_sightings_closed": sightings["mac_closed"],
        "mac_sightings_deleted": sightings["mac_deleted"],
        "arp_sightings_closed": sightings["arp_closed"],
        "arp_sightings_deleted": sightings["arp_deleted"],
    }
