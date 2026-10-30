"""Custom end-of-life products: a tenant's own products and cycles for what
endoflife.date lacks. Stored as EolProduct rows with ``source="custom"``, so
every reader of the catalog takes them like fetched ones; tenant-scoped,
never touched by a refresh or import, and protected from deletion while an
application or platform names them."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.db import IntegrityError, transaction
from django.utils import timezone

from api.models import Application, Platform
from api.tests_applications import APPS, SW, _Base
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from compliance import eol
from compliance.eol_custom import clean_cycles
from compliance.models import EolMapping, EolProduct, EolSettings

URL = "/api/eol/custom-products/"

CYCLES = [
    {"name": "3.1", "release_date": "2022-01-10", "eol_date": "2024-01-10"},
    {"name": "3.2", "release_date": "2023-02-01", "support_until": "2025-01-01",
     "eol_date": "2099-02-01", "extended_until": "2100-02-01", "lts": True,
     "latest": "3.2.7"},
]


class _CustomBase(_Base):
    def setUp(self):
        super().setUp()
        EolSettings.objects.update_or_create(pk=1, defaults={"enabled": True})

    def create(self, **extra):
        body = {"label": "Acme ERP", "releases": CYCLES, **extra}
        return self.ok(self.client.post(URL, body, format="json"), 201)


class CustomProductCrudTests(_CustomBase):
    def test_create_keys_sorts_and_scopes_to_the_tenant(self):
        body = self.create(link="https://acme.example/support", notes="Vendor matrix")
        self.assertEqual((body["source"], body["name"], body["label"]),
                         ("custom", "acme-erp", "Acme ERP"))
        # Newest first, as a source lists them; the shape the sources store.
        self.assertEqual([r["name"] for r in body["releases"]], ["3.2", "3.1"])
        r = body["releases"][0]
        self.assertEqual((r["extended_until"], r["lts"], r["latest"], r["eol"]),
                         ("2100-02-01", True, "3.2.7", False))
        self.assertEqual(body["cycle_count"], 2)
        row = EolProduct.objects.get(pk=body["id"])
        self.assertEqual(row.tenant_id, self.tenant.id)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="compliance.eolproduct", object_id=str(row.pk)).exists())

    def test_the_key_is_unique_per_tenant_and_fixed(self):
        body = self.create()
        r = self.client.post(URL, {"label": "Acme ERP"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())
        r = self.client.patch(f"{URL}{body['id']}/", {"name": "other"}, format="json")
        self.assertEqual(r.status_code, 400)
        # Another tenant may use the same key.
        self.login(self.admin, self.other)
        self.create()
        self.assertEqual(EolProduct.objects.filter(name="acme-erp").count(), 2)

    def test_cycles_are_validated(self):
        bad = [{"name": "1"}, {"name": "1"}, {"name": "2", "eol_date": "soon"},
               {"name": "3", "support_until": "2030-01-01", "eol_date": "2029-01-01"},
               {"name": "bad name"}]
        r = self.client.post(URL, {"label": "X", "releases": bad}, format="json")
        self.assertEqual(r.status_code, 400)
        msgs = " ".join(r.json()["releases"])
        for part in ("listed twice", "must be a date", "after end of life", "bad name"):
            self.assertIn(part, msgs)

    def test_a_custom_product_needs_a_tenant(self):
        with transaction.atomic(), self.assertRaises(IntegrityError):
            EolProduct.objects.create(source="custom", name="x")
        with transaction.atomic(), self.assertRaises(IntegrityError):
            EolProduct.objects.create(source="endoflife_date", name="x", tenant=self.tenant)

    def test_clean_cycles_orders_undated_cycles_by_version(self):
        rows = clean_cycles([{"name": "2"}, {"name": "10"}, {"name": "9.1"}])
        self.assertEqual([r["name"] for r in rows], ["10", "9.1", "2"])


class TenantIsolationTests(_CustomBase):
    def test_another_tenant_never_sees_or_picks_it(self):
        body = self.create()
        self.login(self.admin, self.other)
        self.assertEqual(self.ok(self.client.get(URL))["results"], [])
        self.assertEqual(self.client.get(f"{URL}{body['id']}/").status_code, 404)
        self.assertEqual(self.client.patch(f"{URL}{body['id']}/", {"label": "x"},
                                           format="json").status_code, 404)
        self.assertEqual(self.client.delete(f"{URL}{body['id']}/").status_code, 404)
        names = [p["name"] for p in self.ok(self.client.get("/api/eol/products/"))["results"]]
        self.assertNotIn("acme-erp", names)
        r = self.client.get("/api/eol/products/custom/acme-erp/")
        self.assertEqual(r.status_code, 404)
        other_app = Application.objects.create(tenant=self.other, name="ERP", slug="erp")
        r = self.client.put(f"{APPS}{other_app.id}/eol/",
                            {"source": "custom", "product": "acme-erp"}, format="json")
        self.assertEqual(r.status_code, 400)
        plat = Platform.objects.create(tenant=self.other, name="Acme OS", slug="acme-os")
        r = self.client.put(f"/api/eol/platforms/{plat.id}/",
                            {"source": "custom", "product": "acme-erp", "cycle": "3.2"},
                            format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_mapping_reads_its_own_tenants_product(self):
        """Two tenants with the same key: each one's mappings take its own
        cycles, on save and on a full re-apply."""
        self.create()
        self.login(self.admin, self.other)
        self.create(releases=[{"name": "3.2", "eol_date": "2030-05-05"}])
        self.login(self.admin)
        self.ok(self.client.put(f"{APPS}{self.pg.id}/eol/",
                                {"source": "custom", "product": "acme-erp"}, format="json"))
        self.pg.refresh_from_db()
        self.install("3.2.4")
        m = EolMapping.objects.get(application=self.pg)
        self.assertEqual(str(m.eol_date), "2099-02-01")
        eol.apply_mappings()
        m.refresh_from_db()
        self.assertEqual(str(m.eol_date), "2099-02-01")


class PickerTests(_CustomBase):
    def test_the_picker_lists_both_with_the_custom_flag(self):
        EolProduct.objects.create(source="endoflife_date", name="postgresql",
                                  label="PostgreSQL", releases=[{"name": "16"}])
        self.create()
        rows = self.ok(self.client.get(f"/api/eol/products/?application={self.pg.id}"))
        by = {(r["source"], r["name"]): r for r in rows["results"]}
        self.assertIs(by[("custom", "acme-erp")]["custom"], True)
        self.assertIs(by[("endoflife_date", "postgresql")]["custom"], False)
        body = self.ok(self.client.get("/api/eol/products/custom/acme-erp/"))
        self.assertEqual([r["name"] for r in body["releases"]], ["3.2", "3.1"])

    def test_a_custom_product_is_suggested(self):
        self.create(label="PostgreSQL Pro")
        rows = self.ok(self.client.get(f"/api/eol/products/?application={self.pg.id}"))
        self.assertIn(("custom", "postgresql-pro"),
                      {(s["source"], s["name"]) for s in rows["suggestions"]})


class MatchingTests(_CustomBase):
    def test_installs_match_custom_cycles_like_synced_ones(self):
        self.create()
        body = self.ok(self.client.put(f"{APPS}{self.pg.id}/eol/",
                                       {"source": "custom", "product": "acme-erp"},
                                       format="json"))
        self.assertEqual((body["source"], body["source_label"], body["custom"]),
                         ("custom", "Custom", True))
        self.pg.refresh_from_db()
        a = self.install("3.2.4")
        b = self.install("3.1.0", device=self.dev_b)
        c = self.install("4.0")
        a.refresh_from_db()
        b.refresh_from_db()
        c.refresh_from_db()
        self.assertEqual((a.cycle, b.cycle, c.cycle), ("3.2", "3.1", ""))
        self.assertEqual(a.eol_mapping.latest_version, "3.2.7")
        self.assertIsNotNone(a.eol_mapping.synced_at)
        self.assertIsNone(c.eol_mapping)
        sw = {r["version"]: r for r in self.ok(self.client.get(f"{SW}?application={self.pg.id}"))["results"]}
        self.assertEqual(sw["3.1.0"]["eol"]["status"], "eol")
        self.assertEqual(sw["3.2.4"]["eol"]["status"], "supported")
        detail = self.ok(self.client.get(f"{APPS}{self.pg.id}/eol/"))
        self.assertIs(detail["in_catalog"], True)
        self.assertEqual(detail["product_label"], "Acme ERP")

    def test_editing_cycles_redoes_the_installs(self):
        body = self.create()
        self.pg.eol_source, self.pg.eol_product = "custom", "acme-erp"
        self.pg.save()
        c = self.install("4.0.1")
        a = self.install("3.2.4", device=self.dev_b)
        c.refresh_from_db()
        self.assertEqual(c.cycle, "")
        soon = (timezone.localdate() + timedelta(days=30)).isoformat()
        cycles = [*CYCLES, {"name": "4.0", "eol_date": soon}]
        cycles[1] = {**cycles[1], "eol_date": "2098-01-01", "extended_until": None}
        self.ok(self.client.patch(f"{URL}{body['id']}/", {"releases": cycles}, format="json"))
        c.refresh_from_db()
        a.refresh_from_db()
        self.assertEqual(c.cycle, "4.0")
        self.assertEqual(eol.status_of(c.eol_mapping, 180), "ending")
        self.assertEqual(str(a.eol_mapping.eol_date), "2098-01-01")

    def test_a_platform_maps_to_a_custom_cycle(self):
        self.create()
        plat = Platform.objects.create(tenant=self.tenant, name="Acme OS 3.2", slug="acme-os")
        body = self.ok(self.client.put(f"/api/eol/platforms/{plat.id}/",
                                       {"source": "custom", "product": "acme-erp",
                                        "cycle": "3.2"}, format="json"))
        self.assertEqual((body["source"], body["status"], body["latest_version"]),
                         ("custom", "supported", "3.2.7"))
        plat_row = self.ok(self.client.get(f"/api/platforms/{plat.id}/"))
        self.assertEqual(plat_row["effective_source"], "custom")
        self.assertEqual(str(plat_row["effective_end"]), "2099-02-01")


class RefreshTests(_CustomBase):
    def test_a_refresh_never_touches_custom_rows(self):
        body = self.create()
        self.pg.eol_source, self.pg.eol_product = "custom", "acme-erp"
        self.pg.save()
        inst = self.install("3.2.1")
        inst.refresh_from_db()
        before = EolProduct.objects.get(pk=body["id"])
        # A catalog that has a product of the same name and none of ours.
        catalog = [{"name": "acme-erp", "label": "Other", "category": "", "aliases": [],
                    "releases": [{"name": "3.2", "eol_date": "2001-01-01"}]},
                   {"name": "postgresql", "label": "PostgreSQL", "category": "",
                    "aliases": [], "releases": [{"name": "16"}]}]
        eol.store_catalog("endoflife_date", catalog)
        eol.apply_mappings("endoflife_date")
        eol.store_catalog("endoflife_date", catalog[1:])  # and one that drops it
        eol.apply_mappings()
        after = EolProduct.objects.get(pk=body["id"])
        self.assertEqual((after.label, after.releases, after.updated_at),
                         (before.label, before.releases, before.updated_at))
        inst.eol_mapping.refresh_from_db()
        self.assertEqual(str(inst.eol_mapping.eol_date), "2099-02-01")
        self.assertFalse(inst.eol_mapping.missing)
        self.assertEqual(EolProduct.objects.filter(tenant__isnull=True).count(), 1)

    def test_custom_is_not_a_registrable_source(self):
        from compliance.eol_sources import EolSource, register_source

        with self.assertRaises(ValueError):
            register_source(EolSource(key="custom", label="x", default_url="https://x"))


class DeleteAndPermissionTests(_CustomBase):
    def test_delete_is_refused_while_in_use(self):
        body = self.create()
        self.pg.eol_source, self.pg.eol_product = "custom", "acme-erp"
        self.pg.save()
        r = self.client.delete(f"{URL}{body['id']}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("1 application", r.json()["detail"])
        rows = self.ok(self.client.get(URL))["results"]
        self.assertEqual(rows[0]["application_count"], 1)
        self.ok(self.client.delete(f"{APPS}{self.pg.id}/eol/"), 204)
        plat = Platform.objects.create(tenant=self.tenant, name="P", slug="p")
        self.ok(self.client.put(f"/api/eol/platforms/{plat.id}/",
                                {"source": "custom", "product": "acme-erp", "cycle": "3.1"},
                                format="json"))
        self.assertEqual(self.client.delete(f"{URL}{body['id']}/").status_code, 409)
        self.ok(self.client.delete(f"/api/eol/platforms/{plat.id}/"), 204)
        self.ok(self.client.delete(f"{URL}{body['id']}/"), 204)

    def test_writes_need_the_eolproduct_grant(self):
        body = self.create()
        user = User.objects.create_user("reader", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get(URL).status_code, 403)
        p = ObjectPermission.objects.create(name="v", object_types=["eolproduct"],
                                            actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        self.assertEqual(len(self.ok(self.client.get(URL))["results"]), 1)
        self.assertEqual(self.client.post(URL, {"label": "New"}, format="json").status_code,
                         403)
        self.assertEqual(self.client.patch(f"{URL}{body['id']}/", {"label": "x"},
                                           format="json").status_code, 403)
        self.assertEqual(self.client.delete(f"{URL}{body['id']}/").status_code, 403)
        p.actions = ["view", "add", "change", "delete"]
        p.save()
        self.ok(self.client.post(URL, {"label": "New"}, format="json"), 201)
