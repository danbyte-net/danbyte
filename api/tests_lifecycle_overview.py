"""The Lifecycle page's endpoint (#436): ``GET /api/lifecycle/`` - one row per
object per source, the fixed windows, the effective OS date, coverage by its
governing contract, tenant isolation, RBAC per source and a query count that
does not grow with the fleet."""
from __future__ import annotations

from datetime import date, timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.lifecycle_api import window_of
from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    Manufacturer,
    Platform,
    Site,
    SupportContract,
    SupportCoverage,
    VirtualMachine,
)
from auth_api.models import ObjectPermission, UserProfile
from compliance.models import EolMapping, EolSettings
from core.models import Organization, Tag, Tenant

TODAY = date(2026, 6, 15)
URL = "/api/lifecycle/"


def d(n: int) -> date:
    return TODAY + timedelta(days=n)


class _Base(APITestCase):
    def setUp(self):
        frozen = mock.patch("django.utils.timezone.localdate", return_value=TODAY)
        frozen.start()
        self.addCleanup(frozen.stop)
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Core", slug="core", color="#ff0000")
        ctype = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="C", type=ctype)
        self.admin = User.objects.create_superuser("lc-root", password="x")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def dtype(self, name, release=None, end=None, tenant=None):
        return DeviceType.objects.create(
            tenant=tenant or self.tenant, name=name, manufacturer=None if tenant else self.mfr,
            release_date=release, end_of_support=end)

    def platform(self, name, release=None, end=None):
        return Platform.objects.create(
            tenant=self.tenant, name=name, slug=name.lower(), release_date=release,
            end_of_support=end)

    def device(self, name, dtype=None, platform=None, site=None, warranty=None, tenant=None):
        return Device.objects.create(
            tenant=tenant or self.tenant, name=name, device_type=dtype, platform=platform,
            site=site if site is not None else (None if tenant else self.site_a),
            role=None if tenant else self.role, warranty_end=warranty)

    def vm(self, name, platform=None, site=None):
        return VirtualMachine.objects.create(
            tenant=self.tenant, name=name, cluster=self.cluster, platform=platform, site=site)

    def contract(self, number, devices, start=None, end=None):
        c = SupportContract.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, contract_number=number,
            start_date=start, end_date=end)
        for dev in devices:
            SupportCoverage.objects.create(tenant=self.tenant, contract=c, device=dev)
        return c

    def get(self, **params):
        r = self.client.get(URL, params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def rows(self, **params):
        return {(r["object"]["name"], r["source"]): r for r in self.get(**params)["results"]}


class WindowTests(_Base):
    def test_the_fixed_buckets(self):
        self.assertEqual(window_of(None, False), "none")
        self.assertEqual(window_of(None, False, "later"), "later")
        self.assertEqual(window_of(0, True), "past")
        self.assertEqual(window_of(90, False), "d90")
        self.assertEqual(window_of(91, False), "d180")
        self.assertEqual(window_of(180, False), "d180")
        self.assertEqual(window_of(365, False), "y1")
        self.assertEqual(window_of(366, False), "later")

    def test_hardware_day_boundaries(self):
        for name, end in (("today", d(0)), ("edge", d(180)), ("past-edge", d(181)),
                          ("ago", d(-10)), ("d90", d(90)), ("later", d(400))):
            self.device(name, self.dtype(f"T-{name}", release=d(-1000), end=end))
        rows = self.rows()
        got = {name: (r["status"], r["window"], r["days_left"])
               for (name, source), r in rows.items() if source == "hardware"}
        self.assertEqual(got, {
            # An end of life is reached on its day.
            "today": ("eol", "past", 0),
            "ago": ("eol", "past", -10),
            "d90": ("ending", "d90", 90),
            # The end-of-life window (180 days by default) is hardware's too.
            "edge": ("ending", "d180", 180),
            "past-edge": ("supported", "y1", 181),
            "later": ("supported", "later", 400),
        })
        row = rows[("d90", "hardware")]
        self.assertEqual(row["item"], {
            "type": "devicetype", "id": str(row["item"]["id"]), "name": "T-d90"})
        self.assertEqual((row["start"], row["end"]), (str(d(-1000)), str(d(90))))
        self.assertEqual(row["object"]["kind"], "device")
        self.assertEqual(row["site"]["name"], "A")
        self.assertEqual(row["role"], {
            "id": str(self.role.id), "name": "Core", "color": "#ff0000"})
        self.assertEqual(row["manufacturer"]["name"], "Cisco")
        self.assertEqual(row["tenant"], {"id": str(self.tenant.id), "name": "Acme"})

    def test_sorted_by_days_left_and_counted(self):
        self.device("late", self.dtype("L", end=d(500)))
        self.device("soon", self.dtype("S", end=d(20)))
        self.device("gone", self.dtype("G", end=d(-30)))
        body = self.get(source="hardware")
        self.assertEqual([r["object"]["name"] for r in body["results"]], ["gone", "soon", "late"])
        self.assertEqual(body["counts"], {
            "past": 1, "d90": 1, "d180": 0, "y1": 0, "later": 1, "none": 0})
        self.assertEqual(body["windows"], {"eol_warning_days": 180, "coverage_warning_days": 90})
        self.assertFalse(body["eol_enabled"])


class CoverageTests(_Base):
    def test_the_last_covered_day_is_not_past(self):
        self.device("today", warranty=d(0))
        self.device("gone", warranty=d(-1))
        rows = self.rows(source="coverage")
        self.assertEqual(
            (rows[("today", "coverage")]["status"], rows[("today", "coverage")]["window"]),
            ("expiring", "d90"))
        self.assertEqual(
            (rows[("gone", "coverage")]["status"], rows[("gone", "coverage")]["window"]),
            ("expired", "past"))

    def test_the_governing_contract_or_the_warranty(self):
        a = self.device("contract", warranty=d(10))
        b = self.device("warranty", warranty=d(400))
        c = self.device("open")
        self.contract("SHORT", [a, b], start=d(-50), end=d(20))
        long = self.contract("LONG", [a], start=d(-300), end=d(300))
        self.contract("FOREVER", [c], start=d(-5))
        rows = self.rows(source="coverage")
        row = rows[("contract", "coverage")]
        self.assertEqual(row["item"], {
            "type": "supportcontract", "id": str(long.id), "name": "LONG"})
        self.assertEqual((row["start"], row["end"], row["status"]),
                         (str(d(-300)), str(d(300)), "covered"))
        row = rows[("warranty", "coverage")]
        self.assertEqual(row["item"], {"type": "warranty", "id": None, "name": "Warranty"})
        self.assertEqual((row["start"], row["end"]), (None, str(d(400))))
        # Open-ended: covered, no date to count to, but not undated.
        row = rows[("open", "coverage")]
        self.assertEqual((row["status"], row["end"], row["days_left"], row["window"]),
                         ("covered", None, None, "later"))

    def test_not_covered_is_undated(self):
        self.device("bare")
        body = self.get(source="coverage")
        self.assertEqual(body["results"], [])
        self.assertEqual(body["counts"]["none"], 1)
        rows = self.rows(source="coverage", undated="1")
        self.assertEqual(rows[("bare", "coverage")]["status"], "none")
        self.assertIsNone(rows[("bare", "coverage")]["item"])


class OsTests(_Base):
    def setUp(self):
        super().setUp()
        self.mapped = self.platform("Ubuntu")
        EolMapping.objects.create(
            tenant=self.tenant, platform=self.mapped, source="endoflife_date",
            product="ubuntu", cycle="22.04", release_date=d(-1500), eol_date=d(30),
            synced_at=timezone.now())

    def enable(self, on=True):
        row = EolSettings.load()
        row.enabled = on
        row.save()

    def test_mapping_dates_only_while_eol_data_is_on(self):
        self.device("dev", platform=self.mapped)
        self.vm("vm", platform=self.mapped)
        body = self.get(source="os")
        self.assertEqual(body["results"], [])
        self.assertEqual(body["counts"]["none"], 2)
        self.enable()
        rows = self.rows(source="os")
        for key in (("dev", "os"), ("vm", "os")):
            row = rows[key]
            self.assertEqual((row["start"], row["end"]), (str(d(-1500)), str(d(30))))
            self.assertEqual((row["status"], row["window"]), ("ending", "d90"))
            self.assertEqual(row["item"]["date_source"], "endoflife_date")
        self.assertEqual(rows[("vm", "os")]["object"]["kind"], "virtualmachine")
        self.assertIsNone(rows[("vm", "os")]["manufacturer"])

    def test_entered_dates_win(self):
        self.enable()
        self.mapped.end_of_support = d(700)
        self.mapped.save()
        self.device("dev", platform=self.mapped)
        row = self.rows(source="os")[("dev", "os")]
        self.assertEqual((row["start"], row["end"]), (str(d(-1500)), str(d(700))))
        self.assertEqual(row["item"]["date_source"], "entered")
        self.assertEqual(row["status"], "supported")

    def test_end_of_life_without_a_date_is_past(self):
        self.enable()
        flagged = self.platform("Legacy")
        EolMapping.objects.create(
            tenant=self.tenant, platform=flagged, source="endoflife_date",
            product="legacy", cycle="1", eol_reached=True, synced_at=timezone.now())
        self.device("old", platform=flagged)
        row = self.rows(source="os")[("old", "os")]
        self.assertEqual((row["status"], row["end"], row["window"]), ("eol", None, "past"))

    def test_unknown_sources_and_sites_are_refused(self):
        self.assertEqual(self.client.get(URL, {"source": "os,bogus"}).status_code, 400)
        self.assertEqual(self.client.get(URL, {"site": "nope"}).status_code, 400)
        # Installed software is still to come: accepted, lists nothing.
        self.assertEqual(self.get(source="application")["results"], [])


class ScopeTests(_Base):
    def setUp(self):
        super().setUp()
        self.dt = self.dtype("T", end=d(100))
        self.plat = self.platform("P", end=d(50))
        self.at_a = self.device("at-a", self.dt, self.plat, site=self.site_a, warranty=d(60))
        self.at_b = self.device("at-b", self.dt, self.plat, site=self.site_b, warranty=d(60))
        self.contract("SECRET", [self.at_a], start=d(-10), end=d(70))
        self.vm("vm-a", self.plat, site=self.site_a)
        # Another tenant's fleet, all of it ending soon.
        theirs = self.dtype("Theirs", end=d(5), tenant=self.other)
        Device.objects.create(tenant=self.other, name="foreign", device_type=theirs,
                              warranty_end=d(5))
        self.user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def grant(self, types, sites=()):
        p = ObjectPermission.objects.create(
            name="-".join(types), object_types=list(types), actions=["view"])
        p.users.add(self.user)
        p.tenants.add(self.tenant)
        if sites:
            p.sites.set(sites)

    def names(self, **params):
        return sorted({(r["object"]["name"], r["source"]) for r in self.get(**params)["results"]})

    def test_another_tenants_objects_never_appear(self):
        self.assertNotIn("foreign", {n for n, _ in self.names()})

    def test_sources_follow_the_grants(self):
        self.login(self.user)
        self.assertEqual(self.get()["results"], [])
        self.grant(["virtualmachine"])
        self.assertEqual(self.names(), [("vm-a", "os")])
        self.grant(["device"])
        self.assertEqual(self.names(), [
            ("at-a", "coverage"), ("at-a", "hardware"), ("at-a", "os"),
            ("at-b", "coverage"), ("at-b", "hardware"), ("at-b", "os"), ("vm-a", "os")])

    def test_a_site_limited_grant_sees_its_sites(self):
        self.grant(["device"], sites=[self.site_a])
        self.login(self.user)
        self.assertEqual({n for n, _ in self.names()}, {"at-a"})
        self.assertEqual({n for n, _ in self.names(site=str(self.site_b.id))}, set())

    def test_a_hidden_contract_shows_no_number(self):
        self.grant(["device"])
        self.login(self.user)
        row = self.rows(source="coverage")[("at-a", "coverage")]
        self.assertEqual(row["item"], {"type": "supportcontract", "id": None, "name": "Contract"})
        self.assertIsNone(row["start"])
        self.assertEqual(row["end"], str(d(70)))
        self.grant(["supportcontract"])
        row = self.rows(source="coverage")[("at-a", "coverage")]
        self.assertEqual(row["item"]["name"], "SECRET")
        self.assertEqual(row["start"], str(d(-10)))

    def test_site_and_source_narrow(self):
        self.assertEqual(self.names(site=str(self.site_b.id), source="hardware,os"),
                         [("at-b", "hardware"), ("at-b", "os")])

    def test_default_closed(self):
        self.client.logout()
        self.assertIn(self.client.get(URL).status_code, (401, 403))
        lonely = User.objects.create_user("lonely", password="x")
        self.client.force_login(lonely)
        self.assertEqual(self.client.get(URL).status_code, 403)


class QueryCountTests(_Base):
    """The page reads the fleet in a fixed number of queries (#436)."""

    def _fleet(self, n, start):
        tag = Tag.objects.get_or_create(tenant=self.tenant, name="prod", slug="prod")[0]
        dt = self.dtype(f"T{start}", release=d(-900), end=d(100))
        plat = self.platform(f"P{start}", end=d(200))
        EolMapping.objects.create(
            tenant=self.tenant, platform=plat, source="endoflife_date", product="x",
            cycle="1", eol_date=d(40), synced_at=timezone.now())
        devices = []
        for i in range(start, start + n):
            dev = self.device(f"dev-{i:03d}", dt, plat, warranty=d(i))
            dev.tags.add(tag)
            devices.append(dev)
            self.vm(f"vm-{i:03d}", plat)
        self.contract(f"C{start}", devices, start=d(-20), end=d(30))

    def _count(self):
        self.client.get(URL)
        with CaptureQueriesContext(connection) as ctx:
            body = self.get()
        return len(ctx.captured_queries), body

    def test_one_device_costs_what_two_hundred_cost(self):
        self._fleet(1, 0)
        one, body = self._count()
        self.assertEqual(len(body["results"]), 4)
        self._fleet(199, 1)
        many, body = self._count()
        self.assertEqual(len(body["results"]), 200 * 4)
        self.assertEqual(one, many)
        self.assertEqual(body["results"][0]["tags"][0]["slug"], "prod")
