"""Recompute against a tenant's inventory: diff, priority, isolation,
signals and jobs."""
from __future__ import annotations

import io
import json
import time
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.db import connection, transaction
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from api.models import (
    Application,
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    InstalledSoftware,
    Platform,
    Site,
    VirtualMachine,
)
from core.models import Organization, Tenant

from . import cvss, jobs, matching, products, signals, sources, store
from .models import (
    Cve,
    CveProduct,
    ProductMapping,
    VulnerabilityMatch,
    VulnerabilityPolicy,
    VulnerabilitySettings,
)
from .streaming import open_stream
from .testing import data


def load_nvd(name="nvd_page.json"):
    recs = list(sources.iter_nvd(open_stream(io.BytesIO(data(name)), max_bytes=10**8)))
    return store.store_records(recs, source="nvd_feed", tracked=products.tracked())


def load_osv(raw: bytes):
    recs = list(sources.iter_osv_json(open_stream(io.BytesIO(raw), max_bytes=10**8)))
    return store.store_records(recs, source="osv", tracked=products.tracked())


def make_cve(vuln_id, configurations=(), *, score=None, epss=None, kev=False, osv=None):
    row = Cve.objects.create(
        vuln_id=vuln_id, configurations=list(configurations), osv=osv or {},
        cvss_score=None if score is None else Decimal(str(score)),
        cvss_severity="" if score is None else cvss.severity(Decimal(str(score)), "3.1"),
        epss=None if epss is None else Decimal(str(epss)),
        kev_added=date(2024, 1, 1) if kev else None)
    CveProduct.objects.bulk_create([
        CveProduct(cve=row, kind=k, part=p, vendor=v, product=pr)
        for k, p, v, pr in store.products_of(row)])
    return row


def xe_range(end, start=None):
    m = {"vulnerable": True, "criteria": "cpe:2.3:o:cisco:ios_xe:*:*:*:*:*:*:*:*",
         "versionEndExcluding": end}
    if start:
        m["versionStartIncluding"] = start
    return [{"nodes": [{"operator": "OR", "negate": False, "cpeMatch": [m]}]}]


class Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        cls.site = Site.objects.create(tenant=cls.tenant, name="HQ")
        cls.site2 = Site.objects.create(tenant=cls.tenant, name="Branch")
        ct = ClusterType.objects.create(tenant=cls.tenant, name="CT", slug="ct")
        cls.cluster = Cluster.objects.create(tenant=cls.tenant, name="pve", type=ct)
        cls.xe = Platform.objects.create(tenant=cls.tenant, name="IOS-XE", slug="ios-xe")
        cls.mapping = ProductMapping.objects.create(
            tenant=cls.tenant, platform=cls.xe, kind="cpe", part="o", vendor="cisco",
            product="ios_xe")

    def device(self, name, version, tenant=None, platform=None, site=None, **kw):
        tenant = tenant or self.tenant
        return Device.objects.create(
            tenant=tenant, name=name, software_version=version,
            platform=platform if platform is not None else (self.xe if tenant == self.tenant
                                                            else None),
            site=site or (self.site if tenant == self.tenant else None), **kw)

    def open_matches(self, tenant=None):
        return VulnerabilityMatch.objects.filter(tenant=tenant or self.tenant,
                                                 resolved_at__isnull=True)


class RecomputeTests(Base):
    def test_cve_2023_20198_end_to_end(self):
        a = self.device("a", "17.9.4")
        self.device("b", "17.9.4a")
        c = self.device("c", "17.06.05")
        load_nvd()
        counts = matching.recompute(self.tenant)
        self.assertEqual(counts["created"], 2)
        rows = {m.device_id: m for m in self.open_matches()}
        self.assertEqual(set(rows), {a.pk, c.pk})
        m = rows[a.pk]
        self.assertEqual(m.cve.vuln_id, "CVE-2023-20198")
        self.assertEqual((m.via, m.confidence, m.priority, m.version),
                         ("platform", "exact", "fix_first", "17.9.4"))
        self.assertEqual(m.mapping_id, self.mapping.pk)
        self.mapping.refresh_from_db()
        self.assertEqual(self.mapping.coverage["candidates"], 1)
        self.assertIsNotNone(self.mapping.matched_at)

    def test_diff_new_touched_resolved_priority(self):
        cve = make_cve("CVE-2024-0001", xe_range("17.9.5"), score=7.5)
        d1 = self.device("d1", "17.9.4")
        d2 = self.device("d2", "17.12.1")
        self.assertEqual(matching.recompute(self.tenant)["created"], 1)
        first = self.open_matches().get()
        self.assertEqual((first.device_id, first.priority), (d1.pk, "medium"))

        # Unchanged: touched, nothing new.
        counts = matching.recompute(self.tenant)
        self.assertEqual((counts["created"], counts["touched"], counts["resolved"]), (0, 1, 0))

        # EPSS moves the priority; the row is updated, not replaced.
        Cve.objects.filter(pk=cve.pk).update(epss=Decimal("0.2"))
        counts = matching.recompute(self.tenant)
        self.assertEqual(counts["updated"], 1)
        self.assertEqual(self.open_matches().get().priority, "high")
        self.assertEqual(self.open_matches().get().pk, first.pk)

        # d1 is upgraded, d2 downgraded.
        Device.objects.filter(pk=d1.pk).update(software_version="17.9.5")
        Device.objects.filter(pk=d2.pk).update(software_version="17.6.1")
        counts = matching.recompute(self.tenant)
        self.assertEqual((counts["created"], counts["resolved"]), (1, 1))
        first.refresh_from_db()
        self.assertIsNotNone(first.resolved_at)
        self.assertEqual(self.open_matches().get().device_id, d2.pk)
        # History kept (decision 14).
        self.assertEqual(VulnerabilityMatch.objects.count(), 2)

        # Back on the vulnerable version: a new open row next to the old.
        Device.objects.filter(pk=d1.pk).update(software_version="17.9.4")
        matching.recompute(self.tenant)
        self.assertEqual(self.open_matches().count(), 2)

    def test_disabled_mapping_resolves(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        self.device("d1", "17.9.4")
        matching.recompute(self.tenant)
        ProductMapping.objects.filter(pk=self.mapping.pk).update(enabled=False)
        self.assertEqual(matching.recompute(self.tenant)["resolved"], 1)

    def test_blank_and_unreadable_versions_never_match(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        self.device("d1", "")
        self.device("d2", "weird build")
        matching.recompute(self.tenant)
        self.assertFalse(self.open_matches().exists())
        self.mapping.refresh_from_db()
        self.assertEqual(self.mapping.coverage["version_not_understood"], 1)

    def test_rejected_and_awaiting_analysis_never_match(self):
        row = make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        Cve.objects.filter(pk=row.pk).update(rejected=True)
        make_cve("CVE-2024-0002", [], score=9.8)
        self.device("d1", "17.9.4")
        matching.recompute(self.tenant)
        self.assertFalse(self.open_matches().exists())

    def test_device_type_platform_and_hardware(self):
        cat = DeviceType.objects.create(tenant=self.tenant, name="C9300", platform=self.xe)
        isr = DeviceType.objects.create(tenant=self.tenant, name="ISR", platform=self.xe)
        ProductMapping.objects.create(tenant=self.tenant, device_type=cat, kind="cpe",
                                      part="h", vendor="cisco", product="catalyst_9300")
        ProductMapping.objects.create(tenant=self.tenant, device_type=isr, kind="cpe",
                                      part="h", vendor="cisco", product="isr4451")
        bare = DeviceType.objects.create(tenant=self.tenant, name="Bare", platform=self.xe)
        configs = [{"operator": "AND", "nodes": [
            xe_range("17.9.5")[0]["nodes"][0],
            {"operator": "OR", "negate": False, "cpeMatch": [
                {"vulnerable": False,
                 "criteria": "cpe:2.3:h:cisco:catalyst_9300:-:*:*:*:*:*:*:*"}]}]}]
        make_cve("CVE-2024-0003", configs, score=8)
        on_cat = Device.objects.create(tenant=self.tenant, name="c", device_type=cat,
                                       software_version="17.9.4", site=self.site)
        Device.objects.create(tenant=self.tenant, name="i", device_type=isr,
                              software_version="17.9.4", site=self.site)
        on_bare = Device.objects.create(tenant=self.tenant, name="b", device_type=bare,
                                        software_version="17.9.4", site=self.site)
        matching.recompute(self.tenant)
        got = {m.device_id: m.confidence for m in self.open_matches()}
        self.assertEqual(got, {on_cat.pk: "range", on_bare.pk: "partial"})

    def test_application_installs_cpe_and_purl(self):
        load_nvd()
        pg = Application.objects.create(tenant=self.tenant, name="PostgreSQL",
                                        slug="postgresql")
        ProductMapping.objects.create(tenant=self.tenant, application=pg, kind="cpe",
                                      part="a", vendor="postgresql", product="postgresql")
        dj = Application.objects.create(tenant=self.tenant, name="Django", slug="django")
        ProductMapping.objects.create(tenant=self.tenant, application=dj, kind="purl",
                                      vendor="pypi", product="django")
        load_nvd()
        load_osv(data("osv_django.json"))
        vm = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster, name="db1", site=self.site)
        old = InstalledSoftware.objects.create(tenant=self.tenant, application=pg,
                                               virtual_machine=vm, version="16.4")
        InstalledSoftware.objects.create(tenant=self.tenant, application=pg,
                                         virtual_machine=vm, version="16.5")
        web = InstalledSoftware.objects.create(tenant=self.tenant, application=dj,
                                               virtual_machine=vm, version="4.2.15")
        matching.recompute(self.tenant)
        got = {(m.cve.vuln_id, m.installed_software_id, m.via, m.confidence)
               for m in self.open_matches()}
        self.assertEqual(got, {
            ("CVE-2024-10979", old.pk, "application", "range"),
            ("CVE-2024-45230", web.pk, "application", "range"),
        })
        # The awaiting-analysis CVE is stored but never matches.
        self.assertFalse(Cve.objects.filter(vuln_id="CVE-2025-1094").exists())

    def test_tenant_isolation(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        other_xe = Platform.objects.create(tenant=self.other, name="IOS-XE", slug="ios-xe")
        self.device("theirs", "17.9.4", tenant=self.other, platform=other_xe)
        # A mapping row pointing at another tenant's platform never reaches it.
        ProductMapping.objects.create(tenant=self.tenant, platform=other_xe, kind="cpe",
                                      part="o", vendor="cisco", product="ios_xe")
        mine = self.device("mine", "17.9.4")
        matching.recompute(self.tenant)
        self.assertEqual([m.device_id for m in self.open_matches()], [mine.pk])
        matching.recompute(self.other)
        self.assertFalse(self.open_matches(self.other).exists())

    def test_objects_scope_only_touches_those_hosts(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        d1 = self.device("d1", "17.9.4")
        d2 = self.device("d2", "17.9.4")
        matching.recompute(self.tenant)
        Device.objects.filter(pk__in=[d1.pk, d2.pk]).update(software_version="17.9.5")
        counts = matching.recompute(self.tenant, objects={"device": [str(d1.pk)]})
        self.assertEqual(counts["resolved"], 1)
        self.assertEqual(self.open_matches().get().device_id, d2.pk)

    def test_policy_thresholds(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=9.1, epss=0.6)
        make_cve("CVE-2024-0002", xe_range("17.9.5"), score=7.2, epss=0.2)
        make_cve("CVE-2024-0003", xe_range("17.9.5"), score=3.0, kev=True)
        self.device("d1", "17.9.4")
        matching.recompute(self.tenant)
        prios = dict(self.open_matches().values_list("cve__vuln_id", "priority"))
        self.assertEqual(prios, {"CVE-2024-0001": "fix_first", "CVE-2024-0002": "high",
                                 "CVE-2024-0003": "fix_first"})
        VulnerabilityPolicy.objects.create(tenant=self.tenant, kev_is_fix_first=False,
                                           fix_first_epss=Decimal("0.7"),
                                           high_epss=Decimal("0.3"))
        self.assertEqual(matching.reprioritise(self.tenant), 3)
        prios = dict(self.open_matches().values_list("cve__vuln_id", "priority"))
        self.assertEqual(prios, {"CVE-2024-0001": "high", "CVE-2024-0002": "medium",
                                 "CVE-2024-0003": "low"})

    def test_query_count_is_flat_and_locked(self):
        for i in range(5):
            make_cve(f"CVE-2024-{1000 + i}", xe_range("17.9.5"), score=5)
        for i in range(3):
            self.device(f"s{i}", "17.9.4")
        matching.recompute(self.tenant)
        with CaptureQueriesContext(connection) as small:
            matching.recompute(self.tenant)
        for i in range(30):
            self.device(f"l{i}", "17.9.4" if i % 2 else "17.6.1")
        matching.recompute(self.tenant)
        with CaptureQueriesContext(connection) as large:
            matching.recompute(self.tenant)
        self.assertEqual(len(small), len(large))
        self.assertTrue(any("pg_advisory_xact_lock" in q["sql"] for q in large.captured_queries))

    def test_volume(self):
        """A few thousand hosts against a few hundred records stays quick:
        keys are parsed once per distinct version and evaluations cached."""
        # Five records reach every host; the rest end before any of them.
        cves = [Cve(vuln_id=f"CVE-2023-{10000 + i}",
                    configurations=xe_range("17.99.1" if i < 5 else f"16.{i % 15}.1"),
                    cvss_score=Decimal("6.0")) for i in range(400)]
        Cve.objects.bulk_create(cves)
        CveProduct.objects.bulk_create([CveProduct(cve=c, kind="cpe", part="o", vendor="cisco",
                                                   product="ios_xe") for c in cves])
        Device.objects.bulk_create([
            Device(tenant=self.tenant, name=f"v{i}", platform=self.xe, site=self.site,
                   software_version=f"17.{i % 12}.{i % 5}") for i in range(2000)])
        started = time.monotonic()
        counts = matching.recompute(self.tenant)
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(counts["created"], 10_000)
        self.assertEqual(counts["hosts"], 2000)


class OwnSbomTests(Base):
    """The verification item: Danbyte's own SBOM as a tenant's installs.
    The pypi components of a CycloneDX document become applications with a
    package URL template and installs at their versions; OSV advisories for
    those packages match exactly the components inside their ranges."""

    SBOM = {"bomFormat": "CycloneDX", "specVersion": "1.6", "components": [
        {"type": "library", "name": "Django", "version": "5.2.7",
         "purl": "pkg:pypi/django@5.2.7"},
        {"type": "library", "name": "requests", "version": "2.32.3",
         "purl": "pkg:pypi/requests@2.32.3"},
        {"type": "library", "name": "PyJWT", "version": "2.10.1",
         "purl": "pkg:pypi/pyjwt@2.10.1"},
        {"type": "library", "name": "react", "version": "19.1.0",
         "purl": "pkg:npm/react@19.1.0"},
    ]}

    def advisory(self, osv_id, alias, eco, name, introduced, fixed):
        return {"id": osv_id, "modified": "2025-06-01T00:00:00Z", "aliases": [alias],
                "summary": f"{name} advisory",
                "affected": [{"package": {"ecosystem": eco, "name": name},
                              "ranges": [{"type": "ECOSYSTEM", "events": [
                                  {"introduced": introduced}, {"fixed": fixed}]}]}]}

    def test_own_sbom_installs_match_their_advisories(self):
        host = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster, name="danbyte", site=self.site)
        for comp in self.SBOM["components"]:
            base = comp["purl"].split("@", 1)[0]
            app = Application.objects.create(
                tenant=self.tenant, name=comp["name"], slug=comp["name"].lower(),
                purl_template=f"{base}@{{version}}")
            InstalledSoftware.objects.create(tenant=self.tenant, application=app,
                                             virtual_machine=host, version=comp["version"])
            kind, part, vendor, product = ("purl", "", *base[4:].split("/", 1))
            ProductMapping.objects.create(tenant=self.tenant, application=app, kind=kind,
                                          part=part, vendor=vendor, product=product)
        feed = [
            self.advisory("GHSA-aaaa-0001", "CVE-2025-0001", "PyPI", "Django", "5.2", "5.2.8"),
            self.advisory("GHSA-aaaa-0002", "CVE-2025-0002", "PyPI", "requests", "0",
                          "2.32.4"),
            self.advisory("GHSA-aaaa-0003", "CVE-2025-0003", "PyPI", "PyJWT", "0", "2.10.0"),
            self.advisory("GHSA-aaaa-0004", "CVE-2025-0004", "npm", "react", "19.0.0",
                          "19.1.1"),
            self.advisory("GHSA-aaaa-0005", "CVE-2025-0005", "PyPI", "flask", "0", "9.9"),
        ]
        counts = load_osv(json.dumps(feed).encode())
        self.assertEqual(counts["not_tracked"], 1)
        matching.recompute(self.tenant)
        got = {(m.cve.vuln_id, m.installed_software.application.name)
               for m in self.open_matches()}
        self.assertEqual(got, {("CVE-2025-0001", "Django"), ("CVE-2025-0002", "requests"),
                               ("CVE-2025-0004", "react")})
        # After the bump nothing is open.
        for name, version in (("Django", "5.2.8"), ("requests", "2.32.4"),
                              ("react", "19.1.1")):
            InstalledSoftware.objects.filter(application__name=name).update(version=version)
        matching.recompute(self.tenant)
        self.assertFalse(self.open_matches().exists())


@mock.patch.object(jobs, "_claim", return_value=True)
@mock.patch.object(jobs, "_push")
class SignalTests(Base):
    def commit(self, fn):
        # The test case is one transaction: drop the flush the setup's own
        # saves registered, so the block below gets (and runs) its own.
        connection.run_on_commit = [e for e in connection.run_on_commit
                                    if e[1] is not signals._flush]
        with self.captureOnCommitCallbacks(execute=True):
            fn()

    def pushed(self, push, func):
        return [c.args[1:] for c in push.call_args_list if c.args[0] is func]

    def test_bulk_version_edit_queues_once(self, push, _claim):
        devices = [self.device(f"d{i}", "17.9.4") for i in range(5)]
        push.reset_mock()

        def edit():
            with transaction.atomic():
                for d in Device.objects.filter(pk__in=[d.pk for d in devices]):
                    d.software_version = "17.9.5"
                    d.save()
        self.commit(edit)
        calls = self.pushed(push, jobs.run_objects)
        self.assertEqual(len(calls), 1)
        tenant_id, objects = calls[0]
        self.assertEqual(tenant_id, str(self.tenant.pk))
        self.assertEqual(sorted(objects["device"]), sorted(str(d.pk) for d in devices))

    def test_unrelated_save_queues_nothing(self, push, _claim):
        d = self.device("d1", "17.9.4")
        push.reset_mock()
        d = Device.objects.get(pk=d.pk)
        d.description = "x"
        self.commit(d.save)
        d.name = "renamed"
        self.commit(lambda: d.save(update_fields=["name"]))
        self.assertEqual(push.call_count, 0)

    def test_platform_change_with_update_fields(self, push, _claim):
        d = self.device("d1", "17.9.4")
        push.reset_mock()
        d.platform = Platform.objects.create(tenant=self.tenant, name="IOS", slug="ios")
        self.commit(lambda: d.save(update_fields=["platform"]))
        self.assertEqual(len(self.pushed(push, jobs.run_objects)), 1)

    def test_nothing_without_mapping_or_when_off(self, push, _claim):
        p = Platform.objects.create(tenant=self.other, name="X", slug="x")
        self.commit(lambda: Device.objects.create(tenant=self.other, name="o", platform=p,
                                                  software_version="1"))
        self.assertEqual(push.call_count, 0)
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        self.commit(lambda: self.device("d1", "17.9.4"))
        self.assertEqual(push.call_count, 0)

    def test_install_and_mapping_changes(self, push, _claim):
        app = Application.objects.create(tenant=self.tenant, name="App", slug="app")
        vm = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster, name="vm")
        push.reset_mock()
        inst = InstalledSoftware(tenant=self.tenant, application=app, virtual_machine=vm,
                                 version="1.0")
        self.commit(inst.save)
        calls = self.pushed(push, jobs.run_objects)
        self.assertEqual(calls[-1][1], {"virtual_machine": [str(vm.pk)]})
        push.reset_mock()
        self.commit(lambda: ProductMapping.objects.create(
            tenant=self.tenant, application=app, kind="purl", vendor="pypi", product="app"))
        self.assertEqual(self.pushed(push, jobs.run_recompute), [(str(self.tenant.pk),)])
        push.reset_mock()
        inst.version = "1.1"
        self.commit(inst.save)
        self.assertEqual(len(self.pushed(push, jobs.run_objects)), 1)
        push.reset_mock()
        self.commit(inst.delete)
        self.assertEqual(len(self.pushed(push, jobs.run_objects)), 1)

    @mock.patch("vulnerabilities.fetch.enqueue_products")
    def test_new_mapping_fetches_its_product_in_server_mode(self, enqueue, push, _claim):
        from django.core.cache import cache
        from django.test import override_settings

        override = override_settings(CACHES={"default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
        override.enable()
        self.addCleanup(override.disable)
        cache.clear()
        app = Application.objects.create(tenant=self.tenant, name="App", slug="app")
        dt = DeviceType.objects.create(tenant=self.tenant, name="C9300")
        # Upload mode: nothing is asked for.
        self.commit(lambda: ProductMapping.objects.create(
            tenant=self.tenant, application=app, kind="purl", vendor="pypi", product="a0"))
        self.assertEqual(enqueue.call_count, 0)
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="server")
        m = ProductMapping(tenant=self.tenant, application=app, kind="purl", vendor="pypi",
                           product="app")
        self.commit(m.save)
        enqueue.assert_called_once_with([("purl", "", "pypi", "app")])
        # Re-saving it, or mapping the same product again soon: debounced.
        m.version_scheme = "pep440"
        self.commit(m.save)
        other = Application.objects.create(tenant=self.other, name="App", slug="app")
        self.commit(lambda: ProductMapping.objects.create(
            tenant=self.other, application=other, kind="purl", vendor="pypi", product="app"))
        self.assertEqual(enqueue.call_count, 1)
        # Hardware context and disabled mappings are never fetched.
        self.commit(lambda: ProductMapping.objects.create(
            tenant=self.tenant, device_type=dt, kind="cpe", part="h", vendor="cisco",
            product="catalyst_9300"))
        off = ProductMapping(tenant=self.tenant, application=app, kind="purl",
                             vendor="pypi", product="b", enabled=False)
        self.commit(off.save)
        self.assertEqual(enqueue.call_count, 1)
        # Enabling one later asks for it.
        off.enabled = True
        self.commit(off.save)
        enqueue.assert_called_with([("purl", "", "pypi", "b")])

    def test_policy_save_reprioritises(self, push, _claim):
        self.commit(lambda: VulnerabilityPolicy.for_tenant(self.tenant))
        self.assertEqual(self.pushed(push, jobs.run_reprioritise), [(str(self.tenant.pk),)])

    def test_store_queues_tenants_it_reaches(self, push, _claim):
        load_nvd()
        self.assertEqual(self.pushed(push, jobs.run_recompute), [(str(self.tenant.pk),)])
        push.reset_mock()
        load_nvd()  # replay: nothing changed, nothing queued
        self.assertEqual(push.call_count, 0)

    def test_debounce(self, push, claim):
        claim.return_value = False
        jobs.enqueue_recompute(self.tenant.pk)
        self.assertEqual(push.call_count, 0)


class JobTests(Base):
    def test_job_rechecks_scope(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        self.device("d1", "17.9.4")
        with mock.patch.object(jobs, "_release"):
            self.assertEqual(jobs.run_recompute(str(self.tenant.pk))["created"], 1)
            Tenant.objects.filter(pk=self.other.pk).update(is_active=False)
            self.assertIsNone(jobs.run_recompute(str(self.other.pk)))
            VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
            self.assertIsNone(jobs.run_recompute(str(self.tenant.pk)))

    def test_objects_job_ignores_foreign_ids(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        other_xe = Platform.objects.create(tenant=self.other, name="X", slug="x")
        theirs = self.device("t", "17.9.4", tenant=self.other, platform=other_xe)
        counts = jobs.run_objects(str(self.tenant.pk), {"device": [str(theirs.pk)]})
        self.assertEqual(counts["created"], 0)
        self.assertFalse(VulnerabilityMatch.objects.exists())

    def test_tracked_keys_skip_hardware_and_disabled(self):
        dt = DeviceType.objects.create(tenant=self.tenant, name="C9300")
        ProductMapping.objects.create(tenant=self.tenant, device_type=dt, kind="cpe",
                                      part="h", vendor="cisco", product="catalyst_9300")
        app = Application.objects.create(tenant=self.tenant, name="App", slug="app")
        ProductMapping.objects.create(tenant=self.tenant, application=app, kind="purl",
                                      vendor="pypi", product="app", enabled=False)
        self.assertEqual(jobs.tracked_keys(), {("cpe", "o", "cisco", "ios_xe")})

    def test_resolved_rows_after_a_while_keep_their_dates(self):
        make_cve("CVE-2024-0001", xe_range("17.9.5"), score=5)
        d = self.device("d1", "17.9.4")
        matching.recompute(self.tenant)
        past = timezone.now() - timedelta(days=3)
        VulnerabilityMatch.objects.update(first_seen_at=past)
        Device.objects.filter(pk=d.pk).update(software_version="17.9.5")
        matching.recompute(self.tenant)
        row = VulnerabilityMatch.objects.get()
        self.assertEqual(row.first_seen_at, past)
        self.assertGreater(row.resolved_at, past)


def debian_openssl() -> bytes:
    """One Debian advisory with a fix per release, as OSV writes it."""
    def entry(release, fixed):
        return {"package": {"ecosystem": f"Debian:{release}", "name": "openssl",
                            "purl": "pkg:deb/debian/openssl?arch=source"},
                "ranges": [{"type": "ECOSYSTEM",
                            "events": [{"introduced": "0"}, {"fixed": fixed}]}]}

    return json.dumps({
        "id": "DEBIAN-CVE-2024-5535", "modified": "2024-10-01T00:00:00Z",
        "aliases": ["CVE-2024-5535"],
        "affected": [entry("11", "1.1.1w-0+deb11u2"), entry("12", "3.0.15-1~deb12u1"),
                     entry("13", "3.3.2-1")]}).encode()


class DistroReleaseMatchingTests(Base):
    """A Debian package is tested against its host's release only (B0)."""

    DEB = ("purl", "", "deb", "debian/openssl")

    def setUp(self):
        self.app = Application.objects.create(tenant=self.tenant, name="OpenSSL",
                                              slug="openssl")
        self.mapping = ProductMapping.objects.create(
            tenant=self.tenant, application=self.app, kind="purl", vendor="deb",
            product="debian/openssl")
        self.d12 = Platform.objects.create(tenant=self.tenant, name="Debian 12", slug="d12")
        self.deb = Platform.objects.create(tenant=self.tenant, name="Debian", slug="deb")
        load_osv(debian_openssl())

    def vm(self, name, version, platform=None, purl="", os_version=""):
        vm = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster, name=name,
                                           site=self.site, platform=platform,
                                           software_version=os_version)
        return InstalledSoftware.objects.create(tenant=self.tenant, application=self.app,
                                                virtual_machine=vm, version=version, purl=purl)

    def matched(self):
        return {m.installed_software_id: m.confidence for m in self.open_matches()
                if m.installed_software_id}

    def test_release_from_platform_and_purl(self):
        fixed12 = self.vm("fixed12", "3.0.15-1~deb12u1", self.d12)
        old11 = self.vm("old11", "1.1.1w-0+deb11u1", self.deb, os_version="11.9")
        fixed11 = self.vm("fixed11", "1.1.1w-0+deb11u2", self.deb, os_version="11.11")
        by_purl = self.vm("by_purl", "3.0.14-1~deb12u2",
                          purl="pkg:deb/debian/openssl@{version}?distro=bookworm")
        matching.recompute(self.tenant)
        self.assertEqual(self.matched(), {old11.pk: "range", by_purl.pk: "range"})
        self.assertNotIn(fixed12.pk, self.matched())
        self.assertNotIn(fixed11.pk, self.matched())
        self.mapping.refresh_from_db()
        self.assertEqual(self.mapping.coverage["release_unknown"], 0)

    def test_unknown_release_is_flagged(self):
        unsure = self.vm("unsure", "3.0.15-1~deb12u1")
        old = self.vm("old", "1.0.2u-1")
        matching.recompute(self.tenant)
        # Every release agrees 1.0.2u is affected; 3.0.15 depends on the release.
        self.assertEqual(self.matched(), {old.pk: "partial"})
        self.assertNotIn(unsure.pk, self.matched())
        self.mapping.refresh_from_db()
        self.assertEqual(self.mapping.coverage["release_unknown"], 1)

    def test_source_package_from_upstream(self):
        lib = Application.objects.create(tenant=self.tenant, name="libssl3", slug="libssl3")
        libmap = ProductMapping.objects.create(tenant=self.tenant, application=lib,
                                               kind="purl", vendor="deb",
                                               product="debian/libssl3")
        vm = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster,
                                           name="h", site=self.site)
        named = InstalledSoftware.objects.create(
            tenant=self.tenant, application=lib, virtual_machine=vm, version="3.0.14-1~deb12u2",
            purl="pkg:deb/debian/libssl3@3.0.14-1~deb12u2?upstream=openssl&distro=debian-12")
        vm2 = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster,
                                            name="h2", site=self.site)
        # No source recorded: the binary name finds no Debian advisory.
        InstalledSoftware.objects.create(
            tenant=self.tenant, application=lib, virtual_machine=vm2,
            version="3.0.14-1~deb12u2", purl="pkg:deb/debian/libssl3@{version}?distro=debian-12")
        matching.recompute(self.tenant)
        rows = list(self.open_matches().filter(mapping=libmap))
        self.assertEqual([(m.installed_software_id, m.confidence) for m in rows],
                         [(named.pk, "range")])
        self.assertEqual(rows[0].cve.vuln_id, "CVE-2024-5535")

    def test_releases_for_the_fetch(self):
        self.vm("a", "3.0.15-1~deb12u1", self.d12)
        self.vm("b", "1.1.1w-0+deb11u1", self.deb, os_version="11.9")
        self.assertEqual(matching.package_releases(),
                         {self.DEB: {("debian", "12"), ("debian", "11")}})
        self.vm("c", "3.0.15-1~deb12u1")
        self.assertEqual(matching.package_releases()[self.DEB],
                         {("debian", "12"), ("debian", "11"), None})

    def test_source_packages_are_tracked(self):
        self.mapping.delete()
        lib = Application.objects.create(tenant=self.tenant, name="libssl3", slug="libssl3")
        ProductMapping.objects.create(tenant=self.tenant, application=lib, kind="purl",
                                      vendor="deb", product="debian/libssl3")
        vm = VirtualMachine.objects.create(tenant=self.tenant, cluster=self.cluster,
                                           name="h", site=self.site)
        InstalledSoftware.objects.create(
            tenant=self.tenant, application=lib, virtual_machine=vm, version="3.0.14-1",
            purl="pkg:deb/debian/libssl3@{version}?upstream=openssl")
        keys = jobs.tracked_keys()
        self.assertIn(self.DEB, keys)
        self.assertIn(("purl", "", "deb", "debian/libssl3"), keys)

    def test_a_purl_change_queues_its_host(self):
        inst = self.vm("p", "3.0.15-1~deb12u1")
        with mock.patch.object(signals, "_add_hosts") as add:
            inst.purl = "pkg:deb/debian/openssl@{version}?distro=bookworm"
            inst.save()
        add.assert_called()
