"""A weekly opening schedule, shared by contacts (#66) and providers (#67).

Both answer the same question - *is this party reachable right now, and if not,
when?* - so both store the same shape rather than each inventing one:

    {"0": ["08:00", "17:00"], "1": ["08:00", "17:00"], …}

Keys are weekday numbers as strings, ``0=Monday … 6=Sunday`` (the convention
``DeploymentSettings.digest_weekday`` already uses). A day that is absent is
closed; 24/7 is every day set to ``["00:00", "24:00"]``. One interval per day:
split shifts ("08-12, 13-17") are not modelled, because the field exists to
answer "can I call them", not to be a rostering tool.

Times are wall-clock in the record's own ``business_hours_tz``. Storing the
zone beside the schedule is what makes "open now" answerable for a vendor in
another country - the whole point of the field.
"""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# "24:00" is the end-of-day sentinel: a day that runs to midnight. Python has no
# 24:00 time, so it is normalised to 1440 minutes when comparing.
_END_OF_DAY = "24:00"


class ScheduleError(ValueError):
    """The schedule isn't a valid weekly opening schedule."""


def _minutes(value: str) -> int:
    """"HH:MM" → minutes since midnight. Raises ScheduleError on anything else."""
    if not isinstance(value, str):
        raise ScheduleError("Times are 'HH:MM' strings.")
    if value == _END_OF_DAY:
        return 24 * 60
    try:
        hh, mm = value.split(":")
        h, m = int(hh), int(mm)
    except (ValueError, AttributeError) as err:
        raise ScheduleError(f"'{value}' isn't a time - use 'HH:MM'.") from err
    if len(hh) != 2 or len(mm) != 2 or not (0 <= h <= 23) or not (0 <= m <= 59):
        raise ScheduleError(f"'{value}' isn't a time - use 'HH:MM'.")
    return h * 60 + m


def validate_schedule(value) -> dict:
    """Return the schedule normalised, or raise :class:`ScheduleError`.

    Normalising here (rather than trusting the client) keeps one shape in the
    database whether a row came from the form, the API, or an import.
    """
    if value in (None, "", {}):
        return {}
    if not isinstance(value, dict):
        raise ScheduleError("Expected an object keyed by weekday (0-6).")
    out: dict[str, list[str]] = {}
    for key, span in value.items():
        try:
            day = int(key)
        except (TypeError, ValueError) as err:
            raise ScheduleError(
                f"'{key}' isn't a weekday - use 0 (Mon) to 6 (Sun)."
            ) from err
        if not 0 <= day <= 6:
            raise ScheduleError(f"'{key}' isn't a weekday - use 0 (Mon) to 6 (Sun).")
        if span in (None, [], ""):
            continue  # an explicitly-empty day is simply closed
        if not isinstance(span, (list, tuple)) or len(span) != 2:
            raise ScheduleError(
                f"{DAY_NAMES[day]} needs exactly a start and an end time."
            )
        start, end = str(span[0]), str(span[1])
        if _minutes(end) <= _minutes(start):
            raise ScheduleError(
                f"{DAY_NAMES[day]} ends at or before it starts."
            )
        out[str(day)] = [start, end]
    return dict(sorted(out.items(), key=lambda kv: int(kv[0])))


def is_open_at(schedule, tz_name: str, moment: dt.datetime) -> bool | None:
    """Is the schedule open at ``moment``? ``None`` when unanswerable - no
    schedule set, or no zone to read the wall-clock times in.

    ``None`` is deliberately not ``False``: "we don't know their hours" and
    "they are closed" lead to different decisions during an incident.
    """
    schedule = schedule or {}
    if not schedule or not tz_name:
        return None
    try:
        local = moment.astimezone(ZoneInfo(tz_name))
    except Exception:
        return None
    span = schedule.get(str(local.weekday()))
    if not span:
        return False
    now = local.hour * 60 + local.minute
    return _minutes(span[0]) <= now < _minutes(span[1])


def describe(schedule, tz_name: str = "") -> str:
    """A one-line human summary: "Mon-Fri 08:00-17:00 Europe/Copenhagen".

    Consecutive days sharing the same span collapse into a range, so the common
    weekday schedule reads as one phrase instead of five.
    """
    schedule = validate_schedule(schedule)
    if not schedule:
        return ""
    if len(schedule) == 7 and len({tuple(v) for v in schedule.values()}) == 1:
        span = next(iter(schedule.values()))
        if span == ["00:00", _END_OF_DAY]:
            return "24/7"
    parts: list[str] = []
    run: list[int] = []
    last_span: list[str] | None = None

    def flush() -> None:
        if not run or last_span is None:
            return
        label = (
            DAY_NAMES[run[0]]
            if len(run) == 1
            else f"{DAY_NAMES[run[0]]}-{DAY_NAMES[run[-1]]}"
        )
        parts.append(f"{label} {last_span[0]}-{last_span[1]}")

    for day in range(7):
        span = schedule.get(str(day))
        if span and span == last_span and run and run[-1] == day - 1:
            run.append(day)
            continue
        flush()
        run = [day] if span else []
        last_span = span
    flush()
    line = ", ".join(parts)
    return f"{line} {tz_name}".strip() if line else ""
