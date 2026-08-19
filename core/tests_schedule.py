"""The schedule table and the systemd units must agree.

Docker installs had no scheduler at all for a while: the timers lived only in
``services/``, the compose stack never grew an equivalent, and the gap was
invisible because a check that never ran looks much like a check that ran and
found nothing. ``core.schedule.SCHEDULE`` is now the single answer to "what runs
periodically", and these tests hold the two deployment shapes to it.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path

from unittest import mock

from django.test import SimpleTestCase

from core.management.commands.run_scheduler import Command as SchedulerCommand
from core.schedule import SCHEDULE, ScheduledTask, container_schedule

SERVICES = Path(__file__).resolve().parent.parent / "services"


def _exec_commands(unit: str) -> list[str]:
    """The management commands a unit's ExecStart lines invoke."""
    text = (SERVICES / f"{unit}.service").read_text()
    return re.findall(r"^ExecStart=.*?manage\.py\s+(\S+)", text, re.MULTILINE)


def _on_calendar(unit: str) -> str:
    text = (SERVICES / f"{unit}.timer").read_text()
    found = re.findall(r"^OnCalendar=(.+)$", text, re.MULTILINE)
    assert len(found) == 1, f"{unit}.timer must declare exactly one OnCalendar"
    return found[0].strip()


def _schedule_from_calendar(spec: str) -> ScheduledTask:
    """Parse the two OnCalendar shapes Danbyte uses into table terms.

    Anything else fails loudly rather than being waved through - a new shape
    means this parser (and the container scheduler) needs to learn it.
    """
    minutes = re.fullmatch(r"\*:0/(\d+)", spec)
    if minutes:
        return ScheduledTask(unit="", commands=(), every=int(minutes.group(1)) * 60)
    daily = re.fullmatch(r"\*-\*-\* (\d{2}):(\d{2}):00", spec)
    if daily:
        return ScheduledTask(unit="", commands=(), at=(f"{daily.group(1)}:{daily.group(2)}",))
    stepped = re.fullmatch(r"\*-\*-\* (\d{2})/(\d+):(\d{2}):00", spec)
    if stepped:
        start, step, minute = int(stepped.group(1)), int(stepped.group(2)), stepped.group(3)
        return ScheduledTask(
            unit="",
            commands=(),
            at=tuple(f"{h:02d}:{minute}" for h in range(start, 24, step)),
        )
    raise AssertionError(f"Unrecognised OnCalendar {spec!r}")


class ScheduleParityTests(SimpleTestCase):
    def test_every_timer_is_in_the_table(self):
        units = {p.stem for p in SERVICES.glob("*.timer")}
        self.assertEqual(units, {t.unit for t in SCHEDULE})

    def test_each_entry_matches_its_unit(self):
        for task in SCHEDULE:
            with self.subTest(task.unit):
                self.assertEqual(task.commands, tuple(_exec_commands(task.unit)))
                parsed = _schedule_from_calendar(_on_calendar(task.unit))
                self.assertEqual(task.every, parsed.every)
                self.assertEqual(tuple(sorted(task.at)), tuple(sorted(parsed.at)))

    def test_containers_skip_only_the_upgrade_beat(self):
        """A container upgrades by replacing its image, so it must not run the
        upgrader - but it has to run everything else the timers do."""
        skipped = {t.unit for t in SCHEDULE} - {t.unit for t in container_schedule()}
        self.assertEqual(skipped, {"danbyte-auto-upgrade"})

    def test_materialise_runs_before_dispatch(self):
        """Ordering is what makes a fresh install measure something on its first
        pass instead of reporting "0 due" until the next materialise."""
        order = [t.unit for t in SCHEDULE]
        self.assertLess(
            order.index("danbyte-materialise"), order.index("danbyte-dispatch")
        )


class SlotTests(SimpleTestCase):
    """Due-ness is a slot comparison - the property that makes a restarted or
    late scheduler run each occurrence exactly once."""

    def test_interval_slot_changes_once_per_interval(self):
        task = ScheduledTask(unit="x", commands=(), every=300)
        base = datetime(2026, 8, 13, 10, 0, 0)
        self.assertEqual(task.slot(base), task.slot(base + timedelta(seconds=299)))
        self.assertNotEqual(task.slot(base), task.slot(base + timedelta(seconds=301)))

    def test_daily_task_is_not_due_before_its_time(self):
        task = ScheduledTask(unit="x", commands=(), at=("07:00",))
        self.assertIsNone(task.slot(datetime(2026, 8, 13, 6, 59)))
        self.assertIsNotNone(task.slot(datetime(2026, 8, 13, 7, 0)))

    def test_daily_task_holds_one_slot_for_the_rest_of_the_day(self):
        """The restart case: coming back at 09:00 must not re-send the 07:00
        digest, and midnight must start a fresh slot."""
        task = ScheduledTask(unit="x", commands=(), at=("07:00",))
        morning = task.slot(datetime(2026, 8, 13, 7, 0))
        self.assertEqual(morning, task.slot(datetime(2026, 8, 13, 9, 0)))
        self.assertEqual(morning, task.slot(datetime(2026, 8, 13, 23, 59)))
        self.assertNotEqual(morning, task.slot(datetime(2026, 8, 14, 7, 0)))

    def test_multiple_times_each_get_their_own_slot(self):
        task = ScheduledTask(unit="x", commands=(), at=("00:00", "04:00"))
        self.assertNotEqual(
            task.slot(datetime(2026, 8, 13, 1, 0)),
            task.slot(datetime(2026, 8, 13, 5, 0)),
        )


class FakeRedis:
    """Just the two calls the scheduler makes, with GETSET's atomicity."""

    def __init__(self):
        self.store: dict[str, str] = {}

    def getset(self, key, value):
        previous = self.store.get(key)
        self.store[key] = value
        return previous

    def expire(self, key, ttl):
        return True


class SchedulerPassTests(SimpleTestCase):
    """Each occurrence runs exactly once, however often the beat ticks."""

    def _scheduler(self, redis=None):
        command = SchedulerCommand()
        command._memory = {}
        command._redis = redis
        return command

    def _run(self, command, task, now):
        with mock.patch(
            "core.management.commands.run_scheduler.call_command"
        ) as called, mock.patch(
            "core.management.commands.run_scheduler.timezone.localtime",
            return_value=now,
        ):
            command._pass((task,))
        return [c.args[0] for c in called.call_args_list]

    def test_a_task_runs_once_per_slot_however_often_we_tick(self):
        task = ScheduledTask(unit="t", commands=("dispatch_checks",), every=60)
        command = self._scheduler(FakeRedis())
        first = datetime(2026, 8, 13, 10, 0, 0)
        self.assertEqual(self._run(command, task, first), ["dispatch_checks"])
        self.assertEqual(self._run(command, task, first + timedelta(seconds=10)), [])
        self.assertEqual(self._run(command, task, first + timedelta(seconds=20)), [])
        self.assertEqual(
            self._run(command, task, first + timedelta(seconds=61)),
            ["dispatch_checks"],
        )

    def test_restarting_does_not_repeat_todays_daily_task(self):
        """The digest case: slots live in Redis, so a fresh process picks up
        where the previous one left off instead of sending again."""
        task = ScheduledTask(unit="t", commands=("send_digest",), at=("07:00",))
        redis = FakeRedis()
        morning = datetime(2026, 8, 13, 7, 0)
        self.assertEqual(
            self._run(self._scheduler(redis), task, morning), ["send_digest"]
        )
        # A brand-new process - same Redis.
        self.assertEqual(
            self._run(self._scheduler(redis), task, datetime(2026, 8, 13, 9, 30)), []
        )
        self.assertEqual(
            self._run(self._scheduler(redis), task, datetime(2026, 8, 14, 7, 0)),
            ["send_digest"],
        )

    def test_a_daily_task_does_not_run_before_its_time(self):
        task = ScheduledTask(unit="t", commands=("send_digest",), at=("07:00",))
        command = self._scheduler(FakeRedis())
        self.assertEqual(self._run(command, task, datetime(2026, 8, 13, 3, 0)), [])

    def test_one_failing_task_does_not_stop_the_beat(self):
        task = ScheduledTask(unit="t", commands=("boom", "after"), every=60)
        command = self._scheduler(FakeRedis())
        with mock.patch(
            "core.management.commands.run_scheduler.call_command",
            side_effect=[RuntimeError("nope"), None],
        ) as called, mock.patch(
            "core.management.commands.run_scheduler.timezone.localtime",
            return_value=datetime(2026, 8, 13, 10, 0),
        ), self.assertLogs("danbyte.scheduler", "ERROR"):
            command._pass((task,))
        self.assertEqual([c.args[0] for c in called.call_args_list], ["boom", "after"])

    def test_without_redis_the_beat_still_runs(self):
        """A Redis outage must not stop monitoring; in-memory slots are the
        fallback, at the cost of a possible repeat after a restart."""
        task = ScheduledTask(unit="t", commands=("dispatch_checks",), every=60)
        command = self._scheduler(None)
        now = datetime(2026, 8, 13, 10, 0)
        self.assertEqual(self._run(command, task, now), ["dispatch_checks"])
        self.assertEqual(self._run(command, task, now), [])
