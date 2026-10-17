"""A support contract's cost is commercial data (#421): ``supportcontract``
``view_cost`` shows it, the way ``view_credits`` shows an SLA agreement's
money. Without it the API, the export, the list-column catalog and the change
log leave cost and currency out, and a write may not set or change them; a
body that leaves them out keeps them. The built-in Administrator group holds
the verb; Operator, Read-only and the site roles do not."""
from __future__ import annotations

import csv
import io
import json
from decimal import Decimal

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from api.models import Manufacturer, Site, SupportContract
from audit.models import ChangeLogEntry
from auth_api.api import assemble_site_role
from auth_api.builtin_groups import ensure_builtin_groups
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

COST = ("cost", "currency")


class _Case(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.contract = SupportContract.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, contract_number="SN-1",
            cost=Decimal("12345.67"), currency="EUR",
        )
        self.viewer = self._user("viewer", ["view", "change", "add"])
        self.finance = self._user("finance", ["view", "change", "add", "view_cost"])

    def _user(self, name, actions, types=("supportcontract", "manufacturer")):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=list(types), actions=list(actions),
        )
        perm.users.add(u)
        perm.tenants.add(self.tenant)
        return u

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _detail(self):
        r = self.client.get(f"/api/support-contracts/{self.contract.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _list(self):
        r = self.client.get("/api/support-contracts/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["results"]


class ReadTests(_Case):
    def test_without_view_cost_list_and_detail_leave_cost_out(self):
        self._login(self.viewer)
        self.assertFalse(set(COST) & set(self._detail()))
        rows = self._list()
        self.assertEqual(len(rows), 1)
        self.assertFalse(set(COST) & set(rows[0]))
        self.assertNotIn("12345", json.dumps(rows))

    def test_view_cost_shows_it(self):
        self._login(self.finance)
        body = self._detail()
        self.assertEqual(Decimal(str(body["cost"])), Decimal("12345.67"))
        self.assertEqual(body["currency"], "EUR")
        self.assertEqual(self._list()[0]["currency"], "EUR")

    def test_superuser_sees_it(self):
        self._login(User.objects.create_superuser("root", password="x"))
        self.assertEqual(self._detail()["currency"], "EUR")

    def test_view_cost_in_another_tenant_does_not_count(self):
        other = Tenant.objects.create(org=self.tenant.org, name="T2", slug="t2")
        perm = ObjectPermission.objects.create(
            name="elsewhere", object_types=["supportcontract"], actions=["view_cost"],
        )
        perm.users.add(self.viewer)
        perm.tenants.add(other)
        self._login(self.viewer)
        self.assertNotIn("cost", self._detail())

    def _builtin(self, name):
        ensure_builtin_groups()
        u = User.objects.create_user(f"b-{name}", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        u.groups.add(Group.objects.get(name=name))
        return u

    def test_administrator_sees_it(self):
        """Administrators manage grants, so the built-in grant lists view_cost."""
        self._login(self._builtin("Administrator"))
        body = self._detail()
        self.assertEqual(Decimal(str(body["cost"])), Decimal("12345.67"))
        self.assertEqual(self._list()[0]["currency"], "EUR")

    def test_operator_and_read_only_do_not(self):
        for name in ("Operator", "Read-only"):
            with self.subTest(group=name):
                self._login(self._builtin(name))
                self.assertFalse(set(COST) & set(self._detail()))
                self.assertNotIn("12345", json.dumps(self._list()))

    def test_wildcard_grant_naming_the_verb_shows_it(self):
        u = self._user("star", ["view", "view_cost"], types=["*"])
        self._login(u)
        self.assertEqual(self._detail()["currency"], "EUR")

    def test_site_viewer_and_silo_editor_see_no_cost(self):
        for role, silo in (("viewer", False), ("editor", True), ("editor", False)):
            with self.subTest(role=role, silo=silo):
                u = User.objects.create_user(f"s-{role}-{silo}", password="x")
                UserProfile.objects.create(user=u).tenants.add(self.tenant)
                assemble_site_role(self.tenant, role, [self.site], user_ids=[u.id], silo=silo)
                self._login(u)
                body = self._detail()
                self.assertEqual(body["contract_number"], "SN-1")
                self.assertFalse(set(COST) & set(body))

    def test_list_column_catalog_leaves_cost_out(self):
        url = "/api/list-fields/?path=/api/support-contracts/"
        self._login(self.viewer)
        keys = {f["key"] for f in self.client.get(url).json()["fields"]}
        self.assertIn("contract_number", keys)
        self.assertFalse(set(COST) & keys)
        self._login(self.finance)
        keys = {f["key"] for f in self.client.get(url).json()["fields"]}
        self.assertTrue(set(COST) <= keys)


class ExportTests(_Case):
    def _csv(self, query=""):
        resp = self.client.get(f"/api/io/supportcontract/export/?fmt=csv{query}")
        self.assertEqual(resp.status_code, 200, getattr(resp, "content", b""))
        text = b"".join(resp.streaming_content).decode()
        reader = csv.DictReader(io.StringIO(text))
        return reader.fieldnames, list(reader)

    def test_csv_and_json_leave_cost_out(self):
        self._login(self.viewer)
        cols, rows = self._csv()
        self.assertEqual(len(rows), 1)
        self.assertFalse(set(COST) & set(cols))
        self.assertNotIn("12345", json.dumps(rows))
        resp = self.client.get("/api/io/supportcontract/export/?fmt=json")
        rows = json.loads(b"".join(resp.streaming_content))
        self.assertFalse(set(COST) & set(rows[0]))

    def test_cost_is_refused_as_a_filter(self):
        self._login(self.viewer)
        for f, val in (("cost", "12345.67"), ("currency", "EUR")):
            resp = self.client.get(f"/api/io/supportcontract/export/?fmt=csv&{f}={val}")
            self.assertEqual(resp.status_code, 400, f)

    def test_view_cost_exports_and_filters_it(self):
        self._login(self.finance)
        cols, rows = self._csv()
        self.assertTrue(set(COST) <= set(cols))
        self.assertEqual(Decimal(rows[0]["cost"]), Decimal("12345.67"))
        self.assertEqual(len(self._csv("&currency=EUR")[1]), 1)
        self.assertEqual(len(self._csv("&currency=USD")[1]), 0)

    def _import(self, content):
        r = self.client.post("/api/io/supportcontract/import/",
                             {"format": "csv", "content": content}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_import_without_view_cost_cannot_set_it(self):
        self._login(self.viewer)
        body = self._import("contract_number,manufacturer,cost,currency\nSN-2,Cisco,5.00,USD\n")
        self.assertEqual(body["created"], 0, body)
        self.assertIn("cost", json.dumps(body["errors"]))
        self.assertFalse(SupportContract.objects.filter(contract_number="SN-2").exists())

    def test_round_trip_without_cost_keeps_it(self):
        self._login(self.viewer)
        _cols, rows = self._csv()
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
        body = self._import(buf.getvalue())
        self.assertEqual(body["errors"], [], body)
        self.contract.refresh_from_db()
        self.assertEqual((self.contract.cost, self.contract.currency),
                         (Decimal("12345.67"), "EUR"))


class WriteTests(_Case):
    def _patch(self, body):
        return self.client.patch(
            f"/api/support-contracts/{self.contract.id}/", body, format="json")

    def test_without_view_cost_setting_cost_is_a_field_error(self):
        self._login(self.viewer)
        r = self._patch({"cost": "1.00"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("cost", r.json())
        r = self._patch({"currency": "USD"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("currency", r.json())
        r = self._patch({"cost": None})
        self.assertEqual(r.status_code, 400, r.content)
        self.contract.refresh_from_db()
        self.assertEqual((self.contract.cost, self.contract.currency),
                         (Decimal("12345.67"), "EUR"))

    def test_without_view_cost_create_with_cost_is_refused(self):
        self._login(self.viewer)
        r = self.client.post("/api/support-contracts/", {
            "manufacturer_id": str(self.mfr.id), "contract_number": "SN-3",
            "cost": "10.00", "currency": "EUR",
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("cost", r.json())
        r = self.client.post("/api/support-contracts/", {
            "manufacturer_id": str(self.mfr.id), "contract_number": "SN-3",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("cost", r.json())

    def test_edit_without_cost_keeps_it(self):
        self._login(self.viewer)
        r = self._patch({"description": "renewed", "reseller": "Acme"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(set(COST) & set(r.json()))
        self.contract.refresh_from_db()
        self.assertEqual(self.contract.description, "renewed")
        self.assertEqual((self.contract.cost, self.contract.currency),
                         (Decimal("12345.67"), "EUR"))

    def test_full_put_without_cost_keeps_it(self):
        self._login(self.viewer)
        r = self.client.put(f"/api/support-contracts/{self.contract.id}/", {
            "manufacturer_id": str(self.mfr.id), "contract_number": "SN-1",
            "description": "put",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.contract.refresh_from_db()
        self.assertEqual(self.contract.cost, Decimal("12345.67"))

    def test_repeating_the_stored_value_is_allowed(self):
        self._login(self.viewer)
        r = self._patch({"cost": "12345.67", "currency": "eur", "description": "x"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_view_cost_may_change_it(self):
        self._login(self.finance)
        r = self._patch({"cost": "99.00", "currency": "usd"})
        self.assertEqual(r.status_code, 200, r.content)
        self.contract.refresh_from_db()
        self.assertEqual((self.contract.cost, self.contract.currency), (Decimal("99.00"), "USD"))


class ChangeLogTests(_Case):
    def setUp(self):
        super().setUp()
        self._login(self.finance)
        self.assertEqual(self.client.patch(
            f"/api/support-contracts/{self.contract.id}/",
            {"cost": "500.00", "description": "bumped"}, format="json").status_code, 200)
        self.entry = ChangeLogEntry.objects.filter(
            object_id=str(self.contract.id), action="update").latest("timestamp")
        self.assertIn("cost", self.entry.changes)

    def _entries(self):
        r = self.client.get(
            f"/api/changelog/?object_type=api.supportcontract&object_id={self.contract.id}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["results"]

    def test_history_leaves_cost_out_without_view_cost(self):
        self._login(self.viewer)
        rows = self._entries()
        self.assertTrue(rows)
        for row in rows:
            self.assertFalse(set(COST) & set(row["changes"]))
        self.assertNotIn("12345", json.dumps(rows))
        self.assertNotIn("500.00", json.dumps(rows))
        detail = self.client.get(f"/api/changelog/{self.entry.id}/").json()
        self.assertIn("description", detail["changes"])
        self.assertEqual(detail["change_count"], len(detail["changes"]))
        for key in ("changes", "pre_change", "post_change"):
            self.assertFalse(set(COST) & set(detail.get(key) or {}), key)

    def _builtin(self, name):
        ensure_builtin_groups()
        u = User.objects.create_user(f"h-{name}", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        u.groups.add(Group.objects.get(name=name))
        return u

    def test_history_shows_cost_to_administrator_only(self):
        for name, sees in (("Administrator", True), ("Operator", False), ("Read-only", False)):
            with self.subTest(group=name):
                self._login(self._builtin(name))
                detail = self.client.get(f"/api/changelog/{self.entry.id}/").json()
                self.assertEqual("cost" in detail["changes"], sees)
                self.assertEqual("currency" in (detail.get("post_change") or {}), sees)
                self.assertEqual("500.00" in json.dumps(self._entries()), sees)

    def test_history_shows_cost_with_view_cost(self):
        rows = self._entries()
        self.assertTrue(any("cost" in r["changes"] for r in rows))
        detail = self.client.get(f"/api/changelog/{self.entry.id}/").json()
        self.assertEqual(detail["post_change"]["currency"], "EUR")
