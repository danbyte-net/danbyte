"""Working hours on contacts (#66) and support hours on providers (#67).

Both records answer "can I reach them right now", so both store the same
weekly schedule and expose the same derived reads.
"""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .business_hours import ScheduleError, describe, is_open_at, validate_schedule
from .models import Contact, Provider

User = get_user_model()

WEEKDAYS = {str(d): ["08:00", "17:00"] for d in range(5)}


class ScheduleShapeTests(APITestCase):
    def test_describe_collapses_a_run_of_identical_days(self):
        self.assertEqual(
            describe(WEEKDAYS, "Europe/Copenhagen"),
            "Mon-Fri 08:00-17:00 Europe/Copenhagen",
        )

    def test_always_open_reads_as_24_7(self):
        always = {str(d): ["00:00", "24:00"] for d in range(7)}
        self.assertEqual(describe(always, "UTC"), "24/7")

    def test_split_days_stay_separate(self):
        self.assertEqual(
            describe({"0": ["08:00", "17:00"], "5": ["10:00", "14:00"]}, "UTC"),
            "Mon 08:00-17:00, Sat 10:00-14:00 UTC",
        )

    def test_no_schedule_describes_as_nothing(self):
        self.assertEqual(describe({}, "UTC"), "")

    def test_open_now_is_none_without_hours_or_zone(self):
        moment = dt.datetime(2026, 8, 26, 9, 0, tzinfo=ZoneInfo("UTC"))
        # Unknown is not the same answer as closed - it must stay null.
        self.assertIsNone(is_open_at({}, "Europe/Copenhagen", moment))
        self.assertIsNone(is_open_at(WEEKDAYS, "", moment))

    def test_open_now_reads_the_records_own_zone(self):
        # 23:00 UTC Wednesday is 09:00 Thursday in Tokyo - inside 08:00-17:00
        # there, outside it in Copenhagen. The zone on the record decides.
        moment = dt.datetime(2026, 8, 26, 23, 0, tzinfo=ZoneInfo("UTC"))
        self.assertTrue(is_open_at(WEEKDAYS, "Asia/Tokyo", moment))
        self.assertFalse(is_open_at(WEEKDAYS, "Europe/Copenhagen", moment))

    def test_a_weekend_is_closed_not_unknown(self):
        sunday = dt.datetime(2026, 8, 30, 9, 0, tzinfo=ZoneInfo("UTC"))
        self.assertFalse(is_open_at(WEEKDAYS, "Europe/Copenhagen", sunday))

    def test_the_end_of_a_span_is_exclusive(self):
        day = {"2": ["08:00", "17:00"]}  # Wednesday
        at_close = dt.datetime(2026, 8, 26, 17, 0, tzinfo=ZoneInfo("UTC"))
        self.assertFalse(is_open_at(day, "UTC", at_close))

    def test_bad_shapes_are_rejected(self):
        for bad in (
            {"9": ["08:00", "17:00"]},      # not a weekday
            {"0": ["17:00", "08:00"]},      # ends before it starts
            {"0": ["8:00", "17:00"]},       # not HH:MM
            {"0": ["08:00"]},               # missing the end
            "Mon-Fri",                      # not an object
        ):
            with self.assertRaises(ScheduleError):
                validate_schedule(bad)

    def test_an_empty_day_is_dropped_rather_than_stored(self):
        self.assertEqual(validate_schedule({"0": [], "1": ["08:00", "17:00"]}),
                         {"1": ["08:00", "17:00"]})


class BusinessHoursAPITests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_contact_round_trips_its_hours(self):
        r = self.client.post(
            "/api/contacts/",
            {
                "name": "NOC",
                "business_hours": WEEKDAYS,
                "business_hours_tz": "Europe/Copenhagen",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(
            body["business_hours_display"], "Mon-Fri 08:00-17:00 Europe/Copenhagen"
        )
        self.assertIn("open_now", body)

    def test_contact_without_hours_reports_null_not_false(self):
        r = self.client.post("/api/contacts/", {"name": "Quiet"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["open_now"])
        self.assertEqual(r.json()["business_hours_display"], "")

    def test_a_broken_schedule_is_a_field_error_not_a_500(self):
        r = self.client.post(
            "/api/contacts/",
            {"name": "Bad", "business_hours": {"0": ["17:00", "08:00"]}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("business_hours", r.json())

    def test_an_unknown_zone_is_rejected(self):
        r = self.client.post(
            "/api/contacts/",
            {"name": "Bad tz", "business_hours_tz": "Mars/Olympus"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("business_hours_tz", r.json())

    def test_provider_carries_support_details_and_an_account_manager(self):
        contact = Contact.objects.create(tenant=self.tenant, name="Rep")
        r = self.client.post(
            "/api/providers/",
            {
                "name": "Telco",
                "slug": "telco",
                "support_contract": "SUP-99",
                "support_phone": "+45 1234",
                "account_manager_id": str(contact.id),
                "business_hours": {str(d): ["00:00", "24:00"] for d in range(7)},
                "business_hours_tz": "UTC",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["support_contract"], "SUP-99")
        self.assertEqual(body["account_manager"]["name"], "Rep")
        self.assertEqual(body["business_hours_display"], "24/7")
        self.assertTrue(body["open_now"])

    def test_account_manager_cannot_be_borrowed_from_another_tenant(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = Contact.objects.create(tenant=other, name="Theirs")
        r = self.client.post(
            "/api/providers/",
            {"name": "T2", "slug": "t2", "account_manager_id": str(theirs.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_deleting_the_contact_leaves_the_provider(self):
        contact = Contact.objects.create(tenant=self.tenant, name="Leaving")
        p = Provider.objects.create(
            tenant=self.tenant, name="T3", slug="t3", account_manager=contact
        )
        contact.delete()
        p.refresh_from_db()
        self.assertIsNone(p.account_manager_id)
