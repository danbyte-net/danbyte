"""The beat that keeps external monitors in step.

A timer runs every minute and enqueues the connections that are actually
*due*, rather than working on the timer's cadence - a remote monitoring API is
somebody's production server, and a minute is far too often to walk its whole
inventory.

Each system registers one entry: a name, a label for the Jobs page, and its
``enqueue_due(now)`` function, which usually wraps :func:`enqueue_due` over
its connections. The ``extmon_sync`` command runs every entry that has no
timer of its own; Zabbix keeps its original ``zabbix_sync`` timer
(``own_timer=True``), so moving onto the shared beat changed no installed
unit.

Every job re-checks the switches **at run time**, not only when it was
enqueued: a toggle flipped in between has to win, or Danbyte writes into a
system somebody just switched off. :func:`skip_reason` is that re-check.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from django.utils import timezone


@dataclass(frozen=True)
class BeatTask:
    """One kind of pass a connection can be due for."""

    #: Key it is counted under in the beat's result.
    counter: str
    #: ``(connection, now) -> bool``.
    due: Callable
    #: The RQ job, called with the connection id as a string.
    job: Callable
    timeout: int = 300


@dataclass(frozen=True)
class BeatEntry:
    name: str
    label: str
    #: ``(now) -> dict`` of counts.
    enqueue_due: Callable
    #: Driven by a timer of its own rather than ``extmon_sync``.
    own_timer: bool = False


_ENTRIES: dict[str, BeatEntry] = {}


def register_beat(
    name: str, label: str, enqueue_due: Callable, *, own_timer: bool = False
) -> None:
    """Add (or replace) a system's entry on the beat."""
    _ENTRIES[name] = BeatEntry(name, label, enqueue_due, own_timer)


def entries() -> list[BeatEntry]:
    return list(_ENTRIES.values())


def run_beat(now=None, *, names=None, include_own_timer: bool = False) -> dict:
    """Run the registered entries; ``{name: counts}``.

    ``names`` restricts the run. Entries with their own timer only run when
    named or when ``include_own_timer`` is set, so the shared timer never
    doubles a system's own.
    """
    now = now or timezone.now()
    out = {}
    for entry in entries():
        if names is not None:
            if entry.name not in names:
                continue
        elif entry.own_timer and not include_own_timer:
            continue
        out[entry.name] = entry.enqueue_due(now)
    return out


def enqueue_due(connections, integration_key: str, tasks, *, queue, now) -> dict:
    """Queue every pass whose interval has elapsed, per connection.

    ``connections`` are the enabled connections of active tenants (each with
    ``tenant`` loaded); a connection whose tenant has the integration off is
    skipped. ``queue`` is passed in so the caller decides which queue - and
    so a test that replaces the caller's queue sees every enqueue.
    """
    from integrations.toggles import integration_enabled

    counts = {task.counter: 0 for task in tasks}
    for conn in connections:
        if not integration_enabled(conn.tenant, integration_key):
            continue
        for task in tasks:
            if task.due(conn, now):
                queue.enqueue(task.job, str(conn.id), job_timeout=task.timeout)
                counts[task.counter] += 1
    return counts


def skip_reason(conn, integration_key: str) -> str | None:
    """Why a job must not run for this connection now, or None.

    The run-time re-check every external-monitor job starts with: the row
    still exists, its tenant is active, and the tenant still has the
    integration on.
    """
    from integrations.toggles import integration_enabled

    if conn is None:
        return "gone"
    if not conn.tenant.is_active:
        return "tenant inactive"
    if not integration_enabled(conn.tenant, integration_key):
        return "integration off"
    return None
