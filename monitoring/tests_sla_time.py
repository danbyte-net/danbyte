"""The interval arithmetic under every SLA figure."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from django.test import SimpleTestCase

from .sla_time import (
    DOWN,
    UNMEASURED,
    UP,
    Rules,
    apply_grace,
    classify,
    combine,
    restrict,
    service_windows,
    subtract,
    tally,
)

T = datetime(2026, 9, 7, tzinfo=UTC)  # a Monday


def at(h, m=0):
    return T + timedelta(hours=h, minutes=m)


def seg(a, b, status):
    return {"start": at(a), "end": at(b), "status": status}


class WindowTests(SimpleTestCase):
    def test_around_the_clock_by_default(self):
        self.assertEqual(service_windows(at(0), at(48), "UTC"), [(at(0), at(48))])

    def test_business_hours_in_the_agreements_zone(self):
        # 08-17 Copenhagen is 06-15 UTC in September.
        w = service_windows(
            at(0), at(24), "Europe/Copenhagen", {"mon": [["08:00", "17:00"]]}
        )
        self.assertEqual(w, [(at(6), at(15))])

    def test_holidays_are_not_covered(self):
        w = service_windows(
            at(0), at(48), "UTC",
            {d: [["00:00", "24:00"]] for d in ("mon", "tue")}, holidays=["2026-09-07"],
        )
        self.assertEqual(w, [(at(24), at(48))])

    def test_subtract(self):
        self.assertEqual(
            subtract([(at(0), at(10))], [(at(2), at(3)), (at(5), at(6))]),
            [(at(0), at(2)), (at(3), at(5)), (at(6), at(10))],
        )


class TimelineTests(SimpleTestCase):
    def test_counting_rules(self):
        segs = [seg(0, 1, "up"), seg(1, 2, "degraded"), seg(2, 3, "stale"), seg(3, 4, "down")]
        self.assertEqual(
            [c for *_, c in classify(segs)], [UP, UNMEASURED, DOWN]
        )
        strict = classify(segs, Rules(degraded=DOWN, stale=DOWN))
        self.assertEqual(strict, [(at(0), at(1), UP), (at(1), at(4), DOWN)])

    def test_restrict_to_service_hours(self):
        tl = classify([seg(0, 10, "down")])
        self.assertEqual(restrict(tl, [(at(2), at(3)), (at(8), at(12))]),
                         [(at(2), at(3), DOWN), (at(8), at(10), DOWN)])

    def test_grace_forgives_short_blips_only(self):
        tl = [(at(0), at(1), UP), (at(1), at(1, 1), DOWN), (at(1, 1), at(2), UP),
              (at(2), at(3), DOWN)]
        out = apply_grace(tl, 5 * 60)
        self.assertEqual(tally(out)["incidents"], 1)
        self.assertEqual(tally(out)["down_s"], 3600)

    def test_all_must_pass(self):
        a = [(at(0), at(2), UP), (at(2), at(3), DOWN), (at(3), at(4), UP)]
        b = [(at(0), at(1), UNMEASURED), (at(1), at(4), UP)]
        self.assertEqual(
            combine([a, b], "all"),
            [(at(0), at(2), UP), (at(2), at(3), DOWN), (at(3), at(4), UP)],
        )

    def test_redundancy_is_down_only_when_all_are(self):
        a = [(at(0), at(2), DOWN), (at(2), at(4), UP)]
        b = [(at(0), at(1), UP), (at(1), at(3), DOWN), (at(3), at(4), UP)]
        self.assertEqual(
            combine([a, b], "any"),
            [(at(0), at(1), UP), (at(1), at(2), DOWN), (at(2), at(4), UP)],
        )

    def test_tally(self):
        t = tally([(at(0), at(1), UP), (at(1), at(2), DOWN), (at(2), at(3), UNMEASURED),
                   (at(3), at(4), DOWN)])
        self.assertEqual((t["up_s"], t["down_s"], t["unmeasured_s"], t["incidents"]),
                         (3600, 7200, 3600, 2))
