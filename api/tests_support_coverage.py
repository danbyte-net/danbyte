"""Support & warranty coverage (#421): contracts, the contract ↔ device rows,
the derived status and its filter, serial matching, the dashboard summary,
notifications, the digest section, the compliance check and import/export."""
from __future__ import annotations

import csv
import io
from datetime import timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api import support_coverage as cov
from api.models import (
    Device,
    DeviceType,
    Manufacturer,
    Site,
    SupportContract,
    SupportCoverage,
)
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from compliance.engine import evaluate, evaluate_for_object
from compliance.models import ComplianceRule
from core.models import Organization, Tag, Tenant, TenantSettings
from monitoring.models import NotificationChannel


def days(n: int):
    return timezone.localdate() + timedelta(days=n)


# ─── the rules ───────────────────────────────────────────────────────────────


class StatusRuleTests(SimpleTestCase):
    def test_no_dates_is_not_covered(self):
        self.assertEqual(cov.status_for(None, 90), "none")

    def test_boundaries(self):
        today = timezone.localdate()
        self.assertEqual(cov.status_for(today - timedelta(days=1), 90, today), "expired")
        # The end date is the last covered day.
        self.assertEqual(cov.status_for(today, 90, today), "expiring")
        self.assertEqual(cov.status_for(today + timedelta(days=90), 90, today), "expiring")
        self.assertEqual(cov.status_for(today + timedelta(days=91), 90, today), "covered")
        self.assertEqual(cov.status_for(cov.OPEN_ENDED, 90, today), "covered")

    def test_window_moves_the_edge(self):
        today = timezone.localdate()
        end = today + timedelta(days=30)
        self.assertEqual(cov.status_for(end, 30, today), "expiring")
        self.assertEqual(cov.status_for(end, 29, today), "covered")

    def test_contract_state(self):
        today = timezone.localdate()
        self.assertEqual(cov.contract_state(None, 90, today), "active")
        self.assertEqual(cov.contract_state(today - timedelta(days=1), 90, today), "expired")
        self.assertEqual(cov.contract_state(today, 90, today), "expiring")
        self.assertEqual(cov.contract_state(today + timedelta(days=91), 90, today), "active")

    def test_parse_serials(self):
        self.assertEqual(
            cov.parse_serials("ab1\nAB1, cd2;ef3  gh4\n\n"), ["ab1", "cd2", "ef3", "gh4"]
        )
        self.assertEqual(cov.parse_serials(["x", " y ", ""]), ["x", "y"])


# ─── fixtures ────────────────────────────────────────────────────────────────


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.mfr2 = Manufacturer.objects.create(tenant=self.tenant, name="Juniper", slug="juniper")
        self.admin = User.objects.create_superuser("cov-admin", password="x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def device(self, name, site=None, serial="", warranty_end=None, tenant=None, dtype=None):
        return Device.objects.create(
            tenant=tenant or self.tenant, name=name, site=site or self.site_a,
            serial_number=serial, warranty_end=warranty_end, device_type=dtype,
        )

    def contract(self, number, end=None, mfr=None, tenant=None, devices=(), **kw):
        c = SupportContract.objects.create(
            tenant=tenant or self.tenant, manufacturer=mfr or self.mfr,
            contract_number=number, end_date=end, **kw,
        )
        for d in devices:
            SupportCoverage.objects.create(tenant=c.tenant, contract=c, device=d)
        return c

    def rows(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        return body["results"] if isinstance(body, dict) and "results" in body else body

    def names(self, url):
        return sorted(r["name"] for r in self.rows(url))


# ─── derived status on devices ───────────────────────────────────────────────


class DeviceStatusTests(_Base):
    def test_best_of_contracts_and_warranty(self):
        none = self.device("none")
        warranty = self.device("warranty", warranty_end=days(400))
        expired = self.device("expired")
        self.contract("OLD", end=days(-10), devices=[expired])
        mixed = self.device("mixed", warranty_end=days(10))
        self.contract("LONG", end=days(500), devices=[mixed])
        open_ended = self.device("open")
        self.contract("OPEN", end=None, devices=[open_ended])

        by_name = {r["name"]: r["coverage"] for r in self.rows("/api/devices/")}
        self.assertEqual(by_name["none"], {"status": "none", "end": None, "contracts": 0})
        self.assertEqual(by_name["warranty"]["status"], "covered")
        self.assertEqual(by_name["warranty"]["end"], str(days(400)))
        self.assertEqual(by_name["expired"]["status"], "expired")
        self.assertEqual(by_name["mixed"]["status"], "covered")
        self.assertEqual(by_name["mixed"]["end"], str(days(500)))
        self.assertEqual(by_name["open"], {"status": "covered", "end": None, "contracts": 1})
        del none, warranty

    def test_filter_buckets(self):
        self.device("none")
        self.device("soon", warranty_end=days(0))
        self.device("edge", warranty_end=days(90))
        self.device("fine", warranty_end=days(91))
        self.device("gone", warranty_end=days(-1))
        self.assertEqual(self.names("/api/devices/?coverage=none"), ["none"])
        self.assertEqual(self.names("/api/devices/?coverage=expiring"), ["edge", "soon"])
        self.assertEqual(self.names("/api/devices/?coverage=covered"), ["fine"])
        self.assertEqual(self.names("/api/devices/?coverage=expired"), ["gone"])
        self.assertEqual(
            self.names("/api/devices/?coverage=expired,none"), ["gone", "none"]
        )
        r = self.client.get("/api/devices/?coverage=bogus")
        self.assertEqual(r.status_code, 400)

    def test_tenant_window_setting(self):
        self.device("d", warranty_end=days(60))
        self.assertEqual(self.names("/api/devices/?coverage=expiring"), ["d"])
        TenantSettings.objects.create(tenant=self.tenant, coverage_warning_days=30)
        self.assertEqual(self.names("/api/devices/?coverage=covered"), ["d"])
        self.assertEqual(self.rows("/api/devices/")[0]["coverage"]["status"], "covered")

    def test_support_contract_filter(self):
        a, b = self.device("a"), self.device("b")
        c = self.contract("C1", end=days(100), devices=[a])
        self.contract("C2", end=days(100), devices=[b])
        self.assertEqual(self.names(f"/api/devices/?support_contract={c.id}"), ["a"])

    def test_warranty_end_is_writable(self):
        d = self.device("w")
        r = self.client.patch(
            f"/api/devices/{d.id}/", {"warranty_end": str(days(30))}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["coverage"]["status"], "expiring")
        d.refresh_from_db()
        self.assertEqual(d.warranty_end, days(30))

    def test_list_query_count_is_flat(self):
        def count(n):
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(f"/api/devices/?page_size={n}")
            self.assertEqual(r.status_code, 200)
            return len(ctx.captured_queries)

        for i in range(12):
            d = self.device(f"d{i:02}", warranty_end=days(i * 30 - 60))
            self.contract(f"K{i}", end=days(i), devices=[d])
        self.assertEqual(count(3), count(12))


# ─── contracts API ───────────────────────────────────────────────────────────


class ContractApiTests(_Base):
    url = "/api/support-contracts/"

    def payload(self, **kw):
        body = {
            "manufacturer_id": str(self.mfr.id), "contract_number": "CON-1",
            "service_level": "24x7x4", "start_date": str(days(-10)),
            "end_date": str(days(400)), "reseller": "Partner A/S",
            "cost": "1200.50", "currency": "eur",
            "portal_url": "https://support.example.com/c/1",
        }
        body.update(kw)
        return body

    def test_create_read_update_delete(self):
        r = self.client.post(self.url, self.payload(), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["state"], "active")
        self.assertEqual(body["currency"], "EUR")
        self.assertEqual(body["cost"], 1200.5)
        self.assertEqual(body["manufacturer"]["name"], "Cisco")
        self.assertEqual(body["device_count"], 0)
        self.assertIsNotNone(body["numid"])
        cid = body["id"]
        r = self.client.patch(f"{self.url}{cid}/", {"end_date": str(days(5))}, format="json")
        self.assertEqual(r.json()["state"], "expiring")
        self.assertTrue(
            ChangeLogEntry.objects.filter(object_id=cid, action="update").exists()
        )
        self.assertEqual(self.client.delete(f"{self.url}{cid}/").status_code, 204)

    def test_validation(self):
        cases = [
            ({"end_date": str(days(-20))}, "end_date"),
            ({"currency": "EURO"}, "currency"),
            ({"currency": ""}, "currency"),
            ({"portal_url": "not a url"}, "portal_url"),
            ({"contract_number": "  "}, "contract_number"),
            ({"cost": "-1"}, "cost"),
        ]
        for extra, field in cases:
            with self.subTest(field=field, extra=extra):
                r = self.client.post(self.url, self.payload(**extra), format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(field, r.json())

    def test_number_unique_per_manufacturer(self):
        self.contract("CON-1")
        r = self.client.post(self.url, self.payload(contract_number="con-1"), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("contract_number", r.json())
        r = self.client.post(
            self.url, self.payload(manufacturer_id=str(self.mfr2.id)), format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)

    def test_state_filter_and_device_count(self):
        d = self.device("d")
        self.contract("A", end=days(200), devices=[d])
        self.contract("E", end=days(10))
        self.contract("X", end=days(-1))
        self.contract("O", end=None)

        def numbers(q):
            return sorted(r["contract_number"] for r in self.rows(f"{self.url}?{q}"))

        self.assertEqual(numbers("state=active"), ["A", "O"])
        self.assertEqual(numbers("state=expiring"), ["E"])
        self.assertEqual(numbers("state=expired"), ["X"])
        self.assertEqual(numbers(f"device={d.id}"), ["A"])
        self.assertEqual(numbers("search=Cisco"), ["A", "E", "O", "X"])
        self.assertEqual(self.client.get(f"{self.url}?state=nope").status_code, 400)
        a = next(r for r in self.rows(self.url) if r["contract_number"] == "A")
        self.assertEqual(a["device_count"], 1)

    def test_tenant_isolation(self):
        other_mfr = Manufacturer.objects.create(tenant=self.other, name="X", slug="x")
        theirs = self.contract("THEIRS", mfr=other_mfr, tenant=self.other)
        self.assertEqual(self.rows(self.url), [])
        self.assertEqual(self.client.get(f"{self.url}{theirs.id}/").status_code, 404)
        r = self.client.post(
            self.url, self.payload(manufacturer_id=str(other_mfr.id)), format="json"
        )
        self.assertEqual(r.status_code, 400)
        their_channel = NotificationChannel.objects.create(
            tenant=self.other, name="theirs", kind="webhook"
        )
        r = self.client.post(
            self.url, self.payload(notify_channel_ids=[str(their_channel.id)]), format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_channels_and_tags(self):
        ch = NotificationChannel.objects.create(tenant=self.tenant, name="ops", kind="webhook")
        tag = Tag.objects.create(tenant=self.tenant, name="prod", slug="prod")
        r = self.client.post(
            self.url,
            self.payload(notify_channel_ids=[str(ch.id)], tag_ids=[tag.id]),
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["notify_channels"], [{"id": str(ch.id), "name": "ops"}])
        self.assertEqual([t["slug"] for t in r.json()["tags"]], ["prod"])

    def test_manufacturer_in_use_is_protected(self):
        self.contract("C")
        r = self.client.delete(f"/api/manufacturers/{self.mfr.id}/")
        self.assertIn(r.status_code, (400, 409))
        self.assertTrue(Manufacturer.objects.filter(pk=self.mfr.pk).exists())

    def test_deleting_a_device_drops_its_coverage(self):
        d = self.device("d")
        c = self.contract("C", end=days(10), devices=[d])
        d.delete()
        self.assertEqual(c.coverage.count(), 0)


# ─── coverage rows ───────────────────────────────────────────────────────────


class CoverageApiTests(_Base):
    def bulk_add(self, contract, **body):
        return self.client.post(
            "/api/support-coverage/bulk-add/",
            {"contract_id": str(contract.id), **body}, format="json",
        )

    def test_add_by_ids_and_existing_is_counted(self):
        a, b = self.device("a"), self.device("b")
        c = self.contract("C", end=days(100), devices=[a])
        r = self.bulk_add(c, device_ids=[str(a.id), str(b.id)])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 1)
        self.assertEqual(r.json()["existing"], 1)
        self.assertEqual(c.coverage.count(), 2)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.supportcoverage", action="create").exists())

    def test_add_by_serials(self):
        a = self.device("a", serial="FOC1234X")
        self.device("b", serial="dup-1")
        self.device("c", serial="DUP-1")
        self.device("other", serial="ZZZ", tenant=self.other, site=Site.objects.create(
            tenant=self.other, name="S"))
        c = self.contract("C", end=days(100))
        r = self.bulk_add(c, serials="foc1234x\nFOC1234X, nothere; dup-1 ZZZ")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["created"], 1)
        self.assertEqual(body["matched"], 1)
        self.assertEqual(body["unmatched"], ["nothere", "ZZZ"])
        self.assertEqual(body["ambiguous"], ["dup-1"])
        self.assertEqual(list(c.coverage.values_list("device_id", flat=True)), [a.id])

    def test_add_needs_something(self):
        c = self.contract("C")
        self.assertEqual(self.bulk_add(c).status_code, 400)
        self.assertEqual(self.bulk_add(c, device_ids=["nope"]).status_code, 400)

    def test_foreign_tenant_rows_are_refused(self):
        other_site = Site.objects.create(tenant=self.other, name="S")
        theirs = self.device("theirs", tenant=self.other, site=other_site)
        c = self.contract("C")
        r = self.bulk_add(c, device_ids=[str(theirs.id)])
        self.assertEqual(r.status_code, 400)
        other_mfr = Manufacturer.objects.create(tenant=self.other, name="X", slug="x")
        their_contract = self.contract("T", mfr=other_mfr, tenant=self.other)
        mine = self.device("mine")
        r = self.bulk_add(their_contract, device_ids=[str(mine.id)])
        self.assertEqual(r.status_code, 404)
        r = self.client.post("/api/support-coverage/", {
            "contract_id": str(their_contract.id), "device_id": str(mine.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(SupportCoverage.objects.count(), 0)

    def test_single_create_list_and_duplicate(self):
        d = self.device("d")
        c = self.contract("C")
        body = {"contract_id": str(c.id), "device_id": str(d.id)}
        r = self.client.post("/api/support-coverage/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.post("/api/support-coverage/", body, format="json")
        self.assertEqual(r.status_code, 400)
        rows = self.rows(f"/api/support-coverage/?contract={c.id}")
        self.assertEqual([x["device"]["name"] for x in rows], ["d"])
        self.assertEqual(
            self.client.patch(f"/api/support-coverage/{rows[0]['id']}/", {}).status_code, 405
        )

    def test_bulk_remove(self):
        a, b = self.device("a"), self.device("b")
        c = self.contract("C", devices=[a, b])
        r = self.client.post("/api/support-coverage/bulk-remove/", {
            "contract_id": str(c.id), "device_ids": [str(a.id)],
        }, format="json")
        self.assertEqual(r.json(), {"removed": 1})
        self.assertEqual(list(c.coverage.values_list("device_id", flat=True)), [b.id])


class CoverageRbacTests(_Base):
    """A site-limited grant covers the devices of its sites only; contracts
    are tenant-wide and need their own grant."""

    def setUp(self):
        super().setUp()
        self.user = User.objects.create_user("site-ed", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        self.a = self.device("a", site=self.site_a, serial="SA")
        self.b = self.device("b", site=self.site_b, serial="SB")
        self.c = self.contract("C", end=days(30))

    def grant(self, types, actions, sites=()):
        perm = ObjectPermission.objects.create(
            name="g", object_types=list(types), actions=list(actions)
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        return perm

    def test_contracts_are_default_closed(self):
        self._login(self.user)
        self.assertEqual(self.client.get("/api/support-contracts/").status_code, 403)
        self.assertEqual(self.client.get("/api/support-coverage/").status_code, 403)
        r = self.client.post("/api/support-coverage/bulk-add/", {
            "contract_id": str(self.c.id), "device_ids": [str(self.a.id)],
        }, format="json")
        self.assertEqual(r.status_code, 403)

    def test_a_hidden_contract_cannot_be_filtered_by(self):
        # Coverage rows by a contract the user can't see would answer for it;
        # the row's own name carries the device only.
        row = SupportCoverage.objects.create(tenant=self.tenant, contract=self.c, device=self.a)
        self.assertEqual(str(row), "Coverage of a")
        self.grant(["supportcoverage", "device"], ["view"])
        self._login(self.user)
        r = self.client.get(f"/api/support-coverage/?contract={self.c.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["count"], 0)
        self.grant(["supportcontract"], ["view"])
        r = self.client.get(f"/api/support-coverage/?contract={self.c.id}")
        self.assertEqual(r.json()["count"], 1)

    def test_site_editor_covers_their_sites_only(self):
        self.grant(["supportcontract", "device"], ["view"])
        self.grant(["supportcoverage"], ["view", "add", "delete"], sites=[self.site_a])
        self._login(self.user)
        r = self.client.post("/api/support-coverage/bulk-add/", {
            "contract_id": str(self.c.id), "serials": "SA SB",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 1)
        self.assertEqual(r.json()["unmatched"], ["SB"])
        r = self.client.post("/api/support-coverage/bulk-add/", {
            "contract_id": str(self.c.id), "device_ids": [str(self.b.id)],
        }, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/support-coverage/", {
            "contract_id": str(self.c.id), "device_id": str(self.b.id),
        }, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(
            list(self.c.coverage.values_list("device_id", flat=True)), [self.a.id]
        )
        # Rows at another site are neither listed nor removable.
        SupportCoverage.objects.create(tenant=self.tenant, contract=self.c, device=self.b)
        ids = {r["device"]["name"] for r in self.rows("/api/support-coverage/")}
        self.assertEqual(ids, {"a"})
        r = self.client.post("/api/support-coverage/bulk-remove/", {
            "contract_id": str(self.c.id), "device_ids": [str(self.b.id)],
        }, format="json")
        self.assertEqual(r.json(), {"removed": 0})

    def test_coverage_needs_sight_of_the_contract(self):
        self.grant(["device"], ["view"])
        self.grant(["supportcoverage"], ["view", "add"])
        self._login(self.user)
        r = self.client.post("/api/support-coverage/bulk-add/", {
            "contract_id": str(self.c.id), "device_ids": [str(self.a.id)],
        }, format="json")
        self.assertEqual(r.status_code, 404)
        r = self.client.post("/api/support-coverage/", {
            "contract_id": str(self.c.id), "device_id": str(self.a.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_device_card_hides_contracts_the_caller_cannot_see(self):
        SupportCoverage.objects.create(tenant=self.tenant, contract=self.c, device=self.a)
        self.grant(["device"], ["view"])
        self._login(self.user)
        r = self.client.get(f"/api/devices/{self.a.id}/coverage/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["status"], "expiring")
        self.assertEqual(body["contracts"], [])
        self.assertEqual(body["hidden_contracts"], 1)
        summary = self.client.get("/api/devices/coverage-summary/").json()
        self.assertEqual(summary["ending"], [])
        self.assertEqual(summary["total"], 2)

    def test_coverage_start_only_from_a_contract_the_caller_sees(self):
        # The bar's start is the governing contract's start (#436): a hidden
        # contract's dates stay hidden, its end still governs the status.
        self.c.start_date = days(-300)
        self.c.save()
        SupportCoverage.objects.create(tenant=self.tenant, contract=self.c, device=self.a)
        self.grant(["device"], ["view"])
        self._login(self.user)
        body = self.client.get(f"/api/devices/{self.a.id}/coverage/").json()
        self.assertEqual((body["start"], body["end"]), (None, str(days(30))))
        self.grant(["supportcontract"], ["view"])
        body = self.client.get(f"/api/devices/{self.a.id}/coverage/").json()
        self.assertEqual(body["start"], str(days(-300)))


# ─── device card, flags and the dashboard summary ────────────────────────────


class DeviceCardTests(_Base):
    def test_contracts_best_first_and_flags(self):
        old_hw = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, name="Old", end_of_support=days(-5)
        )
        new_hw = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, name="New", end_of_support=days(200)
        )
        d_old = self.device("old", dtype=old_hw, warranty_end=days(-400))
        d_new = self.device("new", dtype=new_hw)
        self.contract("SHORT", end=days(20), devices=[d_old, d_new])
        self.contract("LONG", end=days(365), devices=[d_new])

        body = self.client.get(f"/api/devices/{d_new.id}/coverage/").json()
        self.assertEqual([c["contract_number"] for c in body["contracts"]], ["LONG", "SHORT"])
        self.assertEqual(body["status"], "covered")
        self.assertEqual([f["code"] for f in body["flags"]], ["contract_after_eol"])

        body = self.client.get(f"/api/devices/{d_old.id}/coverage/").json()
        self.assertEqual(body["status"], "expiring")
        self.assertEqual(body["warranty_end"], str(days(-400)))
        self.assertEqual([f["code"] for f in body["flags"]], ["eol_under_contract"])

    def test_no_flags_without_vendor_dates(self):
        d = self.device("d")
        self.contract("C", end=days(20), devices=[d])
        self.assertEqual(self.client.get(f"/api/devices/{d.id}/coverage/").json()["flags"], [])

    def test_coverage_start_is_the_governing_contracts(self):
        """The coverage bar runs from the start of the contract that sets the
        end (#436); a warranty that reaches further has no start."""
        d = self.device("d", warranty_end=days(100))
        self.contract("SHORT", start_date=days(-50), end=days(20), devices=[d])
        self.contract("LONG", start_date=days(-200), end=days(300), devices=[d])
        body = self.client.get(f"/api/devices/{d.id}/coverage/").json()
        self.assertEqual((body["start"], body["end"]), (str(days(-200)), str(days(300))))

        w = self.device("w", warranty_end=days(400))
        self.contract("UNDER", start_date=days(-10), end=days(30), devices=[w])
        body = self.client.get(f"/api/devices/{w.id}/coverage/").json()
        self.assertEqual((body["start"], body["end"]), (None, str(days(400))))

        o = self.device("o", warranty_end=days(400))
        self.contract("OPEN", start_date=days(-5), devices=[o])
        body = self.client.get(f"/api/devices/{o.id}/coverage/").json()
        self.assertEqual((body["status"], body["start"], body["end"]),
                         ("covered", str(days(-5)), None))
        self.assertEqual(cov.governed_by(None, None), None)
        self.assertEqual(cov.governed_by(days(5), days(5)), "contract")
        self.assertEqual(cov.governed_by(days(4), days(5)), "warranty")

    def test_summary_counts_filters_and_ending(self):
        cisco = DeviceType.objects.create(tenant=self.tenant, manufacturer=self.mfr, name="C")
        juniper = DeviceType.objects.create(tenant=self.tenant, manufacturer=self.mfr2, name="J")
        a = self.device("a", dtype=cisco)
        b = self.device("b", dtype=cisco, site=self.site_b, warranty_end=days(-3))
        self.device("c", dtype=juniper)
        self.contract("SOON", end=days(5), devices=[a])
        self.contract("LATER", end=days(300), mfr=self.mfr2)
        self.contract("PAST", end=days(-1), devices=[b])

        r = self.client.get("/api/devices/coverage-summary/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["counts"], {"covered": 0, "expiring": 1, "expired": 1, "none": 1})
        self.assertEqual(body["total"], 3)
        self.assertEqual(body["warning_days"], 90)
        self.assertEqual([c["contract_number"] for c in body["ending"]], ["SOON", "LATER"])
        self.assertEqual(body["ending"][0]["device_count"], 1)

        body = self.client.get(
            f"/api/devices/coverage-summary/?manufacturer={self.mfr.id}"
        ).json()
        self.assertEqual(body["counts"]["none"], 0)
        self.assertEqual([c["contract_number"] for c in body["ending"]], ["SOON"])
        body = self.client.get(f"/api/devices/coverage-summary/?site={self.site_b.id}").json()
        self.assertEqual(body["counts"], {"covered": 0, "expiring": 0, "expired": 1, "none": 0})
        self.assertEqual(body["ending"], [])


# ─── notifications and the digest ────────────────────────────────────────────


class NotifyTests(_Base):
    def setUp(self):
        super().setUp()
        self.ch = NotificationChannel.objects.create(
            tenant=self.tenant, name="ops", kind="webhook", config={"url": "https://x.test/"}
        )

    def run_notify(self, now=None):
        with mock.patch("monitoring.notify.notify_plain") as sent:
            n = cov.notify_contracts(now=now)
        return n, sent

    def test_each_state_is_announced_once(self):
        c = self.contract("C", end=days(30))
        c.notify_channels.add(self.ch)
        n, sent = self.run_notify()
        self.assertEqual(n, 1)
        self.assertEqual(sent.call_count, 1)
        _ch, subject, text, payload = sent.call_args.args
        self.assertIn("expiring", subject)
        self.assertIn("C", text)
        self.assertEqual(payload["state"], "expiring")
        # A second run sends nothing new.
        n, sent = self.run_notify()
        self.assertEqual((n, sent.call_count), (0, 0))
        # Expired is a new state: announced once more.
        c.end_date = days(-1)
        c.save()
        n, sent = self.run_notify()
        self.assertEqual(n, 1)
        self.assertEqual(sent.call_args.args[3]["severity"], "critical")
        n, sent = self.run_notify()
        self.assertEqual(n, 0)

    def test_renewal_resets_quietly(self):
        c = self.contract("C", end=days(10))
        c.notify_channels.add(self.ch)
        self.run_notify()
        c.end_date = days(400)
        c.save()
        n, sent = self.run_notify()
        self.assertEqual((n, sent.call_count), (0, 0))
        c.refresh_from_db()
        self.assertEqual(c.notified_state, "")
        c.end_date = days(5)
        c.save()
        n, _ = self.run_notify()
        self.assertEqual(n, 1)

    def test_no_channels_no_send_and_active_is_quiet(self):
        self.contract("NOCH", end=days(10))
        self.contract("FAR", end=days(400)).notify_channels.add(self.ch)
        self.contract("OPEN", end=None).notify_channels.add(self.ch)
        n, sent = self.run_notify()
        self.assertEqual((n, sent.call_count), (0, 0))
        self.assertEqual(
            SupportContract.objects.get(contract_number="NOCH").notified_state, "expiring"
        )

    def test_disabled_channel_is_skipped(self):
        self.ch.enabled = False
        self.ch.save()
        self.contract("C", end=days(10)).notify_channels.add(self.ch)
        n, sent = self.run_notify()
        self.assertEqual(sent.call_count, 0)

    def test_notified_state_is_not_writable(self):
        c = self.contract("C", end=days(10))
        r = self.client.patch(
            f"/api/support-contracts/{c.id}/", {"notified_state": "expired"}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        c.refresh_from_db()
        self.assertEqual(c.notified_state, "")

    def test_digest_section(self):
        from monitoring.digest import build_digest, render_html, render_text

        self.contract("SOON", end=days(10))
        self.contract("PAST", end=days(-3))
        self.contract("LONGAGO", end=days(-90))
        self.contract("FAR", end=days(400))
        summary = cov.digest_summary(self.tenant)
        self.assertEqual(summary["expiring"], 1)
        self.assertEqual(summary["expired_recently"], 1)
        self.assertEqual([r["contract_number"] for r in summary["rows"]], ["PAST", "SOON"])
        d = build_digest(self.tenant, timezone.now() - timedelta(days=1))
        self.assertIn("SOON", render_text(d))
        self.assertIn("Support contracts", render_html(d, "Danbyte"))


# ─── compliance ──────────────────────────────────────────────────────────────


class ComplianceCoverageTests(_Base):
    url = "/api/compliance-rules/"

    def test_rule_validation(self):
        base = {"name": "r", "check_type": "coverage", "severity": "warning"}
        r = self.client.post(self.url, {**base, "object_type": "prefix",
                                        "coverage_fail_on": "expired"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("object_type", r.json())
        r = self.client.post(self.url, {**base, "object_type": "device"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("coverage_fail_on", r.json())
        r = self.client.post(self.url, {**base, "object_type": "device",
                                        "coverage_fail_on": "expiring"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_evaluate(self):
        prod = Tag.objects.create(tenant=self.tenant, name="prod", slug="prod")
        bare = self.device("bare")
        soon = self.device("soon", warranty_end=days(10))
        fine = self.device("fine")
        self.contract("C", end=days(500), devices=[fine])
        lab = self.device("lab")
        bare.tags.add(prod)
        soon.tags.add(prod)
        strict = ComplianceRule.objects.create(
            tenant=self.tenant, name="strict", object_type="device",
            check_type="coverage", coverage_fail_on="expiring",
        )
        prod_only = ComplianceRule.objects.create(
            tenant=self.tenant, name="prod", object_type="device",
            check_type="coverage", coverage_fail_on="expired", tag="prod",
        )
        result = evaluate(self.tenant)
        failing = {}
        for v in result["violations"]:
            failing.setdefault(v["rule_name"], set()).add(v["object_repr"])
        self.assertEqual(failing["strict"], {"bare", "soon", "lab"})
        self.assertEqual(failing["prod"], {"bare"})
        self.assertEqual(
            [r.name for r in evaluate_for_object(self.tenant, "device", soon)], ["strict"]
        )
        self.assertEqual(
            sorted(r.name for r in evaluate_for_object(self.tenant, "device", bare)),
            ["prod", "strict"],
        )
        self.assertEqual(evaluate_for_object(self.tenant, "device", fine), [])
        del lab, strict, prod_only


# ─── import / export ─────────────────────────────────────────────────────────


def _csv(resp) -> str:
    content = b"".join(resp.streaming_content) if resp.streaming else resp.content
    return content.decode().lstrip("﻿")


class ImportExportTests(_Base):
    def test_contract_round_trip(self):
        self.contract("RT-1", end=days(100), service_level="8x5xNBD")
        text = _csv(self.client.get("/api/io/supportcontract/export/?fmt=csv"))
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual(rows[0]["contract_number"], "RT-1")
        self.assertEqual(rows[0]["manufacturer"], "Cisco")
        r = self.client.post("/api/io/supportcontract/import/",
                             {"format": "csv", "content": text}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["created"], r.json()["errors"]), (0, []))

    def test_contract_create_by_import(self):
        content = (
            "contract_number,manufacturer,service_level,end_date\n"
            "NEW-1,Juniper,24x7x4,2030-01-31\n"
        )
        r = self.client.post("/api/io/supportcontract/import/",
                             {"format": "csv", "content": content}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 1, r.json())
        c = SupportContract.objects.get(contract_number="NEW-1")
        self.assertEqual((c.manufacturer, str(c.end_date)), (self.mfr2, "2030-01-31"))

    def test_coverage_import_by_number_and_device(self):
        d = self.device("edge-01")
        c = self.contract("CV-9", end=days(100))
        content = "contract,device\nCV-9,edge-01\n"
        r = self.client.post("/api/io/supportcoverage/import/",
                             {"format": "csv", "content": content}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 1, r.json())
        self.assertTrue(SupportCoverage.objects.filter(contract=c, device=d).exists())
        text = _csv(self.client.get("/api/io/supportcoverage/export/?fmt=csv"))
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual((rows[0]["contract"], rows[0]["device"]), ("CV-9", "edge-01"))


class SiteRoleUpgradeTests(TestCase):
    """auth_api 0030 gives site roles built before #421 the coverage type,
    and their catalog reads the contracts."""

    def test_roles_gain_coverage_and_hand_built_grants_do_not(self):
        import importlib

        from django.apps import apps as django_apps

        from auth_api.site_paths import site_role_types

        mig = importlib.import_module("auth_api.migrations.0030_site_roles_support_coverage")
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        site = Site.objects.create(tenant=tenant, name="A")
        # The roles as 0030 found them: no type a later migration added.
        old_types = sorted((set(site_role_types()) & mig.KNOWN) - {"supportcoverage"})

        def grant(name, types, actions):
            perm = ObjectPermission.objects.create(
                name=name, object_types=types, actions=actions
            )
            perm.tenants.set([tenant])
            perm.sites.set([site])
            return perm

        edit = grant("A - site edit", old_types, ["view", "add", "change", "delete"])
        view = grant("A - site view", ["site", *old_types], ["view"])
        # A viewer as 0029 left it, with the catalogs, and a silo editor's
        # catalog grant.
        catalogs = list(mig._0029.ROLE_CATALOGS)
        view_0029 = grant("B - site view", ["site", *old_types, *catalogs], ["view"])
        catalog = grant("A - catalog view", catalogs, ["view"])
        custom = grant("Ops - site view", ["device", "prefix"], ["view"])
        mig.forwards(django_apps, None)
        mig.forwards(django_apps, None)
        for perm in (edit, view, view_0029, catalog, custom):
            perm.refresh_from_db()
        for perm in (view, view_0029):
            self.assertIn("supportcoverage", perm.object_types)
            self.assertEqual(perm.object_types.count("supportcontract"), 1)
        self.assertEqual(catalog.object_types.count("supportcontract"), 1)
        self.assertNotIn("supportcoverage", catalog.object_types)
        self.assertNotIn("supportcontract", edit.object_types)
        self.assertEqual(edit.object_types.count("supportcoverage"), 1)
        self.assertIn("supportcoverage", view.object_types)
        self.assertEqual(custom.object_types, ["device", "prefix"])


class TenantSettingTests(TestCase):
    def test_default_without_a_row(self):
        from core.effective_settings import coverage_warning_days

        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.assertEqual(coverage_warning_days(tenant), 90)
        self.assertFalse(TenantSettings.objects.filter(tenant=tenant).exists())

    def test_written_through_the_api(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = User.objects.create_superuser("ts", password="x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        r = self.client.put("/api/tenant-settings/", {"coverage_warning_days": 30},
                            content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["coverage_warning_days"], 30)
        for bad in (0, 731):
            r = self.client.put("/api/tenant-settings/", {"coverage_warning_days": bad},
                                content_type="application/json")
            self.assertEqual(r.status_code, 400)
