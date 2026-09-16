"""core.cadence - the shared "daily/weekly/monthly at HH:MM" helper."""
from __future__ import annotations

from datetime import datetime, timedelta

from django.test import SimpleTestCase

from core.cadence import Cadence, CadenceError, Retention

# A Wednesday.
NOW = datetime(2026, 9, 9, 10, 30)


class CadenceTests(SimpleTestCase):
    def test_daily_latest_and_next(self):
        cad = Cadence("daily", "02:00")
        self.assertEqual(cad.latest_occurrence(NOW), datetime(2026, 9, 9, 2, 0))
        self.assertEqual(cad.next_occurrence(NOW), datetime(2026, 9, 10, 2, 0))
        late = Cadence("daily", "23:00")
        self.assertEqual(late.latest_occurrence(NOW), datetime(2026, 9, 8, 23, 0))

    def test_hourly(self):
        cad = Cadence("hourly", "00:45")
        self.assertEqual(cad.latest_occurrence(NOW), datetime(2026, 9, 9, 9, 45))
        self.assertEqual(cad.next_occurrence(NOW), datetime(2026, 9, 9, 10, 45))

    def test_weekly(self):
        monday = Cadence("weekly", "06:00", weekday=0)
        self.assertEqual(monday.latest_occurrence(NOW), datetime(2026, 9, 7, 6, 0))
        self.assertEqual(monday.next_occurrence(NOW), datetime(2026, 9, 14, 6, 0))
        friday = Cadence("weekly", "06:00", weekday=4)
        self.assertEqual(friday.latest_occurrence(NOW), datetime(2026, 9, 4, 6, 0))

    def test_monthly_wraps_the_year(self):
        cad = Cadence("monthly", "01:00", day=15)
        self.assertEqual(cad.latest_occurrence(NOW), datetime(2026, 8, 15, 1, 0))
        self.assertEqual(cad.next_occurrence(NOW), datetime(2026, 9, 15, 1, 0))
        jan = datetime(2026, 1, 3, 12, 0)
        self.assertEqual(cad.latest_occurrence(jan), datetime(2025, 12, 15, 1, 0))
        dec = datetime(2025, 12, 20, 12, 0)
        self.assertEqual(cad.next_occurrence(dec), datetime(2026, 1, 15, 1, 0))

    def test_is_due_runs_each_occurrence_once(self):
        cad = Cadence("daily", "02:00")
        created = NOW - timedelta(hours=1)  # created after today's 02:00
        self.assertFalse(cad.is_due(NOW, created))
        self.assertTrue(cad.is_due(NOW + timedelta(days=1), created))
        ran = datetime(2026, 9, 10, 2, 0, 5)
        self.assertFalse(cad.is_due(datetime(2026, 9, 10, 12, 0), ran))
        # a scheduler asleep for three days still fires exactly once on wake
        self.assertTrue(cad.is_due(datetime(2026, 9, 13, 12, 0), ran))
        self.assertTrue(cad.is_due(NOW, None))

    def test_validation(self):
        with self.assertRaises(CadenceError):
            Cadence.from_dict({"frequency": "yearly"})
        with self.assertRaises(CadenceError):
            Cadence.from_dict({"at": "25:00"})
        with self.assertRaises(CadenceError):
            Cadence.from_dict({"frequency": "monthly", "day": 31})
        cad = Cadence.from_dict({"frequency": "weekly", "at": "07:15", "weekday": 6})
        self.assertEqual(cad.to_dict()["weekday"], 6)
        self.assertEqual(cad.label, "Sundays at 07:15")


class RetentionTests(SimpleTestCase):
    def test_count_and_age(self):
        items = [NOW - timedelta(days=d) for d in range(6)]  # 0..5 days old
        keep3 = Retention(max_count=3)
        self.assertEqual(sorted(keep3.expired(items, when=lambda t: t, now=NOW)),
                         sorted(items[3:]))
        young = Retention(max_age_days=2)
        gone = young.expired(items, when=lambda t: t, now=NOW)
        self.assertEqual(sorted(gone), sorted(items[3:]))
        both = Retention(max_count=5, max_age_days=1)
        gone = both.expired(items, when=lambda t: t, now=NOW)
        self.assertEqual(sorted(gone), sorted(items[2:]))
        self.assertEqual(Retention().expired(items, when=lambda t: t, now=NOW), [])

    def test_validation(self):
        with self.assertRaises(CadenceError):
            Retention.from_dict({"max_count": 0})
        self.assertEqual(Retention.from_dict({"max_age_days": ""}).max_age_days, None)
