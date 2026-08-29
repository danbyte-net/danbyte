"""Maintenance & outage events (issue #20): workflows, impacts, calendar."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import timezone as tz

from api.models import Provider
from planning.tests_planned_changes import _PlanBase

from .models import MaintenanceEvent

T0 = datetime(2026, 8, 20, 22, 0, tzinfo=UTC)

URL = "/api/monitoring/maintenance-events/"


class _MaintBase(_PlanBase):
    def setUp(self):
        super().setUp()
        # The workflow vocabularies are editable /statuses rows, seeded on
        # install - mirror that seeding here.
        from api.status_registry import seed_builtin_statuses

        seed_builtin_statuses(self.tenant)

    def _status(self, slug, tenant=None):
        from api.models import Status

        return Status.objects.get(tenant=tenant or self.tenant, slug=slug)

    def _provider(self, name="CarrierOne"):
        return Provider.objects.create(
            tenant=self.tenant, name=name, slug=name.lower()
        )

    def _event(self, **over):
        status = over.pop("status", "tentative")
        body = {
            "kind": "maintenance",
            "status_id": str(self._status(status).id),
            "name": "Fiber splice, span DK-31",
            "starts_at": T0.isoformat(),
            "ends_at": (T0 + timedelta(hours=4)).isoformat(),
        }
        body.update(over)
        return self.client.post(URL, body, format="json")


class MaintenanceEventTests(_MaintBase):
    def test_create_and_read_a_maintenance_window(self):
        provider = self._provider()
        r = self._event(provider=str(provider.id), external_ref="MAINT-1001")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["provider_name"], "CarrierOne")
        self.assertTrue(body["is_open"])

    def test_status_must_come_from_the_catalog(self):
        # A status that isn't available to maintenance events (device-only
        # "Active") is refused - the /statuses catalog is the vocabulary.
        r = self._event(status="active")
        self.assertEqual(r.status_code, 400, r.content)
        # A row the user added themselves works like a built-in one.
        from api.models import Status

        Status.objects.create(
            tenant=self.tenant, name="Awaiting parts", slug="awaiting_parts",
            available_to=["maintenanceevent"], suppresses_alerts=True,
        )
        r = self._event(status="awaiting_parts")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["status"]["name"], "Awaiting parts")

    def test_outage_vocabulary_is_seeded_too(self):
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

        # A member with event rights but no device view cannot mark impact -
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
        from api.status_registry import seed_builtin_statuses

        self._event(name="Ours")
        seed_builtin_statuses(self.other)
        MaintenanceEvent.objects.create(
            tenant=self.other, kind="outage",
            status=self._status("reported", tenant=self.other),
            name="Theirs", starts_at=T0,
        )
        r = self.client.get(URL)
        self.assertEqual([e["name"] for e in r.json()["results"]], ["Ours"])


class SilenceSyncTests(_MaintBase):
    """A confirmed window suppresses exactly its impacted devices, and stops
    when the event closes."""

    def _prefix(self):
        from api.models import Prefix

        return Prefix.objects.create(tenant=self.tenant, cidr="10.9.9.0/24")

    def _confirmed_event_with_device(self):
        dev = self._device()
        from api.models import IPAddress

        ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self._prefix(), ip_address="10.9.9.9",
            assigned_device=dev,
        )
        event_id = self._event(status="confirmed").json()["id"]
        self.client.post(
            "/api/monitoring/event-impacts/",
            {"event": event_id, "object_type": "device",
             "object_id": str(dev.id), "level": "outage"},
            format="json",
        )
        return MaintenanceEvent.objects.get(pk=event_id), dev, ip

    def test_confirmed_event_owns_a_silence_matching_its_devices(self):
        event, dev, _ip = self._confirmed_event_with_device()
        self.assertIsNotNone(event.silence_id)
        self.assertEqual(
            list(event.silence.match_devices.values_list("pk", flat=True)),
            [dev.pk],
        )
        self.assertEqual(event.silence.starts_at, event.starts_at)
        self.assertEqual(event.silence.ends_at, event.ends_at)

    def test_the_silence_suppresses_only_the_impacted_device(self):
        from types import SimpleNamespace

        from monitoring.notify import active_silence

        event, dev, ip = self._confirmed_event_with_device()
        # Inside the window, an alert on the impacted device's IP is covered...
        inside = event.starts_at + (event.ends_at - event.starts_at) / 2
        covered = SimpleNamespace(
            tenant_id=self.tenant.id, kind="icmp", check_status="down",
            target_ip=ip, target_ip_id=ip.id,
        )
        self.assertIsNotNone(active_silence(covered, now=inside))
        # ...an alert on some other IP is not.
        from api.models import IPAddress

        other = IPAddress.objects.create(
            tenant=self.tenant, prefix=ip.prefix, ip_address="10.9.9.10"
        )
        uncovered = SimpleNamespace(
            tenant_id=self.tenant.id, kind="icmp", check_status="down",
            target_ip=other, target_ip_id=other.id,
        )
        self.assertIsNone(active_silence(uncovered, now=inside))

    def test_closing_the_event_retires_the_silence(self):
        event, _dev, _ip = self._confirmed_event_with_device()
        silence_id = event.silence_id
        r = self.client.patch(
            f"{URL}{event.id}/",
            {"status_id": str(self._status("completed").id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        event.refresh_from_db()
        self.assertIsNone(event.silence_id)
        from monitoring.models import Silence

        self.assertFalse(Silence.objects.filter(pk=silence_id).exists())

    def test_tentative_events_do_not_suppress(self):
        dev = self._device()
        event_id = self._event(status="tentative").json()["id"]
        self.client.post(
            "/api/monitoring/event-impacts/",
            {"event": event_id, "object_type": "device",
             "object_id": str(dev.id), "level": "outage"},
            format="json",
        )
        self.assertIsNone(
            MaintenanceEvent.objects.get(pk=event_id).silence_id
        )


class IngestTests(_MaintBase):
    """The external-parser door: upsert by provider reference."""

    INGEST = f"{URL}ingest/"

    def _provider(self):
        from api.models import Provider

        return Provider.objects.create(
            tenant=self.tenant, name="CarrierOne", slug="carrierone"
        )

    def test_ingest_creates_then_updates_by_reference(self):
        self._provider()
        body = {
            "provider": "carrierone",
            "external_ref": "MAINT-9",
            "kind": "maintenance",
            "status": "tentative",
            "name": "Splice window",
            "starts_at": T0.isoformat(),
            "ends_at": (T0 + timedelta(hours=4)).isoformat(),
            "raw_email": "Subject: maintenance...",
        }
        first = self.client.post(self.INGEST, body, format="json")
        self.assertEqual(first.status_code, 201, first.content)

        body["status"] = "confirmed"
        second = self.client.post(self.INGEST, body, format="json")
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(second.json()["id"], first.json()["id"])
        self.assertEqual(second.json()["status"]["name"], "Confirmed")
        self.assertEqual(MaintenanceEvent.objects.count(), 1)

    def test_ingest_replaces_impacts_and_syncs_the_silence(self):
        self._provider()
        dev = self._device()
        body = {
            "provider": "carrierone",
            "external_ref": "MAINT-10",
            "kind": "maintenance",
            "status": "confirmed",
            "name": "Splice window",
            "starts_at": T0.isoformat(),
            "ends_at": (T0 + timedelta(hours=4)).isoformat(),
            "impacts": [
                {"object_type": "device", "object_id": str(dev.id),
                 "level": "degraded"},
            ],
        }
        r = self.client.post(self.INGEST, body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        event = MaintenanceEvent.objects.get(pk=r.json()["id"])
        self.assertEqual(event.impacts.count(), 1)
        self.assertIsNotNone(event.silence_id)

        body["impacts"] = []
        self.client.post(self.INGEST, body, format="json")
        event.refresh_from_db()
        self.assertEqual(event.impacts.count(), 0)
        # No impacted devices → nothing to suppress.
        self.assertIsNone(event.silence_id)

    def test_ingest_requires_the_reference_and_a_known_provider(self):
        r = self.client.post(
            self.INGEST,
            {"kind": "maintenance", "status": "tentative", "name": "X",
             "starts_at": T0.isoformat(),
             "ends_at": (T0 + timedelta(hours=1)).isoformat()},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        r = self.client.post(
            self.INGEST,
            {"provider": "nope", "external_ref": "A", "kind": "maintenance",
             "status": "tentative", "name": "X",
             "starts_at": T0.isoformat(),
             "ends_at": (T0 + timedelta(hours=1)).isoformat()},
            format="json",
        )
        self.assertEqual(r.status_code, 400)


class IcalFeedTests(_MaintBase):
    def _token(self, user=None):
        import secrets

        from auth_api.models import ApiToken, hash_api_key

        key = secrets.token_hex(20)
        ApiToken.objects.create(
            user=user or self.admin, tenant=self.tenant, name="feed",
            key_hash=hash_api_key(key), prefix=key[:8],
        )
        return key

    def test_feed_serves_the_calendar_for_a_valid_token(self):
        from datetime import timedelta as td

        from django.utils import timezone

        from planning.models import Task

        board = self._board()
        Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"),
            title="Splice; window, real",
            due_date=timezone.localdate() + td(days=3),
        )
        # Relative, not T0: the feed serves today forward, so a hardcoded
        # date quietly ages out of the window and fails the suite on a
        # calendar date, not a code change.
        soon = timezone.now() + td(days=2)
        MaintenanceEvent.objects.create(
            tenant=self.tenant, kind="maintenance",
            status=self._status("confirmed"),
            name="Window A", starts_at=soon, ends_at=soon + timedelta(hours=4),
        )
        self.client.logout()

        r = self.client.get(f"/api/planning/calendar.ics?token={self._token()}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r["Content-Type"], "text/calendar; charset=utf-8")
        text = r.content.decode()
        self.assertIn("BEGIN:VCALENDAR", text)
        # RFC 5545: the semicolon and comma in the title arrive escaped.
        self.assertIn(r"Splice\; window\, real", text)
        self.assertIn("Maintenance: Window A", text)

    def test_feed_rejects_missing_or_bad_tokens(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/planning/calendar.ics").status_code, 401)
        self.assertEqual(
            self.client.get("/api/planning/calendar.ics?token=bogus").status_code, 401
        )
