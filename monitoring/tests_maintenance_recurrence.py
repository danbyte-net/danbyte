"""Repeating maintenance windows: one row, a rule, and every reader of the
window - silence, SLA, calendar, Zabbix - asking the same generator."""
from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from unittest import mock
from zoneinfo import ZoneInfo

from django.utils import timezone

from .escalation import advance_recurring_windows
from .models import EventImpact, MaintenanceEvent
from .tests_maintenance import URL, IcalFeedTests, SilenceSyncTests, _MaintBase

CPH = ZoneInfo("Europe/Copenhagen")


def cph(*args):
    return datetime(*args, tzinfo=CPH)


class _RecurBase(_MaintBase):
    _prefix = SilenceSyncTests._prefix
    _token = IcalFeedTests._token

    def nightly(self, **over):
        body = {
            "starts_at": cph(2026, 11, 20).isoformat(),
            "ends_at": cph(2026, 11, 27).isoformat(),
            "recurrence": "daily", "recurrence_start_time": "21:55",
            "recurrence_duration": 545, "timezone": "Europe/Copenhagen",
            "name": "Nightly power-off",
        }
        body.update(over)
        return self._event(**body)

    def with_device(self, event):
        dev = self._device()
        EventImpact.objects.create(
            tenant=self.tenant, event=event, object_type="api.device", object_id=dev.id,
        )
        return dev


class RecurrenceApiTests(_RecurBase):
    def test_a_nightly_window_is_one_row_with_a_rule(self):
        r = self.nightly()
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["recurrence"], "daily")
        self.assertEqual(body["recurrence_start_time"], "21:55")
        self.assertEqual(body["recurrence_weekdays"], [])
        self.assertEqual(body["recurrence_summary"], "Every day 21:55-07:00 until 27 Nov")
        self.assertEqual(MaintenanceEvent.objects.count(), 1)

    def test_weekly_needs_days_and_keeps_them_sorted(self):
        r = self.nightly(recurrence="weekly")
        self.assertEqual(r.status_code, 400)
        self.assertIn("recurrence_weekdays", r.json())
        r = self.nightly(recurrence="weekly", recurrence_weekdays=[4, 0, 4])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["recurrence_weekdays"], [0, 4])
        self.assertTrue(r.json()["recurrence_summary"].startswith("Every Mon, Fri 21:55"))

    def test_field_errors(self):
        cases = {
            "recurrence_start_time": {"recurrence_start_time": None},
            "recurrence_duration": {"recurrence_duration": 2},
            "timezone": {"timezone": "Mars/Olympus"},
        }
        for field, over in cases.items():
            r = self.nightly(**over)
            self.assertEqual(r.status_code, 400, (field, r.content))
            self.assertIn(field, r.json())
        r = self.nightly(recurrence_duration=25 * 60)
        self.assertIn("recurrence_duration", r.json())
        r = self.nightly(kind="outage", status="investigating")
        self.assertEqual(r.status_code, 400)
        self.assertIn("recurrence", r.json())

    def test_no_end_is_fine_when_it_repeats(self):
        r = self.nightly(ends_at=None)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["recurrence_summary"], "Every day 21:55-07:00")
        # A one-off maintenance still needs its end.
        self.assertEqual(self._event(ends_at=None).status_code, 400)

    def test_a_blank_zone_is_fixed_to_the_tenants_at_save(self):
        r = self.nightly(timezone="")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["timezone"], "UTC")

    def test_turning_it_off_clears_the_rule(self):
        eid = self.nightly().json()["id"]
        r = self.client.patch(f"{URL}{eid}/", {"recurrence": ""}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        ev = MaintenanceEvent.objects.get(pk=eid)
        self.assertEqual((ev.recurrence, ev.recurrence_start_time, ev.recurrence_duration),
                         ("", None, None))

    def test_existing_one_off_events_are_unchanged(self):
        r = self._event()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["recurrence"], "")
        self.assertEqual(r.json()["recurrence_summary"], "")
        self.assertIsNone(MaintenanceEvent.objects.get(pk=r.json()["id"]).rule)

    def test_active_at_means_inside_an_occurrence(self):
        eid = self.nightly().json()["id"]
        night = cph(2026, 11, 22, 3, 0).astimezone(UTC).isoformat().replace("+00:00", "Z")
        day = cph(2026, 11, 22, 12, 0).astimezone(UTC).isoformat().replace("+00:00", "Z")
        ids = [e["id"] for e in self.client.get(URL, {"active_at": night}).json()["results"]]
        self.assertEqual(ids, [eid])
        self.assertEqual(self.client.get(URL, {"active_at": day}).json()["results"], [])

    def test_the_calendar_shows_each_occurrence(self):
        self.nightly()
        r = self.client.get("/api/planning/calendar/?start=2026-11-23&end=2026-11-24")
        self.assertEqual(r.status_code, 200, r.content)
        events = r.json()["events"]
        starts = sorted(e["starts_at"] for e in events)
        # The nights of the 21st-24th touch the window (a day either side).
        self.assertIn(cph(2026, 11, 23, 21, 55).astimezone(UTC).isoformat(), starts)
        self.assertEqual(len({e["key"] for e in events}), len(events))
        self.assertTrue(all(e["recurrence_summary"] for e in events))
        ics = self.client.get(
            "/api/planning/calendar.ics",
            {"token": self._token(), "start": "2026-11-23", "end": "2026-11-24"},
        )
        self.assertEqual(ics.status_code, 200)
        uids = [ln for ln in ics.content.decode().splitlines() if ln.startswith("UID:event-")]
        self.assertGreater(len(uids), 1)
        self.assertEqual(len(set(uids)), len(uids))


class RecurringSilenceTests(_RecurBase):
    def confirmed(self):
        r = self.nightly(status="confirmed")
        ev = MaintenanceEvent.objects.get(pk=r.json()["id"])
        self.with_device(ev)
        return ev

    def test_the_silence_is_the_occurrence_open_now_or_next(self):
        ev = self.confirmed()
        ev.sync_silence(now=cph(2026, 11, 21, 12, 0))
        ev.refresh_from_db()
        self.assertEqual(ev.silence.starts_at, cph(2026, 11, 21, 21, 55))
        self.assertEqual(ev.silence.ends_at, cph(2026, 11, 22, 7, 0))
        self.assertFalse(ev.silence.is_active(cph(2026, 11, 21, 12, 0)))
        self.assertTrue(ev.silence.is_active(cph(2026, 11, 22, 3, 0)))

    def test_the_tick_moves_it_on_and_retires_it_at_the_end(self):
        ev = self.confirmed()
        ev.sync_silence(now=cph(2026, 11, 21, 12, 0))
        self.assertEqual(advance_recurring_windows(cph(2026, 11, 22, 6, 0)), 0)
        self.assertEqual(advance_recurring_windows(cph(2026, 11, 22, 7, 1)), 1)
        ev.refresh_from_db()
        self.assertEqual(ev.silence.starts_at, cph(2026, 11, 22, 21, 55))
        sid = ev.silence_id
        # Past the last night (ends 27 Nov 00:00): the silence is retired.
        advance_recurring_windows(cph(2026, 11, 27, 0, 1))
        ev.refresh_from_db()
        self.assertIsNone(ev.silence_id)
        from .models import Silence

        self.assertFalse(Silence.objects.filter(pk=sid).exists())

    def test_alerts_are_suppressed_inside_an_occurrence_only(self):
        from .notify import active_silence

        ev = self.confirmed()
        ev.sync_silence(now=cph(2026, 11, 21, 12, 0))
        dev_id = ev.impacts.get().object_id
        from api.models import IPAddress

        ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self._prefix(), ip_address="10.9.9.9",
            assigned_device_id=dev_id,
        )
        alert = mock.Mock(tenant_id=self.tenant.id, target_ip=ip, target_ip_id=ip.id,
                          kind="icmp", template=None)
        with mock.patch("monitoring.notify.silence_covers", return_value=True):
            self.assertIsNotNone(active_silence(alert, now=cph(2026, 11, 22, 3, 0)))
            self.assertIsNone(active_silence(alert, now=cph(2026, 11, 22, 12, 0)))


class RecurringSlaTests(_RecurBase):
    def test_the_sla_excuses_the_nights_not_the_span(self):
        r = self.nightly(status="confirmed")
        ev = MaintenanceEvent.objects.get(pk=r.json()["id"])
        spans = ev.occurrences(cph(2026, 11, 21), cph(2026, 11, 23))
        self.assertEqual(len(spans), 3)  # nights of the 20th, 21st, 22nd
        total = sum((e - s for s, e in spans), timedelta())
        # The 20th's night is cut at the window's start (the 21st, 00:00 is
        # inside it); excused time is the nights, never 48 hours.
        self.assertLess(total, timedelta(hours=30))
        self.assertEqual(spans[1], (cph(2026, 11, 21, 21, 55), cph(2026, 11, 22, 7, 0)))

    def test_a_one_off_event_keeps_its_window(self):
        ev = MaintenanceEvent.objects.get(pk=self._event().json()["id"])
        self.assertEqual(ev.occurrences(ev.starts_at - timedelta(days=1),
                                        ev.ends_at + timedelta(days=1)),
                         [(ev.starts_at, ev.ends_at)])
        self.assertEqual(ev.window_at()[0], ev.starts_at)

    def test_the_rule_reads_the_events_fields(self):
        ev = MaintenanceEvent(recurrence="daily", recurrence_start_time=time(21, 55),
                              recurrence_duration=545, timezone="Europe/Copenhagen",
                              starts_at=timezone.now(), ends_at=None)
        self.assertEqual(ev.rule.start_time, time(21, 55))
        self.assertEqual(ev.rule.zone, CPH)
