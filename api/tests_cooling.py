"""Cooling sources and feeds (#434, Cooling B): CRUD shaped like power panels
and feeds, tenant and site scoping, the 409 on a source with feeds, bulk
edit and delete, the feeds as a rack's cooling supply, source and feed
utilisation, the cross-site rack-move blocker, import/export and the
picker."""
from __future__ import annotations

import csv
import io

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.capacity import cooling_source_capacity, rack_cooling
from api.models import (
    CoolingFeed,
    CoolingSource,
    Device,
    DeviceType,
    Location,
    Rack,
    Site,
    Status,
)
from api.status_registry import seed_builtin_statuses
from api.test_utils import status_for
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

SOURCES = "/api/cooling-sources/"
FEEDS = "/api/cooling-feeds/"


def _body(resp) -> str:
    if hasattr(resp, "streaming_content"):
        return b"".join(resp.streaming_content).decode("utf-8")
    return resp.content.decode("utf-8")


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.status = status_for(self.tenant)
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.login(self.admin)
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.site2 = Site.objects.create(tenant=self.tenant, name="dc2")
        self.hall = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall", slug="hall")
        self.far_hall = Location.objects.create(
            tenant=self.tenant, site=self.site2, name="Far", slug="far")
        self.crah = CoolingSource.objects.create(
            tenant=self.tenant, site=self.site, name="CRAH-1", type="crah",
            fluid="air", rated_capacity_w=20000)
        self.rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1")
        self.rack2 = Rack.objects.create(tenant=self.tenant, site=self.site, name="R2")
        hot = DeviceType.objects.create(tenant=self.tenant, name="gpu", heat_output_w=3000)
        self.srv = Device.objects.create(
            tenant=self.tenant, name="srv1", site=self.site, rack=self.rack, device_type=hot)
        self.srv2 = Device.objects.create(
            tenant=self.tenant, name="srv2", site=self.site, rack=self.rack2, device_type=hot)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def member(self, *grants):
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for types, actions, sites in grants:
            perm = ObjectPermission.objects.create(
                name=f"{types} {actions}", object_types=list(types), actions=list(actions))
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            for site in sites:
                perm.sites.add(site)
        self.login(user)
        return user

    def feed(self, name="L1", rack=None, source=None, **kw):
        return CoolingFeed.objects.create(
            tenant=self.tenant, source=source or self.crah, name=name,
            rack=rack, **kw)


class CrudTests(_Base):
    def test_create_source_and_feed_and_read_them_back(self):
        r = self.client.post(SOURCES, {
            "name": "CH-1", "site_id": str(self.site.id), "location_id": str(self.hall.id),
            "type": "chiller", "fluid": "water", "rated_capacity_w": 100000,
            "redundancy_group": "N+1", "status_id": str(self.status.id),
            "device_id": str(self.srv.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["type_display"], "Chiller")
        self.assertEqual(body["location"]["name"], "Hall")
        self.assertEqual(body["device"]["name"], "srv1")
        r = self.client.post(FEEDS, {
            "name": "Loop A", "source_id": body["id"], "rack_id": str(self.rack.id),
            "rated_capacity_w": 10000, "flow_rate_lpm": "42.5", "supply_temp_c": "18.0",
            "return_temp_c": "28.5", "connector": "QD", "max_utilization": 90,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        feed = r.json()
        self.assertEqual(feed["site"]["name"], "dc1")
        self.assertEqual(feed["capacity"]["available_w"], 9000)
        self.assertEqual(feed["capacity"]["heat_allocated_w"], 3000)
        self.assertFalse(feed["capacity"]["redundant"])
        detail = self.client.get(f"{SOURCES}{body['id']}/").json()
        self.assertEqual(detail["feed_count"], 1)
        self.assertEqual(detail["capacity"]["heat_allocated_w"], 3000)
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=body["id"]).exists())

    def test_name_is_unique_per_site(self):
        r = self.client.post(SOURCES, {"name": "CRAH-1", "site_id": str(self.site.id)},
                             format="json")
        self.assertEqual(r.status_code, 409, r.content)
        r = self.client.post(SOURCES, {"name": "CRAH-1", "site_id": str(self.site2.id)},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_location_must_be_in_the_site(self):
        r = self.client.post(SOURCES, {
            "name": "X", "site_id": str(self.site.id), "location_id": str(self.far_hall.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_id", r.json())

    def test_feed_rack_must_be_at_the_source_site(self):
        far = Rack.objects.create(tenant=self.tenant, site=self.site2, name="R9")
        r = self.client.post(FEEDS, {
            "name": "L", "source_id": str(self.crah.id), "rack_id": str(far.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("rack_id", r.json())

    def test_status_must_be_offered_to_the_type(self):
        vlan_only = Status.objects.create(
            tenant=self.tenant, name="Odd", slug="odd", available_to=["vlan"])
        r = self.client.patch(f"{SOURCES}{self.crah.id}/", {"status_id": str(vlan_only.id)},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_source_with_feeds_is_a_409_to_delete(self):
        self.feed()
        r = self.client.delete(f"{SOURCES}{self.crah.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertTrue(CoolingSource.objects.filter(pk=self.crah.pk).exists())
        CoolingFeed.objects.all().delete()
        self.assertEqual(self.client.delete(f"{SOURCES}{self.crah.id}/").status_code, 204)

    def test_filters(self):
        other = CoolingSource.objects.create(
            tenant=self.tenant, site=self.site2, name="DRY-1", type="dry_cooler")
        self.feed(rack=self.rack)
        self.feed(name="L9", source=other)
        names = lambda url: sorted(x["name"] for x in self.client.get(url).json()["results"])  # noqa: E731
        self.assertEqual(names(f"{SOURCES}?site={self.site2.id}"), ["DRY-1"])
        self.assertEqual(names(f"{SOURCES}?type=crah"), ["CRAH-1"])
        self.assertEqual(names(f"{SOURCES}?rack={self.rack.id}"), ["CRAH-1"])
        self.assertEqual(names(f"{SOURCES}?search=dry"), ["DRY-1"])
        self.assertEqual(names(f"{FEEDS}?source={other.id}"), ["L9"])
        self.assertEqual(names(f"{FEEDS}?rack={self.rack.id}"), ["L1"])
        self.assertEqual(names(f"{FEEDS}?site={self.site.id}"), ["L1"])

    def test_picker_is_id_and_name(self):
        rows = self.client.get(f"{SOURCES}?picker=1").json()["results"]
        self.assertEqual([(r["id"], r["name"]) for r in rows], [(str(self.crah.id), "CRAH-1")])
        self.assertNotIn("capacity", rows[0])

    def test_choices_are_served(self):
        body = self.client.get("/api/dcim/choices/").json()
        self.assertIn({"value": "crah", "label": "CRAH"}, body["cooling_source_types"])
        self.assertIn({"value": "glycol", "label": "Glycol"}, body["cooling_fluids"])
        self.assertEqual([c["value"] for c in body["cooling_feed_types"]],
                         ["primary", "redundant"])


class ScopeTests(_Base):
    def setUp(self):
        super().setUp()
        org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        site = Site.objects.create(tenant=self.other, name="x")
        self.theirs = CoolingSource.objects.create(tenant=self.other, site=site, name="T")

    def test_another_tenants_source_is_invisible_and_unusable(self):
        names = [x["name"] for x in self.client.get(SOURCES).json()["results"]]
        self.assertEqual(names, ["CRAH-1"])
        self.assertEqual(self.client.get(f"{SOURCES}{self.theirs.id}/").status_code, 404)
        r = self.client.post(FEEDS, {"name": "L", "source_id": str(self.theirs.id)},
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_default_closed_without_a_grant(self):
        self.member((["rack"], ["view"], []))
        self.assertEqual(self.client.get(SOURCES).status_code, 403)
        self.assertEqual(self.client.get(FEEDS).status_code, 403)

    def test_site_scoped_grant_sees_its_site_only(self):
        CoolingSource.objects.create(tenant=self.tenant, site=self.site2, name="FAR")
        self.feed()
        self.member((["coolingsource", "coolingfeed"], ["view"], [self.site2]))
        names = [x["name"] for x in self.client.get(SOURCES).json()["results"]]
        self.assertEqual(names, ["FAR"])
        self.assertEqual(self.client.get(FEEDS).json()["results"], [])


class BulkTests(_Base):
    def test_bulk_delete_keeps_a_source_with_feeds_unless_with_feeds(self):
        f = self.feed()
        r = self.client.post(f"{SOURCES}bulk-delete/", {"ids": [str(self.crah.id)]},
                             format="json")
        self.assertEqual(r.json()["deleted"], 0)
        self.assertIn("1 cooling feed", r.json()["skipped"][0]["reason"])
        r = self.client.post(f"{SOURCES}bulk-delete/",
                             {"ids": [str(self.crah.id)], "with_feeds": True}, format="json")
        self.assertEqual(r.json()["deleted"], 1, r.content)
        self.assertFalse(CoolingFeed.objects.filter(pk=f.pk).exists())
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(f.pk), action="delete").exists())

    def test_bulk_update_feeds(self):
        a, b = self.feed("A"), self.feed("B")
        r = self.client.post(f"{FEEDS}bulk-update/", {
            "ids": [str(a.id), str(b.id)],
            "fields": {"type": "redundant", "max_utilization": 70,
                       "rack_id": str(self.rack.id), "status_id": str(self.status.id)},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        for f in (a, b):
            f.refresh_from_db()
            self.assertEqual((f.type, f.max_utilization, f.rack_id),
                             ("redundant", 70, self.rack.id))

    def test_bulk_update_sources(self):
        r = self.client.post(f"{SOURCES}bulk-update/", {
            "ids": [str(self.crah.id)],
            "fields": {"fluid": "water", "type": "in_row", "rated_capacity_w": 5000},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.crah.refresh_from_db()
        self.assertEqual((self.crah.fluid, self.crah.type, self.crah.rated_capacity_w),
                         ("water", "in_row", 5000))


class CapacityTests(_Base):
    def figure(self, rack):
        rack = Rack.objects.prefetch_related("cooling_feeds").get(pk=rack.pk)
        return rack_cooling(rack)

    def test_primary_feeds_are_the_supply_without_a_budget(self):
        self.feed("A", rack=self.rack, rated_capacity_w=10000, max_utilization=80)
        self.feed("B", rack=self.rack, rated_capacity_w=5000, max_utilization=100)
        self.feed("C", rack=self.rack, rated_capacity_w=50000, type="redundant")
        fig = self.figure(self.rack)
        self.assertEqual((fig["supply"], fig["available_w"]), ("feed", 13000))
        self.assertEqual(fig["heat_allocated_w"], 3000)
        self.assertEqual(sorted(fig), sorted(
            ["available_w", "heat_allocated_w", "heat_maximum_w", "supply", "mismatched"]))

    def test_the_rack_budget_wins_over_the_feeds(self):
        self.feed("A", rack=self.rack, rated_capacity_w=10000)
        Rack.objects.filter(pk=self.rack.pk).update(cooling_capacity_w=4000)
        fig = self.figure(self.rack)
        self.assertEqual((fig["supply"], fig["available_w"]), ("budget", 4000))

    def test_no_budget_and_no_rated_feed_is_no_supply(self):
        self.feed("A", rack=self.rack)
        fig = self.figure(self.rack)
        self.assertEqual((fig["supply"], fig["available_w"]), (None, 0))

    def test_rack_api_and_free_filter_follow_the_feeds(self):
        self.feed("A", rack=self.rack, rated_capacity_w=10000, max_utilization=80)
        body = self.client.get(f"/api/racks/{self.rack.id}/").json()
        self.assertEqual(body["cooling"]["supply"], "feed")
        self.assertEqual(body["cooling_free_w"], 5000)
        names = [r["name"] for r in
                 self.client.get("/api/racks/?cooling_free_w_gte=5000").json()["results"]]
        self.assertEqual(names, ["R1"])
        names = [r["name"] for r in
                 self.client.get("/api/racks/?cooling_free_w_gte=5001").json()["results"]]
        self.assertEqual(names, [])

    def test_source_counts_each_rack_once(self):
        self.feed("A", rack=self.rack)
        self.feed("B", rack=self.rack, type="redundant")
        self.feed("C", rack=self.rack2)
        self.feed("D")
        fig = cooling_source_capacity(self.crah)
        self.assertEqual(fig, {"available_w": 20000, "heat_allocated_w": 6000,
                               "heat_maximum_w": 6000, "racks": 2})
        rows = self.client.get(SOURCES).json()["results"]
        self.assertEqual(rows[0]["capacity"]["heat_allocated_w"], 6000)

    def test_redundant_feed_measures_the_whole_rack(self):
        f = self.feed("B", rack=self.rack, type="redundant", rated_capacity_w=2000)
        cap = self.client.get(f"{FEEDS}{f.id}/").json()["capacity"]
        self.assertTrue(cap["redundant"])
        self.assertEqual((cap["available_w"], cap["rated_w"], cap["heat_allocated_w"]),
                         (1600, 2000, 3000))


class RackMoveTests(_Base):
    def test_a_cooling_feed_from_the_old_site_blocks_the_move(self):
        self.feed(rack=self.rack)
        r = self.client.post(f"/api/racks/{self.rack.id}/move/?dry_run=1",
                             {"site_id": str(self.site2.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["can_move"])
        self.assertIn("cooling_feed", {b["code"] for b in r.json()["blockers"]})


class ImportExportTests(_Base):
    def test_round_trip_by_site_and_name(self):
        self.feed(rack=self.rack, rated_capacity_w=1000)
        resp = self.client.get("/api/io/coolingsource/export/?fmt=csv")
        self.assertEqual(resp.status_code, 200)
        rows = list(csv.DictReader(io.StringIO(_body(resp))))
        self.assertEqual([r["name"] for r in rows], ["CRAH-1"])
        rows[0].pop("id", None)
        rows[0]["rated_capacity_w"] = "25000"
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
        r = self.client.post("/api/io/coolingsource/import/",
                             {"format": "csv", "content": buf.getvalue(), "dry_run": False},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(CoolingSource.objects.count(), 1)
        self.crah.refresh_from_db()
        self.assertEqual(self.crah.rated_capacity_w, 25000)
        resp = self.client.get("/api/io/coolingfeed/export/?fmt=csv")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("L1", _body(resp))
        types = {t["slug"]: t for t in self.client.get("/api/io/types/").json()["object_types"]}
        self.assertEqual(sorted(types["coolingsource"]["natural_key"]), ["name", "site"])
        self.assertEqual(sorted(types["coolingfeed"]["natural_key"]), ["name", "source"])


class StatusSeedTests(APITestCase):
    def test_seed_scopes_the_new_types(self):
        org = Organization.objects.create(name="S", slug="s")
        tenant = Tenant.objects.create(org=org, name="S", slug="s")
        seed_builtin_statuses(tenant)
        active = Status.objects.get(tenant=tenant, slug="active")
        for slug in ("coolingsource", "coolingfeed"):
            self.assertIn(slug, active.available_to)
            self.assertIn(slug, active.default_for)
        self.assertEqual(seed_builtin_statuses(tenant), 0)
