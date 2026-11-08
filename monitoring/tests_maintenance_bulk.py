"""Bulk select on the Maintenance list: a status set in bulk passes the
serializer's checks for each event and starts or retires its alert silence
as a single edit does; the safe bulk delete takes each event's silence
with it. Both stay inside the tenant and the grant."""
from __future__ import annotations

from django.contrib.auth.models import User

from auth_api.models import ObjectPermission, UserProfile

from .models import MaintenanceEvent, Silence
from .tests_maintenance import T0, URL, SilenceSyncTests, _MaintBase


class MaintenanceBulkTests(_MaintBase):
    _prefix = SilenceSyncTests._prefix
    _confirmed_event_with_device = SilenceSyncTests._confirmed_event_with_device

    def post(self, action, ids, **body):
        return self.client.post(f"{URL}{action}/", {"ids": [str(i) for i in ids], **body},
                                format="json")

    def test_describes_its_fields(self):
        r = self.client.get(f"{URL}bulk-edit-fields/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([f["key"] for f in r.json()["fields"]], ["status_id", "description"])

    def test_closing_in_bulk_retires_the_silence(self):
        event, _dev, _ip = self._confirmed_event_with_device()
        silence_id = event.silence_id
        self.assertIsNotNone(silence_id)
        r = self.post("bulk-update", [event.id],
                      fields={"status_id": str(self._status("completed").id)})
        self.assertEqual(r.status_code, 200, r.content)
        event.refresh_from_db()
        self.assertIsNone(event.silence_id)
        self.assertFalse(Silence.objects.filter(pk=silence_id).exists())

    def test_a_status_the_events_do_not_take_is_refused(self):
        from api.models import Status

        other = Status.objects.create(tenant=self.tenant, name="Racked", slug="racked",
                                      available_to=["device"])
        event_id = self._event().json()["id"]
        r = self.post("bulk-update", [event_id], fields={"status_id": str(other.id)})
        self.assertEqual(r.status_code, 400)

    def test_bulk_delete_takes_the_silence_and_leaves_other_tenants(self):
        from api.status_registry import seed_builtin_statuses

        event, _dev, _ip = self._confirmed_event_with_device()
        silence_id = event.silence_id
        seed_builtin_statuses(self.other)
        theirs = MaintenanceEvent.objects.create(
            tenant=self.other, kind="outage", status=self._status("reported", tenant=self.other),
            name="Theirs", starts_at=T0,
        )
        r = self.post("bulk-delete", [event.id, theirs.id], dry_run=True)
        self.assertEqual(r.json()["deleted_ids"], [str(event.id)])
        r = self.post("bulk-delete", [event.id, theirs.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertFalse(MaintenanceEvent.objects.filter(pk=event.pk).exists())
        self.assertFalse(Silence.objects.filter(pk=silence_id).exists())
        self.assertTrue(MaintenanceEvent.objects.filter(pk=theirs.pk).exists())

    def test_grants(self):
        event_id = self._event().json()["id"]
        user = User.objects.create_user("maint-viewer", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name="v", object_types=["maintenanceevent"],
                                            actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.assertEqual(self.post("bulk-update", [event_id],
                                   fields={"description": "x"}).status_code, 403)
        self.assertEqual(self.post("bulk-delete", [event_id]).status_code, 403)
