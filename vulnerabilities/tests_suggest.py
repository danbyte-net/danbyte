"""Suggest mappings (#451): the known-products table, candidate ranking,
the suggestions list (scope, RBAC, tenant isolation, NVD only in server
mode) and bulk-create (all or nothing, one queued recompute and fetch)."""
from __future__ import annotations

import re
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APITestCase

from api.models import (
    Application,
    Device,
    DeviceType,
    InstalledSoftware,
    Manufacturer,
    Platform,
    Site,
)
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import fetch, jobs, signals
from .known_products import KNOWN, compact, lookup, runs, words
from .models import Cve, CveProduct, ProductMapping, VulnerabilitySettings
from .suggest_api import _candidate, nvd_query, rank

User = get_user_model()
HEADER = "X-Danbyte-Unknown-Params"
URL = "/api/vulnerabilities/mappings/suggestions/"
BULK = "/api/vulnerabilities/mappings/bulk-create/"
LOCMEM = override_settings(CACHES={"default": {
    "BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})


def first(names, maker="", parts=("o", "a")):
    hits = lookup(names, maker, parts)
    return (f"{hits[0].entry.vendor}:{hits[0].entry.product}", hits[0].confidence) \
        if hits else None


class KnownProductsTests(SimpleTestCase):
    def test_normalisation(self):
        self.assertEqual(words("IOS-XE 17.9.4a"), ["ios", "xe", "17", "9", "4", "a"])
        self.assertEqual(words("Cisco_NX-OS"), ["cisco", "nx", "os"])
        self.assertEqual(compact("nx-os"), "nxos")
        self.assertIn("iosxe", runs(words("Cisco IOS XE")))
        self.assertIn("os10", runs(words("Dell OS10")))

    def test_exact_expectations(self):
        cases = [
            (["Cisco IOS XE"], "", "cisco:ios_xe", "high"),
            (["IOS-XE 17"], "", "cisco:ios_xe", "high"),
            (["ios_xe"], "", "cisco:ios_xe", "high"),
            (["IOS"], "Cisco", "cisco:ios", "high"),
            (["IOS"], "", "cisco:ios", "medium"),
            (["Cisco IOS 15.2"], "", "cisco:ios", "high"),
            (["IOS XR"], "", "cisco:ios_xr", "high"),
            (["NX-OS"], "", "cisco:nx-os", "high"),
            (["Nexus NXOS 9.3"], "", "cisco:nx-os", "high"),
            (["Junos"], "", "juniper:junos", "high"),
            (["Junos OS Evolved"], "", "juniper:junos_os_evolved", "high"),
            (["EOS"], "Arista Networks", "arista:eos", "high"),
            (["Arista EOS 4.28"], "", "arista:eos", "high"),
            (["FortiOS 7.2"], "", "fortinet:fortios", "high"),
            (["FortiGate"], "", "fortinet:fortios", "high"),
            (["PAN-OS"], "", "paloaltonetworks:pan-os", "high"),
            (["VMware ESXi 8"], "", "vmware:esxi", "high"),
            (["vCenter"], "", "vmware:vcenter_server", "high"),
            (["Proxmox VE"], "", "proxmox:virtual_environment", "high"),
            (["Ubuntu 22.04"], "", "canonical:ubuntu_linux", "high"),
            (["debian-12"], "", "debian:debian_linux", "high"),
            (["RHEL 9"], "", "redhat:enterprise_linux", "high"),
            (["Windows Server 2019 Datacenter"], "", "microsoft:windows_server_2019", "high"),
            (["RouterOS"], "", "mikrotik:routeros", "high"),
            (["v7"], "MikroTik", "mikrotik:routeros", "medium"),
            (["ArubaOS"], "", "arubanetworks:arubaos", "high"),
            (["pfSense"], "", "netgate:pfsense", "high"),
            (["Apache Tomcat"], "", "apache:tomcat", "high"),
            (["PostgreSQL"], "", "postgresql:postgresql", "high"),
            (["nginx"], "", "f5:nginx_open_source", "high"),
            (["ArubaOS-CX 10.13"], "", "hpe:arubaos-cx", "high"),
            (["EXOS"], "Extreme Networks", "extremenetworks:extremexos", "high"),
            (["OS10"], "Dell", "dell:networking_os10", "high"),
        ]
        for names, maker, want, conf in cases:
            with self.subTest(names=names, maker=maker):
                self.assertEqual(first(names, maker), (want, conf))

    def test_shorter_alias_inside_a_longer_one_is_dropped(self):
        ids = {f"{h.entry.vendor}:{h.entry.product}" for h in lookup(["Cisco IOS XE"])}
        self.assertEqual(ids, {"cisco:ios_xe"})
        ids = {h.entry.product for h in lookup(["Junos OS Evolved"], "Juniper")}
        self.assertEqual(ids, {"junos_os_evolved"})
        # A bare word that needed context loses to a plain alias.
        self.assertEqual({h.entry.product for h in lookup(["Apache Tomcat"])}, {"tomcat"})

    def test_no_guess(self):
        for names, maker in ((["Linux"], ""), (["Firmware"], "Acme"), (["iOS 17"], "Apple"),
                             (["Catalyst 9300"], "Cisco")):
            with self.subTest(names=names):
                self.assertIsNone(first(names, maker))

    def test_parts_filter(self):
        self.assertIsNone(first(["Cisco IOS XE"], parts=("h",)))
        self.assertEqual(first(["PostgreSQL"], parts=("a",)),
                         ("postgresql:postgresql", "high"))

    def test_table_is_well_formed(self):
        token = re.compile(r"^[a-z0-9._-]+$")
        seen = set()
        for e in KNOWN:
            with self.subTest(e=e.cpe):
                self.assertIn(e.part, ("o", "a"))
                self.assertRegex(e.vendor, token)
                self.assertRegex(e.product, token)
                self.assertNotIn(e.cpe, seen)
                seen.add(e.cpe)
                self.assertTrue(e.aliases or e.weak)
                for a in (*e.aliases, *e.weak, *e.vendors):
                    self.assertEqual(a, compact(a))


class RankTests(SimpleTestCase):
    def test_best_first_one_per_identifier(self):
        c = [
            _candidate("cpe", "o", "cisco", "ios", "local", "low", records=9),
            _candidate("cpe", "o", "cisco", "ios_xe", "local", "medium", records=4),
            _candidate("cpe", "o", "cisco", "ios_xe", "known", "high"),
            _candidate("cpe", "o", "cisco", "ios_xe", "sbom", "high"),
            _candidate("cpe", "o", "cisco", "iosxe_x", "nvd", "medium"),
        ]
        out = rank(c)
        self.assertEqual([(x["product"], x["source"]) for x in out],
                         [("ios_xe", "sbom"), ("iosxe_x", "nvd"), ("ios", "local")])
        self.assertEqual(out[0]["scheme"], "cisco_iosxe")
        self.assertEqual(out[0]["version_scheme"], "auto")

    def test_nvd_query(self):
        self.assertEqual(nvd_query({"name": "IOS XE 17.9", "manufacturer": "Cisco"}),
                         "cisco ios xe")
        self.assertEqual(nvd_query({"name": "Cisco IOS", "manufacturer": "Cisco"}),
                         "cisco ios")


class Base(APITestCase):
    @classmethod
    def setUpTestData(cls):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        cls.site = Site.objects.create(tenant=cls.tenant, name="HQ")
        cisco = Manufacturer.objects.create(tenant=cls.tenant, name="Cisco", slug="cisco")
        cls.xe = Platform.objects.create(
            tenant=cls.tenant, name="IOS-XE", slug="ios-xe", manufacturer=cisco,
            cpe_template="cpe:2.3:o:cisco:ios_xe:{version}:*:*:*:*:*:*:*")
        cls.ubuntu = Platform.objects.create(tenant=cls.tenant, name="Ubuntu 22.04",
                                             slug="ubuntu-22-04")
        cls.odd = Platform.objects.create(tenant=cls.tenant, name="Acme Firmware",
                                          slug="acme-fw")
        cls.unused = Platform.objects.create(tenant=cls.tenant, name="Junos", slug="junos")
        cls.mapped = Platform.objects.create(tenant=cls.tenant, name="NX-OS", slug="nx-os")
        ProductMapping.objects.create(tenant=cls.tenant, platform=cls.mapped, kind="cpe",
                                      part="o", vendor="cisco", product="nx-os")
        cls.dt = DeviceType.objects.create(tenant=cls.tenant, name="C9300-48P",
                                           manufacturer=cisco)
        for i, v in enumerate(("17.9.4", "", "17.9.5")):
            Device.objects.create(tenant=cls.tenant, name=f"r{i}", site=cls.site,
                                  platform=cls.xe, device_type=cls.dt, software_version=v)
        Device.objects.create(tenant=cls.tenant, name="u1", site=cls.site,
                              platform=cls.ubuntu, software_version="")
        Device.objects.create(tenant=cls.tenant, name="o1", site=cls.site, platform=cls.odd)
        Device.objects.create(tenant=cls.tenant, name="n1", site=cls.site,
                              platform=cls.mapped)
        cls.pg = Application.objects.create(tenant=cls.tenant, name="PostgreSQL",
                                            slug="postgresql")
        InstalledSoftware.objects.create(tenant=cls.tenant, application=cls.pg,
                                         device=Device.objects.get(name="u1"), version="16.2")
        # Another tenant's platform: never listed, never mapped from here.
        cls.foreign = Platform.objects.create(tenant=cls.other, name="IOS XE",
                                              slug="ios-xe")
        Device.objects.create(tenant=cls.other, name="f1", platform=cls.foreign)
        cve = Cve.objects.create(vuln_id="CVE-2024-9999", source="nvd")
        CveProduct.objects.create(cve=cve, kind="cpe", part="h", vendor="cisco",
                                  product="c9300-48p")
        cls.admin = User.objects.create_superuser("root", "r@example.com", "x")

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).pk)
        s.save()

    def member(self, name, grants, sites=()):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for i, (types, actions) in enumerate(grants):
            perm = ObjectPermission.objects.create(name=f"{name}{i}", object_types=list(types),
                                                   actions=list(actions))
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            if sites:
                perm.sites.set(sites)
        self.login(user)
        return user

    def rows(self, query=""):
        r = self.client.get(f"{URL}?page_size=100{query}")
        self.assertEqual(r.status_code, 200, r.content[:300])
        return {row["name"]: row for row in r.json()["results"]}, r.json()


class SuggestionTests(Base):
    def test_lists_unmapped_in_use_subjects_with_ranked_candidates(self):
        self.login(self.admin)
        rows, body = self.rows()
        self.assertEqual(set(rows), {"IOS-XE", "Ubuntu 22.04", "Acme Firmware", "PostgreSQL",
                                     "C9300-48P"})
        xe = rows["IOS-XE"]
        self.assertEqual((xe["subject_type"], xe["in_use"], xe["without_version"]),
                         ("platform", 3, 1))
        self.assertEqual([(c["identifier"], c["source"], c["confidence"])
                          for c in xe["candidates"]],
                         [("cpe:2.3:o:cisco:ios_xe", "sbom", "high")])
        self.assertEqual(xe["candidates"][0]["scheme"], "cisco_iosxe")
        self.assertEqual(rows["Ubuntu 22.04"]["candidates"][0]["identifier"],
                         "cpe:2.3:o:canonical:ubuntu_linux")
        self.assertEqual(rows["Ubuntu 22.04"]["candidates"][0]["source"], "known")
        self.assertEqual(rows["Acme Firmware"]["candidates"], [])
        pg = rows["PostgreSQL"]
        self.assertEqual((pg["subject_type"], pg["in_use"], pg["without_version"]),
                         ("application", 1, 0))
        dt = rows["C9300-48P"]
        self.assertEqual((dt["subject_type"], dt["in_use"]), ("device_type", 3))
        self.assertEqual([(c["identifier"], c["source"], c["confidence"])
                          for c in dt["candidates"]],
                         [("cpe:2.3:h:cisco:c9300-48p", "local", "medium")])
        self.assertEqual(dt["candidates"][0]["records"], 1)
        # Best confidence first; the one without a candidate last.
        self.assertEqual(body["results"][-1]["name"], "Acme Firmware")
        self.assertEqual(body["totals"]["subjects"], 5)
        self.assertEqual(body["nvd_status"], "off")

    def test_disabled_mapping_is_still_suggested(self):
        ProductMapping.objects.filter(platform=self.mapped).update(enabled=False)
        self.login(self.admin)
        rows, _ = self.rows()
        self.assertEqual(rows["NX-OS"]["candidates"][0]["identifier"],
                         "cpe:2.3:o:cisco:nx-os")

    def test_filters(self):
        self.login(self.admin)
        rows, _ = self.rows("&subject_type=application")
        self.assertEqual(set(rows), {"PostgreSQL"})
        rows, _ = self.rows("&confidence=none")
        self.assertEqual(set(rows), {"Acme Firmware"})
        rows, _ = self.rows("&q=ubu")
        self.assertEqual(set(rows), {"Ubuntu 22.04"})
        self.assertEqual(self.client.get(f"{URL}?confidence=sure").status_code, 400)
        self.assertEqual(self.client.get(f"{URL}?subject_type=site").status_code, 400)

    def test_rbac_and_site_scope(self):
        # Change on applications only: no platform or device type is listed.
        self.member("apps", [(["application"], ["view", "change"]),
                             (["device", "installedsoftware"], ["view"])])
        rows, _ = self.rows()
        self.assertEqual(set(rows), {"PostgreSQL"})
        # View on platforms is not enough.
        self.member("viewer", [(["platform", "device"], ["view"])])
        rows, _ = self.rows()
        self.assertEqual(rows, {})
        # In use counts what the caller may see: a site role elsewhere sees
        # no hosts, so nothing is in use for it.
        branch = Site.objects.create(tenant=self.tenant, name="Branch")
        self.member("branch", [(["platform"], ["view", "change"]), (["device"], ["view"])],
                    sites=[branch])
        rows, _ = self.rows()
        self.assertEqual(rows, {})

    def test_tenant_isolation(self):
        self.login(self.admin, self.other)
        rows, _ = self.rows()
        self.assertEqual(set(rows), {"IOS XE"})
        self.assertEqual(rows["IOS XE"]["in_use"], 1)

    def test_off_is_404(self):
        self.login(self.admin)
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        self.assertEqual(self.client.get(URL).status_code, 404)
        self.assertEqual(self.client.post(BULK, [], format="json").status_code, 404)

    def test_unknown_params_are_named(self):
        self.login(self.admin)
        r = self.client.get(f"{URL}?zz_probe=1")
        self.assertEqual(r.get(HEADER), "zz_probe")
        r = self.client.get(f"{URL}?subject_type=platform&confidence=high&q=x&nvd=false"
                            "&page=1&page_size=5")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(HEADER, r)


@mock.patch.object(fetch, "search_cpes")
class NvdTests(Base):
    def setUp(self):
        LOCMEM.enable()
        self.addCleanup(LOCMEM.disable)
        cache.clear()
        self.login(self.admin)

    def test_never_asked_outside_server_mode(self, search):
        for source in ("upload", "browser"):
            VulnerabilitySettings.objects.filter(pk=1).update(update_source=source)
            with self.subTest(source=source):
                rows, body = self.rows("&nvd=true")
                self.assertEqual(body["nvd_status"], "off")
                self.assertEqual(rows["Acme Firmware"]["candidates"], [])
        search.assert_not_called()

    def test_server_mode_asks_for_rows_without_a_candidate_once(self, search):
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="server")
        search.return_value = [
            {"part": "o", "vendor": "acme", "product": "firmware", "example_title": "Acme FW",
             "names": 3, "deprecated": False},
            {"part": "h", "vendor": "acme", "product": "box", "example_title": "",
             "names": 1, "deprecated": False},
        ]
        rows, body = self.rows()
        self.assertEqual(body["nvd_status"], "not_asked")
        self.assertEqual(body["nvd_pending"], 1)
        search.assert_not_called()
        rows, body = self.rows("&nvd=true")
        self.assertEqual(search.call_count, 1)
        self.assertEqual(search.call_args.args[1], "acme firmware")
        self.assertEqual([(c["identifier"], c["source"], c["confidence"])
                          for c in rows["Acme Firmware"]["candidates"]],
                         [("cpe:2.3:o:acme:firmware", "nvd", "medium")])
        # Cached: asked again, NVD is not.
        self.rows("&nvd=true")
        self.assertEqual(search.call_count, 1)

    def test_budget_is_shared_with_the_picker(self, search):
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="server")
        search.return_value = []
        with mock.patch("vulnerabilities.fetch_api._bump", return_value=999):
            rows, body = self.rows("&nvd=true")
        search.assert_not_called()
        self.assertEqual((body["nvd_status"], body["nvd_pending"]), ("limited", 1))
        self.assertIn("retry_after", body)


@mock.patch.object(jobs, "_claim", return_value=True)
@mock.patch.object(jobs, "_push")
@mock.patch.object(fetch, "enqueue_products")
class BulkCreateTests(Base):
    def post(self, body):
        connection.run_on_commit = [e for e in connection.run_on_commit
                                    if e[1] is not signals._flush]
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(BULK, body, format="json")

    def test_creates_all_with_one_recompute_and_one_fetch(self, enqueue, push, _claim):
        LOCMEM.enable()
        self.addCleanup(LOCMEM.disable)
        cache.clear()
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="server")
        self.login(self.admin)
        r = self.post([
            {"platform": str(self.xe.pk), "identifier": "cpe:2.3:o:cisco:ios_xe"},
            {"platform": str(self.ubuntu.pk), "identifier": "cpe:2.3:o:canonical:ubuntu_linux",
             "version_scheme": "dpkg"},
            {"application": str(self.pg.pk), "identifier": "cpe:2.3:a:postgresql:postgresql"},
            {"device_type": str(self.dt.pk), "identifier": "cpe:2.3:h:cisco:c9300-48p"},
        ])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()["created"]), 4)
        self.assertEqual(ProductMapping.objects.filter(platform=self.ubuntu).get()
                         .version_scheme, "dpkg")
        recomputes = [c for c in push.call_args_list if c.args[0] is jobs.run_recompute]
        self.assertEqual(len(recomputes), 1)
        enqueue.assert_called_once()
        self.assertEqual(sorted(enqueue.call_args.args[0]), [
            ("cpe", "a", "postgresql", "postgresql"),
            ("cpe", "o", "canonical", "ubuntu_linux"),
            ("cpe", "o", "cisco", "ios_xe")])
        m = ProductMapping.objects.get(platform=self.xe)
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=str(m.pk),
                                                      action="create").exists())

    def test_all_or_nothing(self, enqueue, push, _claim):
        self.login(self.admin)
        before = ProductMapping.objects.count()
        r = self.post([
            {"platform": str(self.xe.pk), "identifier": "cpe:2.3:o:cisco:ios_xe"},
            {"platform": str(self.ubuntu.pk), "identifier": "cpe:2.3:h:canonical:x"},
            {"platform": str(self.foreign.pk), "identifier": "cpe:2.3:o:cisco:ios_xe"},
            {"platform": str(self.xe.pk), "identifier": "cpe:2.3:o:cisco:ios_xe"},
            {"platform": str(self.mapped.pk), "identifier": "cpe:2.3:o:cisco:nx-os"},
            {"application": str(self.pg.pk)},
        ])
        self.assertEqual(r.status_code, 400)
        errors = r.json()["errors"]
        self.assertEqual(sorted(errors), ["1", "2", "3", "4", "5"])
        self.assertIn("platform", errors["2"])
        self.assertIn("row 0", str(errors["3"]))
        self.assertIn("already mapped", str(errors["4"]))
        self.assertEqual(ProductMapping.objects.count(), before)
        self.assertEqual(push.call_count, 0)
        enqueue.assert_not_called()

    def test_rbac(self, enqueue, push, _claim):
        self.member("viewer", [(["platform"], ["view"]), (["application"], ["view", "change"])])
        r = self.post([
            {"application": str(self.pg.pk), "identifier": "cpe:2.3:a:postgresql:postgresql"},
            {"platform": str(self.xe.pk), "identifier": "cpe:2.3:o:cisco:ios_xe"},
        ])
        self.assertEqual(r.status_code, 403)
        self.assertEqual(sorted(r.json()["errors"]), ["1"])
        self.assertFalse(ProductMapping.objects.filter(application=self.pg).exists())

    def test_shape(self, enqueue, push, _claim):
        self.login(self.admin)
        for body in ({}, [], ["x"]):
            with self.subTest(body=body):
                self.assertEqual(self.post(body).status_code, 400)
