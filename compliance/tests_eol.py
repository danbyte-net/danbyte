"""End-of-life data (#8): source parsing, the catalog cache and refresh
against an in-process fake endoflife.date, the SSRF guard, offline import,
platform mappings, list columns and filters, and compliance rules."""
from __future__ import annotations

import copy
import io
import json
import threading
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Manufacturer,
    Platform,
    Site,
    VirtualMachine,
)
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from . import eol
from .api import ComplianceRuleSerializer
from .engine import evaluate, evaluate_for_object
from .eol_sources import EolSourceError, get_source
from .models import ComplianceRule, EolMapping, EolProduct, EolSettings


def days(n: int) -> str:
    return (timezone.localdate() + timedelta(days=n)).isoformat()


def catalog() -> dict:
    """An endoflife.date ``/api/v1/products/full`` body."""
    return {
        "schema_version": "1.2.0",
        "total": 2,
        "result": [
            {
                "name": "ubuntu",
                "label": "Ubuntu",
                "category": "os",
                "aliases": ["ubuntu-linux"],
                "releases": [
                    {"name": "24.04", "label": "24.04 (LTS)",
                     "releaseDate": "2024-04-25", "isLts": True,
                     "eoasFrom": days(400), "eolFrom": days(900),
                     "isEol": False, "latest": {"name": "24.04.3"}},
                    {"name": "22.04", "label": "22.04 (LTS)",
                     "releaseDate": "2022-04-21", "isLts": True,
                     "eoasFrom": days(-100), "eolFrom": days(60),
                     "isEol": False, "latest": {"name": "22.04.5"}},
                    {"name": "18.04", "releaseDate": "2018-04-26",
                     "eolFrom": days(-500), "isEol": True,
                     "latest": {"name": "18.04.6"}},
                ],
            },
            {
                "name": "cisco-ios-xe",
                "label": "Cisco IOS XE",
                "category": "os",
                "aliases": [],
                "releases": [
                    {"name": "17.9", "releaseDate": "2022-08-01",
                     "eolFrom": None, "isEol": False, "latest": {"name": "17.9.6"}},
                    {"name": "16.12", "eolFrom": None, "isEol": None},
                ],
            },
        ],
    }


class FakeEndOfLife:
    """endoflife.date on 127.0.0.1, in this process."""

    def __init__(self):
        self.body = catalog()
        self.hits = 0
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                fake.hits += 1
                if self.path != "/api/v1/products/full":
                    self.send_response(404)
                    self.end_headers()
                    return
                raw = json.dumps(fake.body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def enable(url: str = "", warning_days: int = 180):
    row = EolSettings.load()
    row.enabled = True
    row.sources = ["endoflife_date"]
    row.source_urls = {"endoflife_date": url} if url else {}
    row.warning_days = warning_days
    row.save()
    return row


def allow_loopback():
    ds = DeploymentSettings.load()
    ds.ssrf_allowlist = ["127.0.0.1/32"]
    ds.save()


def load_catalog():
    eol.store_catalog("endoflife_date", get_source("endoflife_date").parse(catalog()))


class TenantMixin:
    def make_tenant(self, slug="t"):
        org = Organization.objects.create(name=slug.upper(), slug=slug)
        return Tenant.objects.create(org=org, name=slug.upper(), slug=slug)

    def map_platform(self, platform, product="ubuntu", cycle="22.04"):
        m = EolMapping(tenant=platform.tenant, platform=platform,
                       source="endoflife_date", product=product, cycle=cycle)
        eol.fill_mapping(m, EolProduct.objects.get(name=product))
        m.save()
        return m


# ─── parsing ─────────────────────────────────────────────────────────────────


class SourceParseTests(TestCase):
    def test_full_catalog_normalises_releases(self):
        products = get_source("endoflife_date").parse(catalog())
        ubuntu = products[0]
        self.assertEqual(ubuntu["name"], "ubuntu")
        r = ubuntu["releases"][1]
        self.assertEqual(r["name"], "22.04")
        self.assertEqual(r["support_until"], days(-100))
        self.assertEqual(r["eol_date"], days(60))
        self.assertEqual(r["latest"], "22.04.5")
        self.assertTrue(r["lts"])
        self.assertIs(r["eol"], False)

    def test_single_product_payload(self):
        one = {"result": catalog()["result"][0]}
        self.assertEqual(
            [p["name"] for p in get_source("endoflife_date").parse(one)], ["ubuntu"]
        )

    def test_garbage_is_rejected(self):
        for bad in ({"result": "x"}, [], {"result": [{"name": "x"}]}):
            with self.assertRaises(EolSourceError):
                get_source("endoflife_date").parse(bad)


# ─── status ──────────────────────────────────────────────────────────────────


class StatusTests(TestCase):
    def m(self, **kw):
        kw.setdefault("synced_at", timezone.now())
        return EolMapping(**kw)

    def test_buckets(self):
        today = timezone.localdate()
        self.assertEqual(eol.status_of(None, 90), "unknown")
        self.assertEqual(eol.status_of(self.m(synced_at=None), 90), "unknown")
        self.assertEqual(eol.status_of(self.m(eol_date=today), 90), "eol")
        self.assertEqual(
            eol.status_of(self.m(eol_date=today + timedelta(days=30)), 90), "ending")
        self.assertEqual(
            eol.status_of(self.m(eol_date=today + timedelta(days=91)), 90), "supported")
        self.assertEqual(eol.status_of(self.m(eol_reached=True), 90), "eol")
        self.assertEqual(eol.status_of(self.m(eol_reached=False), 90), "supported")
        self.assertEqual(eol.status_of(self.m(), 90), "unknown")


# ─── refresh against the fake server ─────────────────────────────────────────


class RefreshTests(TenantMixin, TestCase):
    def setUp(self):
        self.fake = FakeEndOfLife()
        self.addCleanup(self.fake.close)
        self.tenant = self.make_tenant()
        self.platform = Platform.objects.create(
            tenant=self.tenant, name="Ubuntu 22.04", slug="ubuntu-22-04")

    def test_off_by_default_fetches_nothing(self):
        allow_loopback()
        EolSettings.load()
        self.assertEqual(eol.refresh(), {"skipped": "off"})
        self.assertEqual(self.fake.hits, 0)
        self.assertFalse(EolProduct.objects.exists())

    def test_refresh_caches_catalog_and_updates_mappings(self):
        allow_loopback()
        enable(self.fake.url)
        EolMapping.objects.create(
            tenant=self.tenant, platform=self.platform, source="endoflife_date",
            product="ubuntu", cycle="22.04")
        result = eol.refresh()
        self.assertEqual(result["errors"], [])
        self.assertEqual(self.fake.hits, 1)
        self.assertEqual(EolProduct.objects.count(), 2)
        m = EolMapping.objects.get()
        self.assertEqual(m.eol_date.isoformat(), days(60))
        self.assertEqual(m.latest_version, "22.04.5")
        self.assertIsNotNone(m.synced_at)
        row = EolSettings.load()
        self.assertEqual(row.last_refresh_status, "ok")
        self.assertEqual(row.last_refresh_via, "online")

    def test_unchanged_refresh_writes_no_change_log(self):
        allow_loopback()
        enable(self.fake.url)
        EolMapping.objects.create(
            tenant=self.tenant, platform=self.platform, source="endoflife_date",
            product="ubuntu", cycle="22.04")
        eol.refresh()
        before = ChangeLogEntry.objects.filter(object_type="compliance.eolmapping").count()
        synced = EolMapping.objects.get().synced_at
        self.assertEqual(eol.refresh()["sources"]["endoflife_date"]["changed"], 0)
        self.assertEqual(
            ChangeLogEntry.objects.filter(object_type="compliance.eolmapping").count(),
            before)
        self.assertEqual(EolMapping.objects.get().synced_at, synced)

    def test_changed_upstream_date_updates_the_mapping(self):
        allow_loopback()
        enable(self.fake.url)
        EolMapping.objects.create(
            tenant=self.tenant, platform=self.platform, source="endoflife_date",
            product="ubuntu", cycle="22.04")
        eol.refresh()
        body = copy.deepcopy(self.fake.body)
        body["result"][0]["releases"][1]["eolFrom"] = days(1000)
        self.fake.body = body
        eol.refresh()
        self.assertEqual(EolMapping.objects.get().eol_date.isoformat(), days(1000))

    def test_cycle_gone_upstream_is_flagged_missing_and_keeps_facts(self):
        allow_loopback()
        enable(self.fake.url)
        EolMapping.objects.create(
            tenant=self.tenant, platform=self.platform, source="endoflife_date",
            product="ubuntu", cycle="22.04")
        eol.refresh()
        body = copy.deepcopy(self.fake.body)
        del body["result"][0]["releases"][1]
        self.fake.body = body
        eol.refresh()
        m = EolMapping.objects.get()
        self.assertTrue(m.missing)
        self.assertEqual(m.eol_date.isoformat(), days(60))

    def test_ssrf_guard_refuses_a_private_source(self):
        """No allow-list entry: the loopback fake is a private address."""
        enable(self.fake.url)
        result = eol.refresh()
        self.assertEqual(self.fake.hits, 0)
        self.assertTrue(result["errors"])
        self.assertIn("non-public", result["errors"][0])
        row = EolSettings.load()
        self.assertEqual(row.last_refresh_status, "failed")
        self.assertFalse(EolProduct.objects.exists())

    def test_command_skips_while_off_and_refreshes_when_on(self):
        out = io.StringIO()
        call_command("eol_refresh", stdout=out)
        self.assertIn("off", out.getvalue())
        allow_loopback()
        enable(self.fake.url)
        call_command("eol_refresh", stdout=out)
        self.assertEqual(EolProduct.objects.count(), 2)


# ─── API ─────────────────────────────────────────────────────────────────────


class ApiBase(TenantMixin, APITestCase):
    def setUp(self):
        self.tenant = self.make_tenant()
        self.admin = User.objects.create_superuser("root", password="x")
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.editor = self.user("editor", ["view", "change"])
        self.viewer = self.user("viewer", ["view"])
        self.platform = Platform.objects.create(
            tenant=self.tenant, name="Ubuntu 22.04", slug="ubuntu-22-04")

    def user(self, name, actions, types=("platform",)):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=name, object_types=list(types), actions=actions)
        perm.users.add(u)
        perm.tenants.add(self.tenant)
        return u

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()


class SettingsApiTests(ApiBase):
    def test_non_admin_reads_only_the_switch(self):
        self.login(self.editor)
        body = self.client.get("/api/eol/settings/").json()
        self.assertEqual(body, {"enabled": False, "warning_days": 180})
        r = self.client.patch("/api/eol/settings/", {"enabled": True}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(EolSettings.load().enabled)

    def test_admin_enables_with_the_first_source(self):
        self.login(self.admin)
        r = self.client.patch("/api/eol/settings/", {"enabled": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sources"], ["endoflife_date"])
        self.assertTrue(
            ChangeLogEntry.objects.filter(object_type="compliance.eolsettings").exists())

    def test_validation(self):
        self.login(self.admin)
        for body in ({"sources": ["nope"]},
                     {"source_urls": {"endoflife_date": "http://mirror.example"}},
                     {"warning_days": -1}):
            r = self.client.patch("/api/eol/settings/", body, format="json")
            self.assertEqual(r.status_code, 400, body)

    def test_refresh_enqueues(self):
        self.login(self.admin)
        self.assertEqual(self.client.post("/api/eol/refresh/").status_code, 409)
        enable()
        queue = mock.Mock()
        with mock.patch("django_rq.get_queue", return_value=queue):
            r = self.client.post("/api/eol/refresh/")
        self.assertEqual(r.status_code, 202, r.content)
        queue.enqueue.assert_called_once()
        self.assertEqual(EolSettings.load().last_refresh_status, "queued")
        # A second press while queued is refused.
        self.assertEqual(self.client.post("/api/eol/refresh/").status_code, 409)

    def test_a_dead_run_does_not_block_refresh_for_good(self):
        self.login(self.admin)
        enable()
        EolSettings.objects.filter(pk=1).update(
            last_refresh_status="running",
            updated_at=timezone.now() - timedelta(hours=2))
        with mock.patch("django_rq.get_queue", return_value=mock.Mock()):
            self.assertEqual(self.client.post("/api/eol/refresh/").status_code, 202)

    def test_refresh_without_redis_fails_cleanly(self):
        self.login(self.admin)
        enable()
        with mock.patch("django_rq.get_queue", side_effect=ConnectionError("down")):
            r = self.client.post("/api/eol/refresh/")
        self.assertEqual(r.status_code, 503)

    def test_refresh_is_admin_only(self):
        enable()
        self.login(self.editor)
        self.assertEqual(self.client.post("/api/eol/refresh/").status_code, 403)


class ImportApiTests(ApiBase):
    def upload(self, raw: bytes):
        return self.client.post(
            "/api/eol/import/",
            {"file": SimpleUploadedFile("full.json", raw, "application/json")},
            format="multipart",
        )

    def test_offline_import_fills_catalog_and_mappings(self):
        enable()
        EolMapping.objects.create(
            tenant=self.tenant, platform=self.platform, source="endoflife_date",
            product="ubuntu", cycle="22.04")
        self.login(self.admin)
        with mock.patch("core.ssrf.safe_get") as fetch:
            r = self.upload(json.dumps(catalog()).encode())
            fetch.assert_not_called()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["products"], 2)
        self.assertEqual(EolMapping.objects.get().latest_version, "22.04.5")
        self.assertEqual(EolSettings.load().last_refresh_via, "import")

    def test_import_rules(self):
        self.login(self.admin)
        self.assertEqual(self.upload(b"{}").status_code, 409)  # off
        enable()
        self.assertEqual(self.upload(b"not json").status_code, 400)
        self.login(self.editor)
        self.assertEqual(
            self.upload(json.dumps(catalog()).encode()).status_code, 403)


class MappingApiTests(ApiBase):
    def setUp(self):
        super().setUp()
        enable()
        load_catalog()
        self.url = f"/api/eol/platforms/{self.platform.id}/"

    def test_feature_off_hides_everything(self):
        EolSettings.objects.filter(pk=1).update(enabled=False)
        self.login(self.editor)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.get("/api/eol/products/").status_code, 404)

    def test_put_maps_and_fills_facts(self):
        self.login(self.editor)
        r = self.client.put(self.url, {"product": "ubuntu", "cycle": "22.04"},
                            format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["status"], "ending")
        self.assertEqual(body["eol_date"], days(60))
        self.assertTrue(body["lts"])
        m = EolMapping.objects.get()
        self.assertEqual(m.tenant, self.tenant)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="compliance.eolmapping", action="create").exists())
        r = self.client.put(self.url, {"product": "ubuntu", "cycle": "18.04"},
                            format="json")
        self.assertEqual(r.json()["status"], "eol")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="compliance.eolmapping", action="update").exists())

    def test_put_validates_against_the_catalog(self):
        self.login(self.editor)
        r = self.client.put(self.url, {"product": "nope", "cycle": "1"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.put(self.url, {"product": "ubuntu", "cycle": "9.9"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("cycle", r.json())

    def test_viewer_reads_but_cannot_map(self):
        self.login(self.viewer)
        self.assertEqual(self.client.get(self.url).json(), {"status": "unknown"})
        r = self.client.put(self.url, {"product": "ubuntu", "cycle": "22.04"},
                            format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.delete(self.url).status_code, 403)
        self.assertFalse(EolMapping.objects.exists())

    def test_other_tenants_platform_is_404(self):
        other = self.make_tenant("o")
        foreign = Platform.objects.create(tenant=other, name="X", slug="x")
        self.login(self.editor)
        r = self.client.put(f"/api/eol/platforms/{foreign.id}/",
                            {"product": "ubuntu", "cycle": "22.04"}, format="json")
        self.assertEqual(r.status_code, 404)
        self.assertFalse(EolMapping.objects.exists())

    def test_delete_unmaps(self):
        self.map_platform(self.platform)
        self.login(self.editor)
        self.assertEqual(self.client.delete(self.url).status_code, 204)
        self.assertFalse(EolMapping.objects.exists())

    def test_search_and_suggestions_never_assign(self):
        self.login(self.viewer)
        r = self.client.get("/api/eol/products/", {"q": "ubu"})
        self.assertEqual([p["name"] for p in r.json()["results"]], ["ubuntu"])
        r = self.client.get("/api/eol/products/", {"platform": str(self.platform.id)})
        top = r.json()["suggestions"][0]
        self.assertEqual((top["name"], top["cycle"]), ("ubuntu", "22.04"))
        self.assertFalse(EolMapping.objects.exists())
        r = self.client.get("/api/eol/products/endoflife_date/ubuntu/")
        self.assertEqual(len(r.json()["releases"]), 3)

    def test_platform_detail_carries_eol(self):
        self.map_platform(self.platform)
        self.login(self.viewer)
        body = self.client.get(f"/api/platforms/{self.platform.id}/").json()
        self.assertEqual(body["eol"]["status"], "ending")
        r = self.client.get("/api/platforms/", {"eol": "ending"})
        self.assertEqual([p["id"] for p in r.json()["results"]], [str(self.platform.id)])
        r = self.client.get("/api/platforms/", {"eol": "eol"})
        self.assertEqual(r.json()["results"], [])


# ─── device / VM lists ───────────────────────────────────────────────────────


class ListTests(ApiBase):
    def setUp(self):
        super().setUp()
        load_catalog()
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, model="X")
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        ctype = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        self.cluster = Cluster.objects.create(
            tenant=self.tenant, name="C", type=ctype)
        self.old = Platform.objects.create(tenant=self.tenant, name="U18", slug="u18")
        self.new = Platform.objects.create(tenant=self.tenant, name="U24", slug="u24")
        self.map_platform(self.old, cycle="18.04")
        self.map_platform(self.new, cycle="24.04")
        self.map_platform(self.platform, cycle="22.04")
        self.lister = self.user(
            "lister", ["view"], types=("device", "virtualmachine", "platform"))

    def device(self, name, platform):
        return Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dt, site=self.site,
            platform=platform)

    def vm(self, name, platform):
        return VirtualMachine.objects.create(
            tenant=self.tenant, name=name, cluster=self.cluster, platform=platform)

    def test_feature_off_serializes_null_and_ignores_filter(self):
        self.device("d1", self.old)
        self.login(self.lister)
        rows = self.client.get("/api/devices/", {"eol": "eol"}).json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["platform"]["eol"])

    def test_device_and_vm_columns_and_filters(self):
        enable()
        self.device("d-old", self.old)
        self.device("d-new", self.new)
        self.device("d-none", None)
        self.device("d-unmapped", Platform.objects.create(
            tenant=self.tenant, name="Other", slug="other"))
        self.vm("v-old", self.old)
        self.vm("v-ending", self.platform)
        self.login(self.lister)
        rows = self.client.get("/api/devices/").json()["results"]
        by = {r["name"]: r for r in rows}
        self.assertEqual(by["d-old"]["platform"]["eol"]["status"], "eol")
        self.assertEqual(by["d-new"]["platform"]["eol"]["status"], "supported")
        self.assertEqual(by["d-unmapped"]["platform"]["eol"], {"status": "unknown"})

        def names(url, eol_filter):
            res = self.client.get(url, {"eol": eol_filter})
            self.assertEqual(res.status_code, 200, res.content)
            return sorted(r["name"] for r in res.json()["results"])

        self.assertEqual(names("/api/devices/", "eol"), ["d-old"])
        self.assertEqual(names("/api/devices/", "supported"), ["d-new"])
        self.assertEqual(names("/api/devices/", "unknown"), ["d-none", "d-unmapped"])
        self.assertEqual(names("/api/devices/", "eol,supported"), ["d-new", "d-old"])
        self.assertEqual(names("/api/virtual-machines/", "ending"), ["v-ending"])
        vms = self.client.get("/api/virtual-machines/").json()["results"]
        self.assertEqual(
            {v["name"]: v["platform"]["eol"]["status"] for v in vms},
            {"v-old": "eol", "v-ending": "ending"})
        self.assertEqual(
            self.client.get("/api/devices/", {"eol": "bogus"}).status_code, 400)

    def _count(self, url):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200)
        return len(ctx.captured_queries)

    def test_list_queries_do_not_grow_with_rows(self):
        enable()
        self.login(self.lister)
        self.device("d0", self.old)
        self.vm("v0", self.old)
        one_dev = self._count("/api/devices/")
        one_vm = self._count("/api/virtual-machines/")
        for i in range(1, 6):
            self.device(f"d{i}", [self.old, self.new, self.platform][i % 3])
            self.vm(f"v{i}", [self.old, self.new, self.platform][i % 3])
        self.assertEqual(self._count("/api/devices/"), one_dev)
        self.assertEqual(self._count("/api/virtual-machines/"), one_vm)


# ─── compliance rules ────────────────────────────────────────────────────────


class ComplianceEolTests(TenantMixin, TestCase):
    def setUp(self):
        self.tenant = self.make_tenant()
        load_catalog()
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        site = Site.objects.create(tenant=self.tenant, name="S")
        self.p_eol = Platform.objects.create(tenant=self.tenant, name="A", slug="a")
        self.p_ending = Platform.objects.create(tenant=self.tenant, name="B", slug="b")
        self.p_ok = Platform.objects.create(tenant=self.tenant, name="C", slug="c")
        self.map_platform(self.p_eol, cycle="18.04")
        self.map_platform(self.p_ending, cycle="22.04")
        self.map_platform(self.p_ok, cycle="24.04")
        self.devices = {
            name: Device.objects.create(tenant=self.tenant, name=name,
                                        device_type=dt, site=site, platform=p)
            for name, p in (("old", self.p_eol), ("ending", self.p_ending),
                            ("ok", self.p_ok), ("none", None))
        }

    def rule(self, fail_on, object_type="device"):
        return ComplianceRule.objects.create(
            tenant=self.tenant, name=f"eol {fail_on}", object_type=object_type,
            check_type="eol_status", eol_fail_on=fail_on)

    def failing(self, rule):
        return sorted(v["object_repr"] for v in evaluate(self.tenant, rules=[rule])["violations"])

    def test_off_means_no_violations(self):
        self.assertEqual(self.failing(self.rule("eol")), [])

    def test_fail_on_buckets(self):
        enable()
        self.assertEqual(self.failing(self.rule("eol")), ["old"])
        self.assertEqual(self.failing(self.rule("ending")), ["ending", "old"])
        self.assertEqual(self.failing(self.rule("unknown")), ["none"])

    def test_warning_window_moves_the_line(self):
        enable(warning_days=30)
        self.assertEqual(self.failing(self.rule("ending")), ["old"])

    def test_single_object_and_vm(self):
        enable()
        r = self.rule("ending")
        self.assertEqual(
            evaluate_for_object(self.tenant, "device", self.devices["ending"]), [r])
        ctype = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        cluster = Cluster.objects.create(tenant=self.tenant, name="C", type=ctype)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-old", cluster=cluster, platform=self.p_eol)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-ok", cluster=cluster, platform=self.p_ok)
        self.assertEqual(self.failing(self.rule("eol", "virtualmachine")), ["vm-old"])

    def test_evaluation_query_count_is_flat(self):
        enable()
        r = self.rule("eol")
        with CaptureQueriesContext(connection) as small:
            evaluate(self.tenant, rules=[r])
        site = Site.objects.get(tenant=self.tenant)
        dt = DeviceType.objects.get(tenant=self.tenant)
        for i in range(10):
            Device.objects.create(tenant=self.tenant, name=f"x{i}", device_type=dt,
                                  site=site, platform=self.p_eol)
        with CaptureQueriesContext(connection) as big:
            evaluate(self.tenant, rules=[r])
        self.assertEqual(len(big.captured_queries), len(small.captured_queries))

    def test_serializer_rules(self):
        ok = ComplianceRuleSerializer(data={
            "name": "x", "object_type": "device", "check_type": "eol_status",
            "eol_fail_on": "ending"})
        self.assertTrue(ok.is_valid(), ok.errors)
        bad_type = ComplianceRuleSerializer(data={
            "name": "x", "object_type": "prefix", "check_type": "eol_status",
            "eol_fail_on": "eol"})
        self.assertFalse(bad_type.is_valid())
        self.assertIn("object_type", bad_type.errors)
        missing = ComplianceRuleSerializer(data={
            "name": "x", "object_type": "device", "check_type": "eol_status"})
        self.assertFalse(missing.is_valid())
        self.assertIn("eol_fail_on", missing.errors)
