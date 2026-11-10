"""Storing parsed records: tracked-product filter, replay, NVD/OSV merge,
KEV and EPSS onto stored rows."""
from __future__ import annotations

import io
import json
from datetime import date
from decimal import Decimal

from django.test import TestCase

from . import imports, products, sources, store
from .models import Cve, CveProduct
from .streaming import open_stream
from .testing import DJANGO, IOS_XE, POSTGRES, data, tracking


def nvd_records(raw: bytes):
    return list(sources.iter_nvd(open_stream(io.BytesIO(raw), max_bytes=10**8)))


def osv_records(name: str):
    return list(sources.iter_osv_json(open_stream(io.BytesIO(data(name)), max_bytes=10**8)))


class StoreTests(TestCase):
    def test_only_tracked_products_are_kept(self):
        with tracking(IOS_XE):
            counts = store.store_records(nvd_records(data("nvd_page.json")),
                                         source="nvd_feed", tracked=products.tracked())
        self.assertEqual(counts["records"], 4)
        self.assertEqual(counts["created"], 1)
        # PostgreSQL is not tracked; the awaiting-analysis and rejected CVEs
        # name no product at all.
        self.assertEqual(counts["not_tracked"], 3)
        row = Cve.objects.get()
        self.assertEqual(row.vuln_id, "CVE-2023-20198")
        self.assertEqual(row.cvss_score, Decimal("10.0"))
        self.assertEqual(row.cvss_severity, "critical")
        self.assertTrue(row.cvss_verified)
        self.assertEqual(row.kev_added, date(2023, 10, 16))
        self.assertEqual(row.source, "nvd_feed")
        self.assertEqual(
            list(CveProduct.objects.values_list("kind", "part", "vendor", "product")),
            [("cpe", "o", "cisco", "ios_xe")])

    def test_nothing_tracked_stores_nothing(self):
        counts = store.store_records(nvd_records(data("nvd_page.json")), source="nvd_feed",
                                     tracked=products.tracked())
        self.assertEqual(counts["created"], 0)
        self.assertFalse(Cve.objects.exists())

    def test_replay_is_a_no_op_and_newer_wins(self):
        with tracking(IOS_XE, POSTGRES):
            store.store_records(nvd_records(data("nvd_page.json")), source="nvd_feed",
                                tracked=products.tracked())
            before = dict(Cve.objects.values_list("vuln_id", "fetched_at"))
            with self.assertNumQueries(1):
                counts = store.store_records(nvd_records(data("nvd_page.json")),
                                             source="nvd_feed", tracked=products.tracked())
            self.assertEqual((counts["created"], counts["updated"], counts["unchanged"]),
                             (0, 0, 2))
            self.assertEqual(dict(Cve.objects.values_list("vuln_id", "fetched_at")), before)

            page = json.loads(data("nvd_page.json"))
            xe = page["vulnerabilities"][0]["cve"]
            xe["lastModified"] = "2026-01-01T00:00:00.000"
            xe["descriptions"][0]["value"] = "Updated text."
            older = json.loads(data("nvd_page.json"))
            older["vulnerabilities"][1]["cve"]["lastModified"] = "2024-12-01T00:00:00.000"
            older["vulnerabilities"][1]["cve"]["descriptions"][0]["value"] = "Stale."
            counts = store.store_records(
                nvd_records(json.dumps(page).encode()) + nvd_records(json.dumps(older).encode()),
                source="nvd_api", tracked=products.tracked())
        self.assertEqual(Cve.objects.get(vuln_id="CVE-2023-20198").summary, "Updated text.")
        self.assertNotEqual(Cve.objects.get(vuln_id="CVE-2024-10979").summary, "Stale.")
        self.assertEqual(counts["updated"], 1)

    def test_osv_merges_into_the_cve_row(self):
        page = json.loads(data("nvd_page.json"))
        nvd_django = json.loads(json.dumps(page["vulnerabilities"][1]["cve"]))
        nvd_django.update({
            "id": "CVE-2024-45230",
            "configurations": [{"nodes": [{"operator": "OR", "negate": False, "cpeMatch": [
                {"vulnerable": True,
                 "criteria": "cpe:2.3:a:djangoproject:django:*:*:*:*:*:*:*:*",
                 "versionStartIncluding": "5.0", "versionEndExcluding": "5.0.9"}]}]}],
        })
        page["vulnerabilities"] = [{"cve": nvd_django}]
        with tracking(DJANGO, ("cpe", "a", "djangoproject", "django")):
            # OSV first: the row is filled from the advisory.
            store.store_records(osv_records("osv_django.json"), source="osv",
                                tracked=products.tracked())
            row = Cve.objects.get()
            self.assertEqual(row.vuln_id, "CVE-2024-45230")
            self.assertEqual(row.source, "osv")
            self.assertEqual(row.cvss_score, Decimal("7.5"))
            self.assertEqual(row.aliases, ["GHSA-5hgc-2vfp-mqvc", "PYSEC-2024-83"])
            # Then NVD: its fields win, the advisory stays.
            store.store_records(nvd_records(json.dumps(page).encode()), source="nvd_feed",
                                tracked=products.tracked())
        row.refresh_from_db()
        self.assertEqual(row.source, "nvd_feed")
        self.assertEqual(row.cvss_score, Decimal("8.8"))
        self.assertIn("GHSA-5hgc-2vfp-mqvc", row.osv)
        self.assertEqual(row.aliases, ["GHSA-5hgc-2vfp-mqvc", "PYSEC-2024-83"])
        self.assertEqual(
            set(CveProduct.objects.values_list("kind", "vendor", "product")),
            {("purl", "pypi", "django"), ("cpe", "djangoproject", "django")})
        # A replayed advisory changes nothing.
        with tracking(DJANGO):
            counts = store.store_records(osv_records("osv_django.json"), source="osv",
                                         tracked=products.tracked())
        self.assertEqual(counts["unchanged"], 1)

    def test_osv_only_record_under_its_own_id(self):
        with tracking(("purl", "", "npm", "example-merge")):
            store.store_records(osv_records("osv_npm.json"), source="osv",
                                tracked=products.tracked())
        row = Cve.objects.get()
        self.assertEqual(row.vuln_id, "GHSA-2222-3333-4444")
        self.assertEqual(row.cvss_version, "4.0")
        self.assertIsNone(row.cvss_score)

    def test_kev_and_epss_apply_to_stored_rows_only(self):
        with tracking(IOS_XE, POSTGRES):
            store.store_records(nvd_records(data("nvd_page.json")), source="nvd_feed",
                                tracked=products.tracked())
        with open(imports.__file__.replace("imports.py", "testdata/kev.json"), "rb") as fh:
            counts = imports.process("kev", fh)
        self.assertEqual((counts["updated"], counts["not_in_store"]), (1, 1))
        xe = Cve.objects.get(vuln_id="CVE-2023-20198")
        self.assertEqual(xe.kev_ransomware, "known")
        # Replaying the catalog changes nothing.
        counts = imports.process("kev", io.BytesIO(data("kev.csv")))
        self.assertEqual((counts["updated"], counts["unchanged"], counts["invalid"]), (0, 1, 1))

        counts = imports.process("epss", io.BytesIO(data("epss.csv")))
        self.assertEqual(counts["updated"], 2)
        self.assertEqual(counts["invalid"], 1)
        xe.refresh_from_db()
        self.assertEqual(xe.epss, Decimal("0.94379"))
        self.assertEqual(xe.epss_date, date(2026, 11, 9))
        # An older file never rolls the score back.
        old = data("epss.csv").replace(b"2026-11-09", b"2026-10-01").replace(
            b"0.94379", b"0.10000")
        counts = imports.process("epss", io.BytesIO(old))
        self.assertEqual(counts["updated"], 0)
        xe.refresh_from_db()
        self.assertEqual(xe.epss, Decimal("0.94379"))

    def test_after_store_hook_gets_the_changed_ids(self):
        seen: list = []
        store.register_after_store(seen.append)
        try:
            with tracking(IOS_XE):
                store.store_records(nvd_records(data("nvd_page.json")), source="nvd_feed",
                                    tracked=products.tracked())
                store.store_records(nvd_records(data("nvd_page.json")), source="nvd_feed",
                                    tracked=products.tracked())
        finally:
            store.unregister_after_store(seen.append)
        self.assertEqual(seen, [{"CVE-2023-20198"}])
