"""Static routes: one row per path on one device, normalised the way the box
prints it, VRF-aware, site-scoped through the device, and never a route
whose next hop sits on another box.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import VRF, Device, DeviceType, Interface, Manufacturer, Prefix, Site
from api.status_registry import seed_builtin_statuses
from auth_api import rbac
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import StaticRoute

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        seed_builtin_statuses(self.tenant)
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.r1 = Device.objects.create(tenant=self.tenant, name="ams-r1", device_type=dt, site=self.ams)
        self.r2 = Device.objects.create(tenant=self.tenant, name="lon-r1", device_type=dt, site=self.lon)
        self.eth0 = Interface.objects.create(device=self.r1, name="eth0")
        self.far = Interface.objects.create(device=self.r2, name="eth0")
        self.vrf = VRF.objects.create(tenant=self.tenant, name="CUST", rd="65000:1")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.20.0.0/16")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, **over):
        body = {"device_id": str(self.r1.id), "prefix": "10.20.0.0/16", "next_hop": "10.0.0.1"}
        body.update(over)
        return self.client.post("/api/routing/static-routes/", body, format="json")


class StaticRouteTests(_Base):
    def test_create_normalises_and_reads_back(self):
        r = self._post(vrf_id=str(self.vrf.id), prefix="10.20.0.0/16",
                       next_hop=" 10.0.0.1 ", distance=250, tag=100,
                       prefix_obj_id=str(self.prefix.id))
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["next_hop"], "10.0.0.1")
        self.assertEqual(body["vrf"]["name"], "CUST")
        self.assertEqual(body["prefix_obj"]["cidr"], "10.20.0.0/16")
        self.assertEqual(body["kind_display"], "Next hop")
        names = [
            s["name"] for s in self.client.get(
                "/api/statuses/?available_to=staticroute&picker=1"
            ).json()["results"]
        ]
        self.assertEqual(sorted(names), ["Active", "Disabled", "Planned"])

    def test_host_bits_and_next_hop_shape(self):
        r = self._post(prefix="10.20.0.1/16")
        self.assertEqual(r.status_code, 400)
        self.assertIn("prefix", r.json())
        r = self._post(next_hop="")
        self.assertEqual(r.status_code, 400)
        self.assertIn("next_hop", r.json())
        r = self._post(kind="blackhole", next_hop="10.0.0.1")
        self.assertEqual(r.status_code, 400)
        self.assertIn("kind", r.json())
        r = self._post(kind="blackhole", next_hop="")
        self.assertEqual(r.status_code, 201, r.content)

    def test_next_hop_interface_must_be_on_the_device(self):
        r = self._post(next_hop="", next_hop_interface_id=str(self.far.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("next_hop_interface", r.json())
        r = self._post(next_hop="", next_hop_interface_id=str(self.eth0.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["next_hop_interface"]["name"], "eth0")

    def test_same_path_twice_is_refused(self):
        self.assertEqual(self._post().status_code, 201)
        self.assertEqual(self._post().status_code, 409)
        # The same prefix through another next hop is a second path (ECMP).
        self.assertEqual(self._post(next_hop="10.0.0.2").status_code, 201)
        # Global table and a VRF are different tables.
        self.assertEqual(self._post(vrf_id=str(self.vrf.id)).status_code, 201)

    def test_filters(self):
        self._post()
        self._post(device_id=str(self.r2.id), vrf_id=str(self.vrf.id))
        get = lambda q: self.client.get(f"/api/routing/static-routes/?{q}").json()["count"]  # noqa: E731
        self.assertEqual(get(f"device={self.r1.id}"), 1)
        self.assertEqual(get(f"site={self.lon.id}"), 1)
        self.assertEqual(get("vrf=global"), 1)
        self.assertEqual(get(f"vrf={self.vrf.id}"), 1)
        self.assertEqual(get("search=lon-r1"), 1)
        self.assertEqual(get("search=10.20"), 2)

    def test_site_scoped_user_sees_only_their_site(self):
        self._post()
        self._post(device_id=str(self.r2.id))
        user = User.objects.create_user("u")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="p", object_types=["staticroute"], actions=["view"]
        )
        p.users.add(user)
        p.sites.set([self.ams])
        qs = rbac.restrict_queryset(
            StaticRoute.objects.all(), user, self.tenant, "staticroute", "view"
        )
        self.assertEqual({r.device.name for r in qs}, {"ams-r1"})

    def test_device_tab_count_and_tenant_delete(self):
        self._post()
        d = self.client.get(f"/api/devices/{self.r1.id}/").json()
        self.assertEqual(d["routing_count"], 1)
        row = self.client.get("/api/devices/").json()["results"][0]
        self.assertEqual(row.get("routing_count", 0), 0)
