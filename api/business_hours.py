"""A weekly opening schedule, shared by contacts (#66) and providers (#67).

Both answer the same question - *is this party reachable right now, and if not,
when?* - so both store the same shape rather than each inventing one:

    {"0": [["08:00", "12:00"], ["13:00", "17:00"]], "1": [["08:00", "17:00"]]}

Keys are weekday numbers as strings, ``0=Monday … 6=Sunday`` (the convention
``DeploymentSettings.digest_weekday`` already uses). A day that is absent is
closed; 24/7 is every day set to ``[["00:00", "24:00"]]``.

**Spans, not a span.** A day holds a *list* of intervals so a schedule with a
break - "08:00-12:00, 13:00-17:00", routine for support desks in much of the
world - is representable. A bare ``["08:00", "17:00"]`` pair is accepted on
input and normalised to a one-element list, so older payloads and hand-written
imports keep working.

Times are wall-clock in the record's own ``business_hours_tz``. Storing the
zone beside the schedule is what makes "open now" answerable for a vendor in
another country - the whole point of the field - which is why a schedule
without a zone is refused rather than quietly stored as unanswerable.
"""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# "24:00" is the end-of-day sentinel: a day that runs to midnight. Python has no
# 24:00 time, so it is normalised to 1440 minutes when comparing.
END_OF_DAY = "24:00"

ALWAYS_OPEN = {str(d): [["00:00", END_OF_DAY]] for d in range(7)}


class ScheduleError(ValueError):
    """The schedule isn't a valid weekly opening schedule."""


def _minutes(value: str) -> int:
    """"HH:MM" → minutes since midnight. Raises ScheduleError on anything else."""
    if not isinstance(value, str):
        raise ScheduleError("Times are 'HH:MM' strings.")
    if value == END_OF_DAY:
        return 24 * 60
    try:
        hh, mm = value.split(":")
        h, m = int(hh), int(mm)
    except (ValueError, AttributeError) as err:
        raise ScheduleError(f"'{value}' isn't a time - use 'HH:MM'.") from err
    if len(hh) != 2 or len(mm) != 2 or not (0 <= h <= 23) or not (0 <= m <= 59):
        raise ScheduleError(f"'{value}' isn't a time - use 'HH:MM'.")
    return h * 60 + m


def _spans_of(day: int, raw) -> list[list[str]]:
    """Normalise one day's value into a sorted, non-overlapping span list."""
    if raw in (None, "", []):
        return []
    if not isinstance(raw, (list, tuple)):
        raise ScheduleError(f"{DAY_NAMES[day]} needs a list of time spans.")
    # A bare ["08:00", "17:00"] pair is one span, not two malformed ones.
    items = (
        [raw]
        if len(raw) == 2 and all(isinstance(x, str) for x in raw)
        else list(raw)
    )
    spans: list[list[str]] = []
    for item in items:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ScheduleError(
                f"{DAY_NAMES[day]}: each span is a start and an end time."
            )
        start, end = str(item[0]), str(item[1])
        if _minutes(end) <= _minutes(start):
            raise ScheduleError(
                f"{DAY_NAMES[day]}: {start}-{end} ends at or before it starts."
            )
        spans.append([start, end])
    spans.sort(key=lambda s: _minutes(s[0]))
    for earlier, later in zip(spans, spans[1:], strict=False):
        if _minutes(later[0]) < _minutes(earlier[1]):
            raise ScheduleError(
                f"{DAY_NAMES[day]}: {earlier[0]}-{earlier[1]} and "
                f"{later[0]}-{later[1]} overlap."
            )
    return spans


def validate_schedule(value) -> dict:
    """Return the schedule normalised, or raise :class:`ScheduleError`.

    Normalising here (rather than trusting the client) keeps one shape in the
    database whether a row came from the form, the API, or an import.
    """
    if value in (None, "", {}):
        return {}
    if not isinstance(value, dict):
        raise ScheduleError("Expected an object keyed by weekday (0-6).")
    out: dict[str, list[list[str]]] = {}
    for key, raw in value.items():
        try:
            day = int(key)
        except (TypeError, ValueError) as err:
            raise ScheduleError(
                f"'{key}' isn't a weekday - use 0 (Mon) to 6 (Sun)."
            ) from err
        if not 0 <= day <= 6:
            raise ScheduleError(f"'{key}' isn't a weekday - use 0 (Mon) to 6 (Sun).")
        spans = _spans_of(day, raw)
        if spans:  # an explicitly-empty day is simply closed
            out[str(day)] = spans
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
    try:
        spans = _spans_of(local.weekday(), schedule.get(str(local.weekday())))
    except ScheduleError:
        return None
    now = local.hour * 60 + local.minute
    return any(_minutes(s[0]) <= now < _minutes(s[1]) for s in spans)


def _day_text(spans: list[list[str]]) -> str:
    return ", ".join(f"{s[0]}-{s[1]}" for s in spans)


def describe(schedule, tz_name: str = "") -> str:
    """A one-line human summary: "Mon-Fri 08:00-17:00 Europe/Copenhagen".

    Consecutive days sharing the same spans collapse into a range, so the common
    weekday schedule reads as one phrase instead of five. Day groups are
    separated by "; " because "," already separates spans within a day.
    """
    schedule = validate_schedule(schedule)
    if not schedule:
        return ""
    if len(schedule) == 7 and schedule == ALWAYS_OPEN:
        return "24/7"
    parts: list[str] = []
    run: list[int] = []
    last: list[list[str]] | None = None

    def flush() -> None:
        if not run or last is None:
            return
        label = (
            DAY_NAMES[run[0]]
            if len(run) == 1
            else f"{DAY_NAMES[run[0]]}-{DAY_NAMES[run[-1]]}"
        )
        parts.append(f"{label} {_day_text(last)}")

    for day in range(7):
        spans = schedule.get(str(day))
        if spans and spans == last and run and run[-1] == day - 1:
            run.append(day)
            continue
        flush()
        run = [day] if spans else []
        last = spans
    flush()
    line = "; ".join(parts)
    return f"{line} {tz_name}".strip() if line else ""
