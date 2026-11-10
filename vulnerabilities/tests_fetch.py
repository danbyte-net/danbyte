"""Server mode (#451): gating, the SSRF guard, NVD paging and cursors,
pacing and backoff, resume, OSV, KEV and EPSS, key secrecy, the Refresh and
CPE search endpoints. The network is a fake transport under the real
SafeSession: nothing leaves the test."""
from __future__ import annotations

import copy
import io
import json
import logging
from datetime import timedelta
from io import StringIO
from unittest import mock
from urllib.parse import parse_qs, urlparse

import requests
from django.contrib.auth.models import User
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from requests.adapters import HTTPAdapter
from requests.structures import CaseInsensitiveDict
from rest_framework.test import APITestCase

from core.models import ScheduledRun

from . import fetch, products
from .models import CpeProductSync, Cve, SyncRun, VulnerabilitySettings
from .testing import DJANGO, IOS_XE, POSTGRES, data

KEY = "nvd-secret-key-0123456789"
NVD = "services.nvd.nist.gov"
PUBLIC_IP = "93.184.216.34"
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                      "LOCATION": "vuln-fetch-tests"}}

_BASE = json.loads(data("nvd_page.json"))
_XE = _BASE["vulnerabilities"][0]
_PG = _BASE["vulnerabilities"][1]


def xe_cve(n: int, modified: str = "2026-11-01T00:00:00.000") -> dict:
    rec = copy.deepcopy(_XE)
    rec["cve"]["id"] = f"CVE-2026-{n:05d}"
    rec["cve"]["lastModified"] = modified
    return rec


def nvd_page(records, start: int, total: int) -> bytes:
    return json.dumps({"resultsPerPage": len(records), "startIndex": start,
                       "totalResults": total, "format": "NVD_CVE", "version": "2.0",
                       "timestamp": "2026-11-10T00:00:00.000",
                       "vulnerabilities": records}).encode()


class Call:
    def __init__(self, request):
        u = urlparse(request.url)
        self.ip = u.hostname
        self.host = request.headers.get("Host")
        self.path = u.path
        self.params = {k: v[0] for k, v in parse_qs(u.query).items()}
        self.headers = dict(request.headers)
        self.body = json.loads(request.body) if request.body else None
        self.method = request.method


class FakeNet:
    """Routes by (Host, path prefix). A responder is ``(status, body,
    headers)``, an exception to raise, or a callable taking the call."""

    def __init__(self):
        self.calls: list[Call] = []
        self.routes: list[tuple[str, str, list]] = []

    def on(self, host: str, path: str, *responses):
        self.routes.insert(0, (host, path, list(responses)))

    def send(self, adapter, request, **kw):
        call = Call(request)
        self.calls.append(call)
        for host, path, queue in self.routes:
            if call.host == host and call.path.startswith(path):
                item = queue.pop(0) if len(queue) > 1 else queue[0]
                if callable(item) and not isinstance(item, tuple):
                    item = item(call)
                if isinstance(item, Exception):
                    raise item
                status, body, headers = (item + ({},))[:3] if len(item) == 2 else item
                resp = requests.Response()
                resp.status_code = status
                resp.headers = CaseInsensitiveDict(headers)
                resp.raw = io.BytesIO(body if isinstance(body, bytes) else body.encode())
                resp.url = request.url
                resp.request = request
                return resp
        raise AssertionError(f"unrouted request to {call.host}{call.path}")

    def to(self, host: str) -> list[Call]:
        return [c for c in self.calls if c.host == host]


class NetMixin:
    """Server mode on, a fake network, a fake clock, tracked products."""

    tracked: tuple = (IOS_XE,)

    def setUp(self):
        super().setUp()
        self.net = FakeNet()
        self.sleeps: list[float] = []
        self.clock = [1000.0]

        def sleep(d):
            self.sleeps.append(d)
            self.clock[0] += d

        for target, value in (
            ("vulnerabilities.fetch._sleep", sleep),
            ("vulnerabilities.fetch._monotonic", lambda: self.clock[0]),
        ):
            p = mock.patch(target, value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(HTTPAdapter, "send", lambda adapter, req, **kw:
                              self.net.send(adapter, req, **kw))
        p.start()
        self.addCleanup(p.stop)
        self.resolve = mock.patch("core.ssrf.socket.getaddrinfo",
                                  return_value=[(2, 1, 6, "", (PUBLIC_IP, 443))])
        self.resolve.start()
        self.addCleanup(self.resolve.stop)
        self.set_tracked(*self.tracked)
        VulnerabilitySettings.objects.update_or_create(
            pk=1, defaults={"enabled": True, "update_source": "server",
                            "sync_kev": False, "sync_epss": False})

    def set_tracked(self, *keys):
        if getattr(self, "_provider", None):
            products.unregister_provider(self._provider)
        self._provider = lambda: list(keys)
        products.register_provider(self._provider)
        self.addCleanup(products.unregister_provider, self._provider)

    def settings_(self, **kw):
        VulnerabilitySettings.objects.filter(pk=1).update(**kw)
        if "secrets" in kw:  # encrypted field: write through save()
            row = VulnerabilitySettings.load()
            row.secrets = kw["secrets"]
            row.save()

    def serve_nvd(self, pages: dict[int, tuple[list, int]]):
        """``{startIndex: (records, total)}``."""
        def respond(call):
            start = int(call.params["startIndex"])
            records, total = pages[start]
            return (200, nvd_page(records, start, total), {})
        self.net.on(NVD, "/rest/json/cves/2.0", respond)

    def run_once(self):
        run = fetch.start_run(None)
        return fetch.execute(run.pk)


class GatingTests(NetMixin, TestCase):
    def test_off_or_not_server_mode_makes_no_request(self):
        for kw in ({"enabled": False}, {"update_source": "upload"},
                   {"update_source": "browser"}):
            with self.subTest(**kw):
                VulnerabilitySettings.objects.filter(pk=1).update(
                    enabled=True, update_source="server")
                self.settings_(**kw)
                out = StringIO()
                call_command("vuln_refresh", stdout=out)
                self.assertTrue(out.getvalue().strip())
                with self.assertRaises(fetch.Off):
                    fetch.start_run(None)
                self.assertFalse(fetch.enqueue_products([IOS_XE]))
        self.assertEqual(self.net.calls, [])
        self.assertFalse(SyncRun.objects.exists())
        self.assertEqual(ScheduledRun.objects.filter(name="vuln-refresh").first().status,
                         ScheduledRun.SKIPPED)

    def test_default_settings_are_upload_and_fetch_nothing(self):
        VulnerabilitySettings.objects.all().delete()
        call_command("vuln_refresh", stdout=StringIO())
        self.assertEqual(self.net.calls, [])
        self.assertFalse(SyncRun.objects.exists())

    def test_switched_off_before_the_job_runs(self):
        run = fetch.start_run(None)
        self.settings_(update_source="upload")
        run = fetch.execute(run.pk)
        self.assertEqual(run.status, "failed")
        self.assertIn("server", run.error)
        self.assertEqual(self.net.calls, [])

    def test_a_plain_http_mirror_is_refused(self):
        self.settings_(nvd_url="http://mirror.example.com")
        with self.assertRaises(fetch.FetchError):
            fetch.start_run(None)
        self.assertEqual(self.net.calls, [])


class SsrfTests(NetMixin, TestCase):
    def test_requests_go_through_the_pinned_guard(self):
        self.serve_nvd({0: ([xe_cve(1)], 1)})
        run = self.run_once()
        self.assertEqual(run.status, "ok", run.error)
        call = self.net.calls[0]
        self.assertEqual(call.ip, PUBLIC_IP)       # pinned to the checked address
        self.assertEqual(call.host, NVD)           # Host kept for TLS and routing

    def test_a_mirror_on_a_private_address_is_refused(self):
        self.settings_(nvd_url="https://nvd-mirror.internal")
        with mock.patch("core.ssrf.socket.getaddrinfo",
                        return_value=[(2, 1, 6, "", ("10.0.0.5", 443))]):
            run = self.run_once()
        self.assertEqual(run.status, "failed")
        self.assertIn("non-public", run.error)
        self.assertEqual(self.net.calls, [])
        self.assertEqual(CpeProductSync.objects.get().last_status, "failed")

    def test_a_redirect_is_not_followed(self):
        self.net.on(NVD, "/rest/json/cves/2.0",
                    (302, b"", {"Location": "http://169.254.169.254/"}))
        run = self.run_once()
        self.assertEqual(run.status, "failed")
        self.assertIn("redirect", run.error)
        self.assertEqual(len(self.net.calls), 1)


class NvdPagingTests(NetMixin, TestCase):
    def test_pages_until_total_and_saves_the_cursor(self):
        self.serve_nvd({0: ([xe_cve(1), xe_cve(2)], 3), 2: ([xe_cve(3)], 3)})
        run = self.run_once()
        self.assertEqual(run.status, "ok", run.error)
        self.assertEqual([c.params["startIndex"] for c in self.net.calls], ["0", "2"])
        first = self.net.calls[0].params
        self.assertEqual(first["virtualMatchString"], "cpe:2.3:o:cisco:ios_xe")
        self.assertEqual(first["resultsPerPage"], "2000")
        self.assertNotIn("lastModStartDate", first)
        self.assertEqual(Cve.objects.count(), 3)
        self.assertEqual(run.counts["nvd"]["created"], 3)
        self.assertEqual(run.progress["nvd"]["o:cisco:ios_xe"]["start_index"], 3)
        cursor = CpeProductSync.objects.get(part="o", vendor="cisco", product="ios_xe")
        self.assertEqual((cursor.last_status, cursor.cve_count), ("ok", 3))
        self.assertIsNotNone(cursor.last_synced_at)

    def test_a_young_cursor_asks_only_for_what_changed(self):
        synced = timezone.now() - timedelta(days=3)
        CpeProductSync.objects.create(part="o", vendor="cisco", product="ios_xe",
                                      last_synced_at=synced, last_status="ok")
        self.serve_nvd({0: ([xe_cve(1)], 1)})
        self.assertEqual(self.run_once().status, "ok")
        params = self.net.calls[0].params
        since = fetch._parse_iso(params["lastModStartDate"])
        until = fetch._parse_iso(params["lastModEndDate"])
        self.assertEqual(since, (synced - fetch.CURSOR_OVERLAP).replace(microsecond=0))
        self.assertLess(until - since, timedelta(days=120))
        cursor = CpeProductSync.objects.get()
        self.assertEqual(cursor.last_synced_at.replace(microsecond=0), until)

    def test_an_old_cursor_refetches_the_product_whole(self):
        CpeProductSync.objects.create(part="o", vendor="cisco", product="ios_xe",
                                      last_synced_at=timezone.now() - timedelta(days=111))
        self.serve_nvd({0: ([xe_cve(1)], 1)})
        self.run_once()
        self.assertNotIn("lastModStartDate", self.net.calls[0].params)

    def test_replaying_a_page_writes_nothing(self):
        self.serve_nvd({0: ([xe_cve(1)], 1)})
        self.run_once()
        run = self.run_once()
        self.assertEqual(run.counts["nvd"]["unchanged"], 1)
        self.assertEqual(run.counts["nvd"]["created"], 0)

    def test_a_page_that_does_not_fit_fails_the_product(self):
        self.net.on(NVD, "/rest/json/cves/2.0", (200, nvd_page([xe_cve(1)], 7, 9), {}))
        run = self.run_once()
        self.assertEqual(run.status, "failed")
        self.assertIn("does not fit", run.error)


class PacingTests(NetMixin, TestCase):
    tracked = (IOS_XE, POSTGRES)

    def setUp(self):
        super().setUp()
        self.serve_nvd({0: ([xe_cve(1), _PG], 2)})

    def test_without_a_key_nvd_is_paced_to_five_per_thirty_seconds(self):
        self.run_once()
        self.assertEqual(len(self.net.to(NVD)), 2)
        self.assertEqual(len(self.sleeps), 1)
        self.assertAlmostEqual(self.sleeps[0], fetch.NVD_SPACING)
        self.assertNotIn("apiKey", self.net.calls[0].headers)

    def test_with_a_key_it_is_paced_to_fifty(self):
        self.settings_(secrets={"nvd_api_key": KEY})
        self.run_once()
        self.assertEqual(len(self.sleeps), 1)
        self.assertAlmostEqual(self.sleeps[0], fetch.NVD_SPACING_KEY)
        self.assertEqual({c.headers.get("apiKey") for c in self.net.to(NVD)}, {KEY})

    def test_a_rate_limit_answer_backs_off_and_retries(self):
        ok = self.net.routes[0][2][0]
        self.net.on(NVD, "/rest/json/cves/2.0", (429, b"", {"Retry-After": "7"}),
                    (403, b"", {}), ok)
        run = self.run_once()
        self.assertEqual(run.status, "ok", run.error)
        self.assertIn(7.0, self.sleeps)
        self.assertIn(fetch.BACKOFF[1], self.sleeps)
        self.assertEqual(run.counts["retries"], 2)

    def test_a_product_that_keeps_failing_does_not_stop_the_run(self):
        ok = self.net.routes[0][2][0]

        def respond(call):
            if "ios_xe" in call.params["virtualMatchString"]:
                return (503, b"", {})
            return ok(call)
        self.net.on(NVD, "/rest/json/cves/2.0", respond)
        run = self.run_once()
        self.assertEqual(run.status, "failed")
        self.assertIn("ios_xe", run.error)
        self.assertIn("HTTP 503", run.error)
        # Four tries for IOS-XE, then PostgreSQL still fetched and stored.
        self.assertEqual(len(self.net.to(NVD)), len(fetch.BACKOFF) + 2)
        self.assertTrue(Cve.objects.filter(vuln_id="CVE-2024-10979").exists())
        statuses = dict(CpeProductSync.objects.values_list("product", "last_status"))
        self.assertEqual(statuses, {"ios_xe": "failed", "postgresql": "ok"})


class ResumeTests(NetMixin, TestCase):
    def test_a_failed_run_resumes_where_it_stopped(self):
        pages = {0: ([xe_cve(1), xe_cve(2)], 3), 2: ([xe_cve(3)], 3)}
        broken = {"on": True}

        def respond(call):
            start = int(call.params["startIndex"])
            if start == 2 and broken["on"]:
                return (503, b"", {})
            records, total = pages[start]
            return (200, nvd_page(records, start, total), {})
        self.net.on(NVD, "/rest/json/cves/2.0", respond)
        first = self.run_once()
        self.assertEqual(first.status, "failed")
        self.assertEqual(first.progress["nvd"]["o:cisco:ios_xe"]["start_index"], 2)
        self.assertIsNone(CpeProductSync.objects.get().last_synced_at)

        broken["on"] = False
        self.net.calls.clear()
        again = self.run_once()
        self.assertEqual(again.pk, first.pk)
        self.assertEqual(again.status, "ok", again.error)
        self.assertEqual(again.progress["resumed"], 1)
        self.assertEqual([c.params["startIndex"] for c in self.net.calls], ["2"])
        self.assertEqual(Cve.objects.count(), 3)
        self.assertIsNotNone(CpeProductSync.objects.get().last_synced_at)

    def test_an_old_failure_starts_afresh(self):
        old = SyncRun.objects.create(via="server", started_at=timezone.now() - timedelta(days=1),
                                     status="failed", plan={"resumable": True})
        self.assertNotEqual(fetch.start_run(None).pk, old.pk)

    def test_one_run_at_a_time(self):
        fetch.start_run(None)
        with self.assertRaises(fetch.Busy):
            fetch.start_run(None)
        out = StringIO()
        call_command("vuln_refresh", stdout=out)
        self.assertIn("already running", out.getvalue())

    def test_a_dead_run_is_abandoned_and_then_resumed(self):
        run = fetch.start_run(None)
        SyncRun.objects.filter(pk=run.pk).update(
            updated_at=timezone.now() - timedelta(hours=3))
        self.assertEqual(fetch.start_run(None).pk, run.pk)

    def test_a_run_ended_elsewhere_stops_quietly(self):
        run = fetch.start_run(None)

        def respond(call):
            SyncRun.objects.filter(pk=run.pk).update(status="abandoned")
            return (200, nvd_page([xe_cve(1)], 0, 1), {})
        self.net.on(NVD, "/rest/json/cves/2.0", respond)
        self.assertEqual(fetch.execute(run.pk).status, "abandoned")


class KevEpssTests(NetMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.settings_(sync_kev=True, sync_epss=True)
        self.serve_nvd({0: ([_XE], 1)})
        self.net.on("www.cisa.gov", "/sites/default/files/feeds/", (200, data("kev.json"), {}))
        self.epss_day = timezone.now().date().isoformat()

        def epss(call):
            ids = call.params["cve"].split(",")
            return (200, json.dumps({"status": "OK", "data": [
                {"cve": c, "epss": "0.94379", "percentile": "0.99961", "date": self.epss_day}
                for c in ids]}), {})
        self.net.on("api.first.org", "/data/v1/epss", epss)

    def test_kev_and_epss_land_on_the_stored_cves(self):
        run = self.run_once()
        self.assertEqual(run.status, "ok", run.error)
        row = Cve.objects.get(vuln_id="CVE-2023-20198")
        self.assertEqual(row.kev_ransomware, "known")
        self.assertEqual(str(row.epss), "0.94379")
        self.assertEqual(run.counts["kev"]["updated"], 1)
        self.assertEqual(run.counts["epss"]["updated"], 1)
        hosts = [c.host for c in self.net.calls]
        self.assertEqual(hosts, [NVD, "www.cisa.gov", "api.first.org"])

    def test_epss_asks_a_hundred_at_a_time_and_skips_fresh_scores(self):
        Cve.objects.bulk_create([Cve(vuln_id=f"CVE-2020-{n:05d}") for n in range(150)])
        Cve.objects.create(vuln_id="CVE-2019-00001", epss_date=timezone.now().date())
        self.run_once()
        batches = [c.params["cve"].split(",") for c in self.net.to("api.first.org")]
        self.assertEqual([len(b) for b in batches], [100, 51])
        self.assertNotIn("CVE-2019-00001", sum(batches, []))
        # The second run finds every score fresh.
        self.net.calls.clear()
        self.run_once()
        self.assertEqual(self.net.to("api.first.org"), [])

    def test_an_empty_answer_to_a_batch_fails_it(self):
        self.net.on("api.first.org", "/data/v1/epss",
                    (200, json.dumps({"status": "OK", "data": []}), {}))
        run = self.run_once()
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.progress["epss"]["batches_failed"], 1)
        self.assertIn("no scores", run.error)

    def test_kev_and_epss_follow_their_switches(self):
        self.settings_(sync_kev=False, sync_epss=False)
        self.run_once()
        self.assertEqual([c.host for c in self.net.calls], [NVD])


class OsvTests(NetMixin, TestCase):
    tracked = (DJANGO, ("purl", "", "npm", "@angular/core"), ("purl", "", "generic", "x"))

    def setUp(self):
        super().setUp()
        self.record = json.loads(data("osv_django.json"))
        self.net.on("api.osv.dev", "/v1/vulns/", (200, json.dumps(self.record), {}))

    def serve_batch(self, modified):
        def respond(call):
            results = []
            for q in call.body["queries"]:
                if q["package"]["purl"] == "pkg:pypi/django" and "page_token" not in q:
                    results.append({"vulns": [], "next_page_token": "t1"})
                elif q["package"]["purl"] == "pkg:pypi/django":
                    results.append({"vulns": [{"id": self.record["id"], "modified": modified}]})
                else:
                    results.append({})
            return (200, json.dumps({"results": results}), {})
        self.net.on("api.osv.dev", "/v1/querybatch", respond)

    def test_querybatch_then_only_new_or_changed_advisories(self):
        self.serve_batch(self.record["modified"])
        run = self.run_once()
        self.assertEqual(run.status, "ok", run.error)
        batch = [c for c in self.net.calls if c.path == "/v1/querybatch"]
        self.assertEqual(batch[0].body["queries"], [
            {"package": {"purl": "pkg:npm/%40angular/core"}},
            {"package": {"purl": "pkg:pypi/django"}}])
        self.assertEqual(batch[1].body["queries"],
                         [{"package": {"purl": "pkg:pypi/django"}, "page_token": "t1"}])
        self.assertTrue(Cve.objects.filter(vuln_id="CVE-2024-45230").exists())
        self.assertEqual(run.counts["osv"]["unsupported"], 1)
        fetched = [c.path for c in self.net.calls if c.path.startswith("/v1/vulns/")]
        self.assertEqual(fetched, ["/v1/vulns/GHSA-5hgc-2vfp-mqvc"])

        self.net.calls.clear()
        self.assertEqual(self.run_once().status, "ok")
        self.assertFalse([c for c in self.net.calls if c.path.startswith("/v1/vulns/")])

        self.serve_batch("2025-01-01T00:00:00Z")
        self.net.calls.clear()
        self.run_once()
        self.assertTrue([c for c in self.net.calls if c.path.startswith("/v1/vulns/")])


class KeySecrecyTests(NetMixin, TestCase):
    def test_the_key_goes_only_to_nvd_and_nowhere_else(self):
        self.settings_(secrets={"nvd_api_key": KEY}, sync_kev=True, sync_epss=True)
        self.serve_nvd({0: ([_XE], 1)})
        self.net.on(NVD, "/rest/json/cves/2.0",
                    requests.ConnectionError(f"boom https://{NVD}/?apiKey={KEY}"),
                    (500, b"", {"message": "Internal error"}), (500, b"", {}), (500, b"", {}))
        self.net.on("www.cisa.gov", "/", (404, b"", {}))
        self.net.on("api.first.org", "/", (404, b"", {}))
        Cve.objects.create(vuln_id="CVE-2020-00001")
        records = []

        class Grab(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))
        handler = Grab(level=logging.DEBUG)
        root = logging.getLogger()
        root.addHandler(handler)
        self.addCleanup(root.removeHandler, handler)
        run = self.run_once()
        self.assertEqual(run.status, "failed")
        for c in self.net.calls:
            self.assertEqual("apiKey" in c.headers, c.host == NVD, c.host)
        blob = json.dumps([run.error, run.progress, run.counts], default=str)
        self.assertNotIn(KEY, blob)
        self.assertNotIn(KEY, "\n".join(records))
        self.assertNotIn(KEY, repr(fetch.config()))
        self.assertNotIn(KEY, VulnerabilitySettings.load().last_sync_error)


class EndpointBase(NetMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.admin = User.objects.create_superuser("root", password="x")
        self.user = User.objects.create_user("plain", password="x")
        override = override_settings(CACHES=LOCMEM)
        override.enable()
        self.addCleanup(override.disable)
        from django.core.cache import cache
        cache.clear()


class RefreshTests(EndpointBase):
    def test_refresh_is_admin_only_server_mode_only_and_one_at_a_time(self):
        self.client.force_login(self.user)
        self.assertEqual(self.client.post("/api/vulnerabilities/refresh/").status_code, 403)
        self.client.force_login(self.admin)
        self.settings_(update_source="upload")
        r = self.client.post("/api/vulnerabilities/refresh/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("update_source", r.json())
        self.settings_(update_source="server")
        queue = mock.MagicMock()
        with mock.patch("django_rq.get_queue", return_value=queue):
            r = self.client.post("/api/vulnerabilities/refresh/")
            self.assertEqual(r.status_code, 202, r.content)
            self.assertEqual(r.json()["via"], "server")
            queue.enqueue.assert_called_once()
            self.assertEqual(self.client.post("/api/vulnerabilities/refresh/").status_code, 409)
        self.assertEqual(self.net.calls, [])

    def test_refresh_with_the_queue_down_fails_the_run(self):
        self.client.force_login(self.admin)
        with mock.patch("django_rq.get_queue", side_effect=ConnectionError):
            self.assertEqual(self.client.post("/api/vulnerabilities/refresh/").status_code, 503)
        self.assertEqual(SyncRun.objects.get().status, "failed")


class CpeSearchTests(EndpointBase):
    URL = "/api/vulnerabilities/cpe/search/"

    def setUp(self):
        super().setUp()
        self.cpes = json.dumps({"resultsPerPage": 3, "startIndex": 0, "totalResults": 3,
                                "products": [
            {"cpe": {"cpeName": "cpe:2.3:o:cisco:ios_xe:17.9.4a:*:*:*:*:*:*:*",
                     "titles": [{"title": "Cisco IOS XE 17.9.4a", "lang": "en"}]}},
            {"cpe": {"cpeName": "cpe:2.3:o:cisco:ios_xe:17.9.5:*:*:*:*:*:*:*",
                     "titles": [{"title": "Cisco IOS XE 17.9.5", "lang": "en"}]}},
            {"cpe": {"cpeName": "cpe:2.3:a:cisco:ios_xe_sd-wan:16.12:*:*:*:*:*:*:*",
                     "titles": []}},
            {"cpe": {"cpeName": "not a cpe"}}]})
        self.net.on(NVD, "/rest/json/cpes/2.0", (200, self.cpes, {}))

    def get(self, q):
        return self.client.get(self.URL, {"q": q})

    def test_admin_only_and_off_while_disabled(self):
        self.client.force_login(self.user)
        self.assertEqual(self.get("ios xe").status_code, 403)
        self.client.force_login(self.admin)
        self.settings_(enabled=False)
        self.assertEqual(self.get("ios xe").status_code, 409)
        self.assertEqual(self.net.calls, [])

    def test_picker_users_may_search(self):
        """Anyone who may change a platform, device type or application in the
        active tenant may search; view alone, or a grant in another tenant,
        is not enough."""
        from auth_api.models import ObjectPermission, UserProfile
        from core.models import Organization, Tenant

        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="A", slug="a")
        other = Tenant.objects.create(org=org, name="B", slug="b")

        def member(name, types, actions, granted_in):
            user = User.objects.create_user(name, password="x")
            UserProfile.objects.create(user=user, role="custom").tenants.add(tenant, other)
            perm = ObjectPermission.objects.create(name=name, object_types=types,
                                                   actions=actions)
            perm.users.add(user)
            perm.tenants.add(granted_in)
            self.client.force_login(user)
            s = self.client.session
            s["current_tenant_id"] = str(tenant.pk)
            s.save()

        for name, types, actions, where, status in (
                ("plat", ["platform"], ["view", "change"], tenant, 200),
                ("app", ["application"], ["change"], tenant, 200),
                ("dtype", ["devicetype"], ["change"], tenant, 200),
                ("viewer", ["platform", "application"], ["view"], tenant, 403),
                ("device", ["device"], ["change"], tenant, 403),
                ("elsewhere", ["platform"], ["change"], other, 403)):
            with self.subTest(name=name):
                member(name, types, actions, where)
                r = self.get("ios xe")
                self.assertEqual(r.status_code, status, r.content)
                if status == 200:
                    self.assertIn(r.json()["remote_status"], ("ok", "cached"))
                    self.assertEqual(r.json()["remote"][0]["cpe"], "cpe:2.3:o:cisco:ios_xe")
                    self.assertNotIn(KEY, r.content.decode())
        # Still one NVD request: the answer is cached for everyone.
        self.assertEqual(len(self.net.calls), 1)

    def test_picker_users_share_the_limits(self):
        from auth_api.models import ObjectPermission, UserProfile
        from core.models import Organization, Tenant

        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="A", slug="a")
        user = User.objects.create_user("plat", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(tenant)
        perm = ObjectPermission.objects.create(name="p", object_types=["platform"],
                                               actions=["change"])
        perm.users.add(user)
        perm.tenants.add(tenant)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.pk)
        s.save()
        clock = mock.patch("vulnerabilities.fetch_api.time.time", return_value=3000.0)
        clock.start()
        self.addCleanup(clock.stop)
        statuses = [self.get(f"vendor{n}").json()["remote_status"] for n in range(4)]
        self.assertIn("limited", statuses)
        with mock.patch("vulnerabilities.fetch_api.USER_LIMIT", 1):
            self.assertEqual(self.get("more").status_code, 429)

    def test_outside_server_mode_nvd_is_not_asked(self):
        self.client.force_login(self.admin)
        self.settings_(update_source="browser")
        body = self.get("ios xe").json()
        self.assertEqual(body["remote_status"], "off")
        self.assertEqual(body["update_source"], "browser")
        self.assertEqual(self.net.calls, [])

    def test_server_mode_proxies_folds_and_caches(self):
        self.settings_(secrets={"nvd_api_key": KEY})
        self.client.force_login(self.admin)
        r = self.get("ios xe")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["remote_status"], "ok")
        self.assertEqual([(x["cpe"], x["names"]) for x in body["remote"]],
                         [("cpe:2.3:o:cisco:ios_xe", 2), ("cpe:2.3:a:cisco:ios_xe_sd-wan", 1)])
        self.assertEqual(self.net.calls[0].params["keywordSearch"], "ios xe")
        self.assertEqual(self.net.calls[0].ip, PUBLIC_IP)
        self.assertNotIn(KEY, r.content.decode())
        again = self.get("IOS  XE").json()
        self.assertEqual(again["remote_status"], "cached")
        self.assertEqual(len(self.net.calls), 1)

    def test_local_pairs_and_a_typed_name(self):
        self.client.force_login(self.admin)
        self.serve_nvd({0: ([_XE], 1)})
        self.run_once()
        self.net.calls.clear()
        body = self.get("cpe:2.3:o:cisco:ios_xe:17.9.4:*:*:*:*:*:*:*").json()
        self.assertEqual(body["typed"]["cpe"], "cpe:2.3:o:cisco:ios_xe")
        self.assertEqual(body["local"][0]["cves"], 1)
        self.assertEqual(self.net.calls, [])
        self.assertEqual(self.get("cpe:2.3:bad").status_code, 400)
        self.assertEqual(self.get("x").status_code, 400)

    def test_rate_limits(self):
        self.client.force_login(self.admin)
        clock = mock.patch("vulnerabilities.fetch_api.time.time", return_value=3000.0)
        clock.start()
        self.addCleanup(clock.stop)
        statuses = [self.get(f"vendor{n}").json()["remote_status"] for n in range(4)]
        self.assertEqual(statuses[: fetch_api_budget()], ["ok"] * fetch_api_budget())
        self.assertIn("limited", statuses)
        with mock.patch("vulnerabilities.fetch_api.USER_LIMIT", 1):
            self.assertEqual(self.get("more").status_code, 429)

    def test_an_nvd_error_keeps_the_local_answer(self):
        self.client.force_login(self.admin)
        self.net.on(NVD, "/rest/json/cpes/2.0", (503, b"", {}))
        body = self.get("ios xe").json()
        self.assertEqual(body["remote_status"], "error")
        self.assertEqual(len(self.net.calls), 1)   # interactive: no retries


def fetch_api_budget() -> int:
    from . import fetch_api

    return fetch_api.NVD_BUDGET


class CommandTests(NetMixin, TestCase):
    def test_a_good_run_is_recorded(self):
        self.serve_nvd({0: ([_XE], 1)})
        out = StringIO()
        call_command("vuln_refresh", stdout=out)
        self.assertIn("NVD 1 new", out.getvalue())
        self.assertEqual(ScheduledRun.objects.get(name="vuln-refresh").status, "ok")
        self.assertEqual(VulnerabilitySettings.load().last_sync_via, "server")

    def test_a_failed_run_fails_the_command(self):
        self.net.on(NVD, "/rest/json/cves/2.0", (404, b"", {}))
        with self.assertRaises(CommandError):
            call_command("vuln_refresh", stdout=StringIO())

    def test_newly_mapped_products_are_fetched_alone(self):
        self.set_tracked(IOS_XE, POSTGRES)
        self.serve_nvd({0: ([_PG], 1)})
        fetch.run_products_job([list(POSTGRES)])
        self.assertEqual([c.params["virtualMatchString"] for c in self.net.calls],
                         ["cpe:2.3:a:postgresql:postgresql"])
        self.assertFalse(SyncRun.objects.get().plan["resumable"])


class OsvQueryTests(SimpleTestCase):
    """Distro packages are asked for by release when every host's is known."""

    DEB = ("purl", "", "deb", "debian/openssl")
    APK = ("purl", "", "apk", "alpine/busybox")
    RPM = ("purl", "", "rpm", "rocky/openssl")

    def test_without_releases_by_purl(self):
        queries, unsupported = fetch.osv_queries([self.DEB, DJANGO])
        self.assertEqual(queries, [{"package": {"purl": "pkg:deb/debian/openssl"}},
                                   {"package": {"purl": "pkg:pypi/django"}}])
        self.assertEqual(unsupported, 0)

    def test_known_releases_by_ecosystem(self):
        releases = {self.DEB: {("debian", "12"), ("debian", "11")},
                    self.APK: {("alpine", "3.20")}}
        queries, _ = fetch.osv_queries([self.DEB, self.APK, DJANGO], releases)
        self.assertEqual(queries, [
            {"package": {"ecosystem": "Alpine:v3.20", "name": "busybox"}},
            {"package": {"ecosystem": "Debian:11", "name": "openssl"}},
            {"package": {"ecosystem": "Debian:12", "name": "openssl"}},
            {"package": {"purl": "pkg:pypi/django"}}])
        # Never the purl's distro qualifier: OSV answers nothing for debian-12.
        self.assertNotIn("distro=", json.dumps(queries))

    def test_an_unknown_release_or_rpm_keeps_the_purl(self):
        releases = {self.DEB: {("debian", "12"), None}, self.RPM: {("rocky", "9")}}
        queries, _ = fetch.osv_queries([self.DEB, self.RPM], releases)
        self.assertEqual(queries, [{"package": {"purl": "pkg:deb/debian/openssl"}},
                                   {"package": {"purl": "pkg:rpm/rocky/openssl"}}])
