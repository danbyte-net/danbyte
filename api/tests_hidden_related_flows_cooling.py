"""#453: an application flow or a cooling intake the caller may read never
names a related row the caller can't - another site's address, range,
prefix, device, VM, cooling feed, source or outflow - as IP addresses
behave since #413."""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Application,
    ApplicationFlow,
    CoolingFeed,
    CoolingIntake,
    CoolingOutflow,
    CoolingSource,
    Device,
    IPAddress,
    IPRange,
    Prefix,
    Rack,
    Site,
)
from api.status_registry import seed_builtin_statuses
from auth_api.api import assemble_site_role
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

SECRETS = ("10.2.0.99", "secret-db-b.example", "payroll-db-b", "10.2.0.100",
           "10.2.0.0/24", "chiller-b", "loop-b", "cdu-b", "sec-b", "far-b")


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
        self.web = Device.objects.create(tenant=self.tenant, name="web-a", site=self.site_a)
        self.db = Device.objects.create(tenant=self.tenant, name="payroll-db-b",
                                        site=self.site_b)
        self.net_a = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24",
                                           site=self.site_a)
        self.net_b = Prefix.objects.create(tenant=self.tenant, cidr="10.2.0.0/24",
                                           site=self.site_b)
        self.ip_a = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_a,
                                             ip_address="10.1.0.10", assigned_device=self.web)
        self.ip_b = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_b,
                                             ip_address="10.2.0.99",
                                             dns_name="secret-db-b.example",
                                             assigned_device=self.db)
        self.range_b = IPRange.objects.create(tenant=self.tenant, prefix=self.net_b,
                                              start_address="10.2.0.100",
                                              end_address="10.2.0.150")
        self.app = Application.objects.create(tenant=self.tenant, name="Shop", slug="shop")

        def flow(name, **kw):
            return ApplicationFlow.objects.create(
                tenant=self.tenant, application=self.app, name=name, source_ip=self.ip_a,
                protocol="tcp", ports="5432", **kw)

        self.to_ip = flow("to-ip", destination_ip=self.ip_b)
        self.to_range = flow("to-range", destination_range=self.range_b)
        self.to_prefix = flow("to-prefix", destination_prefix=self.net_b)
        self.to_own = flow("to-own", destination_prefix=self.net_a)

        # Cooling: a site B source and feed into a site A rack, a site B CDU
        # outflow feeding a site A device, a site A outflow serving site B.
        rack = Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R1")
        self.chiller = CoolingSource.objects.create(
            tenant=self.tenant, site=self.site_b, name="chiller-b", type="chiller")
        self.feed = CoolingFeed.objects.create(
            tenant=self.tenant, source=self.chiller, name="loop-b", rack=rack)
        self.intake = CoolingIntake.objects.create(device=self.web, name="in1",
                                                   cooling_feed=self.feed)
        cdu = Device.objects.create(tenant=self.tenant, name="cdu-b", site=self.site_b)
        self.sec_b = CoolingOutflow.objects.create(device=cdu, name="sec-b")
        self.app_a = Device.objects.create(tenant=self.tenant, name="app-a",
                                           site=self.site_a)
        self.cdu_fed = CoolingIntake.objects.create(device=self.app_a, name="in1",
                                                    outflow=self.sec_b)
        self.out_a = CoolingOutflow.objects.create(device=self.app_a, name="out-a")
        far = Device.objects.create(tenant=self.tenant, name="far-b", site=self.site_b)
        CoolingIntake.objects.create(device=far, name="far-in", outflow=self.out_a)

        self.user = User.objects.create_user("viewer-a", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self.login(self.user)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r

    def assertNoSecrets(self, r):
        text = r.content.decode()
        for s in SECRETS:
            self.assertNotIn(s, text)
        for obj in (self.ip_b, self.range_b, self.net_b, self.db, self.feed, self.chiller,
                    self.sec_b):
            self.assertNotIn(str(obj.pk), text)


class FlowsTests(_Fixture):
    def _rows(self, url):
        r = self.get(url)
        self.assertNoSecrets(r)
        return {row["name"]: row for row in r.json()["results"]}

    def test_site_b_objects_are_out_of_reach(self):
        self.assertEqual(self.client.get(f"/api/ips/{self.ip_b.id}/").status_code, 404)
        self.assertEqual(
            self.client.get(f"/api/cooling-feeds/{self.feed.id}/").status_code, 404)

    def test_list_hides_the_other_sites_end(self):
        rows = self._rows("/api/application-flows/")
        self.assertEqual(set(rows), {"to-ip", "to-range", "to-prefix", "to-own"})
        f = rows["to-ip"]
        self.assertIsNone(f["destination_ip"])
        self.assertEqual(f["destination"], {"kind": "ip", "id": None, "label": "Hidden",
                                            "device": None, "vm": None, "hidden": True})
        self.assertIsNone(rows["to-range"]["destination_range"])
        self.assertEqual(rows["to-range"]["destination"]["kind"], "range")
        self.assertTrue(rows["to-range"]["destination"]["hidden"])
        self.assertIsNone(rows["to-prefix"]["destination_prefix"])
        self.assertTrue(rows["to-prefix"]["destination"]["hidden"])
        # The viewer's own end, and an own-site destination, stay.
        self.assertEqual(f["source_ip"]["ip_address"], "10.1.0.10")
        self.assertEqual(f["source"]["device"]["name"], "web-a")
        self.assertFalse(f["source"]["hidden"])
        own = rows["to-own"]
        self.assertEqual(own["destination_prefix"]["cidr"], "10.1.0.0/24")
        self.assertFalse(own["destination"]["hidden"])

    def test_detail_hides_the_other_sites_end(self):
        r = self.get(f"/api/application-flows/{self.to_ip.id}/")
        self.assertNoSecrets(r)
        self.assertTrue(r.json()["destination"]["hidden"])

    def test_map_and_diagram_payload(self):
        # The Application map, the flow diagram and its PDF draw from this list.
        self._rows(f"/api/application-flows/?application={self.app.id}")
        self._rows(f"/api/application-flows/?device={self.web.id}")

    def test_search_does_not_match_a_hidden_end(self):
        r = self.get("/api/application-flows/?search=10.2.0.99")
        self.assertEqual(r.json()["results"], [])
        r = self.get("/api/application-flows/?search=10.2.0.0")
        self.assertEqual(r.json()["results"], [])
        r = self.get("/api/application-flows/?search=10.1.0.10")
        self.assertEqual(len(r.json()["results"]), 4)

    def test_visible_address_does_not_name_a_hidden_device(self):
        # A shared address (no site) on the site B device.
        net = Prefix.objects.create(tenant=self.tenant, cidr="10.250.0.0/24")
        shared = IPAddress.objects.create(tenant=self.tenant, prefix=net,
                                          ip_address="10.250.0.9", assigned_device=self.db)
        self.to_ip.destination_ip = shared
        self.to_ip.save()
        f = self.get(f"/api/application-flows/{self.to_ip.id}/").json()
        self.assertEqual(f["destination_ip"]["ip_address"], "10.250.0.9")
        self.assertEqual(f["destination"]["label"], "10.250.0.9")
        self.assertIsNone(f["destination"]["device"])
        self.assertFalse(f["destination"]["hidden"])
        self.assertNotIn("payroll-db-b", str(f))

    def test_export_leaves_the_hidden_end_out(self):
        r = self.client.get("/api/io/applicationflow/export/?fmt=csv")
        self.assertEqual(r.status_code, 200)
        text = b"".join(r.streaming_content).decode()
        self.assertIn("to-ip", text)
        for s in ("10.2.0.99", "10.2.0.100", "10.2.0.0/24"):
            self.assertNotIn(s, text)

    def test_hidden_end_is_kept_on_edit(self):
        # Editing a flow without touching its hidden end keeps the end.
        self.client.patch(f"/api/application-flows/{self.to_ip.id}/",
                          {"description": "x"}, format="json")
        self.to_ip.refresh_from_db()
        self.assertEqual(self.to_ip.destination_ip_id, self.ip_b.pk)

    def test_superuser_sees_everything(self):
        self.login(User.objects.create_superuser("root", password="x"))
        f = self.get(f"/api/application-flows/{self.to_ip.id}/").json()
        self.assertEqual(f["destination_ip"]["dns_name"], "secret-db-b.example")
        self.assertEqual(f["destination"]["device"]["name"], "payroll-db-b")
        self.assertFalse(f["destination"]["hidden"])
        r = self.get("/api/application-flows/?search=10.2.0.99")
        self.assertEqual(len(r.json()["results"]), 1)


class CoolingTests(_Fixture):
    def test_intake_list_and_detail_hide_the_other_sites_feed(self):
        r = self.get(f"/api/cooling-intakes/?device={self.web.id}")
        self.assertNoSecrets(r)
        (row,) = r.json()["results"]
        self.assertIsNone(row["cooling_feed"])
        self.assertTrue(row["upstream_hidden"])
        r = self.get(f"/api/cooling-intakes/{self.intake.id}/")
        self.assertNoSecrets(r)
        self.assertIsNone(r.json()["cooling_feed"])

    def test_intake_hides_another_sites_outflow(self):
        r = self.get(f"/api/cooling-intakes/{self.cdu_fed.id}/")
        self.assertNoSecrets(r)
        self.assertIsNone(r.json()["outflow"])
        self.assertTrue(r.json()["upstream_hidden"])

    def test_outflow_hides_intakes_it_serves_on_another_site(self):
        r = self.get(f"/api/cooling-outflows/{self.out_a.id}/")
        self.assertNoSecrets(r)
        self.assertEqual(r.json()["served"], [{"id": None, "name": None, "device": None,
                                               "hidden": True}])
        r = self.get(f"/api/cooling-outflows/?device={self.app_a.id}")
        self.assertNoSecrets(r)

    def test_cooling_path_hides_the_other_sites_feed_and_source(self):
        r = self.get(f"/api/devices/{self.web.id}/cooling-path/")
        self.assertNoSecrets(r)
        hops = r.json()["paths"][0]["hops"]
        self.assertEqual(hops[0], {"kind": "source", "hidden": True})
        self.assertEqual(hops[1], {"kind": "feed", "hidden": True})
        self.assertEqual(hops[2]["name"], "web-a")
        r = self.get(f"/api/devices/{self.app_a.id}/cooling-path/")
        self.assertNoSecrets(r)
        self.assertEqual(r.json()["paths"][0]["hops"][0], {"kind": "device", "hidden": True})

    def test_hidden_feed_is_kept_on_edit(self):
        self.client.patch(f"/api/cooling-intakes/{self.intake.id}/",
                          {"description": "x"}, format="json")
        self.intake.refresh_from_db()
        self.assertEqual(self.intake.cooling_feed_id, self.feed.pk)

    def test_visible_feed_hides_a_hidden_source(self):
        # A grant on feeds alone: the feed shows, its source does not.
        perm = ObjectPermission.objects.create(name="feeds", object_types=["coolingfeed"],
                                               actions=["view"])
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        body = self.get(f"/api/cooling-intakes/{self.intake.id}/").json()
        self.assertEqual(body["cooling_feed"]["name"], "loop-b")
        self.assertIsNone(body["cooling_feed"]["source"])
        self.assertFalse(body["upstream_hidden"])

    def test_superuser_sees_everything(self):
        self.login(User.objects.create_superuser("root", password="x"))
        body = self.get(f"/api/cooling-intakes/{self.intake.id}/").json()
        self.assertEqual(body["cooling_feed"]["source"]["name"], "chiller-b")
        self.assertFalse(body["upstream_hidden"])
        body = self.get(f"/api/cooling-outflows/{self.out_a.id}/").json()
        self.assertEqual(body["served"][0]["device"]["name"], "far-b")


class FlowsSeparationTests(FlowsTests):
    separation = True


class CoolingSeparationTests(CoolingTests):
    separation = True
