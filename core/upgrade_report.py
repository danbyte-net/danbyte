"""Tell the admins how an upgrade ended - once.

An unattended upgrade runs while nobody watches, and the stage that ran it
stops every service it could have reported through, so the next auto-upgrade
tick reports it instead: every finished upgrade the timer started, and every
one that failed, whoever started it. The record is a ``ScheduledRun`` named
``upgrade`` (the Jobs page lists it); its ``detail.report_key`` is what makes
the report happen once. The digest recipients get a mail.

Only status files written by the upgrade stage (``stage_api``) count; an old
upgrader's status has no outcome to report.
"""
from __future__ import annotations

import datetime
import logging

from django.utils import timezone

log = logging.getLogger(__name__)

TASK = "upgrade"

_SENTENCES = {
    ("new", "migrated"): "Danbyte now runs {to}.",
    ("new", "unchanged"): "Danbyte now runs {to}.",
    ("restored", "restored"): "It was rolled back: {frm} runs again and the database was "
                              "restored from the snapshot taken before the migration.",
    ("restored", "unchanged"): "It was rolled back: {frm} runs again; the database was not "
                               "changed.",
    ("unchanged", "unchanged"): "Nothing was changed; {frm} keeps running.",
}


def _when(value) -> datetime.datetime | None:
    try:
        return datetime.datetime.fromtimestamp(float(value), tz=datetime.UTC)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def describe(status: dict) -> tuple[str, str]:
    """``(subject, text)`` for a finished upgrade's status."""
    to = status.get("version_to") or "?"
    frm = status.get("version_from") or "the previous release"
    outcome = status.get("outcome") or {}
    code, database = outcome.get("code", ""), outcome.get("database", "")
    who = "Automatic upgrade" if status.get("trigger") == "auto" else "Upgrade"
    if status.get("state") == "done":
        subject = f"{who} to {to} finished"
    elif code == "restore_failed":
        subject = f"{who} to {to} failed and Danbyte is stopped"
    else:
        subject = f"{who} to {to} failed"
    parts = []
    sentence = _SENTENCES.get((code, database))
    if sentence and status.get("state") == "done":
        parts.append(sentence.format(to=to, frm=frm))
    if status.get("state") == "failed":
        parts.append(f"Step {status.get('step') or '?'}: {status.get('error') or 'no detail'}")
    for warning in status.get("warnings") or []:
        parts.append(f"Warning: {warning}")
    if outcome.get("backup"):
        parts.append(f"Pre-upgrade backup: {outcome['backup']}.")
    return subject, "\n".join(parts) or subject


def _mail(subject: str, text: str, failed: bool) -> None:
    from backups.notify import digest_recipients
    from core import email as ek
    from monitoring.notify import _deployment_name

    recipients = digest_recipients()
    if not recipients:
        return
    try:
        html = ek.render_layout(
            subject, ek.callout(text, "warning" if failed else "info"),
            deployment_name=_deployment_name(), kicker="Updates", preheader=text[:120],
        )
        ek.send_html_email(subject, recipients, html_body=html, text_body=text + "\n")
    except Exception:  # noqa: BLE001 - a mail failure must not stop the tick
        log.exception("upgrade report mail failed")


def report_finished(status: dict | None = None) -> dict | None:
    """Report the last upgrade if it finished and nobody has been told yet.
    Returns what was reported, or None."""
    from core.models import ScheduledRun

    from .upgrade import _read_status, _upgrade_lock_guard, _write_status_fields

    status = _read_status() if status is None else status
    if status.get("state") not in ("done", "failed") or not status.get("stage_api") \
            or status.get("reported"):
        return None
    if status.get("trigger") != "auto" and status.get("state") != "failed":
        return None
    key = f"{status.get('started_at')}:{status.get('version_to')}"
    if ScheduledRun.objects.filter(name=TASK, detail__report_key=key).exists():
        return None
    subject, text = describe(status)
    failed = status.get("state") == "failed"
    started = _when(status.get("started_at")) or timezone.now()
    ScheduledRun.objects.create(
        name=TASK, label="Upgrade",
        status=ScheduledRun.FAILED if failed else ScheduledRun.OK,
        summary=subject[:500], started_at=started,
        finished_at=_when(status.get("finished_at")) or timezone.now(),
        detail={"report_key": key, "trigger": status.get("trigger"),
                "version_from": status.get("version_from"),
                "version_to": status.get("version_to"),
                "outcome": status.get("outcome"), "step": status.get("step"),
                "error": status.get("error"), "warnings": status.get("warnings") or []},
    )
    _mail(subject, text, failed)
    try:
        with _upgrade_lock_guard():
            # Only the status just reported: a new upgrade may have seeded
            # its own since it was read.
            current = _read_status()
            if f"{current.get('started_at')}:{current.get('version_to')}" == key \
                    and current.get("state") == status.get("state"):
                _write_status_fields(reported=True)
    except OSError:
        pass  # the ScheduledRun row already keeps it from being sent twice
    return {"subject": subject, "failed": failed}
