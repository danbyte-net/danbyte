"""Cables on floor plans: the plan's cable reads (``cable-paths``, a tray's
``cables`` in its own API and in ``contents/``) show only the cables the
reader may view, as ``/api/cables/`` does, and name a far end the reader may
not view as Hidden (#453). A tray's ``cable_ids`` write keeps the cables the
writer cannot see and needs cable ``change`` for each cable it adds or
removes. ``cable-paths`` reads at a flat query count."""
import json

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.api import assemble_site_role
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import (
    Cable,
    CableRoute,
    CableTermination,
    Device,
    FloorPlan,
    FloorPlanTile,
    FloorPlanTray,
    FloorTileType,
    Interface,
    Location,
    Rack,
    Site,
)
from .status_registry import seed_builtin_statuses

User = get_user_model()

SECRETS = ("far-b", "eth-secret", "X-SECRET")


class _Fixture(APITestCase):
    separation = False

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = self.separation
        dep.save(update_fields=["enhanced_site_separation", "updated_at"])
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site_a, name="Hall A", slug="hall-a"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        rack = Rack.objects.create(
            tenant=self.tenant, site=self.site_a, location=self.loc, name="R1"
        )
        self.rack_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=tt, x=1, y=1, rack=rack, link_kind="rack"
        )
        sw1 = Device.objects.create(
            tenant=self.tenant, name="sw-a1", site=self.site_a, rack=rack
        )
        sw2 = Device.objects.create(
            tenant=self.tenant, name="sw-a2", site=self.site_a, rack=rack
        )
        # Another site's device, drawn on this plan on its own tile.
        self.far = Device.objects.create(tenant=self.tenant, name="far-b", site=self.site_b)
        self.far_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=tt, x=9, y=1, device=self.far,
            link_kind="device",
        )
        # A cable inside site A, and one to the other site's device.
        self.local = self._cable("L-1", sw1, "e1", sw2, "e1")
        self.cross = self._cable("X-SECRET", sw1, "e2", self.far, "eth-secret")
        self.tray = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="T1", points=[[1, 0], [10, 0]]
        )
        self.tray.cables.set([self.local, self.cross])

        self.user = User.objects.create_user("viewer-a", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _cable(self, label, dev_a, port_a, dev_b, port_b):
        cable = Cable.objects.create(tenant=self.tenant, label=label)
        CableTermination.objects.create(
            cable=cable, end="A", interface=Interface.objects.create(device=dev_a, name=port_a)
        )
        CableTermination.objects.create(
            cable=cable, end="B", interface=Interface.objects.create(device=dev_b, name=port_b)
        )
        return cable

    def grant(self, types, actions=("view",), sites=()):
        perm = ObjectPermission.objects.create(
            name="g-" + "-".join(types) + "-".join(actions),
            object_types=list(types), actions=list(actions),
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.set(sites)
        return perm

    def login(self, user=None):
        self.client.force_login(user or self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r

    def paths(self):
        return self.get(f"/api/floor-plans/{self.plan.id}/cable-paths/")

    def tray_reads(self):
        """The tray as it is read: its detail, its list and the plan's
        contents/ (only its trays: a tile names its own link)."""
        detail = self.get(f"/api/floor-plan-trays/{self.tray.id}/").json()
        listing = self.get(f"/api/floor-plan-trays/?floor_plan={self.plan.id}").json()
        contents = self.get(f"/api/floor-plans/{self.plan.id}/contents/").json()
        rows = [detail, listing["results"][0], contents["trays"][0]]
        return rows, rows

    def assertNoSecrets(self, *responses):
        for r in responses:
            text = r.content.decode() if hasattr(r, "content") else json.dumps(r)
            for s in SECRETS:
                self.assertNotIn(s, text)
            self.assertNotIn(str(self.far.pk), text)


class SiteViewerTests(_Fixture):
    """A site viewer holds no cable grant (cables span sites): the plan's
    cable reads show no cable at all and count them hidden."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.login()

    def test_cable_api_refuses(self):
        self.assertEqual(self.client.get("/api/cables/").status_code, 403)

    def test_cable_paths_hide_every_cable(self):
        r = self.paths()
        self.assertEqual(r.json()["cables"], [])
        self.assertEqual(r.json()["hidden_count"], 2)
        self.assertNotIn("L-1", r.content.decode())
        self.assertNoSecrets(r)

    def test_tray_lists_no_cable(self):
        responses, rows = self.tray_reads()
        for row in rows:
            self.assertEqual(row["cables"], [])
            self.assertEqual(row["hidden_cable_count"], 2)
        self.assertNoSecrets(*responses)


class SiteScopedCableGrantTests(_Fixture):
    """A cable grant limited to site A covers the cable inside A only; the
    one to site B is absent and counted."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.grant(["cable"], sites=[self.site_a])
        self.login()

    def test_cable_paths_show_only_the_covered_cable(self):
        r = self.paths()
        body = r.json()
        self.assertEqual([c["label"] for c in body["cables"]], ["L-1"])
        self.assertEqual(body["hidden_count"], 1)
        self.assertNoSecrets(r)

    def test_tray_lists_only_the_covered_cable(self):
        responses, rows = self.tray_reads()
        for row in rows:
            self.assertEqual([c["label"] for c in row["cables"]], ["L-1"])
            self.assertEqual(row["hidden_cable_count"], 1)
        self.assertNoSecrets(*responses)


class HiddenFarEndTests(_Fixture):
    """Every cable is viewable, but the device at the far end is not: the
    run keeps its geometry (the tile is on a plan the reader may view) and
    names the end Hidden."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.grant(["cable"])
        self.login()

    def test_far_end_reads_hidden(self):
        r = self.paths()
        rows = {c["label"]: c for c in r.json()["cables"]}
        self.assertEqual(set(rows), {"L-1", "X-SECRET"})
        self.assertEqual(r.json()["hidden_count"], 0)
        cross = rows["X-SECRET"]
        self.assertEqual(cross["a_points"][0]["port"], "e2")
        self.assertEqual(cross["b_points"], [{"device": None, "port": None, "hidden": True}])
        self.assertEqual(cross["b_tiles"], [str(self.far_tile.id)])
        self.assertEqual(cross["a_tiles"], [str(self.rack_tile.id)])
        text = r.content.decode()
        self.assertNotIn("eth-secret", text)
        self.assertNotIn(str(self.far.pk), text)


class SeparationSiteViewerTests(SiteViewerTests):
    separation = True


class SeparationSiteScopedCableGrantTests(SiteScopedCableGrantTests):
    separation = True


class SeparationHiddenFarEndTests(HiddenFarEndTests):
    separation = True


class TrayWriteTests(_Fixture):
    """A site editor with a site-A cable grant edits the tray: the cable to
    site B, which they cannot see, stays in it."""

    def setUp(self):
        super().setUp()
        self.grant(["floorplan", "floorplantray", "floorplantile"],
                   actions=("view", "change"), sites=[self.site_a])
        self.cable_grant = self.grant(
            ["cable"], actions=("view", "change"), sites=[self.site_a]
        )
        self.login()

    def patch(self, ids):
        return self.client.patch(
            f"/api/floor-plan-trays/{self.tray.id}/",
            {"cable_ids": [str(i) for i in ids]}, format="json",
        )

    def members(self):
        return set(self.tray.cables.values_list("pk", flat=True))

    def test_clearing_keeps_the_hidden_cable(self):
        r = self.patch([])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cables"], [])
        self.assertEqual(r.json()["hidden_cable_count"], 1)
        self.assertEqual(self.members(), {self.cross.pk})
        self.assertNoSecrets(r)

    def test_resending_the_visible_list_keeps_the_hidden_cable(self):
        r = self.patch([self.local.pk])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.members(), {self.local.pk, self.cross.pk})

    def test_adding_a_cable_they_cannot_view_is_refused(self):
        self.tray.cables.set([self.local])
        r = self.patch([self.local.pk, self.cross.pk])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("cable_ids", r.json())
        self.assertEqual(self.members(), {self.local.pk})
        self.assertNoSecrets(r)

    def test_removing_needs_cable_change(self):
        self.cable_grant.actions = ["view"]
        self.cable_grant.save()
        r = self.patch([])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("cable_ids", r.json())
        self.assertIn("L-1", str(r.json()["cable_ids"]))
        self.assertEqual(self.members(), {self.local.pk, self.cross.pk})

    def test_adding_needs_cable_change(self):
        self.tray.cables.set([])
        self.cable_grant.actions = ["view"]
        self.cable_grant.save()
        r = self.patch([self.local.pk])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.members(), set())

    def test_create_with_cables_needs_cable_change(self):
        self.grant(["floorplantray"], actions=("add",), sites=[self.site_a])
        self.cable_grant.actions = ["view"]
        self.cable_grant.save()
        r = self.client.post(
            "/api/floor-plan-trays/",
            {"floor_plan_id": str(self.plan.id), "name": "T2",
             "points": [[0, 0], [1, 0]], "cable_ids": [str(self.local.pk)]},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("cable_ids", r.json())
        self.assertFalse(FloorPlanTray.objects.filter(name="T2").exists())

    def test_unchanged_cables_need_no_change_grant(self):
        """Editing the tray's name sends no cable_ids and checks nothing."""
        self.cable_grant.actions = ["view"]
        self.cable_grant.save()
        r = self.client.patch(
            f"/api/floor-plan-trays/{self.tray.id}/", {"name": "T1b"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.patch([self.local.pk])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.members(), {self.local.pk, self.cross.pk})


class SuperuserTrayWriteTests(_Fixture):
    def test_superuser_replaces_the_whole_list(self):
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.login(admin)
        r = self.client.patch(
            f"/api/floor-plan-trays/{self.tray.id}/", {"cable_ids": []}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.tray.cables.count(), 0)
        self.assertEqual(r.json()["hidden_cable_count"], 0)


class CableRouteWriteTests(_Fixture):
    """The site map's cable routes keep the same rule as trays."""

    def setUp(self):
        super().setUp()
        self.route = CableRoute.objects.create(
            tenant=self.tenant, name="Duct", waypoints=[[0, 0], [1, 1]]
        )
        self.route.cables.set([self.local, self.cross])
        self.grant(["cableroute"], actions=("view", "change"))
        self.grant(["cable"], actions=("view", "change"), sites=[self.site_a])
        self.login()

    def test_route_hides_and_keeps_the_hidden_cable(self):
        r = self.get(f"/api/cable-routes/{self.route.id}/")
        self.assertEqual([c["label"] for c in r.json()["cables"]], ["L-1"])
        self.assertNoSecrets(r)
        r = self.client.patch(
            f"/api/cable-routes/{self.route.id}/", {"cable_ids": []}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            set(self.route.cables.values_list("pk", flat=True)), {self.cross.pk}
        )


class CablePathQueryTests(_Fixture):
    """cable-paths reads a flat number of queries however many cables the
    plan carries."""

    def _add(self, n, start):
        rack = Rack.objects.get(name="R1")
        for i in range(start, start + n):
            a = Device.objects.create(
                tenant=self.tenant, name=f"q{i}a", site=self.site_a, rack=rack
            )
            b = Device.objects.create(
                tenant=self.tenant, name=f"q{i}b", site=self.site_a, rack=rack
            )
            self.tray.cables.add(self._cable(f"Q{i}", a, "e1", b, "e1"))

    def _count(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"/api/floor-plans/{self.plan.id}/cable-paths/")
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), len(r.json()["cables"])

    def _flat(self):
        self._add(2, 0)
        small, n_small = self._count()
        self._add(10, 2)
        big, n_big = self._count()
        self.assertEqual(n_big, n_small + 10)
        self.assertEqual(small, big)

    def test_flat_as_superuser(self):
        self.login(User.objects.create_superuser("admin", "a@example.com", "x"))
        self._flat()

    def test_flat_with_a_scoped_grant(self):
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.grant(["cable"])
        self.login()
        self._flat()
