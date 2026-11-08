"""PDF stamps print in the reader's timezone, named, so a report's cover
date and its footer agree."""
from __future__ import annotations

import datetime as dt
from unittest import mock
from zoneinfo import ZoneInfo

from django.test import SimpleTestCase

from .drawing_pdf import REPORT_ZONE, in_zone, reader_now, stamp


class StampTests(SimpleTestCase):
    WHEN = dt.datetime(2026, 11, 6, 22, 1, tzinfo=dt.UTC)

    def test_utc_prints_as_before(self):
        self.assertEqual(stamp(self.WHEN), "2026-11-06 22:01 UTC")

    def test_the_readers_zone_is_named(self):
        kyiv = self.WHEN.astimezone(ZoneInfo("Europe/Kyiv"))
        self.assertEqual(stamp(kyiv), "2026-11-07 00:01 EET")

    def test_naive_is_utc(self):
        self.assertEqual(stamp(self.WHEN.replace(tzinfo=None)), "2026-11-06 22:01 UTC")

    def test_reader_now_takes_the_preference(self):
        with mock.patch("auth_api.user_prefs.datetime_prefs",
                        return_value={"timezone": "Europe/Kyiv"}):
            self.assertEqual(reader_now(None, None).tzinfo, ZoneInfo("Europe/Kyiv"))

    def test_a_broken_preference_is_utc(self):
        with mock.patch("auth_api.user_prefs.datetime_prefs",
                        return_value={"timezone": "Nowhere/Land"}):
            self.assertEqual(reader_now(None, None).tzinfo, dt.UTC)

    def test_table_zone_is_scoped(self):
        with in_zone(ZoneInfo("Europe/Kyiv")):
            self.assertEqual(REPORT_ZONE.get(), ZoneInfo("Europe/Kyiv"))
        self.assertEqual(REPORT_ZONE.get(), dt.UTC)
