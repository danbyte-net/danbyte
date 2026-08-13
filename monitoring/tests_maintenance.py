"""Maintenance & outage events (issue #20): workflows, impacts, calendar."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone as tz

from api.models import Provider
from planning.tests_planned_changes import _PlanBase

from .models import MaintenanceEvent

T0 = datetime(2026, 8, 20, 22, 0, tzinfo=tz.utc)

URL = "/api/monitoring/maintenance-events/"


class MaintenanceEventTests(_PlanBase):
    def _provider(self, name="CarrierOne"):
        return Provider.objects.create(
            tenant=self.tenant, name=name, slug=name.lower()
        )

    def _event(self, **over):
        body = {
            "kind": "maintenance",
            "status": "tentative",
            "name": "Fiber splice, span DK-31",
            "starts_at": T0.isoformat(),
            "ends_at": (T0 + timedelta(hours=4)).isoformat(),
        }
        body.update(over)
        return self.client.post(URL, body, format="json")

    def test_create_and_read_a_maintenance_window(self):
        provider = self._provider()
        r = self._event(provider=str(provider.id), external_ref="MAINT-1001")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["provider_name"], "CarrierOne")
        self.assertTrue(body["is_open"])

    def test_statuses_are_per_kind(self):
        # An outage status on a maintenance event is vocabulary confusion the
        # API refuses rather than stores.
        self.assertEqual(self._event(status="investigating").status_code, 400)
        r = self._event(
            kind="outage", status="investigating", ends_at=None,
            etr=(T0 + timedelta(hours=2)).isoformat(),
        )
        self.assertEqual(r.status_code, 201, r.content)

    def test_maintenance_needs_an_end_and_no_etr(self):
        self.assertEqual(self._event(ends_at=None).status_code, 400)
        self.assertEqual(
            self._event(etr=(T0 + timedelta(hours=1)).isoformat()).status_code,
            400,
        )

    def test_an_outage_may_be_open_ended(self):
        r = self._event(kind="outage", status="reported", ends_at=None)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["ends_at"])

    def test_a_window_cannot_end_before_it_starts(self):
        r = self._event(ends_at=(T0 - timedelta(hours=1)).isoformat())
        self.assertEqual(r.status_code, 400)

    def test_provider_ref_is_the_dedup_key(self):
        provider = self._provider()
        first = self._event(provider=str(provider.id), external_ref="MAINT-1")
        self.assertEqual(first.status_code, 201)
        dupe = self._event(provider=str(provider.id), external_ref="MAINT-1")
        # The shared IntegrityError handler answers duplicates with 409.
        self.assertEqual(dupe.status_code, 409, dupe.content)
        # No ref → no constraint; manual events are free-form.
        self.assertEqual(self._event().status_code, 201)
        self.assertEqual(self._event().status_code, 201)

    def test_impacts_require_view_on_the_target(self):
        event_id = self._event().json()["id"]
        dev = self._device()
        r = self.client.post(
            "/api/monitoring/event-impacts/",
            {
                "event": event_id,
                "object_type": "device",
                "object_id": str(dev.id),
                "level": "degraded",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["object_type"], "api.device")

        # A member with event rights but no device view cannot mark impact —
        # on an object not yet impacted, so RBAC is what answers, not the
        # uniqueness validator.
        dev2 = self._device(name="dev2")
        member = self._member("noc2", types=["maintenanceevent", "eventimpact"],
                              actions=["view", "add", "change"])
        self._as(member)
        r = self.client.post(
            "/api/monitoring/event-impacts/",
            {
                "event": event_id,
                "object_type": "device",
                "object_id": str(dev2.id),
                "level": "outage",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 403, r.content)

    def test_calendar_carries_events_and_ignores_the_board_filter(self):
        provider = self._provider()
        self._event(provider=str(provider.id), name="Window A")
        board = self._board()
        r = self.client.get(
            "/api/planning/calendar/?start=2026-08-01&end=2026-08-31"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([e["name"] for e in r.json()["events"]], ["Window A"])
        # Provider maintenance matters to every board's schedule.
        r = self.client.get(
            f"/api/planning/calendar/?start=2026-08-01&end=2026-08-31&board={board.id}"
        )
        self.assertEqual(len(r.json()["events"]), 1)

    def test_tenant_isolation(self):
        self._event(name="Ours")
        MaintenanceEvent.objects.create(
            tenant=self.other, kind="outage", status="reported",
            name="Theirs", starts_at=T0,
        )
        r = self.client.get(URL)
        self.assertEqual([e["name"] for e in r.json()["results"]], ["Ours"])
