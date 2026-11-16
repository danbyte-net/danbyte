"""Parsers: NVD API 2.0 pages and feeds, OSV, KEV and EPSS, plus the
streaming readers' limits. No database."""
from __future__ import annotations

import gzip
import io
import json
import zipfile
from datetime import date
from decimal import Decimal
from unittest import mock

from django.test import SimpleTestCase

from . import sources, streaming
from .identifiers import cpe_product, package_key, purl_key
from .streaming import ImportFormatError, JsonStream, LimitExceeded, open_stream
from .testing import Trickle, data


def nvd(raw: bytes, **kw):
    errors: list = []
    out = list(sources.iter_nvd(open_stream(io.BytesIO(raw), max_bytes=10**8),
                                errors=errors, **kw))
    return out, errors


def page_with(*cves) -> bytes:
    return json.dumps({
        "resultsPerPage": len(cves), "startIndex": 0, "totalResults": len(cves),
        "format": "NVD_CVE", "version": "2.0", "timestamp": "2026-11-09T10:00:00.000",
        "vulnerabilities": [{"cve": c} for c in cves],
    }).encode()


def cve(**over):
    base = json.loads(data("nvd_page.json"))["vulnerabilities"][0]["cve"]
    base.update(over)
    return base


class NvdTests(SimpleTestCase):
    def test_page_fixture(self):
        records, errors = nvd(data("nvd_page.json"))
        self.assertEqual(errors, [])
        by_id = {r["vuln_id"]: r for r in records}
        self.assertEqual(list(by_id), ["CVE-2023-20198", "CVE-2024-10979", "CVE-2025-1094",
                                       "CVE-2023-4000"])

        xe = by_id["CVE-2023-20198"]
        self.assertEqual(xe["cvss"]["score"], Decimal("10.0"))
        self.assertEqual(xe["cvss"]["severity"], "critical")
        self.assertTrue(xe["cvss"]["verified"])
        self.assertEqual(xe["cvss"]["attack_vector"], "network")
        self.assertEqual(xe["kev"]["added"], date(2023, 10, 16))
        self.assertEqual(xe["kev"]["due"], date(2023, 10, 20))
        self.assertEqual(xe["products"], {("cpe", "o", "cisco", "ios_xe")})
        self.assertEqual(xe["cwes"], ["CWE-420"])
        self.assertTrue(xe["summary"].startswith("Cisco is providing"))
        # Only http(s) references are kept.
        self.assertEqual(len(xe["references"]), 1)

        pg = by_id["CVE-2024-10979"]
        self.assertEqual(pg["cvss"]["score"], Decimal("8.8"))
        self.assertEqual([f["version"] for f in pg["fixed_in"]], ["15.9", "16.5"])
        self.assertEqual(pg["configurations"][0]["nodes"][0]["cpeMatch"][0]
                         ["versionEndExcluding"], "16.5")
        self.assertNotIn("matchCriteriaId", pg["configurations"][0]["nodes"][0]["cpeMatch"][0])

        awaiting = by_id["CVE-2025-1094"]
        self.assertEqual(awaiting["configurations"], [])
        self.assertEqual(awaiting["products"], set())
        # A CNA's secondary score is used when NVD has none of its own.
        self.assertEqual(awaiting["cvss"]["score"], Decimal("8.1"))

        rejected = by_id["CVE-2023-4000"]
        self.assertTrue(rejected["rejected"])
        self.assertIsNone(rejected["cvss"])

    def test_feed_streamed_across_read_boundaries(self):
        raw = gzip.compress(data("nvd_page.json"))
        reader = open_stream(Trickle(raw, step=5), max_bytes=10**7)
        records = list(sources.iter_nvd(reader))
        self.assertEqual(len(records), 4)
        # A 7-byte JsonStream chunk splits numbers and strings too.
        stream = JsonStream(Trickle(data("nvd_page.json"), step=3), value_cap=10**6, chunk=7)
        header: dict = {}
        items = list(stream.iter_object(stream_keys={"vulnerabilities"}, header_cap=4096,
                                        max_items=10, header=header))
        self.assertEqual(len(items), 4)
        self.assertEqual(header["totalResults"], 4)
        self.assertEqual(header["timestamp"], "2026-11-09T10:12:31.457")

    def test_tampered_score_is_dropped_and_severity_derived(self):
        tampered = cve()
        tampered["metrics"]["cvssMetricV31"] = [{
            "source": "nvd@nist.gov", "type": "Primary",
            "cvssData": {"version": "3.1",
                         "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
                         "baseScore": 9.9, "baseSeverity": "CRITICAL"}}]
        (rec,), _ = nvd(page_with(tampered))
        self.assertIsNone(rec["cvss"])
        self.assertTrue(rec["cvss_mismatch"])

        lying = cve()
        lying["metrics"]["cvssMetricV31"] = [{
            "source": "nvd@nist.gov", "type": "Primary",
            "cvssData": {"version": "3.1",
                         "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
                         "baseScore": 7.5, "baseSeverity": "LOW"}}]
        (rec,), _ = nvd(page_with(lying))
        self.assertEqual(rec["cvss"]["severity"], "high")

    def test_cvss_v4_and_v2_kept_unverified(self):
        v4 = cve(metrics={"cvssMetricV40": [{
            "source": "x", "type": "Secondary",
            "cvssData": {"version": "4.0", "baseScore": 9.3,
                         "vectorString": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"}}]})
        (rec,), _ = nvd(page_with(v4))
        self.assertEqual(rec["cvss"]["version"], "4.0")
        self.assertFalse(rec["cvss"]["verified"])
        self.assertEqual(rec["cvss"]["severity"], "critical")
        v2 = cve(metrics={"cvssMetricV2": [{
            "source": "nvd@nist.gov", "type": "Primary",
            "cvssData": {"version": "2.0", "baseScore": 10.0,
                         "vectorString": "AV:N/AC:L/Au:N/C:C/I:C/A:C"}}]})
        (rec,), _ = nvd(page_with(v2))
        self.assertEqual(rec["cvss"]["severity"], "high")

    def test_bad_records_are_skipped_and_counted(self):
        bad = [
            cve(id="CVE-XXXX-1"),
            cve(published="yesterday"),
            cve(published="2025-01-02T00:00:00.000", lastModified="2025-01-01T00:00:00.000"),
        ]
        records, errors = nvd(page_with(cve(), *bad))
        self.assertEqual(len(records), 1)
        self.assertEqual(len(errors), 3)

    def test_kev_due_before_added_drops_the_due_date(self):
        (rec,), _ = nvd(page_with(cve(cisaActionDue="2023-10-01")))
        self.assertIsNone(rec["kev"]["due"])

    def test_envelope_is_checked(self):
        for raw in (
            json.dumps({"format": "OTHER", "version": "2.0", "vulnerabilities": []}).encode(),
            json.dumps({"format": "NVD_CVE", "version": "1.1",
                        "vulnerabilities": [{"cve": cve()}]}).encode(),
            b"[]",
            b'{"format": "NVD_CVE", "version": "2.0", "vulnerabilities": [{"cve": ',
            b'{"format": "NVD_CVE", "version": "2.0", "vulnerabilities": []} trailing',
            b"\xff\xfe not utf-8",
        ):
            with self.subTest(raw=raw[:30]), self.assertRaises(ImportFormatError):
                nvd(raw)

    def test_parse_page_payload(self):
        payload = json.loads(data("nvd_page.json"))
        self.assertEqual(len(sources.parse_nvd_page(payload)), 4)
        payload["vulnerabilities"] = [{}] * 2001
        with self.assertRaises(ImportFormatError):
            sources.parse_nvd_page(payload)

    def test_configurations_are_capped(self):
        many = cve()
        node = many["configurations"][0]["nodes"][0]
        node["cpeMatch"] = node["cpeMatch"] * 10
        many["configurations"] = [many["configurations"][0]] * 50
        with mock.patch.object(sources, "CONFIGURATIONS_MAX", 4000):
            (rec,), _ = nvd(page_with(many))
        self.assertTrue(rec["configurations_truncated"])
        self.assertLessEqual(len(json.dumps(rec["configurations"])), 4000)
        self.assertTrue(rec["configurations"])


class LimitTests(SimpleTestCase):
    def test_oversized_record(self):
        with mock.patch.object(sources, "RECORD_MAX", 2000), self.assertRaises(LimitExceeded):
            nvd(data("nvd_page.json"))

    def test_too_many_records(self):
        with mock.patch.object(sources, "RECORDS_MAX", 3), self.assertRaises(LimitExceeded):
            nvd(data("nvd_page.json"))

    def test_deep_nesting(self):
        raw = (b'{"format": "NVD_CVE", "version": "2.0", "vulnerabilities": ['
               + b"[" * 200_000 + b"]" * 200_000 + b"]}")
        with self.assertRaises(ImportFormatError):
            nvd(raw)

    def test_gzip_bomb(self):
        bomb = gzip.compress(b" " * (8 * 1024 * 1024))
        reader = open_stream(io.BytesIO(bomb), max_bytes=1024 * 1024)
        with self.assertRaises(LimitExceeded):
            list(sources.iter_nvd(reader))

    def test_zip_limits(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("big.json", b" " * (2 * 1024 * 1024))
            for i in range(3):
                zf.writestr(f"r{i}.json", b"{}")
        buf.seek(0)
        with self.assertRaises(LimitExceeded):
            list(streaming.iter_zip_members(buf, suffixes=(".json",), max_members=10,
                                            max_member_bytes=1024 * 1024,
                                            max_total_bytes=10**9))
        buf.seek(0)
        with self.assertRaises(LimitExceeded):
            list(streaming.iter_zip_members(buf, suffixes=(".json",), max_members=2,
                                            max_member_bytes=10**9, max_total_bytes=10**9))

    def test_zip_member_lying_about_its_size_is_still_capped(self):
        reader = streaming.CappedReader(io.BytesIO(b"x" * 5000), 1000, "m.json")
        with self.assertRaises(LimitExceeded):
            while reader.read(512):
                pass

    def test_not_a_zip(self):
        with self.assertRaises(ImportFormatError):
            list(streaming.iter_zip_members(io.BytesIO(b"PK\x03\x04garbage"),
                                            suffixes=(".json",), max_members=1,
                                            max_member_bytes=1, max_total_bytes=1))


class OsvTests(SimpleTestCase):
    def osv(self, raw: bytes):
        errors: list = []
        out = list(sources.iter_osv_json(open_stream(io.BytesIO(raw), max_bytes=10**7),
                                         errors=errors))
        return out, errors

    def test_record_with_a_cve_alias_is_filed_under_the_cve(self):
        (rec,), _ = self.osv(data("osv_django.json"))
        self.assertEqual(rec["vuln_id"], "CVE-2024-45230")
        self.assertEqual(rec["aliases"], ["GHSA-5hgc-2vfp-mqvc", "PYSEC-2024-83"])
        self.assertEqual(rec["products"], {("purl", "", "pypi", "django")})
        self.assertEqual(rec["cvss"]["score"], Decimal("7.5"))
        self.assertTrue(rec["cvss"]["verified"])
        self.assertEqual(rec["cwes"], ["CWE-130", "CWE-400"])
        affected = rec["osv"]["affected"][0]
        # GIT ranges (commit hashes) are not version ranges; left out.
        self.assertEqual([r["type"] for r in affected["ranges"]], ["ECOSYSTEM", "ECOSYSTEM"])
        self.assertEqual([f["version"] for f in rec["osv"]["fixed_in"]], ["4.2.16", "5.0.9"])

    def test_record_without_cve_keeps_its_own_id(self):
        (rec,), _ = self.osv(data("osv_npm.json"))
        self.assertEqual(rec["vuln_id"], "GHSA-2222-3333-4444")
        self.assertEqual(rec["products"], {("purl", "", "npm", "example-merge")})
        # CVSS 4.0 from OSV is a vector only: no score, no severity.
        self.assertIsNone(rec["cvss"]["score"])
        self.assertEqual(rec["cvss"]["version"], "4.0")

    def test_lists_and_api_responses(self):
        a, b = json.loads(data("osv_django.json")), json.loads(data("osv_npm.json"))
        recs, _ = self.osv(json.dumps([a, b]).encode())
        self.assertEqual(len(recs), 2)
        recs, _ = self.osv(json.dumps({"vulns": [a, b]}).encode())
        self.assertEqual(len(recs), 2)
        recs, errors = self.osv(json.dumps({"vulns": []}).encode())
        self.assertEqual((recs, errors), ([], []))
        with self.assertRaises(ImportFormatError):
            self.osv(json.dumps({"hello": "world"}).encode())

    def test_bad_record(self):
        rec = json.loads(data("osv_npm.json"))
        rec["modified"] = "never"
        recs, errors = self.osv(json.dumps([rec]).encode())
        self.assertEqual(recs, [])
        self.assertEqual(len(errors), 1)


class KevEpssTests(SimpleTestCase):
    def test_kev_json_and_csv_agree(self):
        from_json = list(sources.iter_kev(open_stream(io.BytesIO(data("kev.json")),
                                                      max_bytes=10**7)))
        errors: list = []
        from_csv = list(sources.iter_kev(open_stream(io.BytesIO(data("kev.csv")),
                                                     max_bytes=10**7), errors=errors))
        self.assertEqual(from_json, from_csv)
        self.assertEqual(len(errors), 1)
        self.assertEqual(from_json[0]["ransomware"], "known")
        self.assertEqual(from_json[0]["due"], date(2023, 10, 20))

    def test_kev_rejects_other_files(self):
        for raw in (b'{"title": "x"}', b"a,b,c\n1,2,3\n"):
            with self.subTest(raw=raw), self.assertRaises(ImportFormatError):
                list(sources.iter_kev(open_stream(io.BytesIO(raw), max_bytes=10**7)))

    def test_epss_csv(self):
        errors: list = []
        rows = list(sources.iter_epss_csv(
            open_stream(io.BytesIO(gzip.compress(data("epss.csv"))), max_bytes=10**7),
            errors=errors, today=date(2026, 11, 10)))
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0], {"vuln_id": "CVE-2023-20198", "epss": Decimal("0.94379"),
                                   "percentile": Decimal("0.99961"), "date": date(2026, 11, 9)})
        self.assertEqual(len(errors), 1)  # the 1.5 score

    def test_epss_future_or_headerless_is_refused(self):
        with self.assertRaises(ImportFormatError):
            list(sources.iter_epss_csv(open_stream(io.BytesIO(data("epss.csv")),
                                                   max_bytes=10**7), today=date(2026, 1, 1)))
        with self.assertRaises(ImportFormatError):
            list(sources.iter_epss_csv(open_stream(
                io.BytesIO(b"cve,epss,percentile\nCVE-2023-20198,0.9,0.9\n"),
                max_bytes=10**7)))

    def test_epss_api(self):
        errors: list = []
        rows = sources.parse_epss_api(
            {"status": "OK", "data": [
                {"cve": "CVE-2023-20198", "epss": "0.943790000", "percentile": "0.999610000",
                 "date": "2026-11-09"},
                {"cve": "CVE-2023-20198", "epss": "-1", "percentile": "0.5",
                 "date": "2026-11-09"}]},
            today=date(2026, 11, 10), errors=errors)
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(errors), 1)


class IdentifierTests(SimpleTestCase):
    def test_cpe(self):
        self.assertEqual(cpe_product("cpe:2.3:o:cisco:ios_xe:17.9.4a:*:*:*:*:*:*:*"),
                         ("o", "cisco", "ios_xe"))
        self.assertEqual(cpe_product(r"cpe:2.3:o:cisco:ios:15.2\(7\)e8:*:*:*:*:*:*:*"),
                         ("o", "cisco", "ios"))
        self.assertEqual(cpe_product(r"cpe:2.3:a:vendor\:x:prod:1:*:*:*:*:*:*:*"),
                         ("a", "vendor\\:x", "prod"))
        for bad in ("cpe:/o:cisco:ios", "cpe:2.3:x:cisco:ios:1:*:*:*:*:*:*:*",
                    "cpe:2.3:o:*:ios:1:*:*:*:*:*:*:*", "cpe:2.3:o:cisco"):
            self.assertIsNone(cpe_product(bad))

    def test_purl(self):
        self.assertEqual(purl_key("pkg:pypi/Django_Rest.Framework@3.15"),
                         ("pypi", "django-rest-framework"))
        self.assertEqual(purl_key("pkg:deb/debian/openssl@3.0.11?arch=source"),
                         ("deb", "debian/openssl"))
        self.assertEqual(purl_key("pkg:npm/%40angular/core@17.0.0"), ("npm", "@angular/core"))
        self.assertEqual(purl_key("pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1"),
                         ("maven", "org.apache.logging.log4j/log4j-core"))
        self.assertIsNone(purl_key("django"))
        self.assertEqual(package_key("Maven", "org.apache.logging.log4j:log4j-core"),
                         ("maven", "org.apache.logging.log4j/log4j-core"))
        self.assertEqual(package_key("Debian:12", "openssl"), ("deb", "debian/openssl"))
        self.assertEqual(package_key("PyPI", "Django"), ("pypi", "django"))


class DistroReleaseIdentifierTests(SimpleTestCase):
    """Distro releases: OSV ecosystems, purl ``distro=`` and platforms (B0)."""

    def test_ecosystem_release(self):
        from .identifiers import ecosystem_release

        for eco, expected in [
                ("Debian:12", ("debian", "12")), ("Debian:11", ("debian", "11")),
                ("Ubuntu:22.04:LTS", ("ubuntu", "22.04")), ("Ubuntu:24.10", ("ubuntu", "24.10")),
                ("Ubuntu:Pro:18.04:LTS", ("ubuntu", "18.04")),
                ("Alpine:v3.19", ("alpine", "3.19")), ("Rocky Linux:9", ("rocky", "9")),
                ("AlmaLinux:8", ("almalinux", "8")),
                ("Red Hat:enterprise_linux:9::appstream", ("redhat", "9")),
                ("SUSE:Linux Enterprise Server 15 SP5",
                 ("suse", "linux enterprise server 15 sp5")),
                ("PyPI", None), ("Debian", None), ("", None), (None, None)]:
            with self.subTest(eco=eco):
                self.assertEqual(ecosystem_release(eco), expected)

    def test_distro_qualifier(self):
        from .identifiers import distro_release

        for args, expected in [
                (("deb", "debian", "bookworm"), ("debian", "12")),
                (("deb", "debian", "debian-12"), ("debian", "12")),
                (("deb", "debian", "debian-12.5"), ("debian", "12")),
                (("deb", "debian", "12"), ("debian", "12")),
                (("deb", "ubuntu", "jammy"), ("ubuntu", "22.04")),
                (("deb", "ubuntu", "ubuntu-22.04"), ("ubuntu", "22.04")),
                (("apk", "alpine", "v3.19"), ("alpine", "3.19")),
                (("apk", "alpine", "alpine-3.19.1"), ("alpine", "3.19")),
                (("rpm", "rocky", "el9"), ("rocky", "9")),
                (("rpm", "rocky", "rocky-9.3"), ("rocky", "9")),
                (("rpm", "redhat", "rhel-9"), ("redhat", "9")),
                # Another distro's name or codename, or none at all.
                (("deb", "debian", "jammy"), None),
                (("deb", "debian", "ubuntu-22.04"), None),
                (("deb", "debian", "sid"), None),
                (("deb", "debian", ""), None),
                (("deb", "debian", None), None),
                (("pypi", "", "bookworm"), None)]:
            with self.subTest(args=args):
                self.assertEqual(distro_release(*args), expected)

    def test_platform_release(self):
        from .identifiers import platform_release

        for args, expected in [
                (("deb", "debian", "Debian 12", ""), ("debian", "12")),
                (("deb", "debian", "Debian", "12.5"), ("debian", "12")),
                (("deb", "debian", "Debian Bookworm", "6.1.0"), ("debian", "12")),
                (("deb", "ubuntu", "Ubuntu 22.04 LTS", "6.8.0"), ("ubuntu", "22.04")),
                (("deb", "ubuntu", "Ubuntu", "24.04.1"), ("ubuntu", "24.04")),
                (("rpm", "rocky", "Rocky Linux", "9.3"), ("rocky", "9")),
                (("rpm", "almalinux", "AlmaLinux", "8.10"), ("almalinux", "8")),
                (("rpm", "redhat", "Red Hat Enterprise Linux 9", ""), ("redhat", "9")),
                (("apk", "alpine", "Alpine Linux", "3.20.3"), ("alpine", "3.20")),
                (("deb", "debian", "Ubuntu 22.04", ""), None),
                (("deb", "debian", "Debian", ""), None),
                (("deb", "debian", "Linux", "12"), None)]:
            with self.subTest(args=args):
                self.assertEqual(platform_release(*args), expected)

    def test_qualifiers_and_ecosystems(self):
        from .identifiers import osv_ecosystems, purl_qualifiers

        self.assertEqual(
            purl_qualifiers("pkg:deb/debian/libssl3@3.0.11?arch=amd64"
                            "&upstream=openssl%403.0.11-1&distro=debian-12#x"),
            {"arch": "amd64", "upstream": "openssl@3.0.11-1", "distro": "debian-12"})
        self.assertEqual(purl_qualifiers("pkg:pypi/django@5.2"), {})
        self.assertEqual(osv_ecosystems(("debian", "12")), ["Debian:12"])
        self.assertEqual(osv_ecosystems(("ubuntu", "22.04")), ["Ubuntu:22.04:LTS"])
        self.assertEqual(osv_ecosystems(("ubuntu", "24.10")), ["Ubuntu:24.10"])
        self.assertEqual(osv_ecosystems(("alpine", "3.19")), ["Alpine:v3.19"])
        self.assertEqual(osv_ecosystems(("rocky", "9")), ["Rocky Linux:9"])
        self.assertEqual(osv_ecosystems(("redhat", "9")), [])
