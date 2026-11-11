"""Microsoft's advisory data (#451, MSRC source): the CVRF parser on trimmed
real documents, the Windows product table, build comparison, the merge with
NVD and OSV rows, ``via="os_build"`` matching with its tenant, RBAC,
exception and query-count guarantees, the server fetch (months only, SSRF
guard, incremental) and the upload."""
from __future__ import annotations

import copy
import gzip
import io
import json
import zipfile
from datetime import datetime
from unittest import mock

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Cluster, ClusterType, Device, Site, VirtualMachine
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from discovery.models import HostOsFact
from integrations.models import IntegrationSettings

from . import evaluate, fetch, imports, jobs, matching, products, sources, store, versions
from .models import (
    Cve,
    CveProduct,
    MsrcMonth,
    VulnerabilityException,
    VulnerabilityMatch,
    VulnerabilitySettings,
)
from .msrc_products import FAMILIES, PRODUCTS, key_for_name, resolve
from .streaming import ImportFormatError, LimitExceeded, open_stream
from .testing import Trickle, data, tracking
from .tests_fetch import PUBLIC_IP, NetMixin

NOV = "msrc_2026_nov.json"
OCT = "msrc_2026_oct.json"
OCT25 = "msrc_2025_oct.json"
S2022 = ("msrc", "", "microsoft", "windows_server_2022")
S2022_CORE = ("msrc", "", "microsoft", "windows_server_2022_core")
MSRC_HOST = "api.msrc.microsoft.com"


def parse(name: str, *, step: int | None = None):
    raw = data(name)
    reader = Trickle(raw, step) if step else io.BytesIO(raw)
    header, errors = {}, []
    recs = list(sources.iter_msrc(reader, header=header, errors=errors))
    return recs, header, errors


def doc(name: str) -> dict:
    return json.loads(data(name))


def by_id(recs) -> dict:
    return {r["vuln_id"]: r for r in recs}


# ─── parser ──────────────────────────────────────────────────────────────────


class ParserTests(SimpleTestCase):
    def test_november_document(self):
        recs, header, errors = parse(NOV)
        self.assertEqual(errors, [])
        self.assertEqual(header["month"], "2026-Nov")
        self.assertEqual(header["current_release"].isoformat(), "2026-11-10T08:00:00+00:00")
        recs = by_id(recs)
        ntfs = recs["CVE-2026-100223"]
        self.assertEqual(ntfs["kind"], "msrc")
        self.assertEqual(ntfs["summary"], "Windows NTFS Elevation of Privilege Vulnerability")
        self.assertEqual(ntfs["cwes"], ["CWE-416"])
        self.assertEqual(str(ntfs["cvss"]["score"]), "7.8")
        self.assertTrue(ntfs["cvss"]["verified"])
        p = ntfs["msrc"]["products"]
        self.assertEqual(p["windows_server_2022"],
                         {"fixed": ["10.0.20348.5870"], "kbs": ["5131090"]})
        self.assertEqual(p["windows_server_2022_core"], p["windows_server_2022"])
        # Server 2025: the hotpatch build and the regular one, in build order.
        self.assertEqual(p["windows_server_2025"]["fixed"],
                         ["10.0.26100.33730", "10.0.26100.33822"])
        self.assertIn(S2022, ntfs["products"])
        # A Windows 11 only record names no server.
        shell = recs["CVE-2026-102868"]["msrc"]["products"]
        self.assertNotIn("windows_server_2025", shell)
        self.assertIn("windows_11_24h2_x64", shell)
        self.assertIn("windows_11_26h1_x64", shell)  # "version" in lower case
        # Not a Windows product: nothing kept.
        self.assertEqual(recs["CVE-2026-102224"]["products"], set())

    def test_split_reads_give_the_same_records(self):
        whole, _, _ = parse(NOV)
        split, _, _ = parse(NOV, step=97)
        self.assertEqual(whole, split)

    def test_advisories_without_a_cve_id_are_skipped(self):
        recs, header, errors = parse(OCT)
        self.assertEqual(header["month"], "2026-Oct")
        self.assertEqual([r["vuln_id"] for r in recs], ["CVE-2026-100201"])
        self.assertEqual(errors, [])

    def test_a_fixed_build_on_another_line_is_not_kept(self):
        d = doc(NOV)
        for v in d["Vulnerability"]:
            for r in v["Remediations"]:
                if r.get("FixedBuild", "").startswith("10.0.20348."):
                    r["FixedBuild"] = "10.0.17763.9999"
        recs = by_id(sources.iter_msrc(io.BytesIO(json.dumps(d).encode())))
        self.assertEqual(recs["CVE-2026-100223"]["msrc"]["products"]["windows_server_2022"],
                         {"fixed": [], "kbs": []})

    def test_envelope_is_checked(self):
        d = doc(NOV)
        bad = []
        # Vulnerabilities before the product tree.
        bad.append(json.dumps({"Vulnerability": d["Vulnerability"],
                               "DocumentTracking": d["DocumentTracking"],
                               "ProductTree": d["ProductTree"]}))
        no_month = copy.deepcopy(d)
        no_month["DocumentTracking"]["Identification"]["ID"]["Value"] = "2026-11"
        bad.append(json.dumps(no_month))
        bad.append(json.dumps({"format": "NVD_CVE", "version": "2.0", "vulnerabilities": []}))
        bad.append("[1, 2]")
        bad.append(json.dumps({**d, "Vulnerability": {"not": "a list"}}))
        for text in bad:
            with self.subTest(text=text[:40]), self.assertRaises(ImportFormatError):
                list(sources.iter_msrc(io.BytesIO(text.encode())))

    def test_hostile_values_are_dropped(self):
        d = doc(NOV)
        v = d["Vulnerability"][0]
        for r in v["Remediations"]:
            if r.get("FixedBuild") == "10.0.20348.5870":
                r["FixedBuild"] = "10.0.20348.5870; rm -rf /"
        v["CWE"] = [{"ID": "<script>"}]
        bad = copy.deepcopy(v)
        bad["CVE"] = "../../etc/passwd"
        d["Vulnerability"].append(bad)
        errors = []
        recs = by_id(sources.iter_msrc(io.BytesIO(json.dumps(d).encode()), errors=errors))
        self.assertEqual(len(errors), 1)
        self.assertEqual(recs["CVE-2026-100223"]["cwes"], [])
        self.assertEqual(recs["CVE-2026-100223"]["msrc"]["products"]["windows_server_2022"]
                         ["fixed"], [])


# ─── product table and host resolution ───────────────────────────────────────


class ProductTableTests(SimpleTestCase):
    def test_every_windows_release_in_the_fixtures_maps(self):
        names = set()
        for name in (NOV, OCT, OCT25):
            names |= {p["Value"] for p in doc(name)["ProductTree"]["FullProductName"]}
        windows = {n for n in names if n.startswith("Windows")
                   and ("Server 20" in n or "Windows 1" in n) and "Server 2008" not in n
                   and n not in ("Windows 10 for 32-bit Systems",
                                 "Windows 10 for x64-based Systems")}
        unmapped = sorted(n for n in windows if key_for_name(n) is None)
        self.assertEqual(unmapped, [])
        self.assertIsNone(key_for_name("Azure CycleCloud 8.9.1"))
        self.assertIsNone(key_for_name("Windows Server 2008 for x64-based Systems Service Pack 2"))

    def test_coverage(self):
        for fam in ("windows_server_2016", "windows_server_2019", "windows_server_2022",
                    "windows_server_2025"):
            self.assertIn(fam, PRODUCTS)
            self.assertIn(f"{fam}_core", PRODUCTS)
        for fam in ("windows_10_21h2", "windows_10_22h2", "windows_11_23h2",
                    "windows_11_24h2", "windows_11_25h2", "windows_11_26h1",
                    "windows_11_26h2"):
            self.assertIn(f"{fam}_x64", PRODUCTS)
            self.assertIn(fam, FAMILIES)

    def windows2022(self, **kw):
        base = {"os_id": "windows", "version_id": "10.0.20348.2849", "build": "20348",
                "ubr": 2849, "caption": "Microsoft Windows Server 2022 Standard",
                "edition": "ServerStandard", "display_version": "21H2"}
        return resolve(**{**base, **kw})

    def test_server_desktop_core_and_unknown_installation(self):
        hp = self.windows2022(installation_type="Server")
        self.assertEqual(hp.keys, ("windows_server_2022",))
        self.assertEqual(hp.build, "10.0.20348.2849")
        self.assertEqual(self.windows2022(installation_type="Server Core").keys,
                         ("windows_server_2022_core",))
        hp = self.windows2022()
        self.assertEqual(hp.keys, ("windows_server_2022", "windows_server_2022_core"))
        self.assertEqual(hp.flag, "")

    def test_architecture_spellings(self):
        from .msrc_products import normalise_arch

        for raw, want in (("64-bit", "x64"), ("AMD64", "x64"), ("x64", "x64"),
                          ("64 Bit", "x64"), ("64 bits", "x64"), ("x86_64", "x64"),
                          ("ARM 64-bit Processor", "arm64"), ("ARM64", "arm64"),
                          ("32-bit", "x86"), ("x86", "x86"), ("", ""), ("ARM", ""),
                          ("Itanium", "")):
            with self.subTest(raw):
                self.assertEqual(normalise_arch(raw), want)

    def test_one_build_line_two_products(self):
        server = resolve(os_id="windows", version_id="10.0.26100.33000", build="26100",
                         ubr=33000, caption="Microsoft Windows Server 2025 Datacenter")
        client = resolve(os_id="windows", version_id="10.0.26100.9000", build="26100",
                         ubr=9000, caption="Microsoft Windows 11 Pro", display_version="24H2",
                         architecture="64-bit")
        self.assertEqual(server.family, "windows_server_2025")
        self.assertEqual(client.keys, ("windows_11_24h2_x64",))

    def test_what_cannot_be_placed_gets_a_flag_not_a_guess(self):
        cases = {
            "linux": {"os_id": "debian"},
            "unknown build": {"build": "22000", "version_id": "10.0.22000.100",
                              "caption": "Microsoft Windows 11 Pro"},
            "caption year": {"caption": "Microsoft Windows Server 2019 Standard"},
            "hci": {"caption": "Microsoft Azure Stack HCI", "edition": "ServerAzureStackHCICor"},
            "no caption": {"caption": "", "edition": ""},
            "other line": {"version_id": "6.3.20348.2849"},
        }
        for name, kw in cases.items():
            with self.subTest(name):
                hp = self.windows2022(**kw)
                self.assertEqual(hp.flag, "product_unknown")
                self.assertEqual(hp.keys, ())
        client = resolve(os_id="windows", version_id="10.0.19045.5000", build="19045",
                         ubr=5000, caption="Microsoft Windows 10 Pro", display_version="21H2")
        self.assertEqual(client.flag, "product_unknown")
        eleven = resolve(os_id="windows", version_id="10.0.19045.5000", build="19045",
                         ubr=5000, caption="Microsoft Windows 11 Pro")
        self.assertEqual(eleven.flag, "product_unknown")

    def test_missing_ubr(self):
        hp = self.windows2022(ubr=None, version_id="10.0.20348")
        self.assertEqual(hp.flag, "ubr_unknown")
        self.assertEqual(hp.build, "")
        # The UBR is read from the full version when the field is empty.
        self.assertEqual(self.windows2022(ubr=None).ubr, 2849)


# ─── build comparison ────────────────────────────────────────────────────────


class WinbuildTests(SimpleTestCase):
    def test_parse_and_compare(self):
        a = versions.parse("10.0.20348.2849", "winbuild")
        b = versions.parse("10.0.20348.5870", "winbuild")
        self.assertEqual(versions.compare(a, b), -1)
        self.assertEqual(versions.compare(b, a), 1)
        self.assertEqual(versions.compare(a, versions.parse("10.0.20348.2849", "winbuild")), 0)
        # 10 < 9 as text, not as a number.
        self.assertEqual(versions.compare(versions.parse("10.0.20348.10", "winbuild"),
                                          versions.parse("10.0.20348.9", "winbuild")), 1)

    def test_different_lines_never_compare(self):
        a = versions.parse("10.0.20348.9999", "winbuild")
        b = versions.parse("10.0.17763.1", "winbuild")
        self.assertIsNone(versions.compare(a, b))

    def test_what_does_not_parse(self):
        for text in ("10.0.20348", "10.0.20348.x", "10.0.20348.1.2", "", "KB5044281",
                     "10.0.20348.2849 "):
            with self.subTest(text):
                parsed = versions.parse(text, "winbuild")
                if text.strip() == "10.0.20348.2849":
                    self.assertIsNotNone(parsed)  # surrounding space is trimmed
                else:
                    self.assertIsNone(parsed)

    def test_match_msrc(self):
        msrc = {"2026-Nov": {"products": {
            "windows_server_2022": {"fixed": ["10.0.20348.5870"]},
            "windows_server_2022_core": {"fixed": ["10.0.20348.5870"]},
            "windows_server_2025": {"fixed": ["10.0.26100.33822", "10.0.26100.33730"]},
            "windows_11_24h2_x64": {"fixed": []},
            "windows_10_22h2_x64": {"fixed": ["10.0.19045.7846"]},
        }}}
        m = evaluate.match_msrc
        line = "10.0.20348"
        self.assertEqual(m(msrc, ("windows_server_2022",), line, 2849), ("range", set()))
        self.assertEqual(m(msrc, ("windows_server_2022",), line, 5870), (None, set()))
        self.assertEqual(m(msrc, ("windows_server_2022",), line, 6000), (None, set()))
        self.assertEqual(m(msrc, ("windows_server_2022", "windows_server_2022_core"), line,
                           100)[0], "range")
        # Not named: not affected.
        self.assertEqual(m(msrc, ("windows_server_2019",), "10.0.17763", 1), (None, set()))
        # The hotpatch build (lower) counts as fixed.
        self.assertEqual(m(msrc, ("windows_server_2025",), "10.0.26100", 33730)[0], None)
        self.assertEqual(m(msrc, ("windows_server_2025",), "10.0.26100", 33729)[0], "range")
        # Listed, no fixed build on its line: flagged, not matched.
        self.assertEqual(m(msrc, ("windows_11_24h2_x64",), "10.0.26100", 1),
                         (None, {"no_fixed_build"}))
        # Variants disagree (core not named): flagged, not matched.
        only_desktop = {"m": {"products": {"windows_server_2022":
                                           {"fixed": ["10.0.20348.5870"]}}}}
        self.assertEqual(m(only_desktop, ("windows_server_2022", "windows_server_2022_core"),
                           line, 2849), (None, {"variant_unknown"}))
        # No UBR or no line: nothing.
        self.assertEqual(m(msrc, ("windows_server_2022",), line, None), (None, set()))
        # A fixed build of another line in the data is ignored.
        other = {"m": {"products": {"windows_server_2022": {"fixed": ["10.0.17763.9"]}}}}
        self.assertEqual(m(other, ("windows_server_2022",), line, 1),
                         (None, {"no_fixed_build"}))


# ─── store ───────────────────────────────────────────────────────────────────


def load(name: str, *keys):
    recs, header, _ = parse(name)
    with tracking(*(keys or (S2022, S2022_CORE))):
        return store.store_records(recs, source="msrc", tracked=products.tracked())


class StoreTests(TestCase):
    def test_store_and_replay(self):
        counts = load(NOV)
        # Only the records naming a tracked product: NTFS and DNS name Server 2022.
        self.assertEqual(counts["created"], 2)
        row = Cve.objects.get(vuln_id="CVE-2026-100223")
        self.assertEqual(row.source, "msrc")
        self.assertEqual(str(row.cvss_score), "7.8")
        self.assertEqual(row.cvss_severity, "high")
        self.assertIn("2026-Nov", row.msrc)
        self.assertTrue(CveProduct.objects.filter(cve=row, kind="msrc",
                                                  product="windows_server_2022").exists())
        self.assertFalse(Cve.objects.filter(vuln_id="CVE-2026-102868").exists())
        again = load(NOV)
        self.assertEqual(again["created"] + again["updated"], 0)
        self.assertEqual(again["unchanged"], 2)

    def test_merge_with_nvd_keeps_nvd_fields(self):
        Cve.objects.create(vuln_id="CVE-2026-100223", summary="NVD text", source="nvd_api",
                           last_modified=timezone.now(), cvss_score="5.5",
                           cvss_severity="medium", cvss_version="3.1")
        load(NOV)
        self.assertEqual(Cve.objects.filter(vuln_id="CVE-2026-100223").count(), 1)
        row = Cve.objects.get(vuln_id="CVE-2026-100223")
        self.assertEqual((row.source, row.summary, str(row.cvss_score)),
                         ("nvd_api", "NVD text", "5.5"))
        self.assertIn("2026-Nov", row.msrc)
        self.assertTrue(row.products.filter(kind="msrc").exists())

    def test_nvd_arriving_later_replaces_microsofts_fields(self):
        load(NOV)
        nvd = sources.normalise_nvd({
            "id": "CVE-2026-100223", "published": "2026-11-10T18:15:00.000",
            "lastModified": "2026-11-11T00:00:00.000", "vulnStatus": "Analyzed",
            "descriptions": [{"lang": "en", "value": "NVD's words"}], "metrics": {},
            "configurations": []})
        with tracking(S2022):
            store.store_records([{**nvd, "products": {S2022}}], source="nvd_api",
                                tracked=products.tracked())
        row = Cve.objects.get(vuln_id="CVE-2026-100223")
        self.assertEqual((row.source, row.summary), ("nvd_api", "NVD's words"))
        # Microsoft's builds stay, and so does the product row.
        self.assertIn("2026-Nov", row.msrc)
        self.assertTrue(row.products.filter(kind="msrc").exists())

    def test_microsoft_fills_ahead_of_osv(self):
        Cve.objects.create(vuln_id="CVE-2026-100223", summary="OSV text", source="osv")
        load(NOV)
        row = Cve.objects.get(vuln_id="CVE-2026-100223")
        self.assertEqual((row.source, row.summary),
                         ("msrc", "Windows NTFS Elevation of Privilege Vulnerability"))

    def test_months_stay_apart(self):
        load(NOV)
        recs, _, _ = parse(OCT)
        rec = recs[0]
        rec = {**rec, "vuln_id": "CVE-2026-100223"}
        with tracking(S2022):
            store.store_records([rec], source="msrc", tracked=products.tracked())
        row = Cve.objects.get(vuln_id="CVE-2026-100223")
        self.assertEqual(set(row.msrc), {"2026-Nov", "2026-Oct"})


# ─── matching ────────────────────────────────────────────────────────────────


def fact(tenant, host, *, ubr=2849, build="20348", caption="Microsoft Windows Server 2022 "
         "Standard", **kw):
    field = "virtual_machine" if isinstance(host, VirtualMachine) else "device"
    defaults = {"tenant": tenant, "os_id": "windows", "build": build, "ubr": ubr,
                "version_id": f"10.0.{build}" + (f".{ubr}" if ubr is not None else ""),
                "pretty_name": caption, "edition": "ServerStandard",
                "display_version": "21H2", "package_manager": "windows",
                "collected_at": timezone.now(), **kw}
    row, _ = HostOsFact.objects.update_or_create(**{field: host}, defaults=defaults)
    return row


@override_settings(DISCOVERY_ENABLED=True)
class Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        for t in (cls.tenant, cls.other):
            IntegrationSettings.objects.create(tenant=t, discovery_enabled=True)
        cls.site = Site.objects.create(tenant=cls.tenant, name="HQ")
        ct = ClusterType.objects.create(tenant=cls.tenant, name="CT", slug="ct")
        cls.cluster = Cluster.objects.create(tenant=cls.tenant, name="pve", type=ct)

    def setUp(self):
        self.srv = Device.objects.create(tenant=self.tenant, name="srv", site=self.site)
        self.vm = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster,
                                                name="vm1")
        fact(self.tenant, self.srv)
        fact(self.tenant, self.vm, ubr=5870)
        recs, _, _ = parse(NOV)
        store.store_records(recs, source="msrc", tracked=products.tracked())

    def open(self, tenant=None):
        return VulnerabilityMatch.objects.filter(tenant=tenant or self.tenant,
                                                 resolved_at__isnull=True)


class MatchTests(Base):
    def test_hosts_are_tracked(self):
        keys = products.tracked().keys
        self.assertIn(S2022, keys)
        self.assertIn(S2022_CORE, keys)
        self.assertEqual(Cve.objects.filter(products__kind="msrc").distinct().count(), 2)

    def test_os_build_matches(self):
        counts = matching.recompute(self.tenant)
        self.assertEqual(counts["windows_hosts"], 2)
        rows = list(self.open())
        self.assertEqual({r.cve.vuln_id for r in rows}, {"CVE-2026-100223", "CVE-2026-105520"})
        for r in rows:
            self.assertEqual((r.via, r.device_id, r.confidence), ("os_build", self.srv.pk,
                                                                   "range"))
            self.assertIsNone(r.mapping_id)
            self.assertIsNone(r.host_package_id)
            self.assertEqual(r.version, "10.0.20348.2849")
        # Patched to the fixed build: resolved; the VM (already there) never matched.
        fact(self.tenant, self.srv, ubr=5870)
        counts = matching.recompute(self.tenant, objects={"device": [self.srv.pk]})
        self.assertEqual(counts["resolved"], 2)
        self.assertFalse(self.open().exists())

    def test_vm_and_missing_ubr(self):
        fact(self.tenant, self.vm, ubr=100)
        fact(self.tenant, self.srv, ubr=None)
        matching.recompute(self.tenant)
        self.assertEqual({r.virtual_machine_id for r in self.open()}, {self.vm.pk})
        self.assertFalse(self.open().filter(device=self.srv).exists())

    def test_other_product_on_the_same_line_does_not_match(self):
        # Server 2025 at an old UBR: the Windows 11 only record must not match.
        fact(self.tenant, self.srv, build="26100", ubr=1,
             caption="Microsoft Windows Server 2025 Datacenter")
        with tracking(("msrc", "", "microsoft", "windows_server_2025"),
                      ("msrc", "", "microsoft", "windows_11_24h2_x64")):
            recs, _, _ = parse(NOV)
            store.store_records(recs, source="msrc", tracked=products.tracked())
        self.assertTrue(Cve.objects.filter(vuln_id="CVE-2026-102868").exists())
        matching.recompute(self.tenant)
        self.assertEqual({r.cve.vuln_id for r in self.open()},
                         {"CVE-2026-100223", "CVE-2026-105520"})

    def test_installation_type_picks_the_variant(self):
        # A record Microsoft wrote for the Desktop Experience only.
        recs, _, _ = parse(NOV)
        rec = copy.deepcopy(by_id(recs)["CVE-2026-105520"])
        rec["vuln_id"] = "CVE-2026-199999"
        rec["msrc"]["products"] = {"windows_server_2022":
                                   rec["msrc"]["products"]["windows_server_2022"]}
        rec["products"] = {S2022}
        store.store_records([rec], source="msrc", tracked=products.tracked())
        core = Device.objects.create(tenant=self.tenant, name="core", site=self.site)
        desk = Device.objects.create(tenant=self.tenant, name="desk", site=self.site)
        fact(self.tenant, core, installation_type="Server Core")
        fact(self.tenant, desk, installation_type="Server")
        matching.recompute(self.tenant)

        def cves(host):
            return {r.cve.vuln_id for r in self.open().filter(device=host)}

        both = {"CVE-2026-100223", "CVE-2026-105520"}
        self.assertEqual(cves(core), both)
        self.assertEqual(cves(desk), both | {"CVE-2026-199999"})
        # Unknown installation type: both variants, as before - a CVE only
        # one variant lists does not match.
        self.assertEqual(cves(self.srv), both)

    def test_discovery_off_resolves(self):
        matching.recompute(self.tenant)
        self.assertTrue(self.open().exists())
        IntegrationSettings.objects.filter(tenant=self.tenant).update(discovery_enabled=False)
        matching.recompute(self.tenant)
        self.assertFalse(self.open().exists())
        self.assertNotIn(S2022, products.tracked().keys)

    def test_tenant_isolation(self):
        theirs = Device.objects.create(tenant=self.other, name="t")
        fact(self.other, theirs)
        matching.recompute(self.tenant)
        self.assertFalse(self.open(self.other).exists())
        self.assertEqual(jobs.tenants_for(["CVE-2026-100223"]),
                         {self.tenant.pk, self.other.pk})
        matching.recompute(self.other)
        self.assertEqual({r.device_id for r in self.open(self.other)}, {theirs.pk})
        # A fact filed under one tenant for another tenant's host matches nothing.
        stray = Device.objects.create(tenant=self.other, name="stray")
        fact(self.tenant, stray)
        matching.recompute(self.tenant)
        self.assertFalse(self.open().filter(device=stray).exists())

    def test_exceptions_host_and_tenant(self):
        cve = Cve.objects.get(vuln_id="CVE-2026-100223")
        dns = Cve.objects.get(vuln_id="CVE-2026-105520")
        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=cve, device=self.srv, status="not_applicable",
            reason="not used")
        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=dns, status="not_applicable", reason="no DNS role")
        matching.recompute(self.tenant)
        self.assertTrue(all(r.excepted_id for r in self.open()))

    def test_store_queues_the_tenants(self):
        Cve.objects.all().delete()
        with mock.patch.object(jobs, "enqueue_recompute") as q:
            load(NOV)
        tenants = {c.args[0] for c in q.call_args_list}
        self.assertIn(self.tenant.pk, tenants)

    def test_cost_does_not_grow_with_hosts(self):
        def queries():
            with CaptureQueriesContext(connection) as ctx:
                matching.recompute(self.tenant)
            return len(ctx.captured_queries)

        queries()
        small = queries()
        for i in range(30):
            fact(self.tenant, Device.objects.create(tenant=self.tenant, name=f"w{i}",
                                                    site=self.site), ubr=1000 + i)
        first = queries()
        again = queries()
        self.assertLessEqual(first, small + 3)
        self.assertLessEqual(again, small + 1)
        self.assertEqual(self.open().count(), 2 * 31)

    def test_inventory_os_change_queues_a_rematch(self):
        from danbyte_checks.inventory import windows_result
        from discovery import packages
        from discovery.models import InventoryProfile, InventoryRun

        text = data("../../discovery/testdata/windows2022-inventory.json").decode()
        host = Device.objects.create(tenant=self.tenant, name="w", site=self.site)
        profile = InventoryProfile.objects.create(tenant=self.tenant, name="p")
        run = InventoryRun.objects.create(tenant=self.tenant, profile=profile)
        first = packages.store(self.tenant, host, run, windows_result(text))
        self.assertTrue(first["changed"])
        self.assertFalse(packages.store(self.tenant, host, run, windows_result(text))["changed"])
        patched = text.replace('"ubr":2849', '"ubr":5870')
        self.assertTrue(packages.store(self.tenant, host, run,
                                       windows_result(patched))["changed"])
        stored = HostOsFact.objects.get(device=host)
        self.assertEqual((stored.installation_type, stored.architecture), ("Server", "x64"))
        core = patched.replace('"installation_type":"Server"',
                               '"installation_type":"Server Core"')
        self.assertTrue(packages.store(self.tenant, host, run,
                                       windows_result(core))["changed"])
        self.assertEqual(HostOsFact.objects.get(device=host).installation_type, "Server Core")


class MatchApiTests(APITestCase, Base):
    def setUp(self):
        super().setUp()
        matching.recompute(self.tenant)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.pk)
        s.save()

    def member(self, name, grants):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for slug, actions in grants.items():
            p = ObjectPermission.objects.create(name=f"{name}{slug}", object_types=[slug],
                                                actions=actions)
            p.users.add(user)
            p.tenants.add(self.tenant)
        self.login(user)

    def test_os_build_matches_need_installed_software_view(self):
        url = f"/api/devices/{self.srv.pk}/vulnerabilities/"
        self.member("dev", {"device": ["view"]})
        self.assertEqual(self.client.get(url).json()["results"], [])
        self.member("both", {"device": ["view"], "installedsoftware": ["view"]})
        rows = self.client.get(url).json()["results"]
        self.assertEqual({r["via"] for r in rows}, {"os_build"})
        self.assertEqual(len(rows), 2)
        self.assertIsNone(rows[0]["mapping"])
        self.assertIsNone(rows[0]["host_package"])

    def test_filter_record_page_packages_tab_and_vex(self):
        self.login(User.objects.create_superuser("root", "r@example.com", "x"))
        r = self.client.get("/api/vulnerabilities/matches/?via=os_build")
        self.assertEqual(r.json()["count"], 2)
        r = self.client.get("/api/vulnerabilities/CVE-2026-100223/")
        fixed = {(f["product"], tuple(f["fixed"])) for f in r.json()["msrc_fixed_in"]}
        self.assertIn(("Windows Server 2022", ("10.0.20348.5870",)), fixed)
        r = self.client.get(f"/api/devices/{self.srv.pk}/packages/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["os_build"], {"product": "Windows Server 2022",
                                                "build": "10.0.20348.2849", "flag": "",
                                                "open": 2})
        from . import vex

        out = vex.section(self.tenant, Device.objects.filter(pk=self.srv.pk),
                          VirtualMachine.objects.none(), {("device", self.srv.pk): "os"}, {})
        self.assertEqual(out, [])


# ─── server fetch ────────────────────────────────────────────────────────────


def index(*months: tuple[str, str]) -> bytes:
    return json.dumps({"value": [
        {"ID": m, "Alias": m, "CurrentReleaseDate": current,
         "CvrfUrl": f"https://{MSRC_HOST}/cvrf/v3.0/cvrf/{m}"} for m, current in months]
    }).encode()


@override_settings(DISCOVERY_ENABLED=True)
class FetchTests(NetMixin, TestCase):
    tracked = (S2022, S2022_CORE)

    def setUp(self):
        super().setUp()
        p = mock.patch("django.utils.timezone.now",
                       return_value=datetime.fromisoformat("2026-11-11T00:00:00+00:00"))
        p.start()
        self.addCleanup(p.stop)
        self.net.on(MSRC_HOST, "/cvrf/v3.0/updates", (200, index(
            ("2026-Nov", "2026-11-10T08:00:00Z"), ("2026-Oct", "2026-11-10T14:50:30Z"),
            ("2024-Jan", "2026-11-05T00:00:00Z"), ("not-a-month", "x"))))
        self.net.on(MSRC_HOST, "/cvrf/v3.0/cvrf/2026-Nov", (200, data(NOV)))
        self.net.on(MSRC_HOST, "/cvrf/v3.0/cvrf/2026-Oct", (200, data(OCT)))

    def docs_fetched(self):
        return [c.path for c in self.net.to(MSRC_HOST) if "/cvrf/v3.0/cvrf/" in c.path]

    def test_months_only_and_incremental(self):
        run = self.run_once()
        self.assertEqual(run.status, "ok", run.error)
        calls = self.net.to(MSRC_HOST)
        self.assertEqual([c.path for c in calls], [
            "/cvrf/v3.0/updates", "/cvrf/v3.0/cvrf/2026-Nov", "/cvrf/v3.0/cvrf/2026-Oct"])
        # Nothing but the month is in a request: no query, no body.
        self.assertTrue(all(c.params == {} and c.body is None for c in calls))
        self.assertTrue(all(c.ip == PUBLIC_IP for c in calls))  # pinned, SSRF-checked
        self.assertEqual(set(MsrcMonth.objects.values_list("month", flat=True)),
                         {"2026-Nov", "2026-Oct"})
        self.assertTrue(Cve.objects.filter(vuln_id="CVE-2026-100223", source="msrc").exists())
        self.net.calls.clear()
        self.run_once()
        self.assertEqual(self.docs_fetched(), [])
        # Microsoft revised October: read again.
        self.net.on(MSRC_HOST, "/cvrf/v3.0/updates", (200, index(
            ("2026-Nov", "2026-11-10T08:00:00Z"), ("2026-Oct", "2026-11-12T00:00:00Z"))))
        self.net.calls.clear()
        self.run_once()
        self.assertEqual(self.docs_fetched(), ["/cvrf/v3.0/cvrf/2026-Oct"])
        # A Windows product appeared: every month is read again.
        self.set_tracked(S2022, ("msrc", "", "microsoft", "windows_server_2025"))
        self.net.calls.clear()
        self.run_once()
        self.assertEqual(len(self.docs_fetched()), 2)

    def test_no_windows_host_no_request(self):
        self.set_tracked()
        self.run_once()
        self.assertEqual(self.net.to(MSRC_HOST), [])

    def test_switch_off(self):
        self.settings_(sync_msrc=False)
        self.run_once()
        self.assertEqual(self.net.to(MSRC_HOST), [])

    def test_private_address_is_refused(self):
        self.resolve.stop()
        with mock.patch("core.ssrf.socket.getaddrinfo",
                        return_value=[(2, 1, 6, "", ("10.0.0.5", 443))]):
            run = self.run_once()
        self.assertEqual(run.status, "failed")
        self.assertIn("Microsoft index", run.error)
        self.assertEqual(self.net.to(MSRC_HOST), [])
        self.resolve.start()

    def test_a_wrong_document_fails_the_month(self):
        self.net.on(MSRC_HOST, "/cvrf/v3.0/cvrf/2026-Oct", (200, data(NOV)))
        run = self.run_once()
        self.assertEqual(run.status, "failed")
        self.assertIn("2026-Oct", run.error)
        self.assertEqual(list(MsrcMonth.objects.values_list("month", flat=True)), ["2026-Nov"])

    def test_upload_mode_fetches_nothing(self):
        self.settings_(update_source="upload")
        with self.assertRaises(fetch.Off):
            fetch.start_run(None)
        self.assertEqual(self.net.calls, [])


# ─── upload ──────────────────────────────────────────────────────────────────


@override_settings(DISCOVERY_ENABLED=True)
class UploadTests(TestCase):
    def setUp(self):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})

    def process(self, raw: bytes):
        with tracking(S2022, S2022_CORE):
            return imports.process("msrc", io.BytesIO(raw))

    def test_import_a_month(self):
        counts = self.process(data(NOV))
        self.assertEqual(counts["created"], 2)
        self.assertEqual(counts["month"], "2026-Nov")
        m = MsrcMonth.objects.get(month="2026-Nov")
        self.assertEqual((m.via, m.records), ("upload", 2))
        # Gzip is read too.
        counts = self.process(gzip.compress(data(OCT)))
        self.assertEqual(counts["month"], "2026-Oct")

    def test_files_that_are_not_a_month_are_refused(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("a.json", data(NOV))
        for raw in (data("nvd_page.json"), buf.getvalue(), b"not json", b"{}"):
            with self.subTest(raw=raw[:20]), self.assertRaises(ImportFormatError):
                self.process(raw)
        self.assertFalse(Cve.objects.exists())

    def test_size_cap(self):
        with mock.patch.object(imports, "MSRC_MAX_BYTES", 1000), \
                self.assertRaises(LimitExceeded):
            self.process(data(NOV))
        with self.assertRaises(LimitExceeded):
            list(sources.iter_msrc(open_stream(io.BytesIO(data(NOV)), max_bytes=1000)))

    def test_refused_without_a_windows_host(self):
        upload = SimpleUploadedFile("2026-Nov.json", data(NOV))
        user = User.objects.create_superuser("root", "r@example.com", "x")
        with self.assertRaises(imports.ImportRefused) as ctx:
            imports.start_upload(user, upload, "msrc")
        self.assertIn("Windows", str(ctx.exception))


class SettingsApiTests(APITestCase):
    def test_switch_and_status(self):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        store.record_msrc_month("2026-Nov", current_release=None, via="upload",
                                products={"windows_server_2022"}, records=2)
        self.client.force_login(User.objects.create_superuser("root", "r@example.com", "x"))
        r = self.client.get("/api/vulnerabilities/settings/")
        body = r.json()
        self.assertTrue(body["sync_msrc"])
        self.assertEqual(body["msrc"]["months"], 1)
        self.assertEqual(body["msrc"]["newest"], "2026-Nov")
        self.assertIn("msrc", body["import_kinds"])
        r = self.client.patch("/api/vulnerabilities/settings/",
                              {"sync_msrc": False, "msrc_url": "http://mirror"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("msrc_url", r.json())
        r = self.client.patch("/api/vulnerabilities/settings/", {"sync_msrc": False},
                              format="json")
        self.assertFalse(r.json()["sync_msrc"])
        self.assertFalse(VulnerabilitySettings.load().sync_msrc)

    def test_not_for_non_admins(self):
        User.objects.create_user("u", password="x")
        self.client.force_login(User.objects.get(username="u"))
        r = self.client.patch("/api/vulnerabilities/settings/", {"sync_msrc": False},
                              format="json")
        self.assertEqual(r.status_code, 403)
