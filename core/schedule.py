"""What Danbyte runs periodically, and how often — for every install shape.

Bare metal gets this as systemd timers under ``services/``; a container install
gets it from ``manage.py run_scheduler``, which reads this table. Both answer to
the list below, and ``core/tests_schedule.py`` fails if the units and the table
disagree — the two ways of deploying cannot silently drift apart again.

Adding periodic work means: write the management command, add one row here, and
add the matching ``.service``/``.timer`` pair.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class ScheduledTask:
    """One periodic job: a systemd unit, and the commands its timer fires."""

    #: systemd unit basename, minus the .service/.timer suffix.
    unit: str
    #: Management commands, run in order (a couple of units run two).
    commands: tuple[str, ...]
    #: Fixed interval in seconds, mirroring ``OnCalendar=*:0/N``.
    every: int | None = None
    #: Wall-clock times ("HH:MM"), mirroring ``OnCalendar=*-*-* HH:MM:SS``.
    at: tuple[str, ...] = ()
    #: Whether a container install runs it. Upgrading is the one thing a
    #: container does *not* do for itself — the image is the unit of upgrade —
    #: so the auto-upgrade beat is bare-metal only.
    in_container: bool = True
    #: Why it exists, for the docs table and `run_scheduler --list`.
    label: str = ""

    def slot(self, now: datetime) -> str | None:
        """A key that changes exactly when this task next becomes due, or None
        when it is not due yet today.

        Comparing slots rather than tracking deadlines means a scheduler that
        was asleep, restarted, or a second late still runs each occurrence once,
        and never runs an occurrence twice — the same catch-up behaviour
        ``Persistent=true`` gives the systemd timers.
        """
        if self.every:
            return str(int(now.timestamp()) // self.every)
        # Wall-clock: due once per calendar day per listed time, and only once
        # that time has passed. Before the first one, nothing is due.
        passed = [t for t in sorted(self.at) if now.strftime("%H:%M") >= t]
        return f"{now:%Y-%m-%d}:{passed[-1]}" if passed else None

    @property
    def cadence(self) -> str:
        if self.every:
            mins = self.every // 60
            return "every minute" if mins == 1 else f"every {mins} minutes"
        return "daily at " + ", ".join(sorted(self.at))


MINUTE = 60

#: Order matters within a tick: materialising the effective checks is what makes
#: them dispatchable, so a fresh install measures something on its first pass
#: instead of reporting "0 due" until the next materialise.
SCHEDULE: tuple[ScheduledTask, ...] = (
    ScheduledTask(
        unit="danbyte-materialise",
        commands=("materialise_checks",),
        every=5 * MINUTE,
        label="Expand check assignments into per-IP checks",
    ),
    ScheduledTask(
        unit="danbyte-dispatch",
        commands=("dispatch_checks",),
        every=MINUTE,
        label="Check engine — enqueue every check that is due",
    ),
    ScheduledTask(
        unit="danbyte-drift-dispatch",
        commands=("drift_dispatch",),
        every=MINUTE,
        label="SNMP drift polling",
    ),
    ScheduledTask(
        unit="danbyte-drive-outposts",
        commands=("drive_outposts",),
        every=MINUTE,
        label="Hand work to remote Outposts",
    ),
    ScheduledTask(
        unit="danbyte-alert-maintenance",
        commands=("alert_maintenance",),
        every=MINUTE,
        label="Alert escalation, auto-resolve and silences",
    ),
    ScheduledTask(
        unit="danbyte-discover",
        commands=("discover_subnets",),
        every=5 * MINUTE,
        label="Discover live addresses in monitored prefixes",
    ),
    ScheduledTask(
        unit="danbyte-utilization",
        commands=("check_utilization",),
        every=15 * MINUTE,
        label="Prefix/VLAN utilisation thresholds",
    ),
    ScheduledTask(
        unit="danbyte-hardware",
        commands=("poll_hardware",),
        every=30 * MINUTE,
        label="Redfish/SNMP hardware health",
    ),
    ScheduledTask(
        unit="danbyte-auto-upgrade",
        commands=("auto_upgrade",),
        every=20 * MINUTE,
        in_container=False,
        label="Apply approved upgrades (bare metal only)",
    ),
    ScheduledTask(
        unit="danbyte-acme-renew",
        commands=("acme_renew",),
        at=("00:00", "04:00", "08:00", "12:00", "16:00", "20:00"),
        label="Renew ACME certificates due for renewal",
    ),
    ScheduledTask(
        unit="danbyte-prune",
        commands=("prune_check_results", "prune_changelog"),
        at=("04:17",),
        label="Retention — drop old check results and changelog rows",
    ),
    ScheduledTask(
        unit="danbyte-cleanup",
        commands=("cleanup_stale_ips",),
        at=("04:42",),
        label="Retire stale discovered IPs",
    ),
    ScheduledTask(
        unit="danbyte-document-linkcheck",
        commands=("document_linkcheck",),
        at=("05:15",),
        label="Check document links still resolve",
    ),
    ScheduledTask(
        unit="danbyte-certificate-expiry",
        commands=("certificate_expiry",),
        at=("06:30",),
        label="Certificate expiry alerting",
    ),
    ScheduledTask(
        unit="danbyte-digest",
        commands=("send_digest",),
        at=("07:00",),
        label="Daily email digest",
    ),
    ScheduledTask(
        unit="danbyte-task-reminders",
        commands=("send_task_reminders",),
        at=("06:45",),
        label="Personal task reminder emails",
    ),
)


def container_schedule() -> tuple[ScheduledTask, ...]:
    return tuple(t for t in SCHEDULE if t.in_container)
