"""A user-facing schedule: "daily / weekly / monthly at HH:MM" plus retention.

``core/schedule.py`` describes what Danbyte itself runs (systemd timers). This
is the operator-authored counterpart for features that let a user pick when
something happens - backups, script runs - so both share one definition of
"due" instead of each growing its own.

Due-ness is decided by comparing timestamps, not by remembering deadlines: a
cadence is due when its latest occurrence at or before *now* is later than the
last run. A scheduler that slept through an occurrence runs it once on wake and
never twice - the same catch-up behaviour ``Persistent=true`` gives the timers.
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import datetime, timedelta

FREQUENCIES = ("hourly", "daily", "weekly", "monthly")


class CadenceError(ValueError):
    """The cadence definition is not usable."""


def _parse_at(value: str) -> tuple[int, int]:
    try:
        hh, mm = value.split(":")
        hour, minute = int(hh), int(mm)
    except (ValueError, AttributeError) as exc:
        raise CadenceError(f"time must be HH:MM, got {value!r}") from exc
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise CadenceError(f"time out of range: {value!r}")
    return hour, minute


@dataclass(frozen=True)
class Cadence:
    """When something recurs. ``at`` is wall-clock in the active time zone;
    ``weekday`` (0 = Monday) applies to weekly, ``day`` (1-28) to monthly."""

    frequency: str = "daily"
    at: str = "02:00"
    weekday: int = 0
    day: int = 1

    def validate(self) -> None:
        if self.frequency not in FREQUENCIES:
            raise CadenceError(f"frequency must be one of {', '.join(FREQUENCIES)}")
        _parse_at(self.at)
        if not 0 <= self.weekday <= 6:
            raise CadenceError("weekday must be 0 (Monday) to 6 (Sunday)")
        if not 1 <= self.day <= 28:
            raise CadenceError("day of month must be 1 to 28 so every month has it")

    @classmethod
    def from_dict(cls, data: dict | None) -> Cadence:
        data = data or {}
        cad = cls(
            frequency=str(data.get("frequency", "daily")),
            at=str(data.get("at", "02:00")),
            weekday=int(data.get("weekday", 0)),
            day=int(data.get("day", 1)),
        )
        cad.validate()
        return cad

    def to_dict(self) -> dict:
        return {
            "frequency": self.frequency,
            "at": self.at,
            "weekday": self.weekday,
            "day": self.day,
        }

    def latest_occurrence(self, now: datetime) -> datetime:
        """The most recent scheduled moment at or before ``now`` (same tzinfo).
        Wall-clock arithmetic happens in ``now``'s own zone, so pass a local
        time for a local schedule."""
        hour, minute = _parse_at(self.at)
        if self.frequency == "hourly":
            cand = now.replace(minute=minute, second=0, microsecond=0)
            return cand if cand <= now else cand - timedelta(hours=1)
        cand = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if self.frequency == "daily":
            return cand if cand <= now else cand - timedelta(days=1)
        if self.frequency == "weekly":
            cand -= timedelta(days=(cand.weekday() - self.weekday) % 7)
            return cand if cand <= now else cand - timedelta(days=7)
        # monthly
        cand = cand.replace(day=self.day)
        if cand <= now:
            return cand
        year, month = (now.year, now.month - 1) if now.month > 1 else (now.year - 1, 12)
        return cand.replace(year=year, month=month)

    def next_occurrence(self, now: datetime) -> datetime:
        """The first scheduled moment strictly after ``now``."""
        last = self.latest_occurrence(now)
        if self.frequency == "hourly":
            return last + timedelta(hours=1)
        if self.frequency == "daily":
            return last + timedelta(days=1)
        if self.frequency == "weekly":
            return last + timedelta(days=7)
        year, month = (last.year, last.month + 1) if last.month < 12 else (last.year + 1, 1)
        return last.replace(year=year, month=month)

    def is_due(self, now: datetime, last_run: datetime | None) -> bool:
        """Due when the latest occurrence has not been run yet. A never-run
        cadence is due only once its first occurrence after creation has
        passed - callers pass ``created_at`` as ``last_run`` for that."""
        occ = self.latest_occurrence(now)
        return last_run is None or last_run < occ

    @property
    def label(self) -> str:
        if self.frequency == "hourly":
            return f"hourly at :{_parse_at(self.at)[1]:02d}"
        if self.frequency == "daily":
            return f"daily at {self.at}"
        if self.frequency == "weekly":
            return f"{calendar.day_name[self.weekday]}s at {self.at}"
        return f"monthly on day {self.day} at {self.at}"


@dataclass(frozen=True)
class Retention:
    """Keep at most ``max_count`` items and/or nothing older than
    ``max_age_days``. ``None`` means no limit of that kind."""

    max_count: int | None = None
    max_age_days: int | None = None

    def validate(self) -> None:
        if self.max_count is not None and self.max_count < 1:
            raise CadenceError("max_count must be at least 1")
        if self.max_age_days is not None and self.max_age_days < 1:
            raise CadenceError("max_age_days must be at least 1")

    @classmethod
    def from_dict(cls, data: dict | None) -> Retention:
        data = data or {}
        def _opt(key: str) -> int | None:
            v = data.get(key)
            return None if v in (None, "") else int(v)

        ret = cls(max_count=_opt("max_count"), max_age_days=_opt("max_age_days"))
        ret.validate()
        return ret

    def to_dict(self) -> dict:
        return {"max_count": self.max_count, "max_age_days": self.max_age_days}

    def expired(self, items: list, *, when, now: datetime) -> list:
        """The subset of ``items`` to discard. ``when(item)`` gives each item's
        timestamp. Newest survive a count cap; anything past the age cap goes."""
        ordered = sorted(items, key=when, reverse=True)
        gone: list = []
        if self.max_count is not None:
            gone.extend(ordered[self.max_count :])
        if self.max_age_days is not None:
            cutoff = now - timedelta(days=self.max_age_days)
            gone.extend(i for i in ordered if when(i) < cutoff and i not in gone)
        return gone
