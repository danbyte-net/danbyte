"""Applications and installed software (#436): the catalog and its tree,
installs on a device or VM, cycles and end-of-life mappings, tenant and site
scope, the delete guards and import/export."""
from __future__ import annotations

import csv
import io

from django.contrib.auth.models import User
from django.db import IntegrityError, transaction
from rest_framework.test import APITestCase

from api.models import (
    Application,
    Cluster,
    ClusterType,
    Device,
    InstalledSoftware,
    Manufacturer,
    Service,
    ServiceTemplate,
    Site,
    VirtualMachine,
)
from auth_api.models import ObjectPermission, UserProfile
from compliance.eol import apply_mappings
from compliance.models import EolMapping, EolProduct, EolSettings
from core.models import Organization, Tenant

APPS = "/api/applications/"
SW = "/api/installed-software/"

RELEASES = [
    {"name": "16", "release_date": "2023-09-14", "eol_date": "2028-11-09"},
    {"name": "12", "release_date": "2019-10-03", "eol_date": "2024-11-14", "eol": True},
]


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="PGDG", slug="pgdg")
        self.dev = Device.objects.create(tenant=self.tenant, name="db1", site=self.site_a)
        self.dev_b = Device.objects.create(tenant=self.tenant, name="db2", site=self.site_b)
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        self.vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cl)
        self.pg = Application.objects.create(tenant=self.tenant, name="PostgreSQL",
                                             slug="postgresql", manufacturer=self.mfr)
        self.admin = User.objects.create_superuser("apps-root", password="x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def install(self, version="16.4", app=None, **parent):
        if not parent:
            parent = {"device": self.dev}
        return InstalledSoftware.objects.create(
            tenant=self.tenant, application=app or self.pg, version=version, **parent)

    def catalog(self):
        return EolProduct.objects.create(source="endoflife_date", name="postgresql",
                                         label="PostgreSQL", releases=RELEASES)

    def map_product(self):
        self.catalog()
        self.pg.eol_source, self.pg.eol_product = "endoflife_date", "postgresql"
        self.pg.save()

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None


class ApplicationCatalogTests(_Base):
    def test_crud_and_slug(self):
        body = self.ok(self.client.post(APPS, {"name": "Payments"}, format="json"), 201)
        self.assertEqual(body["slug"], "payments")
        body = self.ok(self.client.patch(f"{APPS}{body['id']}/", {"name": "Payments EU"},
                                         format="json"))
        # A rename keeps the slug: it is the import key.
        self.assertEqual((body["name"], body["slug"]), ("Payments EU", "payments"))
        r = self.client.post(APPS, {"name": "x", "slug": "postgresql"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("slug", r.json())

    def test_tree_paths_and_picker(self):
        dom = Application.objects.create(tenant=self.tenant, name="Payments", slug="payments")
        proc = Application.objects.create(tenant=self.tenant, name="Checkout",
                                          slug="checkout", parent=dom)
        self.pg.parent = proc
        self.pg.save()
        rows = {r["name"]: r for r in self.ok(self.client.get(f"{APPS}?picker=1"))["results"]}
        self.assertEqual(rows["PostgreSQL"]["path"], "Payments › Checkout › PostgreSQL")
        self.assertEqual(rows["PostgreSQL"]["depth"], 2)
        roots = self.ok(self.client.get(f"{APPS}?parent=none"))["results"]
        self.assertEqual([r["name"] for r in roots], ["Payments"])
        self.assertEqual(roots[0]["child_count"], 1)
        kids = self.ok(self.client.get(f"{APPS}?parent={proc.id}"))["results"]
        self.assertEqual([r["name"] for r in kids], ["PostgreSQL"])

    def test_no_cycles(self):
        a = Application.objects.create(tenant=self.tenant, name="A", slug="a")
        b = Application.objects.create(tenant=self.tenant, name="B", slug="b", parent=a)
        r = self.client.patch(f"{APPS}{a.id}/", {"parent_id": str(b.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("parent_id", r.json())
        r = self.client.patch(f"{APPS}{a.id}/", {"parent_id": str(a.id)}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_filters(self):
        Application.objects.create(tenant=self.tenant, name="nginx", slug="nginx")
        names = [r["name"] for r in self.ok(
            self.client.get(f"{APPS}?manufacturer={self.mfr.id}"))["results"]]
        self.assertEqual(names, ["PostgreSQL"])
        names = [r["name"] for r in self.ok(self.client.get(f"{APPS}?search=ngi"))["results"]]
        self.assertEqual(names, ["nginx"])
        self.assertEqual(self.client.get(f"{APPS}?manufacturer=nope").status_code, 400)

    def test_delete_is_refused_while_installs_or_children_exist(self):
        self.install()
        r = self.client.delete(f"{APPS}{self.pg.id}/")
        self.assertEqual(r.status_code, 409)
        parent = Application.objects.create(tenant=self.tenant, name="P", slug="p")
        Application.objects.create(tenant=self.tenant, name="K", slug="k", parent=parent)
        self.assertEqual(self.client.delete(f"{APPS}{parent.id}/").status_code, 409)
        lone = Application.objects.create(tenant=self.tenant, name="L", slug="l")
        body = self.ok(self.client.post(f"{APPS}bulk-delete/", {
            "ids": [str(self.pg.id), str(parent.id), str(lone.id)]}, format="json"))
        self.assertEqual(body["deleted_ids"], [str(lone.id)])
        self.assertEqual(sorted(s["name"] for s in body["skipped"]), ["P", "PostgreSQL"])
        self.assertTrue(Application.objects.filter(pk=self.pg.pk).exists())

    def test_tenant_isolation(self):
        theirs = Application.objects.create(tenant=self.other, name="Theirs", slug="theirs")
        names = [r["name"] for r in self.ok(self.client.get(APPS))["results"]]
        self.assertNotIn("Theirs", names)
        self.assertEqual(self.client.get(f"{APPS}{theirs.id}/").status_code, 404)
        r = self.client.patch(f"{APPS}{self.pg.id}/", {"parent_id": str(theirs.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)

    def test_default_closed(self):
        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get(APPS).status_code, 403)
        self.assertEqual(self.client.get(SW).status_code, 403)

    def test_service_template_names_an_application(self):
        r = self.client.post("/api/service-templates/", {
            "name": "Postgres", "protocol": "tcp", "ports": [5432],
            "application_id": str(self.pg.id)}, format="json")
        body = self.ok(r, 201)
        self.assertEqual(body["application"]["name"], "PostgreSQL")
        self.assertEqual(ServiceTemplate.objects.get().application, self.pg)


class InstalledSoftwareTests(_Base):
    def post(self, **data):
        data.setdefault("application_id", str(self.pg.id))
        return self.client.post(SW, data, format="json")

    def test_create_on_a_device_and_a_vm(self):
        body = self.ok(self.post(device_id=str(self.dev.id), version="16.4"), 201)
        self.assertEqual((body["device"]["name"], body["source"]), ("db1", "manual"))
        body = self.ok(self.post(virtual_machine_id=str(self.vm.id), version="15"), 201)
        self.assertEqual(body["virtual_machine"]["name"], "vm1")
        rows = self.ok(self.client.get(f"{SW}?virtual_machine={self.vm.id}"))["results"]
        self.assertEqual([r["version"] for r in rows], ["15"])
        rows = self.ok(self.client.get(f"{SW}?application={self.pg.id}"))["results"]
        self.assertEqual(len(rows), 2)

    def test_exactly_one_parent(self):
        r = self.post(version="1")
        self.assertEqual(r.status_code, 400)
        r = self.post(version="1", device_id=str(self.dev.id), virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 400)
        with self.assertRaises(IntegrityError), transaction.atomic():
            InstalledSoftware.objects.create(tenant=self.tenant, application=self.pg,
                                             version="1")

    def test_the_same_version_once_per_parent(self):
        self.install("16.4")
        r = self.post(device_id=str(self.dev.id), version="16.4")
        self.assertEqual(r.status_code, 400)
        self.assertIn("version", r.json())
        self.ok(self.post(device_id=str(self.dev_b.id), version="16.4"), 201)
        # Blank versions clash too (nulls_distinct=False on the parents).
        self.install("", virtual_machine=self.vm)
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.install("", virtual_machine=self.vm)

    def test_service_must_be_on_the_same_parent(self):
        mine = Service.objects.create(tenant=self.tenant, name="pg", ports=[5432],
                                      device=self.dev)
        elsewhere = Service.objects.create(tenant=self.tenant, name="pg", ports=[5432],
                                           device=self.dev_b)
        r = self.post(device_id=str(self.dev.id), version="1", service_id=str(elsewhere.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("service_id", r.json())
        body = self.ok(self.post(device_id=str(self.dev.id), version="1",
                                 service_id=str(mine.id)), 201)
        self.assertEqual(body["service"]["name"], "pg")
        rows = self.ok(self.client.get(f"{SW}?service={mine.id}"))["results"]
        self.assertEqual(len(rows), 1)

    def test_cross_tenant_references_are_refused(self):
        theirs_app = Application.objects.create(tenant=self.other, name="X", slug="x")
        theirs_dev = Device.objects.create(tenant=self.other, name="foreign")
        r = self.post(application_id=str(theirs_app.id), device_id=str(self.dev.id), version="1")
        self.assertEqual(r.status_code, 400)
        r = self.post(device_id=str(theirs_dev.id), version="1")
        self.assertEqual(r.status_code, 400)
        foreign = InstalledSoftware.objects.create(
            tenant=self.other, application=theirs_app, device=theirs_dev, version="1")
        self.assertEqual(self.client.get(f"{SW}{foreign.id}/").status_code, 404)

    def test_bulk_delete(self):
        a, b = self.install("1"), self.install("2")
        body = self.ok(self.client.post(f"{SW}bulk-delete/", {
            "ids": [str(a.id), str(b.id)]}, format="json"))
        self.assertEqual(body["deleted"], 2)
        self.assertFalse(InstalledSoftware.objects.exists())

    def test_a_site_limited_editor_stays_in_their_sites(self):
        user = User.objects.create_user("site-ed", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ed", object_types=["installedsoftware", "device", "application"],
            actions=["view", "add", "change", "delete"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        self.install("1", device=self.dev_b)
        self.login(user)
        self.assertEqual(self.ok(self.client.get(SW))["results"], [])
        self.ok(self.post(device_id=str(self.dev.id), version="2"), 201)
        r = self.post(device_id=str(self.dev_b.id), version="3")
        self.assertIn(r.status_code, (400, 403))


class CycleAndMappingTests(_Base):
    def test_cycle_is_derived_and_overridable(self):
        self.map_product()
        sw = self.install("16.4")
        self.assertEqual((sw.cycle, sw.cycle_manual), ("16", False))
        self.assertEqual(sw.eol_mapping.cycle, "16")
        self.assertEqual(str(sw.eol_mapping.eol_date), "2028-11-09")
        r = self.client.patch(f"{SW}{sw.id}/", {"cycle": "12"}, format="json")
        body = self.ok(r)
        self.assertEqual((body["cycle"], body["cycle_manual"]), ("12", True))
        # A version change keeps a cycle set by hand ...
        body = self.ok(self.client.patch(f"{SW}{sw.id}/", {"version": "16.5"}, format="json"))
        self.assertEqual(body["cycle"], "12")
        # ... until it is cleared, which derives it again.
        body = self.ok(self.client.patch(f"{SW}{sw.id}/", {"cycle": ""}, format="json"))
        self.assertEqual((body["cycle"], body["cycle_manual"]), ("16", False))

    def test_no_product_no_cycle(self):
        sw = self.install("16.4")
        self.assertEqual(sw.cycle, "")
        self.assertIsNone(sw.eol_mapping)

    def test_installs_share_a_mapping_and_the_last_takes_it_along(self):
        self.map_product()
        a = self.install("16.1")
        b = self.install("16.2", device=self.dev_b)
        self.assertEqual(a.eol_mapping_id, b.eol_mapping_id)
        self.assertEqual(EolMapping.objects.filter(application=self.pg).count(), 1)
        c = self.install("12.9", virtual_machine=self.vm)
        self.assertEqual(EolMapping.objects.filter(application=self.pg).count(), 2)
        # Moving the last 12.x install to 16 drops the 12 mapping.
        c.version = "16.0"
        c.save()
        self.assertEqual(list(EolMapping.objects.filter(application=self.pg)
                              .values_list("cycle", flat=True)), ["16"])
        a.delete()
        b.delete()
        self.assertTrue(EolMapping.objects.filter(application=self.pg).exists())
        c.delete()
        self.assertFalse(EolMapping.objects.filter(application=self.pg).exists())

    def test_the_eol_endpoint_redoes_the_installs(self):
        EolSettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        self.catalog()
        sw = self.install("12.4")
        self.assertEqual(sw.cycle, "")
        body = self.ok(self.client.put(f"{APPS}{self.pg.id}/eol/",
                                       {"product": "postgresql"}, format="json"))
        self.assertEqual(body["product"], "postgresql")
        self.assertEqual([c["cycle"] for c in body["cycles"]], ["12"])
        self.assertEqual(body["cycles"][0]["status"], "eol")
        sw.refresh_from_db()
        self.assertEqual(sw.cycle, "12")
        detail = self.ok(self.client.get(f"{SW}{sw.id}/"))
        self.assertEqual(detail["eol"]["status"], "eol")
        self.assertEqual(detail["effective_end"], "2024-11-14")
        self.assertEqual(self.client.delete(f"{APPS}{self.pg.id}/eol/").status_code, 204)
        sw.refresh_from_db()
        self.assertEqual((sw.cycle, sw.eol_mapping_id), ("", None))
        self.assertFalse(EolMapping.objects.filter(application=self.pg).exists())
        r = self.client.put(f"{APPS}{self.pg.id}/eol/", {"product": "nope"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_the_eol_endpoint_is_off_with_the_feature(self):
        r = self.client.put(f"{APPS}{self.pg.id}/eol/", {"product": "postgresql"},
                            format="json")
        self.assertEqual(r.status_code, 404)

    def test_the_refresh_updates_application_mappings(self):
        self.map_product()
        sw = self.install("16.4")
        p = EolProduct.objects.get()
        p.releases = [{**RELEASES[0], "eol_date": "2029-01-01"}, RELEASES[1]]
        p.save()
        self.assertEqual(apply_mappings()["changed"], 1)
        sw.refresh_from_db()
        self.assertEqual(str(sw.eol_mapping.eol_date), "2029-01-01")

    def test_catalog_suggestions_for_an_application(self):
        EolSettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        self.catalog()
        body = self.ok(self.client.get(f"/api/eol/products/?application={self.pg.id}"))
        self.assertEqual(body["suggestions"][0]["name"], "postgresql")


def _csv(resp) -> str:
    content = b"".join(resp.streaming_content) if resp.streaming else resp.content
    return content.decode().lstrip("﻿")


class ImportExportTests(_Base):
    def test_application_round_trip(self):
        child = Application.objects.create(tenant=self.tenant, name="Checkout",
                                           slug="checkout", parent=self.pg)
        text = _csv(self.client.get("/api/io/application/export/?fmt=csv"))
        rows = {r["slug"]: r for r in csv.DictReader(io.StringIO(text))}
        self.assertEqual(rows["checkout"]["parent"], "postgresql")
        r = self.client.post("/api/io/application/import/",
                             {"format": "csv", "content": text}, format="json")
        body = self.ok(r)
        self.assertEqual((body["created"], body["errors"]), (0, []))
        child.refresh_from_db()
        self.assertEqual(child.parent, self.pg)

    def test_install_import_by_names_and_round_trip(self):
        content = ("application,device,virtual_machine,version\n"
                   "postgresql,db1,,16.4\n"
                   "postgresql,,vm1,15\n")
        body = self.ok(self.client.post("/api/io/installedsoftware/import/",
                                        {"format": "csv", "content": content}, format="json"))
        self.assertEqual((body["created"], body["errors"]), (2, []))
        sw = InstalledSoftware.objects.get(device=self.dev)
        self.assertEqual((sw.version, sw.source), ("16.4", "import"))
        text = _csv(self.client.get("/api/io/installedsoftware/export/?fmt=csv"))
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual({(r["application"], r["device"], r["virtual_machine"], r["version"])
                          for r in rows},
                         {("postgresql", "db1", "", "16.4"), ("postgresql", "", "vm1", "15")})
        body = self.ok(self.client.post("/api/io/installedsoftware/import/",
                                        {"format": "csv", "content": text}, format="json"))
        self.assertEqual((body["created"], body["errors"]), (0, []))
        self.assertEqual(InstalledSoftware.objects.count(), 2)

    def test_import_refuses_another_tenants_application(self):
        Application.objects.create(tenant=self.other, name="Theirs", slug="theirs")
        content = "application,device,version\ntheirs,db1,1\n"
        body = self.ok(self.client.post("/api/io/installedsoftware/import/",
                                        {"format": "csv", "content": content}, format="json"))
        self.assertEqual(body["created"], 0)
        self.assertTrue(body["errors"])
