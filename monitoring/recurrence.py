"""Occurrences of a recurring maintenance window.

A recurring event is one row with a rule - every day, or on some weekdays, at
a local start time for a duration, inside a validity span - and never a row
per occurrence. Everything that reads an event's window (alert suppression
through its silence, SLA exclusion, the calendar, the Zabbix and PRTG
mirrors) asks this module, so they cannot disagree.

Pure: no database, no ``now`` of its own.

* The start time is wall-clock time in the rule's zone, so 21:55 stays 21:55
  across a DST change. A start that falls in a spring-forward gap runs at the
  instant just after it (02:30 that does not exist reads as 03:30); one that
  falls twice in a fall-back hour runs at the first.
* The duration is elapsed time: 21:55 + 9 h 05 m ends at 07:00 on an ordinary
  night and an hour off on the nights the clocks change - which is what a
  Zabbix period in seconds does too.
* An occurrence is cut to the validity span, the way Zabbix's
  ``active_since`` / ``active_till`` cut a period.
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

NONE, DAILY, WEEKLY = "", "daily", "weekly"
FREQUENCIES = (DAILY, WEEKLY)
WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
MIN_DURATION = timedelta(minutes=5)
#: One occurrence never runs into the next day's: longer is not a recurrence.
MAX_DURATION = timedelta(hours=24)
#: The furthest a single question looks: about ten years of days.
MAX_DAYS = 3700


@dataclass(frozen=True)
class Recurrence:
    freq: str
    start_time: time
    duration: timedelta
    zone: ZoneInfo
    valid_from: datetime
    valid_until: datetime | None = None
    #: 0 = Monday ... 6 = Sunday; weekly only.
    weekdays: frozenset[int] = frozenset()

    @classmethod
    def of(cls, event, *, default_zone: str = "UTC") -> Recurrence | None:
        """The rule an event carries, or None for a one-off window."""
        if getattr(event, "recurrence", "") not in FREQUENCIES:
            return None
        if event.recurrence_start_time is None or not event.recurrence_duration:
            return None
        return cls(
            freq=event.recurrence,
            start_time=event.recurrence_start_time,
            duration=timedelta(minutes=int(event.recurrence_duration)),
            zone=ZoneInfo(event.timezone or default_zone),
            valid_from=event.starts_at,
            valid_until=event.ends_at,
            weekdays=frozenset(int(d) for d in (event.recurrence_weekdays or [])),
        )

    # ── the days ────────────────────────────────────────────────────────
    def _runs_on(self, day: date) -> bool:
        return self.freq == DAILY or day.weekday() in self.weekdays

    def _start_on(self, day: date) -> datetime:
        local = datetime.combine(day, self.start_time).replace(tzinfo=self.zone, fold=0)
        # Through UTC and back: a time in a DST gap becomes a real instant.
        return local.astimezone(UTC)

    def _clip(self, start: datetime, end: datetime) -> tuple[datetime, datetime] | None:
        start = max(start, self.valid_from)
        if self.valid_until is not None:
            end = min(end, self.valid_until)
        return (start, end) if start < end else None

    def _raw(self, start: datetime, end: datetime) -> Iterator[tuple[datetime, datetime]]:
        """Unclipped occurrences that overlap ``[start, end)``, in order."""
        first = (start - self.duration).astimezone(self.zone).date() - timedelta(days=1)
        last = end.astimezone(self.zone).date() + timedelta(days=1)
        if (last - first).days > MAX_DAYS:
            last = first + timedelta(days=MAX_DAYS)
        day = first
        while day <= last:
            if self._runs_on(day):
                s = self._start_on(day)
                e = s + self.duration
                if s < end and e > start:
                    yield s, e
            day += timedelta(days=1)

    # ── the questions ───────────────────────────────────────────────────
    def between(self, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
        """Every occurrence overlapping ``[start, end)``, cut to the validity
        span (not to ``start``/``end``: the caller clips if it wants)."""
        lo = max(start, self.valid_from)
        hi = end if self.valid_until is None else min(end, self.valid_until)
        if lo >= hi:
            return []
        out = []
        for s, e in self._raw(lo, hi):
            clipped = self._clip(s, e)
            if clipped:
                out.append(clipped)
        return out

    def at(self, moment: datetime) -> tuple[datetime, datetime] | None:
        """The occurrence ``moment`` is inside, or None."""
        for s, e in self.between(moment - MAX_DURATION, moment + timedelta(seconds=1)):
            if s <= moment < e:
                return s, e
        return None

    def next_window(self, moment: datetime) -> tuple[datetime, datetime] | None:
        """The occurrence open at ``moment`` or the next one - joined with the
        ones that follow without a gap, so a silence never blinks between
        back-to-back occurrences. None once the rule has run out."""
        lo = max(moment, self.valid_from - MAX_DURATION)
        horizon = lo + timedelta(days=8)
        found = [w for w in self.between(lo, horizon) if w[1] > moment]
        if not found:
            # A weekly rule runs within any eight days of its span, so
            # nothing here means the rule has run out.
            return None
        start, end = found[0]
        for s, e in found[1:]:
            if s > end:
                break
            end = max(end, e)
        return start, end

    # ── words ───────────────────────────────────────────────────────────
    def summary(self, now: datetime | None = None) -> str:
        """``Every day 21:55-07:00 until 27 Nov``."""
        start_local = datetime.combine(date(2000, 1, 3), self.start_time)
        end_local = start_local + self.duration
        span = f"{start_local:%H:%M}-{end_local:%H:%M}"
        if self.freq == DAILY:
            days = "day"
        else:
            days = ", ".join(WEEKDAY_NAMES[d] for d in sorted(self.weekdays))
        out = f"Every {days} {span}"
        if self.valid_until is not None:
            until = self.valid_until.astimezone(self.zone)
            this_year = (now or self.valid_from).astimezone(self.zone).year
            out += f" until {until.day} {until:%b}"
            if until.year != this_year:
                out += f" {until.year}"
        return out


def weekday_mask(weekdays) -> int:
    """Zabbix's ``dayofweek`` bits: Monday 1, Tuesday 2 ... Sunday 64."""
    mask = 0
    for d in weekdays:
        mask |= 1 << int(d)
    return mask
