"""Cabinets, cabinet types and cabinet roles (#277): CRUD, the sizes a new
cabinet copies from its type, the plate-fits-the-box rule, tenancy, site
scope and the registries a new object type has to join."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from customization.models import CustomField

from .models import Cabinet, CabinetRole, CabinetType, Location, Manufacturer, Site, Status
from .status_registry import seed_builtin_statuses
from .test_utils import status_for


class CabinetTestCase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="plant-1")
        self.site2 = Site.objects.create(tenant=self.tenant, name="plant-2")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Rittal")
        self.active = status_for(self.tenant)
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.their_site = Site.objects.create(tenant=self.tenant2, name="theirs")
        admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _limited_user(self, name, object_types, actions, sites=None):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=object_types, actions=actions
        )
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u

    def _type(self, name="AE 1060.500", **extra):
        body = {"name": name, "manufacturer_id": str(self.mfr.id),
                "inner_width_mm": 525, "inner_height_mm": 625,
                "outer_width_mm": 600, "outer_height_mm": 700,
                "outer_depth_mm": 210, **extra}
        return self.client.post("/api/cabinet-types/", body, format="json")

    def _cabinet(self, name="K1", site=None, **extra):
        body = {"name": name, "site_id": str((site or self.site).id),
                "inner_width_mm": 500, "inner_height_mm": 600, **extra}
        return self.client.post("/api/cabinets/", body, format="json")


class CabinetRoleTests(CabinetTestCase):
    def test_a_role_gets_its_slug_and_counts_its_cabinets(self):
        r = self.client.post("/api/cabinet-roles/",
                             {"name": "Distribution board", "color": "#f59e0b"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        role = r.json()
        self.assertEqual(role["slug"], "distribution-board")
        self.assertIsNotNone(role["numid"])
        self.assertEqual(self._cabinet(role_id=role["id"]).status_code, 201)
        rows = self.client.get("/api/cabinet-roles/").json()["results"]
        self.assertEqual([x["cabinet_count"] for x in rows], [1])
        picker = self.client.get("/api/cabinet-roles/?picker=1").json()["results"]
        self.assertEqual(set(picker[0]), {"id", "numid", "name", "slug", "color"})

    def test_a_role_in_use_is_not_deleted(self):
        role = CabinetRole.objects.create(tenant=self.tenant, name="Control", slug="control")
        self.assertEqual(self._cabinet(role_id=str(role.id)).status_code, 201)
        r = self.client.delete(f"/api/cabinet-roles/{role.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "1 cabinet uses this role.")
        Cabinet.objects.all().delete()
        self.assertEqual(self.client.delete(f"/api/cabinet-roles/{role.id}/").status_code, 204)

    def test_a_second_role_with_the_same_name_is_refused(self):
        self.client.post("/api/cabinet-roles/", {"name": "Metering"}, format="json")
        r = self.client.post("/api/cabinet-roles/", {"name": "Metering"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("slug", r.json())


class CabinetTypeTests(CabinetTestCase):
    def test_a_type_round_trips_its_sizes(self):
        r = self._type()
        self.assertEqual(r.status_code, 201, r.content)
        t = r.json()
        self.assertEqual(t["manufacturer"]["name"], "Rittal")
        self.assertEqual(
            [t[f] for f in ("inner_width_mm", "inner_height_mm", "outer_width_mm",
                            "outer_height_mm", "outer_depth_mm")],
            [525, 625, 600, 700, 210],
        )
        self.assertEqual(t["cabinet_count"], 0)
        picker = self.client.get("/api/cabinet-types/?picker=1").json()["results"][0]
        self.assertEqual(picker["inner_width_mm"], 525)
        self.assertEqual(picker["manufacturer"], {"id": str(self.mfr.id), "name": "Rittal"})

    def test_the_plate_must_fit_in_the_box(self):
        r = self._type(outer_width_mm=500, outer_height_mm=600)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {
            "outer_width_mm": ["Narrower than the mounting plate (525 mm)."],
            "outer_height_mm": ["Shorter than the mounting plate (625 mm)."],
        })
        t = self._type().json()
        # A PATCH is checked against the sizes already stored.
        r = self.client.patch(f"/api/cabinet-types/{t['id']}/",
                              {"inner_width_mm": 650}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("outer_width_mm", r.json())

    def test_sizes_outside_the_range_are_refused(self):
        r = self._type(inner_width_mm=10, outer_depth_mm=9000)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(set(r.json()), {"inner_width_mm", "outer_depth_mm"})

    def test_names_are_unique_and_a_type_in_use_stays(self):
        t = self._type().json()
        r = self._type()
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"name": "A cabinet type with this name already exists."})
        self.assertEqual(self._cabinet(cabinet_type_id=t["id"]).status_code, 201)
        r = self.client.delete(f"/api/cabinet-types/{t['id']}/")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "1 cabinet uses this type.")

    def test_a_malformed_manufacturer_filter_is_a_400(self):
        self.assertEqual(self.client.get("/api/cabinet-types/?manufacturer=nope").status_code, 400)


class CabinetTests(CabinetTestCase):
    def test_a_cabinet_of_a_type_copies_its_sizes(self):
        t = self._type().json()
        r = self.client.post("/api/cabinets/", {
            "name": "K1", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
            "status_id": str(self.active.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        c = r.json()
        self.assertEqual(
            [c[f] for f in ("inner_width_mm", "inner_height_mm", "outer_width_mm",
                            "outer_height_mm", "outer_depth_mm")],
            [525, 625, 600, 700, 210],
        )
        self.assertEqual(c["cabinet_type"]["name"], "AE 1060.500")
        self.assertEqual(c["status"]["id"], str(self.active.id))
        self.assertEqual(c["site"]["name"], "plant-1")
        # Sizes sent with it win over the type's.
        r = self.client.post("/api/cabinets/", {
            "name": "K2", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
            "inner_width_mm": 400, "outer_depth_mm": 300,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["inner_width_mm"], r.json()["inner_height_mm"],
                          r.json()["outer_depth_mm"]), (400, 625, 300))
        # A size cleared on create stays clear.
        r = self.client.post("/api/cabinets/", {
            "name": "K3", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
            "outer_depth_mm": None,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["outer_width_mm"], r.json()["outer_depth_mm"]), (600, None))
        # Changing the type later leaves the sizes alone.
        other = self._type(name="AE 1050.500", inner_width_mm=450).json()
        r = self.client.patch(f"/api/cabinets/{c['id']}/",
                              {"cabinet_type_id": other["id"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["inner_width_mm"], 525)

    def test_a_cabinet_without_a_type_needs_its_plate(self):
        r = self.client.post("/api/cabinets/", {"name": "K1", "site_id": str(self.site.id)},
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"inner_width_mm": ["This field is required."],
                                    "inner_height_mm": ["This field is required."]})
        r = self._cabinet(outer_width_mm=450)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"outer_width_mm": ["Narrower than the mounting plate (500 mm)."]})

    def test_the_location_must_be_in_the_cabinets_site(self):
        hall = Location.objects.create(tenant=self.tenant, site=self.site2, name="Hall B")
        r = self._cabinet(location_id=str(hall.id))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"location_id": ["Pick a location within the cabinet's site."]})
        r = self._cabinet(site=self.site2, location_id=str(hall.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["location"], {"id": str(hall.id), "name": "Hall B"})

    def test_sites_and_locations_count_their_cabinets(self):
        hall = Location.objects.create(tenant=self.tenant, site=self.site, name="Hall A")
        self._cabinet(name="K1", location_id=str(hall.id))
        self._cabinet(name="K2")
        self.assertEqual(self.client.get(f"/api/sites/{self.site.id}/").json()["cabinet_count"], 2)
        self.assertEqual(
            self.client.get(f"/api/locations/{hall.id}/").json()["cabinet_count"], 1
        )
        rows = self.client.get(f"/api/locations/?site={self.site.id}").json()["results"]
        self.assertEqual([x["cabinet_count"] for x in rows], [1])

    def test_names_are_unique_per_site(self):
        self.assertEqual(self._cabinet().status_code, 201)
        self.assertEqual(self._cabinet(site=self.site2).status_code, 201)
        r = self._cabinet()
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"name": ["A cabinet with this name already exists at this site."]})
        k2 = Cabinet.objects.get(site=self.site2)
        r = self.client.patch(f"/api/cabinets/{k2.id}/", {"site_id": str(self.site.id)},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("name", r.json())
        r = self.client.patch(f"/api/cabinets/{k2.id}/", {"description": "Spare"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_another_tenants_rows_cannot_be_referenced(self):
        their_role = CabinetRole.objects.create(tenant=self.tenant2, name="X", slug="x")
        their_type = CabinetType.objects.create(
            tenant=self.tenant2, name="X", inner_width_mm=100, inner_height_mm=100
        )
        their_status = Status.objects.create(tenant=self.tenant2, name="Theirs", slug="theirs",
                                             available_to=["cabinet"])
        their_hall = Location.objects.create(tenant=self.tenant2, site=self.their_site, name="H")
        for field, value in (("role_id", their_role.id), ("cabinet_type_id", their_type.id),
                             ("status_id", their_status.id), ("location_id", their_hall.id)):
            with self.subTest(field):
                r = self._cabinet(name=f"K-{field}", **{field: str(value)})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(field, r.json())
        r = self._cabinet(site=self.their_site)
        self.assertEqual(r.status_code, 400)
        self.assertIn("site_id", r.json())
        theirs = Cabinet.objects.create(tenant=self.tenant2, site=self.their_site, name="K9",
                                        inner_width_mm=100, inner_height_mm=100)
        self.assertEqual(self.client.get(f"/api/cabinets/{theirs.id}/").status_code, 404)
        self.assertEqual(self.client.get("/api/cabinets/").json()["count"], 0)

    def test_filters_and_search(self):
        role = CabinetRole.objects.create(tenant=self.tenant, name="Control", slug="control")
        t = self._type().json()
        self._cabinet(name="K1", role_id=str(role.id), facility_id="=UH1+K1")
        self._cabinet(name="K2", site=self.site2, cabinet_type_id=t["id"])

        def names(query):
            r = self.client.get(f"/api/cabinets/?{query}")
            self.assertEqual(r.status_code, 200, r.content)
            return [c["name"] for c in r.json()["results"]]

        self.assertEqual(names(f"site={self.site2.id}"), ["K2"])
        self.assertEqual(names(f"role={role.id}"), ["K1"])
        self.assertEqual(names(f"cabinet_type={t['id']}"), ["K2"])
        self.assertEqual(names("search=UH1"), ["K1"])
        self.assertEqual(names("picker=1"), ["K1", "K2"])
        for param in ("site", "location", "role", "status", "cabinet_type"):
            with self.subTest(param):
                self.assertEqual(self.client.get(f"/api/cabinets/?{param}=nope").status_code, 400)

    def test_custom_fields_are_checked_against_their_definitions(self):
        CustomField.objects.create(tenant=self.tenant, key="ip_rating", label="IP rating",
                                   type="integer", applies_to=["cabinet"])
        r = self._cabinet(custom_fields={"ip_rating": "sealed"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("custom_fields", r.json())
        r = self._cabinet(custom_fields={"ip_rating": 65})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["custom_fields"], {"ip_rating": 65})

    def test_changes_are_logged(self):
        c = self._cabinet().json()
        self.client.patch(f"/api/cabinets/{c['id']}/", {"description": "Pump house"},
                          format="json")
        actions = list(ChangeLogEntry.objects.filter(
            object_type="api.cabinet", object_id=c["id"]
        ).order_by("timestamp").values_list("action", flat=True))
        self.assertEqual(actions, ["create", "update"])


class CabinetSiteScopeTests(CabinetTestCase):
    def test_a_site_scoped_user_sees_and_writes_only_their_site(self):
        Cabinet.objects.create(tenant=self.tenant, site=self.site, name="K1",
                               inner_width_mm=500, inner_height_mm=600)
        Cabinet.objects.create(tenant=self.tenant, site=self.site2, name="K2",
                               inner_width_mm=500, inner_height_mm=600)
        u = self._limited_user("plant1", ["cabinet"], ["view", "add", "change"],
                               sites=[self.site])
        self._login(u)
        rows = self.client.get("/api/cabinets/").json()["results"]
        self.assertEqual([c["name"] for c in rows], ["K1"])
        self.assertEqual(self._cabinet(name="K3").status_code, 201)
        r = self._cabinet(name="K4", site=self.site2)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(Cabinet.objects.filter(name="K4").exists())

    def test_without_a_grant_nothing_is_listed(self):
        Cabinet.objects.create(tenant=self.tenant, site=self.site, name="K1",
                               inner_width_mm=500, inner_height_mm=600)
        self._login(self._limited_user("nobody", ["rack"], ["view"]))
        self.assertEqual(self.client.get("/api/cabinets/").status_code, 403)


class CabinetStatusSeedTests(CabinetTestCase):
    def test_the_catalog_offers_cabinet_statuses_with_active_as_default(self):
        seed_builtin_statuses(self.tenant2)
        rows = {s.slug: s for s in Status.objects.filter(tenant=self.tenant2)}
        for slug in ("active", "planned", "reserved", "available", "deprecated"):
            self.assertIn("cabinet", rows[slug].available_to, slug)
        self.assertIn("cabinet", rows["active"].default_for)
        self.assertEqual(seed_builtin_statuses(self.tenant2), 0)
