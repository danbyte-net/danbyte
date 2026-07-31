"""ACME certificate renewal — re-issue certs before they expire.

Certificates issued through the ACME engine (an :class:`AcmeOrder` with an
``issued_certificate``) are re-issued automatically once they cross a fraction of
their lifetime, so short-lived certs — step-ca defaults to **24 hours** — never
lapse. The threshold is a *fraction* of the certificate's own lifetime, so the
same rule fits a 24-hour cert (renew in the last 8h) and a 90-day one (renew in
the last 30 days).

Only issuers with a DNS-01 **auto-publisher** renew unattended; manual issuers
can't self-validate, so they're counted and left for the operator (the expiry
alerting already warns about them). Renewal reuses the request's existing CSR
(same key); a renewed cert lands as a new :class:`Certificate` row, exactly like
a first issuance.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from .models import AcmeOrder, CertificateRequest

log = logging.getLogger("monitoring.acme_renew")

# Renew once a certificate is this far through its lifetime (2/3 elapsed leaves
# the final third as the renewal window: 8h of a 24h cert, 30d of a 90d cert).
RENEW_AFTER_FRACTION = 2 / 3


def _renew_due(cert, now) -> bool:
    total = (cert.not_after - cert.not_before).total_seconds()
    if total <= 0:
        return True  # degenerate validity — treat as due
    elapsed = (now - cert.not_before).total_seconds()
    return elapsed >= total * RENEW_AFTER_FRACTION


def renew_due(now=None, enqueue: bool = True) -> dict:
    """Find ACME-issued certs past their renewal point and re-issue them.

    Returns counts: ``checked`` (requests with a live ACME cert), ``renewed``
    (renewal orders opened), ``skipped_manual`` (due, but the issuer has no
    auto-publisher), ``in_flight`` (due, but a renewal is already open).
    """
    now = now or timezone.now()
    import django_rq

    checked = renewed = skipped_manual = in_flight = 0
    open_states = [AcmeOrder.Status.PENDING, AcmeOrder.Status.PROCESSING]

    req_ids = list(
        AcmeOrder.objects.values_list("request_id", flat=True).distinct()
    )
    requests = CertificateRequest.objects.filter(id__in=req_ids).select_related(
        "tenant"
    )
    for req in requests:
        latest = (
            req.acme_orders.filter(
                status=AcmeOrder.Status.VALID, issued_certificate__isnull=False
            )
            .select_related("issuer", "issued_certificate")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        checked += 1
        if not _renew_due(latest.issued_certificate, now):
            continue
        issuer = latest.issuer
        if not issuer.enabled or not issuer.dns_provider:
            skipped_manual += 1  # manual issuer can't self-validate
            continue
        if req.acme_orders.filter(status__in=open_states).exists():
            in_flight += 1  # a renewal is already running — don't stack another
            continue

        order = AcmeOrder.objects.create(
            tenant=req.tenant,
            issuer=issuer,
            request=req,
            challenge_type=latest.challenge_type,
            status=AcmeOrder.Status.PROCESSING,
        )
        if enqueue:
            try:
                django_rq.get_queue("default").enqueue(
                    "monitoring.acme_engine.issue_order_job", str(order.id)
                )
            except Exception as exc:  # noqa: BLE001 — Redis down: record, continue
                order.status = AcmeOrder.Status.ERRORED
                order.error = f"could not enqueue renewal: {exc}"
                order.save(update_fields=["status", "error", "updated_at"])
                log.warning("acme renewal enqueue failed for %s: %s", req.id, exc)
        renewed += 1

    return {
        "checked": checked,
        "renewed": renewed,
        "skipped_manual": skipped_manual,
        "in_flight": in_flight,
    }
