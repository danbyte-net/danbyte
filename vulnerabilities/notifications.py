"""Tell a tenant about new vulnerabilities (#451, decision 19).

After each recompute a tenant gets at most **one** message, through its
notification channels (``monitoring.notify.notify_event``), listing:

* new matches whose record meets the policy's ``notify_on`` - ``fix_first``
  (the match's priority), ``critical`` (CVSS severity), ``kev`` (in CISA
  KEV);
* matches already told about that have since joined KEV (with ``kev`` in
  ``notify_on``).

Each match is told about once: ``notified_at`` is set (and ``notified_kev``
when it was in KEV), so a replayed sync, a second recompute or a resync
says nothing. Matches an exception covers are never named, and nothing is
sent when the policy's ``notify_enabled`` is off. The rows are claimed with
``SELECT … FOR UPDATE SKIP LOCKED``, so two jobs for one tenant cannot both
announce them; the message goes out after the claim commits.
"""
from __future__ import annotations

import logging
from collections import defaultdict

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

log = logging.getLogger(__name__)

EVENT = "vulnerabilities_matched"
PAYLOAD_MAX = 200
LINES_MAX = 20
_LABEL = {"fix_first": "fix first", "high": "high", "medium": "medium", "low": "low"}


def _eligible_q(notify_on) -> Q | None:
    q = Q()
    any_ = False
    if "fix_first" in notify_on:
        q |= Q(priority="fix_first")
        any_ = True
    if "critical" in notify_on:
        q |= Q(cve__cvss_severity="critical")
        any_ = True
    if "kev" in notify_on:
        q |= Q(cve__kev_added__isnull=False)
        any_ = True
    return q if any_ else None


def _base_url() -> str:
    from core.models import DeploymentSettings

    try:
        return (DeploymentSettings.load().public_base_url or "").rstrip("/")
    except Exception:  # noqa: BLE001 - a link is a nicety
        return ""


def _hosts_phrase(devices: int, vms: int) -> str:
    parts = []
    if devices:
        parts.append(f"{devices} device{'' if devices == 1 else 's'}")
    if vms:
        parts.append(f"{vms} virtual machine{'' if vms == 1 else 's'}")
    return " and ".join(parts) or "no hosts"


def claim(tenant) -> list[dict]:
    """Mark the tenant's matches due a notification as told and return them
    (one dict per match, ``kind`` ``new`` or ``kev``)."""
    from .models import VulnerabilityMatch, VulnerabilityPolicy

    policy = VulnerabilityPolicy.objects.filter(tenant=tenant).first()
    notify_on = policy.notify_on if policy is not None else ["fix_first", "critical", "kev"]
    if policy is not None and not policy.notify_enabled:
        return []
    eligible = _eligible_q(notify_on or [])
    if eligible is None:
        return []
    due = Q(notified_at__isnull=True)
    if "kev" in notify_on:
        due |= Q(notified_at__isnull=False, notified_kev=False, cve__kev_added__isnull=False)
    now = timezone.now()
    with transaction.atomic():
        rows = list(
            VulnerabilityMatch.objects.select_for_update(skip_locked=True, of=("self",))
            .filter(eligible, due, tenant=tenant, resolved_at__isnull=True,
                    excepted__isnull=True)
            .select_related("cve", "device", "virtual_machine")
            .order_by("cve__vuln_id", "id"))
        if not rows:
            return []
        out = []
        kev_ids, other_ids = [], []
        for r in rows:
            kev = r.cve.kev_added is not None
            (kev_ids if kev else other_ids).append(r.pk)
            host = r.device or r.virtual_machine
            out.append({
                "id": str(r.pk),
                "kind": "new" if r.notified_at is None else "kev",
                "vuln_id": r.cve.vuln_id,
                "priority": r.priority,
                "cvss_score": None if r.cve.cvss_score is None else float(r.cve.cvss_score),
                "cvss_severity": r.cve.cvss_severity,
                "kev": kev,
                "kev_due": r.cve.kev_due.isoformat() if r.cve.kev_due else None,
                "version": r.version,
                "host_type": "device" if r.device_id else "virtual_machine",
                "host": {"id": str(host.pk), "name": str(host)},
                "site_id": str(host.site_id) if getattr(host, "site_id", None) else None,
            })
        VulnerabilityMatch.objects.filter(pk__in=kev_ids).update(
            notified_at=now, notified_kev=True)
        VulnerabilityMatch.objects.filter(pk__in=other_ids).update(notified_at=now)
    return out


def compose(rows: list[dict], base_url: str = "") -> tuple[str, str, dict, str | None]:
    """``(subject, body, payload, site_id)`` for the claimed rows."""
    new = [r for r in rows if r["kind"] == "new"]
    kev = [r for r in rows if r["kind"] == "kev"]
    link = f"{base_url}/vulnerabilities" if base_url else ""

    def per_record(items):
        by: dict = defaultdict(lambda: {"devices": set(), "vms": set(), "row": None})
        for r in items:
            g = by[r["vuln_id"]]
            g["row"] = g["row"] or r
            (g["devices"] if r["host_type"] == "device" else g["vms"]).add(r["host"]["id"])
        order = sorted(by.items(), key=lambda kv: (not kv[1]["row"]["kev"],
                                                   kv[1]["row"]["priority"] != "fix_first",
                                                   -(kv[1]["row"]["cvss_score"] or 0), kv[0]))
        lines = []
        for vuln_id, g in order[:LINES_MAX]:
            r = g["row"]
            tags = []
            if r["kev"]:
                tags.append("KEV")
            if r["cvss_score"] is not None:
                tags.append(f"CVSS {r['cvss_score']:.1f}")
            tags.append(_LABEL.get(r["priority"], r["priority"]))
            lines.append(f"- {vuln_id} ({', '.join(tags)}) on "
                         f"{_hosts_phrase(len(g['devices']), len(g['vms']))}")
        if len(order) > LINES_MAX:
            lines.append(f"- and {len(order) - LINES_MAX} more")
        return len(order), lines

    devices = {r["host"]["id"] for r in rows if r["host_type"] == "device"}
    vms = {r["host"]["id"] for r in rows if r["host_type"] != "device"}
    hosts = _hosts_phrase(len(devices), len(vms))
    n_new, new_lines = per_record(new)
    n_kev, kev_lines = per_record(kev)
    heads = []
    if n_new:
        fix_first = len({r["vuln_id"] for r in new if r["priority"] == "fix_first"})
        what = f"{n_new} new vulnerabilit{'y' if n_new == 1 else 'ies'}"
        if fix_first == n_new:
            what += " to fix first"
        heads.append(what)
    if n_kev:
        heads.append(f"{n_kev} now in CISA KEV")
    subject = f"[Danbyte] {' and '.join(heads)} on {hosts}"
    body = []
    if new_lines:
        body += ["New:", *new_lines]
    if kev_lines:
        body += ([""] if body else []) + ["Now known to be exploited (CISA KEV):", *kev_lines]
    if link:
        body += ["", link]
    sites = {r["site_id"] for r in rows}
    site_id = next(iter(sites)) if len(sites) == 1 and None not in sites else None
    payload = {
        "event": EVENT,
        "count": len(rows),
        "records": n_new + n_kev,
        "hosts": len(devices) + len(vms),
        "matches": [{k: v for k, v in r.items() if k != "site_id"} for r in rows[:PAYLOAD_MAX]],
        "url": link or None,
    }
    return subject, "\n".join(body) + "\n", payload, site_id


def after_recompute(tenant) -> int:
    """Claim and send; returns how many matches the message named."""
    rows = claim(tenant)
    if not rows:
        return 0
    subject, body, payload, site_id = compose(rows, _base_url())
    from monitoring.notify import notify_event

    try:
        notify_event(tenant.pk, subject, body, payload, site_id=site_id)
    except Exception:  # noqa: BLE001 - a failed send never fails the recompute
        log.exception("vulnerability notification for tenant %s failed", tenant.pk)
    return len(rows)
