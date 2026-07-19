"""Geographic cable routes (outside plant): CRUD, waypoint validation,
cable assignment, tenant isolation, RBAC, and the connections meta."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Cable, CableRoute, CableTermination, Device, Interface, Site

User = get_user_model()

WAYPOINTS = [[55.676, 12.568], [55.68, 12.59], [55.69, 12.61]]


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()


class CableRouteCrudTests(_Base):
    def test_create_read_update_delete(self):
        resp = self.client.post(
            "/api/cable-routes/",
            {"name": "North duct", "kind": "duct", "color": "#0ea5e9",
             "waypoints": WAYPOINTS},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        rid = resp.json()["id"]
        self.assertEqual(resp.json()["waypoints"], WAYPOINTS)

        resp = self.client.patch(
            f"/api/cable-routes/{rid}/", {"kind": "aerial"}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["kind"], "aerial")

        self.assertEqual(
            self.client.delete(f"/api/cable-routes/{rid}/").status_code, 204
        )

    def test_waypoints_rounded_to_6dp(self):
        resp = self.client.post(
            "/api/cable-routes/",
            {"name": "r", "waypoints": [[55.1234567891, 12.0000000009],
                                        [55.2, 12.1]]},
            format="json",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()["waypoints"][0], [55.123457, 12.0])

    def test_waypoint_validation(self):
        bad = [
            [[55.0, 12.0]],                      # too few
            [[95.0, 12.0], [55.0, 12.0]],        # lat out of range
            [[55.0, 200.0], [55.0, 12.0]],       # lng out of range
            [["a", 12.0], [55.0, 12.0]],         # non-numeric
        ]
        for wp in bad:
            resp = self.client.post(
                "/api/cable-routes/", {"name": "r", "waypoints": wp},
                format="json",
            )
            self.assertEqual(resp.status_code, 400, wp)

    def test_cable_assignment_and_filter(self):
        c1 = Cable.objects.create(tenant=self.tenant, label="F-001")
        c2 = Cable.objects.create(tenant=self.tenant, label="F-002")
        resp = self.client.post(
            "/api/cable-routes/",
            {"name": "r", "waypoints": WAYPOINTS,
             "cable_ids": [str(c1.id)]},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        rid = resp.json()["id"]
        self.assertEqual(
            [c["label"] for c in resp.json()["cables"]], ["F-001"]
        )
        # ?cable= filter
        hits = self.client.get(f"/api/cable-routes/?cable={c1.id}").json()
        self.assertEqual(hits["count"], 1)
        misses = self.client.get(f"/api/cable-routes/?cable={c2.id}").json()
        self.assertEqual(misses["count"], 0)

    def test_tenant_isolation(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        CableRoute.objects.create(
            tenant=other, name="theirs", waypoints=WAYPOINTS
        )
        resp = self.client.get("/api/cable-routes/").json()
        self.assertEqual(resp["count"], 0)


class ConnectionsRouteMetaTests(_Base):
    def test_bundle_cables_carry_route_ids(self):
        sa = Site.objects.create(
            tenant=self.tenant, name="A", latitude=55.6, longitude=12.5
        )
        sz = Site.objects.create(
            tenant=self.tenant, name="Z", latitude=56.0, longitude=12.6
        )
        da = Device.objects.create(tenant=self.tenant, name="da", site=sa)
        dz = Device.objects.create(tenant=self.tenant, name="dz", site=sz)
        ia = Interface.objects.create(device=da, name="eth0")
        iz = Interface.objects.create(device=dz, name="eth0")
        cab = Cable.objects.create(tenant=self.tenant, label="SPAN-1")
        CableTermination.objects.create(cable=cab, end="A", interface=ia)
        CableTermination.objects.create(cable=cab, end="B", interface=iz)
        route = CableRoute.objects.create(
            tenant=self.tenant, name="duct", waypoints=WAYPOINTS
        )
        route.cables.add(cab)

        resp = self.client.get("/api/site-map/connections/")
        self.assertEqual(resp.status_code, 200)
        edges = [e for e in resp.json()["connections"] if e["kind"] == "cable"]
        self.assertEqual(len(edges), 1)
        meta_cables = edges[0]["meta"]["cables"]
        self.assertEqual(meta_cables[0]["route_ids"], [str(route.id)])


class CableRouteRbacTests(APITestCase):
    """cableroute is a REGISTERED object type (unlike floor-plan trays):
    a custom role without a grant must not see route geometry."""

    def setUp(self):
        from django.contrib.auth.models import Group

        from auth_api.models import ObjectPermission, UserProfile

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        CableRoute.objects.create(
            tenant=self.tenant, name="duct", waypoints=WAYPOINTS
        )
        self.user = User.objects.create_user("limited", password="x")
        prof = UserProfile.objects.create(user=self.user, role="custom")
        prof.tenants.add(self.tenant)
        # A grant on prefixes only — nothing on cable routes.
        perm = ObjectPermission.objects.create(
            name="prefix view", object_types=["prefix"], actions=["view"]
        )
        perm.users.add(self.user)
        self.client.force_login(self.user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_no_grant_no_routes(self):
        resp = self.client.get("/api/cable-routes/")
        self.assertIn(resp.status_code, (200, 403))
        if resp.status_code == 200:
            self.assertEqual(resp.json()["count"], 0)

    def test_readonly_group_sees_routes(self):
        from django.contrib.auth.models import Group

        self.user.groups.add(Group.objects.get(name="Read-only"))
        resp = self.client.get("/api/cable-routes/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["count"], 1)


class SiteMapCablesEndpointTests(_Base):
    """/api/site-map/cables/ — every cable with two placeable ends draws."""

    def _wire(self, name, dev_a, dev_b):
        ia = Interface.objects.create(device=dev_a, name=f"{name}-a")
        ib = Interface.objects.create(device=dev_b, name=f"{name}-b")
        c = Cable.objects.create(tenant=self.tenant, label=name)
        CableTermination.objects.create(cable=c, end="A", interface=ia)
        CableTermination.objects.create(cable=c, end="B", interface=ib)
        return c

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(
            tenant=self.tenant, name="S", latitude=55.6, longitude=12.5
        )

    def test_device_coords_and_site_fallback(self):
        placed = Device.objects.create(
            tenant=self.tenant, name="placed", site=self.site,
            latitude=55.61, longitude=12.52,
        )
        # No device coords → falls back to its site's coords.
        unplaced = Device.objects.create(
            tenant=self.tenant, name="sited", site=self.site
        )
        c = self._wire("A-B", placed, unplaced)
        resp = self.client.get("/api/site-map/cables/")
        self.assertEqual(resp.status_code, 200)
        rows = {r["id"]: r for r in resp.json()["cables"]}
        self.assertIn(str(c.id), rows)
        r = rows[str(c.id)]
        self.assertEqual(r["a"]["port"], "A-B-a")
        self.assertEqual(r["z"]["port"], "A-B-b")
        # unplaced end resolved to the site coords
        self.assertEqual(r["z"]["lat"], 55.6)

    def test_unresolvable_endpoint_dropped(self):
        placed = Device.objects.create(
            tenant=self.tenant, name="placed", site=self.site,
            latitude=55.61, longitude=12.52,
        )
        # A device with no coords and no site → not drawable.
        homeless = Device.objects.create(tenant=self.tenant, name="homeless")
        self._wire("drop-me", placed, homeless)
        ids = {r["id"] for r in self.client.get(
            "/api/site-map/cables/").json()["cables"]}
        # nothing drawn (the only cable has an unresolvable end)
        self.assertEqual(len(ids), 0)

    def test_route_ids_populated(self):
        a = Device.objects.create(
            tenant=self.tenant, name="a", site=self.site,
            latitude=55.61, longitude=12.52,
        )
        b = Device.objects.create(
            tenant=self.tenant, name="b", site=self.site,
            latitude=55.63, longitude=12.55,
        )
        c = self._wire("routed", a, b)
        route = CableRoute.objects.create(
            tenant=self.tenant, name="duct", waypoints=WAYPOINTS
        )
        route.cables.add(c)
        row = next(
            r for r in self.client.get("/api/site-map/cables/").json()["cables"]
            if r["id"] == str(c.id)
        )
        self.assertEqual(row["route_ids"], [str(route.id)])


class SiteMapCablesRbacTests(APITestCase):
    def setUp(self):
        from auth_api.models import ObjectPermission, UserProfile

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        site = Site.objects.create(
            tenant=self.tenant, name="S", latitude=55.6, longitude=12.5
        )
        a = Device.objects.create(
            tenant=self.tenant, name="a", site=site,
            latitude=55.61, longitude=12.52,
        )
        b = Device.objects.create(
            tenant=self.tenant, name="b", site=site,
            latitude=55.63, longitude=12.55,
        )
        ia = Interface.objects.create(device=a, name="e0")
        ib = Interface.objects.create(device=b, name="e0")
        c = Cable.objects.create(tenant=self.tenant, label="x")
        CableTermination.objects.create(cable=c, end="A", interface=ia)
        CableTermination.objects.create(cable=c, end="B", interface=ib)
        self.user = User.objects.create_user("limited", password="x")
        prof = UserProfile.objects.create(user=self.user, role="custom")
        prof.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="prefix view", object_types=["prefix"], actions=["view"]
        )
        perm.users.add(self.user)
        self.client.force_login(self.user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_no_cable_grant_no_cables(self):
        resp = self.client.get("/api/site-map/cables/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["cables"], [])
