"""The occurrence generator: pure, so no database."""
from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.test import SimpleTestCase

from .recurrence import DAILY, WEEKLY, Recurrence, weekday_mask

CPH = ZoneInfo("Europe/Copenhagen")


def local(*args):
    return datetime(*args, tzinfo=CPH)


def rule(freq=DAILY, start=time(21, 55), minutes=545, valid_from=None, until=None,
         weekdays=()):
    return Recurrence(
        freq=freq, start_time=start, duration=timedelta(minutes=minutes), zone=CPH,
        valid_from=valid_from or local(2026, 11, 1), valid_until=until,
        weekdays=frozenset(weekdays),
    )


class RecurrenceTests(SimpleTestCase):
    def test_a_night_window_crosses_midnight(self):
        r = rule()
        occ = r.between(local(2026, 11, 10), local(2026, 11, 12))
        # The one from the 9th still runs on the morning of the 10th.
        self.assertEqual(occ[0], (local(2026, 11, 9, 21, 55), local(2026, 11, 10, 7, 0)))
        self.assertEqual(occ[1], (local(2026, 11, 10, 21, 55), local(2026, 11, 11, 7, 0)))
        self.assertEqual(len(occ), 3)

    def test_inside_an_occurrence(self):
        r = rule()
        self.assertEqual(
            r.at(local(2026, 11, 10, 3, 0)),
            (local(2026, 11, 9, 21, 55), local(2026, 11, 10, 7, 0)),
        )
        self.assertIsNone(r.at(local(2026, 11, 10, 12, 0)))
        self.assertIsNotNone(r.at(local(2026, 11, 10, 21, 55)))
        self.assertIsNone(r.at(local(2026, 11, 11, 7, 0)))  # the end is open

    def test_valid_from_and_until_cut_the_occurrences(self):
        r = rule(valid_from=local(2026, 11, 10, 23, 0), until=local(2026, 11, 12, 5, 0))
        occ = r.between(local(2026, 11, 1), local(2026, 12, 1))
        self.assertEqual(occ, [
            (local(2026, 11, 10, 23, 0), local(2026, 11, 11, 7, 0)),
            (local(2026, 11, 11, 21, 55), local(2026, 11, 12, 5, 0)),
        ])
        self.assertIsNone(r.next_window(local(2026, 11, 12, 6, 0)))

    def test_weekly_on_chosen_days(self):
        r = rule(freq=WEEKLY, start=time(2, 0), minutes=120, weekdays=[0, 2])  # Mon, Wed
        occ = r.between(local(2026, 11, 16), local(2026, 11, 23))  # Mon 16 - Mon 23
        self.assertEqual([s.astimezone(CPH).strftime("%a %d %H:%M") for s, _e in occ],
                         ["Mon 16 02:00", "Wed 18 02:00"])
        self.assertEqual(weekday_mask([0, 2]), 1 | 4)
        self.assertEqual(weekday_mask([6]), 64)

    def test_wall_clock_survives_dst(self):
        # Copenhagen leaves summer time on 25 Oct 2026 at 03:00.
        r = rule(valid_from=local(2026, 10, 20))
        before = r.at(local(2026, 10, 24, 23, 0))
        after = r.at(local(2026, 10, 26, 23, 0))
        self.assertEqual(before[0].astimezone(CPH).strftime("%H:%M"), "21:55")
        self.assertEqual(after[0].astimezone(CPH).strftime("%H:%M"), "21:55")
        self.assertEqual(before[0].utcoffset(), timedelta(0))  # instants are UTC
        self.assertEqual(before[0], datetime(2026, 10, 24, 19, 55, tzinfo=UTC))
        self.assertEqual(after[0], datetime(2026, 10, 26, 20, 55, tzinfo=UTC))
        # The night the clocks go back: elapsed 9 h 05 m ends at 06:00 local.
        night = r.at(local(2026, 10, 25, 1, 0))
        self.assertEqual(night[1] - night[0], timedelta(minutes=545))
        self.assertEqual(night[1].astimezone(CPH).strftime("%H:%M"), "06:00")

    def test_a_start_in_the_spring_gap_runs_just_after_it(self):
        # 29 Mar 2026: 02:00 -> 03:00 in Copenhagen; 02:30 does not exist.
        r = rule(start=time(2, 30), minutes=60, valid_from=local(2026, 3, 27))
        occ = r.between(local(2026, 3, 29), local(2026, 3, 30))
        self.assertEqual(occ[0][0].astimezone(CPH).strftime("%d %H:%M"), "29 03:30")

    def test_a_night_already_running_at_valid_from_is_cut_not_dropped(self):
        # As Zabbix's active_since does: from midnight, not from 21:55.
        r = rule(valid_from=local(2026, 12, 1))
        self.assertEqual(
            r.next_window(local(2026, 11, 19)),
            (local(2026, 12, 1), local(2026, 12, 1, 7, 0)),
        )

    def test_next_window_joins_back_to_back_occurrences(self):
        r = rule(start=time(0, 0), minutes=24 * 60, until=local(2026, 11, 4))
        self.assertEqual(
            r.next_window(local(2026, 11, 1, 12, 0)),
            (local(2026, 11, 1), local(2026, 11, 4)),
        )

    def test_next_window_before_the_first_and_between_occurrences(self):
        r = rule(valid_from=local(2026, 12, 1, 12, 0))
        self.assertEqual(
            r.next_window(local(2026, 11, 19, 12, 0)),
            (local(2026, 12, 1, 21, 55), local(2026, 12, 2, 7, 0)),
        )
        self.assertEqual(
            r.next_window(local(2026, 12, 2, 12, 0)),
            (local(2026, 12, 2, 21, 55), local(2026, 12, 3, 7, 0)),
        )

    def test_a_year_of_nights_is_365_occurrences_not_rows(self):
        r = rule(valid_from=local(2027, 1, 1, 12, 0))
        self.assertEqual(len(r.between(local(2027, 1, 1), local(2028, 1, 1))), 365)

    def test_summary(self):
        now = local(2026, 11, 19)
        self.assertEqual(rule(until=local(2026, 11, 27)).summary(now),
                         "Every day 21:55-07:00 until 27 Nov")
        self.assertEqual(
            rule(freq=WEEKLY, weekdays=[4, 0], until=local(2027, 1, 8)).summary(now),
            "Every Mon, Fri 21:55-07:00 until 8 Jan 2027",
        )
        self.assertEqual(rule().summary(now), "Every day 21:55-07:00")
