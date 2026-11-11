"""The package inventory feeds the model (#451): the running OS version and
its platform's end of life, installs of applications that name packages,
the review queue's platform and application proposals, the Packages tab's
Application/CVEs columns and advisory state, and the package-over-CPE
dedupe rule. Tenant isolation, RBAC and query counts throughout."""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.core.exceptions import ValidationError
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from api import software_versions
from api.models import Application, Device, InstalledSoftware, Platform, VirtualMachine
from api.package_names import Matcher, clean, parse
from audit.models import ChangeLogEntry
from compliance.models import EolMapping, EolProduct, EolSettings
from danbyte_checks import inventory as inv
from vulnerabilities.models import (
    Cve,
    CveProduct,
    ProductMapping,
    SyncRun,
    VulnerabilityMatch,
    VulnerabilitySettings,
)

from . import inventory_findings, known_software, os_platform, packages, runner, software
from .models import HostOsFact, HostPackage, InventoryFindingDecision
from .tests_discovery import ApiBase, Base, FakeCollector

DEBIAN13 = {"id": "debian", "version_id": "13", "version_codename": "trixie",
            "pretty_name": "Debian GNU/Linux 13 (trixie)", "id_like": []}
PKGS = [
    ("deb", "nginx", "1.26.3-3+deb13u1", "amd64", "nginx", "1.26.3-3+deb13u1"),
    ("deb", "nginx-common", "1.26.3-3+deb13u1", "all", "nginx", "1.26.3-3+deb13u1"),
    ("deb", "libssl3t64", "3.5.1-1", "amd64", "openssl", "3.5.1-1"),
    ("deb", "bash", "5.2.37-2", "amd64", "bash", "5.2.37-2"),
]


def debian13(pkgs=PKGS, os=DEBIAN13):
    return inv.InventoryResult(inv.OK, os=dict(os), manager="dpkg",
                               packages=[inv.Package(*p) for p in pkgs])


def eol_catalog(enabled=True):
    EolSettings.objects.update_or_create(pk=1, defaults={"enabled": enabled})
    EolProduct.objects.update_or_create(
        tenant=None, source="endoflife_date", name="debian",
        defaults={"label": "Debian", "releases": [
            {"name": "13", "release_date": "2025-08-09", "eol_date": "2028-08-09",
             "eol": False, "latest": "13.1"},
            {"name": "12", "release_date": "2023-06-10", "eol_date": "2026-06-10",
             "eol": False, "latest": "12.12"}]})
    EolProduct.objects.update_or_create(
        tenant=None, source="endoflife_date", name="nginx",
        defaults={"label": "nginx", "releases": [
            {"name": "1.26", "release_date": "2024-04-23", "eol_date": "2025-04-16"},
            {"name": "1.28", "release_date": "2025-04-23", "eol_date": None, "eol": False}]})


# ─── package names ───────────────────────────────────────────────────────────


class PackageNamesTests(SimpleTestCase):
    def test_parse_and_clean(self):
        self.assertEqual(parse("deb:nginx"), [("deb", "nginx")])
        self.assertEqual(parse("nginx"), [("deb", "nginx"), ("rpm", "nginx"), ("apk", "nginx")])
        self.assertEqual(parse("generic:Mozilla Firefox*"), [("generic", "Mozilla Firefox*")])
        self.assertEqual(clean([" Deb:Nginx ", "deb:nginx", "rpm:httpd"]),
                         ["deb:nginx", "rpm:httpd"])
        for bad in ("deb:ngin[x]", "deb:(a|b)", "deb:.*", "foo:nginx", "deb:*", "", "deb:a b"):
            with self.subTest(bad), self.assertRaises(ValidationError):
                clean([bad])
        with self.assertRaises(ValidationError):
            clean([f"deb:p{i}" for i in range(60)])

    def test_matcher_exact_glob_and_rank(self):
        m = Matcher([("pg", ["deb:postgresql-1*", "rpm:postgresql-server"]),
                     ("web", ["deb:nginx", "deb:nginx-*"]),
                     ("ff", ["generic:Mozilla Firefox*"])])
        self.assertEqual(m.apps_of("deb", "postgresql-16"), {"pg"})
        self.assertEqual(m.apps_of("deb", "postgresql-common"), set())
        self.assertEqual(m.apps_of("rpm", "postgresql-server"), {"pg"})
        self.assertEqual(m.apps_of("rpm", "postgresql-16"), set())
        self.assertEqual(m.match("deb", "nginx"), (("web", 0),))
        self.assertEqual(m.match("deb", "nginx-common"), (("web", 1),))
        self.assertEqual(m.apps_of("generic", "mozilla firefox (x64 en-US)"), {"ff"})
        # A glob never escapes: a dot is a dot.
        self.assertEqual(Matcher([("a", ["deb:php8.*"])]).apps_of("deb", "php8x2"), set())

    def test_upstream_versions(self):
        self.assertEqual(software.upstream_version("deb", "1:2.4.62-1~deb12u2"), "2.4.62")
        self.assertEqual(software.upstream_version("deb", "5:27.3.1-1~debian.12~bookworm"),
                         "27.3.1")
        self.assertEqual(software.upstream_version("rpm", "1.20.1-14.el9"), "1.20.1")
        self.assertEqual(software.upstream_version("apk", "1.26.2-r0"), "1.26.2")
        self.assertEqual(software.upstream_version("generic", "120.0.1"), "120.0.1")


class KnownSoftwareTests(SimpleTestCase):
    def test_table_is_valid_data(self):
        keys, names = set(), set()
        for k in known_software.KNOWN:
            with self.subTest(k.key):
                self.assertNotIn(k.key, keys)
                self.assertNotIn(k.name.lower(), names)
                keys.add(k.key)
                names.add(k.name.lower())
                self.assertTrue(k.packages)
                self.assertEqual(clean(list(k.packages)), list(k.packages))
                for entry in k.packages:
                    self.assertIn(entry.split(":")[0], ("deb", "rpm", "apk"))
        for wanted in ("nginx", "apache-httpd", "postgresql", "mysql", "mariadb", "redis",
                       "docker", "containerd", "haproxy", "openssh-server", "bind", "samba",
                       "php", "nodejs", "python3", "openjdk", "tomcat", "rabbitmq",
                       "elasticsearch", "grafana", "prometheus", "zabbix-agent", "keepalived",
                       "frr", "openvpn", "wireguard", "squid", "postfix", "dovecot"):
            self.assertIn(wanted, known_software.BY_KEY)

    def test_well_known_names_resolve(self):
        m = Matcher([(k.key, k.packages) for k in known_software.KNOWN])
        for ptype, name, key in (("deb", "nginx", "nginx"), ("rpm", "httpd", "apache-httpd"),
                                 ("deb", "postgresql-16", "postgresql"),
                                 ("apk", "postgresql16", "postgresql"),
                                 ("deb", "docker-ce", "docker"), ("deb", "bind9", "bind"),
                                 ("deb", "php8.2-cli", "php"),
                                 ("rpm", "java-17-openjdk-headless", "openjdk"),
                                 ("deb", "openjdk-17-jre-headless", "openjdk")):
            with self.subTest(name):
                self.assertIn(key, m.apps_of(ptype, name))
        self.assertEqual(m.apps_of("deb", "php-common"), set())


# ─── part 1: the OS version and the platform ─────────────────────────────────


@override_settings(DISCOVERY_ENABLED=True)
class VersionPrecedenceTests(Base):
    def vm(self, version="", source="", seen=True):
        self.n = getattr(self, "n", 0) + 1
        return VirtualMachine.objects.create(
            tenant=self.tenant, name=f"v{self.n}", cluster=self.cluster,
            software_version=version,
            software_version_source=source,
            software_version_seen_at=timezone.now() if seen and version else None)

    def test_discovery_outranks_the_other_automatic_sources(self):
        for source, held in (("snmp", "6.1"), ("virtualization", "13.1"), ("oxidized", "12")):
            with self.subTest(source):
                vm = self.vm(held, source)
                self.assertTrue(software_versions.record(vm, "13", "discovery"))
                self.assertEqual((vm.software_version, vm.software_version_source),
                                 ("13", "discovery"))
                # And none of them replaces it.
                self.assertEqual(software_versions.record(vm, "13.1", source), [])
                self.assertEqual(vm.software_version, "13")

    def test_a_person_value_is_never_overwritten(self):
        for source in ("manual", "import"):
            vm = self.vm("12", source, seen=False)
            self.assertEqual(software_versions.record(vm, "13", "discovery"), [])
            self.assertEqual(vm.software_version, "12")

    def test_version_forms(self):
        def fact(**kw):
            return HostOsFact(tenant=self.tenant, collected_at=timezone.now(), **kw)

        self.assertEqual(os_platform.version_of(fact(os_id="debian", version_id="13")), "13")
        self.assertEqual(os_platform.version_of(fact(os_id="ubuntu", version_id="22.04")),
                         "22.04")
        self.assertEqual(os_platform.version_of(fact(os_id="rocky", version_id="9.4")), "9.4")
        self.assertEqual(os_platform.version_of(
            fact(os_id="windows", version_id="10.0.20348", build="20348", ubr=2700)),
            "10.0.20348.2700")
        eol_catalog()
        rhel = EolProduct.objects.create(source="endoflife_date", name="rhel", releases=[
            {"name": "9"}, {"name": "8"}])
        t = os_platform.target(fact(os_id="rhel", version_id="9.4"), {"rhel": rhel})
        self.assertEqual((t.name, t.eol_product, t.eol_cycle),
                         ("Red Hat Enterprise Linux 9", "rhel", "9"))
        t = os_platform.target(fact(os_id="debian", version_id="13"))
        self.assertEqual((t.name, t.eol_product, t.eol_cycle), ("Debian 13", "debian", "13"))
        self.assertIsNone(os_platform.target(fact(os_id="windows", version_id="10.0.1")))

    def test_fits(self):
        eol_catalog()
        t = os_platform.target(HostOsFact(os_id="debian", version_id="13",
                                          collected_at=timezone.now()))
        for name, ok in (("Debian", True), ("Debian 13", True), ("Debian GNU/Linux 13", True),
                         ("Debian 12", False), ("Linux 6.x/2.6 Kernel", False),
                         ("Ubuntu 24.04", False)):
            with self.subTest(name):
                p = Platform(tenant=self.tenant, name=name, slug=name.lower().replace(" ", "-"))
                self.assertEqual(os_platform.fits(p, t), ok)
        self.assertFalse(os_platform.fits(None, t))


@mock.patch.object(software, "enqueue_sync", lambda tenant_id: None)
@mock.patch("monitoring.models.DeviceCredential.resolve_secret",
            lambda self: {"password": "pw"})
@override_settings(DISCOVERY_ENABLED=True)
class ReadFeedsModelTests(ApiBase):
    def setUp(self):
        self.generic = Platform.objects.create(tenant=self.tenant, name="Linux 6.x/2.6 Kernel",
                                               slug="linux")
        self.vm = self.host("vm13", "10.0.0.5", site=self.site, vm=True)
        VirtualMachine.objects.filter(pk=self.vm.pk).update(platform=self.generic)
        self.p = self.profile()
        self.p.sites.add(self.site)
        self.nginx = Application.objects.create(
            tenant=self.tenant, name="nginx", slug="nginx",
            package_names=["deb:nginx", "deb:nginx-*"])

    def read(self, res):
        with mock.patch.object(runner, "enqueue"), self.captureOnCommitCallbacks(execute=True):
            run = runner.start(self.p, user=self.su)
        fake = FakeCollector({"10.0.0.5": res})
        runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe)
        run.refresh_from_db()
        return run

    def test_a_debian_13_read_sets_version_installs_and_shows_end_of_life(self):
        eol_catalog()
        run = self.read(debian13())
        self.assertEqual(run.status, "ok")
        self.vm.refresh_from_db()
        self.assertEqual((self.vm.software_version, self.vm.software_version_source),
                         ("13", "discovery"))
        self.assertIsNotNone(self.vm.software_version_seen_at)
        # Never the platform on its own.
        self.assertEqual(self.vm.platform_id, self.generic.pk)
        self.assertEqual(run.counts["versions"], 1)
        inst = InstalledSoftware.objects.get(application=self.nginx, virtual_machine=self.vm)
        self.assertEqual((inst.version, inst.observed_version, inst.source),
                         ("1.26.3", "1.26.3", "discovery"))
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(inst.pk), action="create", cause="Package inventory").exists())
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(self.vm.pk), cause="Package inventory",
            changes__has_key="software_version").exists())
        self.assertIsNotNone(inst.numid)

        # The review queue proposes the platform; accepting it creates and maps it.
        self.login(self.su)
        rows = self.client.get("/api/discovery/findings/?kind=platform").data["results"]
        self.assertEqual(len(rows), 1)
        f = rows[0]
        self.assertEqual(f["title"], "Set platform to Debian 13")
        self.assertIsNone(f["proposal"]["platform"])
        self.assertEqual(f["proposal"]["eol"], {"product": "debian", "cycle": "13"})
        self.assertEqual(f["proposal"]["current"]["name"], "Linux 6.x/2.6 Kernel")
        self.assertNotIn("evidence_key", f)
        r = self.client.post("/api/discovery/findings/accept/", {"ids": [f["id"]]},
                             format="json")
        self.assertEqual(r.data["refused"], [])
        self.assertEqual(r.data["created"][0]["mapped"], "debian 13")
        self.vm.refresh_from_db()
        self.assertEqual(self.vm.platform.name, "Debian 13")
        m = EolMapping.objects.get(platform=self.vm.platform)
        self.assertEqual((m.product, m.cycle, str(m.eol_date)), ("debian", "13", "2028-08-09"))
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(self.vm.pk), changes__has_key="platform").exists())
        # The VM shows its OS support from the cycle; nobody typed a date.
        body = self.client.get(f"/api/virtual-machines/{self.vm.pk}/").json()
        self.assertEqual(body["platform"]["eol"]["status"], "supported")
        self.assertEqual(body["platform"]["effective_end"], "2028-08-09")
        self.assertEqual(body["software_version_source"], "discovery")
        # Accepted: the finding is gone.
        self.assertEqual(
            self.client.get("/api/discovery/findings/?kind=platform").data["results"], [])

    def test_installs_follow_the_packages(self):
        self.read(debian13())
        inst = InstalledSoftware.objects.get(application=self.nginx, virtual_machine=self.vm)
        upgraded = [("deb", "nginx", "1.28.0-1", "amd64", "nginx", "1.28.0-1"), *PKGS[2:]]
        self.read(debian13(upgraded))
        inst.refresh_from_db()
        self.assertEqual((inst.version, inst.observed_version), ("1.28.0", "1.28.0"))
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(inst.pk), action="update", changes__has_key="version").exists())
        # Gone from the host: the Discovery install goes through the change log.
        self.read(debian13(PKGS[2:]))
        self.assertFalse(InstalledSoftware.objects.filter(pk=inst.pk).exists())
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=str(inst.pk),
                                                      action="delete").exists())

    def test_a_person_install_is_never_overwritten(self):
        mine = InstalledSoftware.objects.create(tenant=self.tenant, application=self.nginx,
                                                virtual_machine=self.vm, version="1.24")
        scan = Application.objects.create(tenant=self.tenant, name="OpenSSH", slug="openssh")
        scanned = InstalledSoftware.objects.create(
            tenant=self.tenant, application=scan, virtual_machine=self.vm, version="9.6p1",
            source="discovery")
        self.read(debian13())
        mine.refresh_from_db()
        self.assertEqual((mine.version, mine.observed_version, mine.source),
                         ("1.24", "1.26.3", "manual"))
        self.assertEqual(InstalledSoftware.objects.filter(application=self.nginx).count(), 1)
        self.login(self.su)
        row = self.client.get(f"/api/installed-software/{mine.pk}/").json()
        self.assertEqual(row["observed_version"], "1.26.3")
        self.read(debian13(PKGS[2:]))
        mine.refresh_from_db()
        self.assertEqual((mine.version, mine.observed_version), ("1.24", ""))
        # A service-scan install is not the package inventory's to remove.
        self.assertTrue(InstalledSoftware.objects.filter(pk=scanned.pk).exists())

    def test_a_platform_that_fits_is_left_alone(self):
        eol_catalog()
        deb = Platform.objects.create(tenant=self.tenant, name="Debian 13", slug="debian-13")
        VirtualMachine.objects.filter(pk=self.vm.pk).update(platform=deb)
        self.read(debian13())
        self.login(self.su)
        self.assertEqual(
            self.client.get("/api/discovery/findings/?kind=platform").data["results"], [])


@mock.patch.object(software, "enqueue_sync", lambda tenant_id: None)
@override_settings(DISCOVERY_ENABLED=True)
class InventoryFindingsApiTests(ApiBase):
    def setUp(self):
        eol_catalog()
        self.a = self.host("a", "10.0.0.1", site=self.site, vm=True, cred=None, key=False)
        self.b = self.host("b", "10.0.0.2", site=self.branch, vm=True, cred=None, key=False)
        for h in (self.a, self.b):
            packages.store(self.tenant, h, None, debian13())
        self.theirs = self.host("t", "10.0.0.9", tenant=self.other, cred=None, key=False)
        packages.store(self.other, self.theirs, None, debian13())

    def findings(self, kind=None, **params):
        q = f"?kind={kind}" if kind else "?"
        for k, v in params.items():
            q += f"&{k}={v}"
        r = self.client.get(f"/api/discovery/findings/{q}")
        self.assertEqual(r.status_code, 200, r.data)
        return r.data

    def test_one_application_finding_per_software(self):
        self.login(self.su)
        data = self.findings("application")
        rows = {f["id"]: f for f in data["results"]}
        self.assertIn("application:nginx", rows)
        f = rows["application:nginx"]
        self.assertEqual(f["title"], "Application nginx found on 2 hosts")
        self.assertEqual(f["proposal"]["hosts"], 2)
        self.assertEqual({e["name"] for e in f["packages"]}, {"a", "b"})
        self.assertEqual(data["totals"]["application"], len(rows))
        r = self.client.post("/api/discovery/findings/accept/", {"ids": ["application:nginx"]},
                             format="json")
        self.assertEqual(r.data["refused"], [])
        app = Application.objects.get(tenant=self.tenant, name="nginx")
        self.assertEqual(app.package_names, list(known_software.BY_KEY["nginx"].packages))
        self.assertEqual((app.eol_source, app.eol_product), ("endoflife_date", "nginx"))
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=str(app.pk),
                                                      action="create").exists())
        # Installs follow; the 1.26 cycle comes from each version.
        software.sync_installs(self.tenant)
        installs = InstalledSoftware.objects.filter(application=app)
        self.assertEqual(installs.count(), 2)
        self.assertEqual({i.cycle for i in installs}, {"1.26"})
        self.assertNotIn("application:nginx", {f["id"] for f in self.findings()["results"]})
        # The other tenant's host is not theirs to see, nor installed here.
        self.assertFalse(InstalledSoftware.objects.filter(device=self.theirs).exists())

    def test_existing_application_gets_a_link_proposal(self):
        app = Application.objects.create(tenant=self.tenant, name="NGINX", slug="web")
        self.login(self.su)
        rows = {f["id"]: f for f in self.findings()["results"]}
        self.assertNotIn("application:nginx", rows)
        f = rows["link:nginx"]
        self.assertEqual(f["proposal"]["application"]["id"], str(app.pk))
        self.client.post("/api/discovery/findings/accept/", {"ids": ["link:nginx"]},
                         format="json")
        app.refresh_from_db()
        self.assertIn("deb:nginx", app.package_names)
        self.assertNotIn("link:nginx", {f["id"] for f in self.findings()["results"]})

    def test_ignore_is_remembered(self):
        self.login(self.su)
        r = self.client.post("/api/discovery/findings/ignore/",
                             {"ids": ["application:nginx"]}, format="json")
        self.assertEqual(r.data["done"], ["application:nginx"])
        self.assertTrue(InventoryFindingDecision.objects.filter(
            tenant=self.tenant, key="application:nginx").exists())
        self.assertNotIn("application:nginx",
                         {f["id"] for f in self.findings()["results"]})
        shown = {f["id"]: f for f in self.findings(ignored="true")["results"]}
        self.assertTrue(shown["application:nginx"]["ignored"])
        self.client.post("/api/discovery/findings/ignore/",
                         {"ids": ["application:nginx"], "ignore": False}, format="json")
        self.assertIn("application:nginx", {f["id"] for f in self.findings()["results"]})

    def test_platform_ignore_comes_back_when_the_evidence_changes(self):
        self.login(self.su)
        fid = f"platform:virtual_machine:{self.a.pk}"
        self.client.post("/api/discovery/findings/ignore/", {"ids": [fid]}, format="json")
        self.assertNotIn(fid, {f["id"] for f in self.findings("platform")["results"]})
        other = Platform.objects.create(tenant=self.tenant, name="Generic", slug="generic")
        VirtualMachine.objects.filter(pk=self.a.pk).update(platform=other)
        self.assertIn(fid, {f["id"] for f in self.findings("platform")["results"]})

    def test_bulk_accept_reuses_the_created_platform(self):
        self.login(self.su)
        ids = [f["id"] for f in self.findings("platform")["results"]]
        self.assertEqual(len(ids), 2)
        r = self.client.post("/api/discovery/findings/accept/", {"ids": ids}, format="json")
        self.assertEqual(len(r.data["created"]), 2)
        self.assertEqual(Platform.objects.filter(tenant=self.tenant, name="Debian 13").count(), 1)
        self.assertEqual(Platform.objects.filter(tenant=self.other).count(), 0)

    def test_rbac_and_site_scope(self):
        # Neither ipaddress nor installedsoftware view: no queue.
        self.member("nothing", {"virtualmachine": ["view"]})
        self.assertEqual(self.client.get("/api/discovery/findings/").status_code, 403)
        # Installed-software view alone reads the inventory's proposals,
        # limited to the hosts at its sites.
        self.member("hq", {"virtualmachine": ["view"], "installedsoftware": ["view"]},
                    sites=[self.site])
        data = self.findings()
        hosts = {f["host"]["name"] for f in data["results"] if f["kind"] == "platform"}
        self.assertEqual(hosts, {"a"})
        app = next(f for f in data["results"] if f["id"] == "application:nginx")
        self.assertEqual(app["proposal"]["hosts"], 1)
        # Viewing is not changing: accept and ignore are refused.
        fid = f"platform:virtual_machine:{self.a.pk}"
        r = self.client.post("/api/discovery/findings/accept/",
                             {"ids": [fid, "application:nginx"]}, format="json")
        self.assertEqual(r.data["created"], [])
        reasons = {x["id"]: x["reason"] for x in r.data["refused"]}
        self.assertIn("virtualmachine.change", reasons[fid])
        self.assertIn("application.add", reasons["application:nginx"])
        r = self.client.post("/api/discovery/findings/ignore/", {"ids": [fid]}, format="json")
        self.assertEqual(r.data["done"], [])
        # Change on the host, but no platform add: a new platform is refused.
        self.member("chg", {"virtualmachine": ["view", "change"],
                            "installedsoftware": ["view"]}, sites=[self.site])
        r = self.client.post("/api/discovery/findings/accept/", {"ids": [fid]}, format="json")
        self.assertIn("platform.add", r.data["refused"][0]["reason"])
        self.assertFalse(Platform.objects.filter(tenant=self.tenant, name="Debian 13").exists())
        # A host at another site is not found at all.
        other = f"platform:virtual_machine:{self.b.pk}"
        r = self.client.post("/api/discovery/findings/accept/", {"ids": [other]},
                             format="json")
        self.assertEqual(r.data["refused"][0]["reason"], "Not found.")

    def test_tenant_isolation(self):
        self.login(self.su, self.other)
        data = self.findings()
        hosts = {f["host"]["name"] for f in data["results"] if f["host"]}
        self.assertEqual(hosts, {"t"})
        f = next(f for f in data["results"] if f["id"] == "application:nginx")
        self.assertEqual(f["proposal"]["hosts"], 1)
        # Another tenant's host id is not found from here.
        fid = f"platform:virtual_machine:{self.a.pk}"
        r = self.client.post("/api/discovery/findings/accept/", {"ids": [fid]}, format="json")
        self.assertEqual(r.data["refused"][0]["reason"], "Not found.")


# ─── the Packages tab ────────────────────────────────────────────────────────


@mock.patch.object(software, "enqueue_sync", lambda tenant_id: None)
@override_settings(DISCOVERY_ENABLED=True)
class PackagesTabTests(ApiBase):
    def setUp(self):
        VulnerabilitySettings.objects.update_or_create(
            pk=1, defaults={"enabled": True, "update_source": "browser"})
        self.vm = self.host("vm", "10.0.0.5", site=self.site, vm=True, cred=None, key=False)
        packages.store(self.tenant, self.vm, None, debian13())
        self.nginx = Application.objects.create(tenant=self.tenant, name="nginx", slug="nginx",
                                                package_names=["deb:nginx", "deb:nginx-*"])
        pkg = HostPackage.objects.get(virtual_machine=self.vm, name="libssl3t64")
        for vid, sev in (("CVE-2025-0001", "high"), ("CVE-2025-0002", "critical")):
            cve = Cve.objects.create(vuln_id=vid, cvss_severity=sev)
            VulnerabilityMatch.objects.create(
                tenant=self.tenant, cve=cve, virtual_machine=self.vm, via="package",
                host_package=pkg, confidence="range", priority="high",
                first_seen_at=timezone.now(), last_seen_at=timezone.now())

    def url(self):
        return f"/api/virtual-machines/{self.vm.pk}/packages/"

    def test_application_and_cves_columns(self):
        self.login(self.su)
        rows = {p["name"]: p for p in self.client.get(self.url()).json()["results"]}
        self.assertEqual(rows["nginx"]["application"]["name"], "nginx")
        self.assertEqual(rows["nginx-common"]["application"]["name"], "nginx")
        self.assertIsNone(rows["bash"]["application"])
        self.assertEqual(rows["libssl3t64"]["cves"], {"count": 2, "severity": "critical"})
        self.assertEqual(rows["bash"]["cves"], {"count": 0, "severity": ""})

    def test_no_application_without_application_view(self):
        self.member("sw", {"virtualmachine": ["view"], "installedsoftware": ["view"]})
        rows = {p["name"]: p for p in self.client.get(self.url()).json()["results"]}
        self.assertIsNone(rows["nginx"]["application"])

    def test_query_count_does_not_grow_with_the_page(self):
        self.login(self.su)

        def n(size):
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get(f"{self.url()}?page_size={size}")
                                 .status_code, 200)
            return len(ctx.captured_queries)

        n(1)
        small = n(1)
        more = [inv.Package("deb", f"lib{i}", "1.0-1", "amd64", f"lib{i}", "1.0-1")
                for i in range(200)]
        packages.store(self.tenant, self.vm, None, debian13([*PKGS, *[
            (p.type, p.name, p.version, p.arch, p.source_name, p.source_version)
            for p in more]]))
        self.assertEqual(n(500), small)

    def test_advisory_state_per_mode(self):
        self.login(self.su)

        def state():
            return self.client.get(self.url()).json()["advisories"]

        s = state()
        self.assertEqual((s["mode"], s["state"], s["last_fetch"]),
                         ("browser", "not_fetched", None))
        self.assertTrue(s["can_sync"])
        now = timezone.now()
        SyncRun.objects.create(via="browser", status="ok", started_at=now, finished_at=now,
                               counts={"osv": {"advisories": 0}})
        self.assertEqual(state()["state"], "fetched")
        # A newer package is not covered by that fetch.
        HostPackage.objects.filter(virtual_machine=self.vm, name="bash").update(
            first_seen=now + timedelta(minutes=1))
        self.assertEqual(state()["state"], "not_fetched")
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="server")
        self.assertEqual(state()["state"], "queued")
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="upload")
        self.assertEqual(state()["mode"], "upload")
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        body = self.client.get(self.url()).json()
        self.assertIsNone(body["advisories"])
        self.assertIsNone(body["results"][0]["cves"])

    def test_tenant_isolation_and_rbac(self):
        self.member("dev", {"virtualmachine": ["view"]})
        self.assertEqual(self.client.get(self.url()).status_code, 403)
        self.login(self.su, self.other)
        self.assertEqual(self.client.get(self.url()).status_code, 404)


@override_settings(DISCOVERY_ENABLED=True)
class ServerFetchTests(Base):
    def test_new_package_keys_are_fetched_in_server_mode_only(self):
        a = self.host("a", "10.0.0.1", vm=True, cred=None, key=False)
        b = self.host("b", "10.0.0.2", vm=True, cred=None, key=False)
        earlier = timezone.now() - timedelta(hours=1)
        packages.store(self.tenant, a, None, debian13(PKGS[:1]), now=earlier)
        since = timezone.now()
        stored = packages.store(self.tenant, b, None, debian13())
        self.assertEqual(stored["new_keys"], {("deb", "debian/nginx"), ("deb", "debian/openssl"),
                                              ("deb", "debian/bash")})
        with mock.patch("vulnerabilities.fetch.enqueue_products", return_value=True) as q:
            VulnerabilitySettings.objects.update_or_create(
                pk=1, defaults={"enabled": True, "update_source": "browser"})
            self.assertFalse(packages.queue_fetch(stored["new_keys"], since))
            q.assert_not_called()
            VulnerabilitySettings.objects.filter(pk=1).update(update_source="server")
            self.assertTrue(packages.queue_fetch(stored["new_keys"], since))
            # nginx was already on host a before this read: not new.
            self.assertEqual(set(q.call_args[0][0]), {("purl", "", "deb", "debian/openssl"),
                                                      ("purl", "", "deb", "debian/bash")})


# ─── query counts at scale ───────────────────────────────────────────────────


@mock.patch.object(software, "enqueue_sync", lambda tenant_id: None)
@override_settings(DISCOVERY_ENABLED=True)
class ScaleTests(Base):
    def fleet(self, n, start=0):
        now = timezone.now()
        vms = [VirtualMachine.objects.create(tenant=self.tenant, name=f"h{i}",
                                             cluster=self.cluster)
               for i in range(start, start + n)]
        HostOsFact.objects.bulk_create([
            HostOsFact(tenant=self.tenant, virtual_machine=v, os_id="debian", version_id="13",
                       collected_at=now) for v in vms])
        rows = []
        for v in vms:
            rows += [HostPackage(tenant=self.tenant, virtual_machine=v, purl_type="deb",
                                 namespace="debian", name=f"pkg{j}", version="1.0-1",
                                 match_name=f"debian/pkg{j}", match_version="1.0-1",
                                 first_seen=now, last_seen=now) for j in range(298)]
            rows += [HostPackage(tenant=self.tenant, virtual_machine=v, purl_type="deb",
                                 namespace="debian", name=name, version="1.26.3-3",
                                 match_name="debian/nginx", match_version="1.26.3-3",
                                 first_seen=now, last_seen=now)
                     for name in ("nginx", "nginx-common")]
        HostPackage.objects.bulk_create(rows, batch_size=5000)
        return vms

    def test_40_hosts_by_300_packages(self):
        Application.objects.create(tenant=self.tenant, name="nginx", slug="nginx",
                                   package_names=["deb:nginx", "deb:nginx-*"])
        Application.objects.create(tenant=self.tenant, name="pg", slug="pg",
                                   package_names=["deb:postgresql-1*"])

        def run(vms):
            hosts = {"device": set(), "virtual_machine": {v.pk for v in vms}}
            facts = list(HostOsFact.objects.filter(virtual_machine__in=vms))
            with CaptureQueriesContext(connection) as ctx:
                software.sync_installs(self.tenant, hosts)
                os_platform.record_versions(self.tenant, facts)
            return len(ctx.captured_queries)

        run(self.fleet(2, start=50))  # settle the per-tenant counters
        small = run(self.fleet(4))
        big = run(self.fleet(40, start=100))
        self.assertEqual(InstalledSoftware.objects.filter(source="discovery").count(), 46)
        self.assertEqual(big, small)
        self.assertLess(big, 40)
        # Nothing new: a steady read is a handful of statements.
        vms = list(VirtualMachine.objects.filter(name__startswith="h1"))
        self.assertLess(run(vms), 15)


# ─── the dedupe rule ─────────────────────────────────────────────────────────


@mock.patch.object(software, "enqueue_sync", lambda tenant_id: None)
@override_settings(DISCOVERY_ENABLED=True)
class DedupeTests(Base):
    def setUp(self):
        from vulnerabilities.store import products_of
        from vulnerabilities.tests_matching import debian_openssl, load_osv

        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        self.d = Device.objects.create(tenant=self.tenant, name="d", site=self.site)
        now = timezone.now()
        self.pkg = HostPackage.objects.create(
            tenant=self.tenant, device=self.d, purl_type="deb", namespace="debian",
            name="libssl3", version="3.0.14-1~deb12u2", source_name="openssl",
            source_version="3.0.14-1~deb12u2", ecosystem="Debian:12",
            match_name="debian/openssl", match_version="3.0.14-1~deb12u2",
            first_seen=now, last_seen=now)
        load_osv(debian_openssl())
        cve = Cve.objects.get(vuln_id="CVE-2024-5535")
        cve.configurations = [{"nodes": [{"operator": "OR", "negate": False, "cpeMatch": [
            {"vulnerable": True, "criteria": "cpe:2.3:a:openssl:openssl:*:*:*:*:*:*:*:*",
             "versionEndExcluding": "3.0.15"}]}]}]
        cve.save()
        CveProduct.objects.filter(cve=cve).delete()
        CveProduct.objects.bulk_create([CveProduct(cve=cve, kind=k, part=p, vendor=v, product=pr)
                                        for k, p, v, pr in products_of(cve)])
        self.app = Application.objects.create(tenant=self.tenant, name="OpenSSL",
                                              slug="openssl")
        ProductMapping.objects.create(tenant=self.tenant, application=self.app, kind="cpe",
                                      part="a", vendor="openssl", product="openssl")
        self.inst = InstalledSoftware.objects.create(tenant=self.tenant, application=self.app,
                                                     device=self.d, version="3.0.14")

    def open(self):
        return {m.via for m in VulnerabilityMatch.objects.filter(
            tenant=self.tenant, device=self.d, resolved_at__isnull=True)}

    def test_package_match_wins_over_the_application_cpe_match(self):
        from vulnerabilities import matching

        matching.recompute(self.tenant)
        # Not linked: both report it.
        self.assertEqual(self.open(), {"package", "application"})
        Application.objects.filter(pk=self.app.pk).update(package_names=["deb:libssl3"])
        counts = matching.recompute(self.tenant)
        self.assertEqual(counts["covered"], 1)
        self.assertEqual(self.open(), {"package"})
        # Backported fix: the distribution says fixed, so nothing - the
        # upstream version no longer raises it through the application.
        HostPackage.objects.filter(pk=self.pkg.pk).update(match_version="3.0.15-1~deb12u1")
        matching.recompute(self.tenant)
        self.assertEqual(self.open(), set())
        # Another host whose package is not linked keeps its CPE match.
        other = Device.objects.create(tenant=self.tenant, name="e", site=self.site)
        InstalledSoftware.objects.create(tenant=self.tenant, application=self.app,
                                         device=other, version="3.0.14")
        matching.recompute(self.tenant)
        self.assertTrue(VulnerabilityMatch.objects.filter(
            device=other, via="application", resolved_at__isnull=True).exists())


class InventoryFindingsUnitTests(TestCase):
    def test_known_prefilter_covers_every_glob(self):
        exact, prefixes = inventory_findings._known_names()
        self.assertIn("nginx", exact)
        self.assertIn("postgresql-1", prefixes)
        self.assertNotIn("", prefixes)


# ─── the same follow-ups for an Outpost's read ───────────────────────────────


@mock.patch.object(software, "enqueue_sync", lambda tenant_id: None)
@mock.patch("monitoring.models.DeviceCredential.resolve_secret",
            lambda self: {"password": "pw"})
@override_settings(DISCOVERY_ENABLED=True)
class OutpostReadTests(ApiBase):
    def test_an_outpost_read_sets_the_version_and_syncs_installs(self):
        from rest_framework.test import APIClient

        from .tests_outposts import CAPS, OutpostBase

        eng = OutpostBase.outpost(self, caps=CAPS)
        vm = self.host("vm13", "10.0.0.5", site=self.site, vm=True)
        p = self.profile(runs_on="outpost", outpost=eng)
        p.virtual_machines.add(vm)
        app = Application.objects.create(tenant=self.tenant, name="nginx", slug="nginx",
                                         package_names=["deb:nginx"])
        run = OutpostBase.go(self, p)
        client = APIClient()
        auth = {"HTTP_AUTHORIZATION": f"Bearer {eng.token['secret']}"}
        jobs = client.get("/api/outpost/discovery-work/", **auth).json()["jobs"]
        item = jobs[0]["items"][0]
        with mock.patch("vulnerabilities.fetch.enqueue_products", return_value=True) as q:
            VulnerabilitySettings.objects.update_or_create(
                pk=1, defaults={"enabled": True, "update_source": "server"})
            r = client.post("/api/outpost/discovery-results/", {"results": [{
                "item_id": item["item_id"], "result": inv.result_as_dict(debian13()),
                "used": 0, "attempts": []}]}, format="json", **auth)
        self.assertEqual(r.json()["accepted"], 1)
        vm.refresh_from_db()
        self.assertEqual((vm.software_version, vm.software_version_source),
                         ("13", "discovery"))
        inst = InstalledSoftware.objects.get(application=app, virtual_machine=vm)
        self.assertEqual((inst.version, inst.source), ("1.26.3", "discovery"))
        run.refresh_from_db()
        self.assertEqual(run.counts["versions"], 1)
        self.assertEqual(run.counts["installs"], 1)
        self.assertTrue(run.counts["fetch_queued"])
        # The change log names the Outpost, as for its other writes.
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(vm.pk), changes__has_key="software_version", user=None)
            .exclude(user_name="").exists())
        q.assert_called_once()

    async def no_server(self, *a, **kw):  # OutpostBase.go's collectors
        raise AssertionError("contacted from the server")

    def no_scan(self, *a, **kw):
        raise AssertionError("scanned from the server")


@override_settings(DISCOVERY_ENABLED=True)
class BusyFetchTests(Base):
    def test_a_busy_store_loses_no_package_key(self):
        from vulnerabilities import fetch, products

        VulnerabilitySettings.objects.update_or_create(
            pk=1, defaults={"enabled": True, "update_source": "server"})
        vm = self.host("a", "10.0.0.1", vm=True, cred=None, key=False)
        packages.store(self.tenant, vm, None, debian13())
        key = ("purl", "", "deb", "debian/openssl")
        # Another update is running (or one was left "running" by a worker
        # restart): the at-once fetch gives up quietly ...
        with mock.patch.object(fetch, "start_run", side_effect=fetch.Busy("busy")), \
                mock.patch.object(fetch, "execute") as ex:
            fetch.run_products_job([list(key)])
        ex.assert_not_called()
        # ... and the key stays a tracked product, so the next run asks for it.
        self.assertIn(key, products.tracked().keys)
