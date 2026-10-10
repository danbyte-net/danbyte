"""A power panel's optional location: it must be in the panel's site, it is
tenant-scoped like every relation, it filters the list, and the panel bulk
edit sets or clears it under the same rules as the edit form's PATCH."""
from __future__ import annotations

from api.models import Location, PowerPanel, Site
from audit.models import ChangeLogEntry
from core.models import Organization, Tenant

from .tests_power_bulk import _Base

URL = "/api/power-panels/"
SAME_SITE = "Pick a location within the panel's site."


class _LocBase(_Base):
    def setUp(self):
        super().setUp()
        self.hall = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a")
        self.room = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Room 2", slug="room-2")
        self.far_hall = Location.objects.create(
            tenant=self.tenant, site=self.site2, name="Hall Z", slug="hall-z")
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        other_site = Site.objects.create(tenant=other, name="x")
        self.theirs = Location.objects.create(
            tenant=other, site=other_site, name="Theirs", slug="theirs")


class PanelLocationTests(_LocBase):
    def test_create_with_a_location_in_the_site_and_read_it_back(self):
        r = self.client.post(URL, {"name": "MDB-5", "site_id": str(self.site.id),
                                   "location_id": str(self.hall.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["location"], {"id": str(self.hall.id), "name": "Hall A"})
        r = self.client.get(f"{URL}{r.json()['id']}/")
        self.assertEqual(r.json()["location"]["name"], "Hall A")

    def test_location_is_optional(self):
        r = self.client.post(URL, {"name": "MDB-6", "site_id": str(self.site.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["location"])

    def test_a_location_in_another_site_is_refused(self):
        r = self.client.post(URL, {"name": "MDB-7", "site_id": str(self.site.id),
                                   "location_id": str(self.far_hall.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"location_id": [SAME_SITE]})
        self.assertFalse(PowerPanel.objects.filter(name="MDB-7").exists())

    def test_another_tenants_location_is_not_found(self):
        r = self.client.patch(f"{URL}{self.panel.id}/",
                              {"location_id": str(self.theirs.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("location_id", r.json())
        self.panel.refresh_from_db()
        self.assertIsNone(self.panel.location_id)

    def test_moving_site_keeps_the_rule(self):
        self.panel.location = self.hall
        self.panel.save()
        r = self.client.patch(f"{URL}{self.panel.id}/", {"site_id": str(self.site2.id)},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"location_id": [SAME_SITE]})
        r = self.client.patch(f"{URL}{self.panel.id}/", {"site_id": str(self.site2.id),
                                                         "location_id": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.panel.refresh_from_db()
        self.assertEqual((self.panel.site_id, self.panel.location_id), (self.site2.id, None))

    def test_deleting_the_location_keeps_the_panel(self):
        self.panel.location = self.hall
        self.panel.save()
        self.hall.delete()
        self.panel.refresh_from_db()
        self.assertIsNone(self.panel.location_id)

    def test_list_filters_by_location(self):
        PowerPanel.objects.filter(pk=self.panel.pk).update(location=self.hall)
        PowerPanel.objects.filter(pk=self.empty.pk).update(location=self.room)
        r = self.client.get(f"{URL}?location={self.hall.id}")
        self.assertEqual([p["name"] for p in r.json()["results"]], ["MDB-1"])
        self.assertEqual(r.json()["results"][0]["location"]["id"], str(self.hall.id))


class PanelLocationBulkTests(_LocBase):
    def test_bulk_sets_and_clears_the_location_and_logs_each_row(self):
        r = self.update(URL, [self.panel.id, self.empty.id], {"location_id": str(self.hall.id)})
        self.assertEqual(r.status_code, 200, r.content)
        for p in (self.panel, self.empty):
            p.refresh_from_db()
            self.assertEqual(p.location_id, self.hall.id)
            self.assertTrue(ChangeLogEntry.objects.filter(
                object_id=str(p.pk), action="update").exists())
        r = self.update(URL, [self.panel.id], {"location_id": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.panel.refresh_from_db()
        self.assertIsNone(self.panel.location_id)

    def test_bulk_refuses_a_location_outside_any_rows_site_and_writes_nothing(self):
        r = self.update(URL, [self.panel.id, self.far.id], {"location_id": str(self.hall.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("location_id", r.json())
        self.assertIn("MDB-9", str(r.json()))
        for p in (self.panel, self.far):
            p.refresh_from_db()
            self.assertIsNone(p.location_id)

    def test_bulk_site_move_with_a_location_needs_it_changed_too(self):
        PowerPanel.objects.filter(pk=self.panel.pk).update(location=self.hall)
        r = self.update(URL, [self.panel.id], {"site_id": str(self.site2.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.panel.refresh_from_db()
        self.assertEqual(self.panel.site_id, self.site.id)
        r = self.update(URL, [self.panel.id], {"site_id": str(self.site2.id),
                                               "location_id": str(self.far_hall.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.panel.refresh_from_db()
        self.assertEqual((self.panel.site_id, self.panel.location_id),
                         (self.site2.id, self.far_hall.id))

    def test_bulk_refuses_another_tenants_location(self):
        r = self.update(URL, [self.panel.id], {"location_id": str(self.theirs.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.panel.refresh_from_db()
        self.assertIsNone(self.panel.location_id)
