"""Certificate digest — a periodic, certificate-focused summary email.

This is deliberately *separate* from the monitoring digest. Certificate expiry
is the one class of problem where "you find out when it breaks" is a paged
outage, so a certificate summary should never be buried inside a general status
email that an operator has learned to skim. The immediate, per-certificate
alerts already fire in real time through the notification channels
(:mod:`monitoring.cert_expiry` → :mod:`monitoring.notify`); this digest is the
recurring "here is everything approaching expiry, at a glance" companion.

What it reports, per tenant:

* **Expired** and **expiring** leaf certificates actually served on the wire
  (from the newest binding per endpoint — what each endpoint serves *now*).
* **Declared** (uploaded + assigned, not-yet-observed) certificates approaching
  expiry — the source-of-truth certs :mod:`monitoring.cert_expiry` also covers.
* **Recent renewals/changes** — endpoints now serving a different certificate
  than before, inside the window.

:func:`cert_summary` returns just the headline counts so the general monitoring
digest can carry an "overall certificate status" strip without duplicating the
whole report.

Scheduling reuses the digest cadence (:func:`run_scheduled_cert_digests`, run by
the same daily timer as the monitoring digest) but is gated by its own
``cert_digest_enabled`` flag and tracked by its own ``cert_digest_last_run`` so
the two emails are independent — a tenant can run one, both, or neither.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

from core import email as ek

log = logging.getLogger("danbyte.cert_digest")

# Windows this digest looks back over for "recent changes".
DEFAULT_CHANGE_WINDOW_DAYS = 7
_MAX_ROWS = 100  # cap any single list so a large estate can't produce a huge mail


def _deployment_name() -> str:
    from core.models import DeploymentSettings

    return DeploymentSettings.load().deployment_name or "Danbyte"


def _base_url() -> str:
    from core.models import DeploymentSettings

    return (DeploymentSettings.load().public_base_url or "").rstrip("/")


def _classified_bindings(tenant, now):
    """The current leaf binding per endpoint, split by expiry state."""
    from .cert_expiry import (
        EXPIRED,
        EXPIRING_CRITICAL,
        EXPIRING_WARNING,
        classify,
        current_bindings,
        thresholds,
    )
    from .models import MonitoringSettings

    row = MonitoringSettings.objects.filter(tenant_id=tenant.id).first()
    limits = thresholds(row)
    stale_after = now - timedelta(days=limits["stale_days"])

    buckets = {EXPIRED: [], EXPIRING_CRITICAL: [], EXPIRING_WARNING: []}
    for b in current_bindings(tenant_ids=[tenant.id]):
        if b.last_seen < stale_after:
            continue  # nobody serves this any more — the alert engine ignores it too
        state = classify(b.certificate, limits, now)
        if state in buckets:
            days = round((b.certificate.not_after - now).total_seconds() / 86400, 1)
            buckets[state].append(
                {
                    "endpoint": b.endpoint_label,
                    "subject_cn": b.certificate.subject_cn or "—",
                    "fingerprint": b.certificate.fingerprint_sha256,
                    "not_after": b.certificate.not_after,
                    "days": days,
                }
            )
    for rows in buckets.values():
        rows.sort(key=lambda r: r["days"])
    return buckets, limits


def _declared_expiring(tenant, now, limits):
    """Uploaded + assigned certs (not observed on the wire) approaching expiry."""
    from .cert_expiry import EXPIRED, EXPIRING_CRITICAL, EXPIRING_WARNING, classify
    from .models import CertificateAssignment

    out = []
    seen = set()
    qs = CertificateAssignment.objects.select_related("certificate").filter(
        tenant_id=tenant.id,
        certificate__uploaded=True,
        certificate__observed=False,
    )
    for a in qs:
        cert = a.certificate
        if cert.id in seen:
            continue
        state = classify(cert, limits, now)
        if state in (EXPIRED, EXPIRING_CRITICAL, EXPIRING_WARNING):
            seen.add(cert.id)
            days = round((cert.not_after - now).total_seconds() / 86400, 1)
            out.append(
                {
                    "subject_cn": cert.subject_cn or cert.name or "—",
                    "fingerprint": cert.fingerprint_sha256,
                    "not_after": cert.not_after,
                    "days": days,
                    "object_type": a.object_type,
                }
            )
    out.sort(key=lambda r: r["days"])
    return out


def _recent_changes(tenant, since):
    """Endpoints now serving a *different* certificate than before, in-window.

    A renewal is a new certificate row (new fingerprint). An endpoint whose
    current leaf certificate first appeared inside the window, and which also has
    an older binding on file, has rotated its certificate — worth surfacing.
    """
    from .cert_expiry import current_bindings
    from .models import CertificateBinding

    # endpoint_keys that had a binding predating the window (so a new cert = a
    # change, not a first observation).
    had_before = set(
        CertificateBinding.objects.filter(
            tenant_id=tenant.id, chain_depth=0, first_seen__lt=since
        ).values_list("endpoint_key", flat=True)
    )
    changes = []
    for b in current_bindings(tenant_ids=[tenant.id]):
        if b.first_seen >= since and b.endpoint_key in had_before:
            changes.append(
                {
                    "endpoint": b.endpoint_label,
                    "subject_cn": b.certificate.subject_cn or "—",
                    "fingerprint": b.certificate.fingerprint_sha256,
                    "at": b.first_seen,
                }
            )
    changes.sort(key=lambda c: c["at"], reverse=True)
    return changes


def cert_summary(tenant, now=None, *, window_days=DEFAULT_CHANGE_WINDOW_DAYS) -> dict:
    """Headline certificate counts for a tenant — used by both this digest and
    the general monitoring digest's overall certificate strip."""
    from .cert_expiry import EXPIRED, EXPIRING_CRITICAL, EXPIRING_WARNING

    now = now or timezone.now()
    since = now - timedelta(days=window_days)
    buckets, limits = _classified_bindings(tenant, now)
    declared = _declared_expiring(tenant, now, limits)
    changes = _recent_changes(tenant, since)
    return {
        "expired": len(buckets[EXPIRED]),
        "expiring_critical": len(buckets[EXPIRING_CRITICAL]),
        "expiring_warning": len(buckets[EXPIRING_WARNING]),
        "declared_expiring": len(declared),
        "changes": len(changes),
        "buckets": buckets,
        "declared": declared,
        "recent_changes": changes,
        "since": since,
        "now": now,
    }


def has_content(summary: dict) -> bool:
    """Whether a cert digest has anything worth sending."""
    return any(
        summary[k]
        for k in ("expired", "expiring_critical", "expiring_warning",
                  "declared_expiring", "changes")
    )


# ── rendering ────────────────────────────────────────────────────────────────

def _fmt_days(days: float) -> str:
    if days < 0:
        return f"expired {abs(round(days))}d ago"
    if days < 1:
        return "expires today"
    return f"{round(days)}d left"


def render_text(summary: dict, tenant_name: str) -> str:
    from .cert_expiry import EXPIRED, EXPIRING_CRITICAL, EXPIRING_WARNING

    d = summary
    lines = [
        f"Certificate digest — {tenant_name}",
        f"As of {d['now']:%Y-%m-%d %H:%M}",
        "",
        f"Expired: {d['expired']}   Critical: {d['expiring_critical']}   "
        f"Warning: {d['expiring_warning']}   Declared: {d['declared_expiring']}   "
        f"Changed: {d['changes']}",
    ]
    labels = [
        (EXPIRED, "Expired (served)"),
        (EXPIRING_CRITICAL, "Expiring — critical"),
        (EXPIRING_WARNING, "Expiring — warning"),
    ]
    for state, heading in labels:
        rows = d["buckets"][state][:_MAX_ROWS]
        if not rows:
            continue
        lines += ["", f"{heading}:"]
        for r in rows:
            lines.append(
                f"  {r['endpoint']} — {r['subject_cn']} "
                f"({_fmt_days(r['days'])}, {r['not_after']:%Y-%m-%d})"
            )
    if d["declared"]:
        lines += ["", "Declared certificates (assigned, not observed):"]
        for r in d["declared"][:_MAX_ROWS]:
            lines.append(
                f"  {r['subject_cn']} ({_fmt_days(r['days'])}, "
                f"{r['not_after']:%Y-%m-%d})"
            )
    if d["recent_changes"]:
        lines += ["", "Recent certificate changes:"]
        for r in d["recent_changes"][:_MAX_ROWS]:
            lines.append(f"  {r['endpoint']} — now {r['subject_cn']} ({r['at']:%b %d})")
    return "\n".join(lines) + "\n"


def _fp_short(fp: str) -> str:
    return (fp or "")[:12]


def _rows_table(rows, state):
    cells = []
    for r in rows[:_MAX_ROWS]:
        cells.append([
            ek.escape(r["endpoint"]),
            ek.escape(r["subject_cn"]),
            ek.pill(_fmt_days(r["days"]), state),
            ek.escape(f"{r['not_after']:%Y-%m-%d}"),
        ])
    return ek.data_table(["Endpoint", "Subject", "Expiry", "Not after"], cells)


def render_html(summary: dict, tenant_name: str, deployment_name: str) -> str:
    from .cert_expiry import EXPIRED, EXPIRING_CRITICAL, EXPIRING_WARNING

    d = summary
    parts = [
        ek.lead(
            "Certificates approaching expiry, expired certificates still being "
            "served, and any that changed recently."
        ),
        ek.stat_grid([
            (d["expired"], "expired", ek.STATUS_BG["expired"]),
            (d["expiring_critical"], "critical", ek.STATUS_BG["critical"]),
            (d["expiring_warning"], "warning", ek.STATUS_BG["warning"]),
            (d["changes"], "changed", ek.PALETTE["brand"]),
        ]),
    ]

    if d["expired"]:
        parts.append(ek.callout(
            f"{d['expired']} certificate(s) are expired and still being served — "
            f"anything validating against them is failing now.", "critical"))

    blocks = [
        (EXPIRED, "Expired — still served", d["buckets"][EXPIRED]),
        (EXPIRING_CRITICAL, "Expiring — critical", d["buckets"][EXPIRING_CRITICAL]),
        (EXPIRING_WARNING, "Expiring — warning", d["buckets"][EXPIRING_WARNING]),
    ]
    for state, heading, rows in blocks:
        if rows:
            parts.append(ek.section(heading))
            parts.append(_rows_table(rows, state))

    if d["declared"]:
        parts.append(ek.section("Declared — assigned, not observed"))
        cells = [
            [
                ek.escape(r["subject_cn"]),
                ek.escape(r["object_type"]),
                ek.pill(_fmt_days(r["days"]), "critical" if r["days"] < 0 else "warning"),
                ek.escape(f"{r['not_after']:%Y-%m-%d}"),
            ]
            for r in d["declared"][:_MAX_ROWS]
        ]
        parts.append(ek.data_table(
            ["Subject", "Assigned to", "Expiry", "Not after"], cells))

    if d["recent_changes"]:
        parts.append(ek.section("Recent changes"))
        cells = [
            [
                ek.escape(r["endpoint"]),
                ek.escape(r["subject_cn"]),
                ek.escape(f"{r['at']:%b %d, %H:%M}"),
            ]
            for r in d["recent_changes"][:_MAX_ROWS]
        ]
        parts.append(ek.data_table(["Endpoint", "Now serving", "Seen"], cells))

    if not has_content(d):
        parts.append(ek.callout(
            "No certificates are expired, approaching expiry, or recently "
            "changed. Everything looks healthy.", "success"))

    base = _base_url()
    if base:
        parts.append(ek.email_button(f"{base}/monitoring/certificates",
                                     "Open certificate inventory"))

    return ek.render_layout(
        f"Certificate digest — {tenant_name}",
        "".join(parts),
        deployment_name=deployment_name,
        kicker="Certificates",
        preheader=(
            f"{d['expired']} expired · {d['expiring_critical']} critical · "
            f"{d['expiring_warning']} warning"
        ),
    )


# ── send + schedule ──────────────────────────────────────────────────────────

def send_cert_digest(tenant, *, force: bool = False, recipients=None) -> bool:
    """Build + email one tenant's certificate digest.

    ``force`` ignores the enabled/empty gates (the test/send-now path). Without
    ``force`` an empty digest is skipped — no point mailing "nothing to report"
    on a schedule.
    """
    from core.effective_settings import effective_digest
    from core.email import parse_recipients, send_html_email

    cfg = effective_digest(tenant)
    if not force and not getattr(cfg, "cert_digest_enabled", False):
        return False
    to = recipients or parse_recipients(
        getattr(cfg, "cert_digest_recipients", "") or cfg.digest_recipients
    )
    if not to:
        return False

    summary = cert_summary(tenant)
    if not force and not has_content(summary):
        return False

    name = _deployment_name()
    subject = f"{name} certificate digest — {tenant.name}"
    return send_html_email(
        subject,
        to,
        html_body=render_html(summary, tenant.name, name),
        text_body=render_text(summary, tenant.name),
        tenant=tenant,
    )


def run_scheduled_cert_digests(now=None) -> int:
    """Send the certificate digest for every active tenant that is due.

    Due = ``cert_digest_enabled`` on the effective config, frequency matches
    today (weekly → the configured weekday), and not already sent today
    (per-tenant ``cert_digest_last_run``). Independent of the monitoring digest.
    """
    from core.effective_settings import effective_digest
    from core.models import Tenant, TenantSettings

    now = now or timezone.now()
    sent = 0
    for tenant in Tenant.objects.filter(is_active=True):
        cfg = effective_digest(tenant)
        if not getattr(cfg, "cert_digest_enabled", False):
            continue
        if cfg.digest_frequency == "weekly" and now.weekday() != cfg.digest_weekday:
            continue
        row = TenantSettings.objects.filter(tenant=tenant).first()
        if row and row.cert_digest_last_run and \
                row.cert_digest_last_run.date() == now.date():
            continue
        if send_cert_digest(tenant):
            row, _ = TenantSettings.objects.get_or_create(tenant=tenant)
            row.cert_digest_last_run = now
            row.save(update_fields=["cert_digest_last_run", "updated_at"])
            sent += 1
    return sent
