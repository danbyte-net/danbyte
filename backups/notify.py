"""Backup and restore notifications.

A schedule names the notification channels that hear about its runs; a
failed run of any kind also mails the deployment digest recipients. Manual
runs that succeed notify nobody - the person who clicked is watching.
"""
from __future__ import annotations

import logging
import re

from monitoring.notify import _deployment_name, notify_plain

log = logging.getLogger(__name__)


def _channels(schedule):
    if schedule is None:
        return []
    return list(schedule.notify_channels.filter(enabled=True))


def digest_recipients() -> list[str]:
    from core.models import DeploymentSettings

    raw = DeploymentSettings.load().digest_recipients or ""
    return [r for r in re.split(r"[,\s]+", raw) if r]


def _mail_admins(subject: str, text: str) -> None:
    recipients = digest_recipients()
    if not recipients:
        return
    from core import email as ek

    try:
        html = ek.render_layout(
            subject, ek.callout(text, "warning"), deployment_name=_deployment_name(),
            kicker="Backups", preheader=text[:120],
        )
        ek.send_html_email(subject, recipients, html_body=html, text_body=text + "\n")
    except Exception:  # noqa: BLE001 - a mail failure must not fail the run
        log.exception("backup admin mail failed")


def _failed_step(steps: list) -> str:
    for s in reversed(steps or []):
        if s.get("status") == "failed":
            return str(s.get("name") or "")
    return ""


def notify_backup(backup) -> None:
    ok = backup.status == "success"
    if ok and backup.kind == "manual":
        return
    label = backup.filename or backup.get_kind_display().lower()
    if ok:
        subject = f"Backup completed: {label}"
        size = f"{(backup.size or 0) / 2**20:.0f} MB"
        text = f"{', '.join(backup.components)} · {size} · {backup.target.name}"
    else:
        subject = f"Backup failed: {label}"
        step = _failed_step(backup.steps)
        text = f"Step {step}: {backup.error}" if step else backup.error
    payload = {
        "kind": "backup", "kicker": "Backups", "backup_id": str(backup.id), "status": backup.status,
        "components": list(backup.components), "size": backup.size, "target": backup.target.name,
        "error": backup.error, "severity": "info" if ok else "critical",
        "dedup_key": f"backup-{backup.id}",
    }
    for ch in _channels(backup.schedule):
        notify_plain(ch, subject, text, payload)
    if not ok:
        _mail_admins(subject, text)


def notify_restore(run) -> None:
    ok = run.status == "success"
    label = run.backup.filename
    if ok:
        subject = f"Restore completed: {label}"
        text = f"{', '.join(run.components)} restored; the site is back."
    else:
        subject = f"Restore failed: {label}"
        step = _failed_step(run.steps)
        text = f"Step {step}: {run.error}" if step else run.error
        if run.safety_backup_id:
            text += " The state from before the restore is kept as a protected backup."
    payload = {
        "kind": "restore", "kicker": "Backups", "restore_id": str(run.id), "status": run.status,
        "components": list(run.components), "backup_id": str(run.backup_id), "error": run.error,
        "severity": "info" if ok else "critical", "dedup_key": f"restore-{run.id}",
    }
    for ch in _channels(run.backup.schedule):
        notify_plain(ch, subject, text, payload)
    if not ok:
        _mail_admins(subject, text)
