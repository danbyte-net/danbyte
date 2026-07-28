"""Assignment drift (S1) — the endpoint serves a certificate other than the one
its object was declared to present.

This is the source-of-truth half of the certificate feature: an operator
*assigns* certificate X to a device / IP / VM (intent), and the TLS observation
becomes drift against that intent. It folds into the **same endpoint alert path**
as expiry (X1/X2): :func:`monitoring.cert_expiry.evaluate_endpoints` calls
:func:`evaluate_mismatch` on every reactive pass (after an observation) and on
the nightly sweep, so ``cert_mismatch`` opens/resolves ordinary :class:`Alert`
rows through the alert engine — ack, silence, renotify and every channel come for
free, and there is no parallel mechanism.

What fires
----------
For each endpoint (the newest leaf :class:`CertificateBinding`, i.e. what the
endpoint serves now) whose owning object has **≥1 assigned certificate**:

* served fingerprint matches one of the assignments → healthy, **resolve**;
* served fingerprint matches none → ``cert_mismatch`` fires.

An endpoint whose object has *no* assignment drifts on nothing (that is the
optional ``cert_unassigned``, deferred to S3) and resolves any stale mismatch.

Endpoint → object → assignment
------------------------------
The binding names an ``(IPAddress, port, SNI)`` endpoint. An assignment is
resolved by walking the IP outward:

* **direct** — an assignment to that IP (``object_type="api.ipaddress"``);
* **inherited** — an assignment to the Device the IP is on
  (``ip.assigned_device`` → ``object_type="api.device"``) or the VM
  (``ip.assigned_vm`` → ``object_type="api.virtualmachine"``); a device-level
  declaration applies to every endpoint of that device.

Read-only
---------
Detection never writes intent. Accepting the drift
(:func:`accept_cert_mismatch`) is the only path that creates/replaces an
assignment, mirroring how ``snmp_drift.apply_drift_action`` accepts other kinds.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.db.models import Q
from django.utils import timezone

from .cert_expiry import current_bindings, thresholds
from .models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    CertificateAssignment,
    MonitoringSettings,
)

log = logging.getLogger("monitoring.cert_drift")

# Dedup-key namespace, distinct from expiry ("cert-expiry:") and ordinary check
# alerts ("<ip>:<template>"), so a mismatch and an expiry alert can coexist on
# the same endpoint without colliding.
DEDUP_PREFIX = "cert-mismatch:"


def dedup_key(endpoint_key: str) -> str:
    return f"{DEDUP_PREFIX}{endpoint_key}"


def _target_refs(binding) -> list[tuple[str, str]]:
    """The ``(object_type, object_id)`` pairs that could carry an assignment for
    this endpoint: its IP directly, plus the device/VM the IP is assigned to."""
    ip = binding.target_ip
    refs = [("api.ipaddress", str(ip.id))]
    if ip.assigned_device_id:
        refs.append(("api.device", str(ip.assigned_device_id)))
    if ip.assigned_vm_id:
        refs.append(("api.virtualmachine", str(ip.assigned_vm_id)))
    return refs


def assigned_fingerprints(binding) -> tuple[set[str], list[dict]]:
    """The fingerprints declared for this endpoint's object, and a compact list
    of the assignments (for the alert detail). Tenant-scoped."""
    refs = _target_refs(binding)
    q = Q()
    for ot, oid in refs:
        q |= Q(object_type=ot, object_id=oid)
    rows = (
        CertificateAssignment.objects.filter(tenant_id=binding.tenant_id)
        .filter(q)
        .select_related("certificate")
    )
    fingerprints: set[str] = set()
    declared: list[dict] = []
    for a in rows:
        fingerprints.add(a.certificate.fingerprint_sha256)
        declared.append({
            "assignment_id": str(a.id),
            "object_type": a.object_type,
            "object_id": a.object_id,
            "certificate_id": str(a.certificate_id),
            "fingerprint_sha256": a.certificate.fingerprint_sha256,
            "subject_cn": a.certificate.subject_cn,
        })
    return fingerprints, declared


def _detail(binding, declared, now) -> dict:
    cert = binding.certificate
    return {
        "drift": "cert_mismatch",
        "endpoint": binding.endpoint_label,
        "endpoint_key": binding.endpoint_key,
        "port": binding.port,
        "server_name": binding.server_name,
        "binding_id": str(binding.id),
        "binding_last_seen": binding.last_seen.isoformat(),
        # What is actually being served.
        "served_certificate_id": str(cert.id),
        "served_fingerprint_sha256": cert.fingerprint_sha256,
        "served_subject_cn": cert.subject_cn,
        "served_not_after": cert.not_after.isoformat(),
        # What was declared (any of these would clear the drift).
        "assigned": declared,
    }


def _resolve(tenant_id, endpoint_key: str, reason: str, now) -> int:
    """Resolve the endpoint's firing mismatch alert, if any."""
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
            log.exception("mismatch resolve notify failed for %s", alert.dedup_key)
    return len(firing)


def _open_or_update(binding, declared, now) -> str:
    """Open the endpoint's mismatch alert, or refresh its payload silently."""
    from .notify import notify_alert

    detail = _detail(binding, declared, now)
    alert, created = Alert.objects.get_or_create(
        tenant_id=binding.tenant_id,
        dedup_key=dedup_key(binding.endpoint_key),
        status=AlertStatus.FIRING,
        defaults={
            "target_ip_id": binding.target_ip_id,
            "template_id": None,
            # A mismatch is an endpoint TLS condition, like expiry — reuse the
            # tls_cert kind rather than minting a new one; the drift marker in
            # ``detail`` and the dedup namespace distinguish it.
            "kind": "tls_cert",
            # Drift, not an outage: the endpoint answers TLS fine, it just isn't
            # serving the declared certificate.
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
            log.exception("mismatch open notify failed for %s", alert.dedup_key)
        return "opened"

    # Already firing — refresh the payload silently (a renewal to another wrong
    # cert keeps it firing but must stop naming the retired one) without paging.
    if alert.detail != detail:
        alert.detail = detail
        alert.save(update_fields=["detail"])
    return "unchanged"


def evaluate_mismatch(*, tenant_ids=None, endpoint_keys=None, now=None) -> dict:
    """Reconcile ``cert_mismatch`` for the endpoints in scope.

    Called from :func:`monitoring.cert_expiry.evaluate_endpoints`, so it runs on
    the same reactive pass (scoped to the endpoints just observed) and the
    nightly sweep (no scope). Read-only w.r.t. intent — it only opens/resolves
    alerts, never writes an assignment.
    """
    now = now or timezone.now()
    bindings = current_bindings(tenant_ids=tenant_ids, endpoint_keys=endpoint_keys)
    counts = {"opened": 0, "unchanged": 0, "resolved": 0, "checked": len(bindings)}
    if not bindings:
        return counts

    settings_by_tenant = {
        s.tenant_id: s
        for s in MonitoringSettings.objects.filter(
            tenant_id__in={b.tenant_id for b in bindings}
        )
    }

    for binding in bindings:
        limits = thresholds(settings_by_tenant.get(binding.tenant_id))
        # A mismatch on an endpoint we can no longer see is noise, exactly as for
        # expiry — the endpoint's own check owns "unreachable".
        stale_after = now - timedelta(days=limits["stale_days"])
        if binding.last_seen < stale_after:
            counts["resolved"] += _resolve(
                binding.tenant_id, binding.endpoint_key,
                "endpoint no longer observed", now,
            )
            continue

        fingerprints, declared = assigned_fingerprints(binding)
        if not fingerprints:
            # No intent to drift against (undocumented cert = S3, deferred).
            counts["resolved"] += _resolve(
                binding.tenant_id, binding.endpoint_key,
                "endpoint's object has no assigned certificate", now,
            )
            continue

        if binding.certificate.fingerprint_sha256 in fingerprints:
            counts["resolved"] += _resolve(
                binding.tenant_id, binding.endpoint_key,
                "served certificate matches an assignment", now,
            )
            continue

        counts[_open_or_update(binding, declared, now)] += 1

    if counts["opened"] or counts["resolved"]:
        log.info(
            "certificate mismatch: %s opened, %s resolved (%s checked)",
            counts["opened"], counts["resolved"], counts["checked"],
        )
    return counts


def sweep_orphans(now=None) -> int:
    """Resolve any firing mismatch alert whose endpoint has no leaf binding left
    (the certificate row was deleted out from under it), so the alert list can
    never accumulate rows nothing can clear. Mirrors the expiry orphan sweep."""
    from .models import CertificateBinding

    now = now or timezone.now()
    live = {
        dedup_key(key)
        for key in CertificateBinding.objects.filter(chain_depth=0)
        .values_list("endpoint_key", flat=True)
        .distinct()
    }
    orphans = Alert.objects.filter(
        status=AlertStatus.FIRING, dedup_key__startswith=DEDUP_PREFIX
    ).exclude(dedup_key__in=live)
    resolved = 0
    for alert in orphans.select_related("target_ip", "template"):
        resolved += _resolve(
            alert.tenant_id, alert.dedup_key[len(DEDUP_PREFIX):],
            "no binding remains for this endpoint", now,
        )
    return resolved


def accept_cert_mismatch(tenant, binding, *, notes="") -> CertificateAssignment:
    """Accept the drift: declare the **served** certificate on the endpoint's IP.

    Mirrors ``snmp_drift.apply_drift_action``'s accept semantics — reality flows
    into intent only on an explicit accept. We create/replace the *most specific*
    assignment (an IP-level one on the binding's IP) to point at what is actually
    served, so the mismatch resolves; broader device/VM assignments are left
    alone (the IP-level one is more specific and now matches). Re-evaluates the
    endpoint immediately so the alert clears without waiting for the next poll.

    Returns the assignment. Raises ``ValueError`` on a cross-tenant binding.
    """
    served = binding.certificate
    if served.tenant_id != tenant.id or binding.tenant_id != tenant.id:
        raise ValueError("binding belongs to a different tenant")

    ip_id = str(binding.target_ip_id)
    # Replace: drop any IP-level assignment on this IP that points elsewhere.
    CertificateAssignment.objects.filter(
        tenant=tenant, object_type="api.ipaddress", object_id=ip_id
    ).exclude(certificate=served).delete()
    assignment, _ = CertificateAssignment.objects.get_or_create(
        tenant=tenant,
        certificate=served,
        object_type="api.ipaddress",
        object_id=ip_id,
        defaults={"notes": notes},
    )
    evaluate_mismatch(
        tenant_ids={tenant.id}, endpoint_keys={binding.endpoint_key}
    )
    return assignment
