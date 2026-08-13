"""The periodic beat, for installs with no systemd.

Bare metal runs each entry in ``core.schedule.SCHEDULE`` as its own systemd
timer. A container install has no init to do that, so it runs one long-lived
process — the ``scheduler`` service in docker-compose — which reads the same
table and calls the same management commands::

    manage.py run_scheduler            # the beat
    manage.py run_scheduler --list     # what it would run, and how often
    manage.py run_scheduler --once     # one pass, for a cron-driven install

Due-ness is a *slot* comparison, not a timer: each task's slot changes exactly
when it next becomes due, so a scheduler that restarted, or was a few seconds
late, still runs each occurrence once and never twice. Slots live in Redis, so
restarting the container does not re-send this morning's digest, and running two
replicas does not send it twice — the claim is a single atomic GETSET.
"""
from __future__ import annotations

import logging
import signal
import time

from django.core.management import call_command
from django.core.management.base import BaseCommand
from django.utils import timezone

from core.schedule import SCHEDULE, ScheduledTask, container_schedule

log = logging.getLogger("danbyte.scheduler")

#: How often to look for due work. Finer than the shortest interval (a minute),
#: so a minute-resolution task fires within a few seconds of its boundary.
TICK_SECONDS = 10

#: Slot keys outlive a daily task's gap, but not so long that a removed task
#: leaves rubbish in Redis for ever.
_SLOT_TTL = 14 * 24 * 3600


class Command(BaseCommand):
    help = "Run Danbyte's periodic tasks (the container equivalent of the timers)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--once",
            action="store_true",
            help="Run one pass over the schedule and exit.",
        )
        parser.add_argument(
            "--list",
            action="store_true",
            help="Print the schedule and exit, without running anything.",
        )

    def handle(self, *args, **opts):
        if opts["list"]:
            for task in SCHEDULE:
                where = "" if task.in_container else "   (bare metal only)"
                self.stdout.write(
                    f"{task.unit:<28} {task.cadence:<22} "
                    f"{', '.join(task.commands)}{where}"
                )
            return

        tasks = container_schedule()
        # In-memory fallback: a Redis outage must not stop the beat, and running
        # an idempotent command twice is far cheaper than not running it at all.
        self._memory: dict[str, str] = {}
        self._redis = _redis_or_none()
        if self._redis is None:
            log.warning(
                "scheduler: no Redis — slots kept in memory, so a restart may "
                "repeat a daily task"
            )

        if opts["once"]:
            self._pass(tasks)
            return

        self._stop = False
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, self._request_stop)

        self.stdout.write(
            self.style.SUCCESS(f"scheduler: {len(tasks)} task(s), tick {TICK_SECONDS}s")
        )
        while not self._stop:
            self._pass(tasks)
            # Sleep in short steps so SIGTERM stops the container promptly.
            for _ in range(TICK_SECONDS):
                if self._stop:
                    break
                time.sleep(1)
        self.stdout.write("scheduler: stopped")

    def _request_stop(self, *_args):
        self._stop = True

    def _pass(self, tasks: tuple[ScheduledTask, ...]) -> None:
        now = timezone.localtime()
        for task in tasks:
            slot = task.slot(now)
            if slot is None or not self._claim(task, slot):
                continue
            for command in task.commands:
                try:
                    call_command(command)
                except Exception:  # noqa: BLE001
                    # One failing task must not take the whole beat down with
                    # it; the command's own run-log row records the failure.
                    log.exception("scheduler: %s failed", command)

    def _claim(self, task: ScheduledTask, slot: str) -> bool:
        """True when *this* process is the one to run this occurrence."""
        key = f"danbyte:schedule:{task.unit}"
        if self._redis is None:
            if self._memory.get(key) == slot:
                return False
            self._memory[key] = slot
            return True
        try:
            previous = self._redis.getset(key, slot)
            self._redis.expire(key, _SLOT_TTL)
        except Exception:  # noqa: BLE001
            log.exception("scheduler: Redis unavailable, falling back to memory")
            self._redis = None
            return self._claim(task, slot)
        return _decode(previous) != slot


def _decode(value) -> str | None:
    if isinstance(value, bytes):
        return value.decode()
    return value


def _redis_or_none():
    try:
        import django_rq

        connection = django_rq.get_connection()
        connection.ping()
        return connection
    except Exception:  # noqa: BLE001
        return None
