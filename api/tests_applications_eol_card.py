"""The application page's End of life card and Hierarchy card (#436): the
``/eol/`` payload's per-cycle install counts, other catalog cycles and
unmapped installs; the ``?cycle=`` install filter; the detail-only ancestors
and children summaries. All of it tenant-scoped and narrowed to what the
reader may view."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext

from api.models import Application, Device
from auth_api.models import ObjectPermission, UserProfile
from compliance.models import EolProduct, EolSettings

from .tests_applications import APPS, SW, _Base

RELEASES = [
    {"name": "17", "release_date": "2024-09-26", "eol_date": "2029-11-08", "lts": True,
     "latest": "17.2"},
    {"name": "16", "release_date": "2023-09-14", "eol_date": "2028-11-09", "latest": "16.6"},
    {"name": "12", "release_date": "2019-10-03", "eol_date": "2024-11-14", "eol": True},
]


class EolCardTests(_Base):
    def setUp(self):
        super().setUp()
        EolSettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        EolProduct.objects.create(source="endoflife_date", name="postgresql",
                                  label="PostgreSQL", releases=RELEASES)
        self.pg.eol_source, self.pg.eol_product = "endoflife_date", "postgresql"
        self.pg.save()
        self.install("16.4")
        self.install("16.5", device=self.dev_b)
        self.install("12.9", virtual_machine=self.vm)
        self.install("9.6")  # no cycle in the catalog

    def test_counts_per_cycle_other_cycles_and_unmapped(self):
        body = self.ok(self.client.get(f"{APPS}{self.pg.id}/eol/"))
        self.assertEqual([(c["cycle"], c["install_count"]) for c in body["cycles"]],
                         [("16", 2), ("12", 1)])
        self.assertEqual(body["unmapped_installs"], 1)
        self.assertEqual([c["cycle"] for c in body["other_cycles"]], ["17"])
        other = body["other_cycles"][0]
        self.assertEqual((other["install_count"], other["lts"], other["latest_version"]),
                         (0, True, "17.2"))
        self.assertEqual(other["status"], "supported")
        self.assertEqual(body["cycles"][1]["status"], "eol")
        self.assertIs(body["in_catalog"], True)
        self.assertEqual(body["source_label"], "endoflife.date")
        self.assertEqual(body["product_label"], "PostgreSQL")
        self.assertEqual(body["product_url"], "https://endoflife.date/postgresql")

    def test_counts_take_one_query(self):
        from api.applications_api import _eol_detail
        from compliance.eol import load_config

        app = Application.objects.prefetch_related("eol_mappings").get(pk=self.pg.pk)
        cfg = load_config()
        with CaptureQueriesContext(connection) as q:
            _eol_detail(app, cfg, None)
        # The install counts, then the catalog product.
        self.assertEqual(len(q.captured_queries), 2)

    def test_a_product_out_of_the_catalog(self):
        self.pg.eol_product = "php"
        self.pg.save()
        body = self.ok(self.client.get(f"{APPS}{self.pg.id}/eol/"))
        self.assertIs(body["in_catalog"], False)
        self.assertEqual(body["other_cycles"], [])
        self.assertEqual(body["product_url"], "https://endoflife.date/php")

    def test_no_product(self):
        self.ok(self.client.delete(f"{APPS}{self.pg.id}/eol/"), 204)
        body = self.ok(self.client.get(f"{APPS}{self.pg.id}/eol/"))
        self.assertIsNone(body["product"])
        self.assertIsNone(body["in_catalog"])
        self.assertEqual(body["cycles"], [])
        self.assertEqual(body["unmapped_installs"], 4)

    def test_a_site_limited_reader_counts_their_sites(self):
        user = User.objects.create_user("site-ro", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ro", object_types=["installedsoftware", "device", "application"],
            actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        self.login(user)
        body = self.ok(self.client.get(f"{APPS}{self.pg.id}/eol/"))
        counts = {c["cycle"]: c["install_count"] for c in body["cycles"]}
        # db2 is in site B: not theirs. The count matches the list they get.
        self.assertEqual(counts["16"], 1)
        listed = self.ok(self.client.get(f"{SW}?application={self.pg.id}&cycle=16"))
        self.assertEqual(listed["count"], 1)

    def test_another_tenants_installs_do_not_count(self):
        theirs = Device.objects.create(tenant=self.other, name="x", site=None)
        from api.models import InstalledSoftware

        # A stray row pointing across tenants (never made by the API) is not
        # counted: the count is the application's tenant's.
        InstalledSoftware.objects.create(tenant=self.other, application=self.pg,
                                         version="16.9", device=theirs)
        body = self.ok(self.client.get(f"{APPS}{self.pg.id}/eol/"))
        self.assertEqual(body["cycles"][0]["install_count"], 2)

    def test_cycle_filter_on_installs(self):
        rows = self.ok(self.client.get(f"{SW}?application={self.pg.id}&cycle=16"))["results"]
        self.assertEqual(sorted(r["version"] for r in rows), ["16.4", "16.5"])
        rows = self.ok(self.client.get(f"{SW}?application={self.pg.id}&cycle=none"))["results"]
        self.assertEqual([r["version"] for r in rows], ["9.6"])


class HierarchyTests(_Base):
    def setUp(self):
        super().setUp()
        self.dom = Application.objects.create(tenant=self.tenant, name="Payments",
                                              slug="payments")
        self.proc = Application.objects.create(tenant=self.tenant, name="Checkout",
                                               slug="checkout", parent=self.dom)
        self.pg.parent = self.proc
        self.pg.save()
        self.api = Application.objects.create(tenant=self.tenant, name="checkout-api",
                                              slug="checkout-api", parent=self.proc)
        self.l3 = Application.objects.create(tenant=self.tenant, name="L3", slug="l3",
                                             parent=self.api)
        self.l4 = Application.objects.create(tenant=self.tenant, name="L4", slug="l4",
                                             parent=self.l3)
        self.install("16.4")
        self.install("1.0", app=self.api)
        Application.objects.create(tenant=self.other, name="Theirs", slug="theirs")

    def test_detail_carries_ancestors_and_children(self):
        body = self.ok(self.client.get(f"{APPS}{self.pg.id}/"))
        self.assertEqual([a["name"] for a in body["ancestors"]], ["Payments", "Checkout"])
        self.assertEqual(body["children"], [])
        body = self.ok(self.client.get(f"{APPS}{self.dom.id}/"))
        self.assertEqual(body["ancestors"], [])
        (checkout,) = body["children"]
        self.assertEqual(checkout["name"], "Checkout")
        self.assertEqual(checkout["child_count"], 2)
        names = [c["name"] for c in checkout["children"]]
        self.assertEqual(names, ["checkout-api", "PostgreSQL"])
        api = checkout["children"][0]
        self.assertEqual(api["install_count"], 1)
        # Three levels: L3 is listed, its child L4 only counted.
        (l3,) = api["children"]
        self.assertEqual((l3["name"], l3["child_count"], l3["children"]), ("L3", 1, []))

    def test_the_list_stays_cheap(self):
        rows = self.ok(self.client.get(APPS))["results"]
        self.assertTrue(all(r["ancestors"] == [] and r["children"] == [] for r in rows))

    def test_a_reader_sees_only_installs_they_may_view(self):
        user = User.objects.create_user("site-ro2", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ro2", object_types=["installedsoftware", "device", "application"],
            actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_b])
        self.login(user)
        body = self.ok(self.client.get(f"{APPS}{self.proc.id}/"))
        counts = {c["name"]: c["install_count"] for c in body["children"]}
        self.assertEqual(counts, {"checkout-api": 0, "PostgreSQL": 0})
