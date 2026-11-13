"""Browser mode (#451): the run, its plan and cursors, and every post the
page makes - validated, bound to the admin's run, bounded, idempotent. The
browser is the test client; nothing leaves the test."""
from __future__ import annotations

import copy
import json
from datetime import timedelta
from decimal import Decimal
from unittest import mock

from django.contrib.auth.models import User
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.authentication import SessionAuthentication
from rest_framework.test import APIClient, APITestCase

from . import browser_api, browser_sync, products
from .models import CpeProductSync, Cve, SyncRun, VulnerabilitySettings
from .testing import DJANGO, IOS_XE, data

START = "/api/vulnerabilities/sync/"
KEY = "nvd-secret-key-0123456789"
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                      "LOCATION": "vuln-browser-tests"}}
XE = "o:cisco:ios_xe"

_BASE = json.loads(data("nvd_page.json"))
_XE_REC = _BASE["vulnerabilities"][0]
_PG_REC = _BASE["vulnerabilities"][1]


def xe_cve(n: int) -> dict:
    rec = copy.deepcopy(_XE_REC)
    rec["cve"]["id"] = f"CVE-2026-{n:05d}"
    return rec


def page(records, start: int = 0, total: int | None = None, **over) -> bytes:
    body = {"resultsPerPage": len(records), "startIndex": start,
            "totalResults": len(records) if total is None else total,
            "format": "NVD_CVE", "version": "2.0", "timestamp": "2026-11-10T00:00:00.000",
            "vulnerabilities": records}
    body.update(over)
    return json.dumps(body).encode()


def epss_answer(rows, day=None) -> bytes:
    day = day or timezone.now().date().isoformat()
    return json.dumps({"status": "OK", "data": [
        {"cve": c, "epss": e, "percentile": p, "date": day} for c, e, p in rows]}).encode()


@override_settings(CACHES=LOCMEM)
class Base(APITestCase):
    tracked: tuple = (IOS_XE,)

    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_superuser("root", password="x")
        self.other = User.objects.create_superuser("second", password="x")
        self.user = User.objects.create_user("plain", password="x")
        self._provider = lambda: list(self.tracked)
        products.register_provider(self._provider)
        self.addCleanup(products.unregister_provider, self._provider)
        VulnerabilitySettings.objects.update_or_create(
            pk=1, defaults={"enabled": True, "update_source": "browser"})
        self.client.force_login(self.admin)

    def start(self, client=None):
        r = (client or self.client).post(START, {"via": "browser"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def post_nvd(self, run_id, body: bytes, *, product=XE, start=0, client=None):
        return (client or self.client).post(
            f"{START}{run_id}/nvd/?product={product}&start_index={start}", body,
            content_type="application/json")

    def post_raw(self, run_id, what: str, body: bytes, query: str = ""):
        return self.client.post(f"{START}{run_id}/{what}/{query}", body,
                                content_type="application/json")


class AccessTests(Base):
    def test_non_admin_and_anonymous_are_refused(self):
        run = self.start()
        self.client.force_login(self.user)
        self.assertEqual(self.client.post(START, {}, format="json").status_code, 403)
        self.assertEqual(self.post_nvd(run["id"], page([_XE_REC])).status_code, 403)
        self.assertEqual(self.client.post(f"{START}{run['id']}/finish/", {},
                                          format="json").status_code, 403)
        self.client.logout()
        self.assertIn(self.client.post(START, {}, format="json").status_code, (401, 403))

    def test_session_only_and_csrf_enforced(self):
        # An API token cannot drive a browser sync, and a session needs CSRF.
        for view in (browser_api.sync_start, browser_api.sync_nvd, browser_api.sync_epss,
                     browser_api.sync_osv, browser_api.sync_osv_ids,
                     browser_api.sync_epss_plan, browser_api.sync_finish):
            self.assertEqual(view.cls.authentication_classes, [SessionAuthentication])
        strict = APIClient(enforce_csrf_checks=True)
        strict.force_login(self.admin)
        self.assertEqual(strict.post(START, {}, format="json").status_code, 403)
        self.assertFalse(SyncRun.objects.exists())

    def test_only_in_browser_mode_and_while_on(self):
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="upload")
        r = self.client.post(START, {}, format="json")
        self.assertEqual(r.status_code, 409)
        self.assertIn("update_source", r.json())
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="browser",
                                                          enabled=False)
        self.assertEqual(self.client.post(START, {}, format="json").status_code, 409)

    def test_posts_stop_when_the_source_changes(self):
        run = self.start()
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="server")
        self.assertEqual(self.post_nvd(run["id"], page([_XE_REC])).status_code, 409)
        self.assertFalse(Cve.objects.exists())

    def test_nothing_mapped_has_nothing_to_fetch(self):
        products.unregister_provider(self._provider)
        self.assertEqual(self.client.post(START, {}, format="json").status_code, 409)

    def test_only_browser_runs_start_here(self):
        r = self.client.post(START, {"via": "server"}, format="json")
        self.assertEqual(r.status_code, 400)


class PlanTests(Base):
    tracked = (IOS_XE, DJANGO)

    def test_new_product_is_fetched_whole(self):
        run = self.start()
        (entry,) = run["plan"]["nvd"]
        self.assertEqual(entry["product"], XE)
        self.assertEqual(entry["params"], {"virtualMatchString": "cpe:2.3:o:cisco:ios_xe"})
        self.assertIsNone(entry["since"])
        self.assertEqual(run["plan"]["urls"]["nvd"],
                         "https://services.nvd.nist.gov/rest/json/cves/2.0")
        self.assertEqual(run["plan"]["urls"]["epss"], "https://api.first.org/data/v1/epss")
        self.assertEqual(run["plan"]["page_size"], 500)
        self.assertEqual(run["plan"]["osv"]["queries"],
                         [{"package": {"purl": "pkg:pypi/django"}}])
        self.assertEqual(run["via"], "browser")
        self.assertEqual(run["started_by"], "root")

    def test_recent_cursor_asks_only_for_changes(self):
        # The same cursor server mode keeps: younger than 110 days → window.
        synced = timezone.now() - timedelta(days=3)
        CpeProductSync.objects.create(part="o", vendor="cisco", product="ios_xe",
                                      last_synced_at=synced)
        (entry,) = self.start()["plan"]["nvd"]
        self.assertIn("lastModStartDate", entry["params"])
        self.assertEqual(entry["params"]["lastModEndDate"], entry["until"])
        self.assertTrue(entry["since"].startswith(
            (synced - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M")))

    def test_old_cursor_refetches_whole(self):
        CpeProductSync.objects.create(part="o", vendor="cisco", product="ios_xe",
                                      last_synced_at=timezone.now() - timedelta(days=200))
        (entry,) = self.start()["plan"]["nvd"]
        self.assertNotIn("lastModStartDate", entry["params"])

    def test_mirror_urls_are_planned(self):
        VulnerabilitySettings.objects.filter(pk=1).update(nvd_url="https://nvd.mirror.example")
        run = self.start()
        self.assertEqual(run["plan"]["urls"]["nvd"],
                         "https://nvd.mirror.example/rest/json/cves/2.0")

    def test_the_stored_key_is_never_planned_or_returned(self):
        row = VulnerabilitySettings.load()
        row.secrets = {"nvd_api_key": KEY}
        row.save()
        run = self.start()
        self.assertNotIn(KEY, json.dumps(run))
        self.assertNotIn(KEY, self.client.get(f"{START}{run['id']}/").content.decode())
        self.assertNotIn(KEY, self.client.get("/api/vulnerabilities/settings/")
                         .content.decode())
        self.assertNotIn(KEY, json.dumps(SyncRun.objects.get().plan))

    def test_a_key_posted_is_not_stored(self):
        # The page never sends one; a body that carries one is ignored.
        run = self.start()
        r = self.client.post(f"{START}{run['id']}/finish/", {"apiKey": KEY, "errors": []},
                             format="json")
        self.assertEqual(r.status_code, 200)
        row = SyncRun.objects.get()
        self.assertNotIn(KEY, json.dumps([row.plan, row.progress, row.counts, row.error]))
        self.assertFalse((VulnerabilitySettings.load().secrets or {}).get("nvd_api_key"))

    def test_same_admin_gets_the_open_run_another_is_refused(self):
        run = self.start()
        self.assertEqual(self.start()["id"], run["id"])
        other = APIClient()
        other.force_login(self.other)
        r = other.post(START, {}, format="json")
        self.assertEqual(r.status_code, 409)
        self.assertIn("root", r.json()["detail"])

    def test_one_update_at_a_time(self):
        SyncRun.objects.create(via="server", started_at=timezone.now(), status="running")
        self.assertEqual(self.client.post(START, {}, format="json").status_code, 409)


class NvdIngestTests(Base):
    def test_page_is_stored_as_browser_data_and_moves_the_cursor(self):
        run = self.start()
        r = self.post_nvd(run["id"], page([_XE_REC]))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["done"])
        self.assertEqual(body["start_index"], 1)
        self.assertEqual(body["created"], 1)
        cve = Cve.objects.get(vuln_id="CVE-2023-20198")
        self.assertEqual(cve.source, "browser")
        self.assertEqual(cve.cvss_score, Decimal("10.0"))
        self.assertTrue(cve.cvss_verified)
        self.assertEqual(str(cve.kev_added), "2023-10-16")
        sync = CpeProductSync.objects.get(product="ios_xe")
        self.assertEqual(sync.last_status, "ok")
        self.assertIsNotNone(sync.last_synced_at)

    def test_paging_in_order(self):
        run = self.start()
        r = self.post_nvd(run["id"], page([xe_cve(1), xe_cve(2)], 0, 3))
        self.assertEqual(r.json()["start_index"], 2)
        self.assertFalse(r.json()["done"])
        # A gap is refused with where to go on.
        r = self.post_nvd(run["id"], page([xe_cve(4)], 3, 4), start=3)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["expected"], 2)
        r = self.post_nvd(run["id"], page([xe_cve(3)], 2, 3), start=2)
        self.assertTrue(r.json()["done"])
        self.assertEqual(Cve.objects.count(), 3)

    def test_replay_is_idempotent(self):
        run = self.start()
        body = page([xe_cve(1), xe_cve(2)], 0, 3)
        self.post_nvd(run["id"], body)
        before = list(Cve.objects.values_list("vuln_id", "fetched_at"))
        r = self.post_nvd(run["id"], body)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["duplicate"])
        self.assertEqual(r.json()["start_index"], 2)
        self.assertEqual(list(Cve.objects.values_list("vuln_id", "fetched_at")), before)

    def test_tampered_score_is_dropped_and_severity_derived(self):
        rec = copy.deepcopy(_XE_REC)
        for m in rec["cve"]["metrics"]["cvssMetricV31"]:
            m["cvssData"]["baseScore"] = 3.1
            m["cvssData"]["baseSeverity"] = "LOW"
        run = self.start()
        r = self.post_nvd(run["id"], page([rec]))
        self.assertEqual(r.json()["cvss_mismatch"], 1)
        cve = Cve.objects.get()
        self.assertIsNone(cve.cvss_score)
        self.assertFalse(cve.cvss_verified)
        self.assertEqual(cve.cvss_severity, "")

    def test_claimed_severity_is_ignored(self):
        rec = copy.deepcopy(_XE_REC)
        for m in rec["cve"]["metrics"]["cvssMetricV31"]:
            m["cvssData"]["baseSeverity"] = "LOW"
        run = self.start()
        self.post_nvd(run["id"], page([rec]))
        self.assertEqual(Cve.objects.get().cvss_severity, "critical")

    def test_records_of_another_product_are_dropped(self):
        # A PostgreSQL record posted as an IOS XE page is not stored.
        run = self.start()
        r = self.post_nvd(run["id"], page([_PG_REC, _XE_REC]))
        self.assertEqual(r.json()["not_tracked"], 1)
        self.assertEqual(list(Cve.objects.values_list("vuln_id", flat=True)),
                         ["CVE-2023-20198"])

    def test_product_not_in_the_plan(self):
        run = self.start()
        r = self.post_nvd(run["id"], page([_PG_REC]), product="a:postgresql:postgresql")
        self.assertEqual(r.status_code, 400)
        self.assertIn("product", r.json())
        self.assertEqual(self.post_nvd(run["id"], page([]), product="nonsense")
                         .status_code, 400)

    def test_envelope_is_checked(self):
        run = self.start()
        for body in (page([_XE_REC], format="OSV"), page([_XE_REC], version="1.0"),
                     page([_XE_REC], start=5), page([_XE_REC], totalResults="x"),
                     page([_XE_REC], resultsPerPage=5000),
                     page([_XE_REC, xe_cve(1)], resultsPerPage=1),
                     b"[1, 2]", b"not json"):
            with self.subTest(body=body[:60]):
                self.assertEqual(self.post_nvd(run["id"], body).status_code, 400)
        self.assertFalse(Cve.objects.exists())

    def test_mismatched_start_index(self):
        run = self.start()
        r = self.post_nvd(run["id"], page([_XE_REC], 0, 1), start=1)
        self.assertEqual(r.status_code, 400)

    def test_invalid_records_are_counted_and_skipped(self):
        bad = copy.deepcopy(_XE_REC)
        bad["cve"]["id"] = "CVE-nope"
        run = self.start()
        r = self.post_nvd(run["id"], page([bad, _XE_REC]))
        self.assertEqual(r.json()["invalid"], 1)
        self.assertTrue(r.json()["done"])
        self.assertEqual(Cve.objects.count(), 1)

    def test_empty_page_before_the_end_is_an_error(self):
        run = self.start()
        r = self.post_nvd(run["id"], page([], 0, 5, resultsPerPage=500))
        self.assertEqual(r.status_code, 422)
        p = SyncRun.objects.get().progress["nvd"][XE]
        self.assertIn("stopped", p["error"])

    def test_size_caps(self):
        run = self.start()
        big = b" " * (browser_sync.NVD_POST_MAX + 1)
        self.assertEqual(self.post_nvd(run["id"], big).status_code, 413)
        r = self.client.post(f"{START}{run['id']}/nvd/?product={XE}&start_index=0",
                             page([_XE_REC]), content_type="text/plain")
        self.assertEqual(r.status_code, 415)

    def test_run_record_ceiling(self):
        run = self.start()
        SyncRun.objects.filter(pk=run["id"]).update(
            counts={"nvd": {"records": browser_sync.RUN_CVE_MAX}})
        self.assertEqual(self.post_nvd(run["id"], page([_XE_REC])).status_code, 413)

    def test_wrong_owner_unknown_and_closed_runs(self):
        run = self.start()
        other = APIClient()
        other.force_login(self.other)
        self.assertEqual(self.post_nvd(run["id"], page([_XE_REC]), client=other).status_code,
                         403)
        self.assertEqual(self.post_nvd("00000000-0000-0000-0000-000000000000",
                                       page([_XE_REC])).status_code, 404)
        server = SyncRun.objects.create(via="upload", started_at=timezone.now(),
                                        status="ok", started_by=self.admin)
        self.assertEqual(self.post_nvd(server.pk, page([_XE_REC])).status_code, 404)
        SyncRun.objects.filter(pk=run["id"]).update(status="abandoned")
        r = self.post_nvd(run["id"], page([_XE_REC]))
        self.assertEqual(r.status_code, 409)
        self.assertFalse(Cve.objects.exists())

    def test_rate_limited(self):
        run = self.start()
        # One window for the whole burst: the posts are bucketed by the clock
        # and the count lives two windows in the cache, so a slow run that
        # crossed a boundary or outlived the key started a fresh count.
        with mock.patch.object(browser_api, "time") as clock, \
                mock.patch.object(browser_sync, "POST_WINDOW", 3600):
            clock.time.return_value = 1_000_000_005.0
            codes = [self.post_nvd(run["id"], page([_XE_REC])).status_code
                     for _ in range(browser_sync.POST_LIMIT + 1)]
        self.assertEqual(codes[-1], 429)
        self.assertEqual(codes[:-1].count(429), 0)


class EpssIngestTests(Base):
    def setUp(self):
        super().setUp()
        self.run_ = self.start()
        self.post_nvd(self.run_["id"], page([_XE_REC, xe_cve(7)]))

    def plan(self):
        r = self.post_raw(self.run_["id"], "epss-plan", b"")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_plan_lists_the_stored_cves(self):
        self.assertEqual(self.plan()["batches"], [["CVE-2023-20198", "CVE-2026-00007"]])

    def test_answer_is_stored_and_replay_is_a_no_op(self):
        self.plan()
        body = epss_answer([("CVE-2023-20198", "0.94379", "0.99961"),
                            ("CVE-2026-00007", "0.1", "0.5")])
        r = self.post_raw(self.run_["id"], "epss", body, "?batch=0")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["stored"], 2)
        self.assertEqual(Cve.objects.get(vuln_id="CVE-2023-20198").epss, Decimal("0.94379"))
        r = self.post_raw(self.run_["id"], "epss", body, "?batch=0")
        self.assertTrue(r.json()["duplicate"])

    def test_bad_rows_are_refused(self):
        self.plan()
        future = (timezone.now().date() + timedelta(days=5)).isoformat()
        body = json.dumps({"data": [
            {"cve": "CVE-2023-20198", "epss": "1.5", "percentile": "0.5",
             "date": timezone.now().date().isoformat()},
            {"cve": "CVE-2026-00007", "epss": "0.5", "percentile": "0.5", "date": future},
            {"cve": "CVE-1999-0001", "epss": "0.5", "percentile": "0.5",
             "date": timezone.now().date().isoformat()},
        ]}).encode()
        r = self.post_raw(self.run_["id"], "epss", body, "?batch=0")
        # Nothing usable is left: the batch fails, nothing is written.
        self.assertEqual(r.status_code, 422)
        self.assertFalse(Cve.objects.exclude(epss=None).exists())

    def test_old_scores_are_refused(self):
        self.plan()
        old = (timezone.now().date() - timedelta(days=40)).isoformat()
        r = self.post_raw(self.run_["id"], "epss",
                          epss_answer([("CVE-2023-20198", "0.9", "0.9")], old), "?batch=0")
        self.assertEqual(r.status_code, 422)

    def test_plan_first_and_known_batches_only(self):
        r = self.post_raw(self.run_["id"], "epss", epss_answer([]), "?batch=0")
        self.assertEqual(r.status_code, 409)
        self.plan()
        r = self.post_raw(self.run_["id"], "epss", epss_answer([]), "?batch=4")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.post_raw(self.run_["id"], "epss", b"{}", "?batch=0")
                         .status_code, 400)


class OsvIngestTests(Base):
    tracked = (DJANGO,)

    def test_ids_then_records(self):
        run = self.start()
        record = json.loads(data("osv_django.json"))
        r = self.post_raw(run["id"], "osv-ids",
                          json.dumps({"vulns": {record["id"]: record["modified"],
                                                "bad id!": "x"}}).encode())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["to_fetch"], [record["id"]])
        stray = copy.deepcopy(record)
        stray["id"] = "GHSA-zzzz-zzzz-zzzz"
        r = self.post_raw(run["id"], "osv", json.dumps([record, stray]).encode())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["stored"], 1)
        self.assertEqual(r.json()["dropped"], 1)
        self.assertTrue(r.json()["done"])
        self.assertEqual(Cve.objects.get().vuln_id, "CVE-2024-45230")

    def test_records_before_ids(self):
        run = self.start()
        r = self.post_raw(run["id"], "osv", data("osv_django.json"))
        self.assertEqual(r.status_code, 409)


class FinishAndResumeTests(Base):
    def test_finish_ok_enqueues_recompute(self):
        run = self.start()
        self.post_nvd(run["id"], page([_XE_REC]))
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            r = self.client.post(f"{START}{run['id']}/finish/", {}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")
        self.assertTrue(callbacks)
        settings = VulnerabilitySettings.load()
        self.assertEqual(settings.last_sync_via, "browser")
        self.assertEqual(settings.last_sync_status, "ok")

    def test_unfinished_product_fails_the_run_and_its_cursor(self):
        run = self.start()
        r = self.client.post(f"{START}{run['id']}/finish/",
                             {"errors": ["NVD o:cisco:ios_xe: CORS refused"]}, format="json")
        body = r.json()
        self.assertEqual(body["status"], "failed")
        self.assertIn("CORS refused", body["error"])
        self.assertIn("not finished", body["error"])
        self.assertEqual(CpeProductSync.objects.get().last_status, "failed")
        self.assertIsNone(CpeProductSync.objects.get().last_synced_at)

    def test_stop_then_resume_keeps_progress(self):
        run = self.start()
        self.post_nvd(run["id"], page([xe_cve(1)], 0, 2))
        r = self.client.post(f"{START}{run['id']}/finish/", {"stop": True}, format="json")
        self.assertEqual(r.json()["status"], "abandoned")
        again = self.start()
        self.assertEqual(again["id"], run["id"])
        self.assertEqual(again["status"], "running")
        self.assertEqual(again["progress"]["nvd"][XE]["start_index"], 1)
        self.assertEqual(again["progress"]["resumed"], 1)

    def test_idle_run_is_abandoned_and_another_admin_resumes(self):
        run = self.start()
        self.post_nvd(run["id"], page([xe_cve(1)], 0, 2))
        SyncRun.objects.filter(pk=run["id"]).update(
            updated_at=timezone.now() - timedelta(minutes=31))
        other = APIClient()
        other.force_login(self.other)
        again = self.start(client=other)
        self.assertEqual(again["id"], run["id"])
        self.assertEqual(again["started_by"], "second")
        # The first admin's page can no longer post to it.
        r = self.post_nvd(run["id"], page([xe_cve(2)], 1, 2), start=1)
        self.assertEqual(r.status_code, 403)
        r = self.post_nvd(run["id"], page([xe_cve(2)], 1, 2), start=1, client=other)
        self.assertTrue(r.json()["done"])

    def test_resume_adds_newly_mapped_products(self):
        run = self.start()
        self.client.post(f"{START}{run['id']}/finish/", {"stop": True}, format="json")
        self.tracked = (IOS_XE, ("cpe", "o", "juniper", "junos"))
        again = self.start()
        self.assertEqual([e["product"] for e in again["plan"]["nvd"]],
                         [XE, "o:juniper:junos"])

    def test_finished_ok_runs_are_not_resumed(self):
        run = self.start()
        self.post_nvd(run["id"], page([_XE_REC]))
        self.client.post(f"{START}{run['id']}/finish/", {}, format="json")
        self.assertNotEqual(self.start()["id"], run["id"])
