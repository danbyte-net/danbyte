"""Matching through inventoried packages (#451 B2, ``via="package"``):
release-aware, source-package keyed, gated on Discovery, bulk-only, and
visible with installed-software view."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Site, VirtualMachine
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from discovery.models import HostPackage
from integrations.models import IntegrationSettings

from . import fetch, jobs, matching, products
from .models import Cve, VulnerabilityException, VulnerabilityMatch, VulnerabilitySettings
from .tests_matching import debian_openssl, load_osv


def pkg(tenant, host, name, version, *, source="", ecosystem="Debian:12", ns="debian",
        ptype="deb", removed=False):
    now = timezone.now()
    field = "virtual_machine" if isinstance(host, VirtualMachine) else "device"
    src = source or name
    return HostPackage.objects.create(
        tenant=tenant, purl_type=ptype, namespace=ns, name=name, version=version,
        source_name=src, source_version=version, ecosystem=ecosystem,
        match_name=f"{ns}/{src}", match_version=version, first_seen=now, last_seen=now,
        removed_at=now if removed else None, **{field: host})


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
        cls.site2 = Site.objects.create(tenant=cls.tenant, name="Branch")

    def setUp(self):
        self.d12 = Device.objects.create(tenant=self.tenant, name="d12", site=self.site)
        self.d11 = Device.objects.create(tenant=self.tenant, name="d11", site=self.site2)
        # libssl3 is advised under its source package, openssl.
        pkg(self.tenant, self.d12, "libssl3", "3.0.14-1~deb12u2", source="openssl")
        pkg(self.tenant, self.d11, "libssl1.1", "1.1.1w-0+deb11u1", source="openssl",
            ecosystem="Debian:11")
        load_osv(debian_openssl())

    def open(self, tenant=None):
        return VulnerabilityMatch.objects.filter(tenant=tenant or self.tenant,
                                                 resolved_at__isnull=True)


class PackageMatchTests(Base):
    def test_the_inventory_is_tracked_and_the_record_stored(self):
        self.assertTrue(Cve.objects.filter(vuln_id="CVE-2024-5535").exists())
        key = ("purl", "", "deb", "debian/openssl")
        self.assertIn(key, products.tracked().keys)
        self.assertEqual(fetch.package_releases()[key], {("debian", "12"), ("debian", "11")})
        queries, _ = fetch.osv_queries([key], fetch.package_releases())
        self.assertEqual(queries, [
            {"package": {"ecosystem": "Debian:11", "name": "openssl"}},
            {"package": {"ecosystem": "Debian:12", "name": "openssl"}}])

    def test_release_aware_matches_via_package(self):
        counts = matching.recompute(self.tenant)
        self.assertEqual(counts["created"], 2)
        rows = {m.device_id: m for m in self.open()}
        self.assertEqual(set(rows), {self.d12.pk, self.d11.pk})
        for m in rows.values():
            self.assertEqual(m.via, "package")
            self.assertIsNone(m.mapping_id)
            self.assertIsNotNone(m.host_package_id)
            self.assertEqual(m.confidence, "range")
        # Fixed on 12 at deb12u1? No: 3.0.14-1~deb12u2 < 3.0.15-1~deb12u1.
        # Upgrade the Debian 12 host past the fix: its match resolves.
        HostPackage.objects.filter(device=self.d12).update(match_version="3.0.15-1~deb12u1")
        counts = matching.recompute(self.tenant, objects={"device": [self.d12.pk]})
        self.assertEqual(counts["resolved"], 1)
        self.assertEqual([m.device_id for m in self.open()], [self.d11.pk])

    def test_the_other_release_is_not_tested(self):
        # A Debian 12 host at 1.1.1w-0+deb11u2 would be "fixed" by the 11 entry;
        # tested against 12's fix it is still affected.
        HostPackage.objects.filter(device=self.d12).update(match_version="1.1.1w-0+deb11u2")
        matching.recompute(self.tenant)
        self.assertIn(self.d12.pk, {m.device_id for m in self.open()})
        HostPackage.objects.filter(device=self.d11).update(match_version="1.1.1w-0+deb11u2")
        matching.recompute(self.tenant)
        self.assertNotIn(self.d11.pk, {m.device_id for m in self.open()})

    def test_removed_packages_and_discovery_off(self):
        matching.recompute(self.tenant)
        HostPackage.objects.filter(device=self.d11).update(removed_at=timezone.now())
        matching.recompute(self.tenant)
        self.assertEqual({m.device_id for m in self.open()}, {self.d12.pk})
        IntegrationSettings.objects.filter(tenant=self.tenant).update(discovery_enabled=False)
        matching.recompute(self.tenant)
        self.assertFalse(self.open().exists())

    def test_tenant_isolation(self):
        theirs = Device.objects.create(tenant=self.other, name="t")
        pkg(self.other, theirs, "libssl3", "3.0.14-1~deb12u2", source="openssl")
        matching.recompute(self.tenant)
        self.assertFalse(self.open(self.other).exists())
        self.assertEqual(jobs.tenants_for(["CVE-2024-5535"]), {self.tenant.pk, self.other.pk})
        matching.recompute(self.other)
        self.assertEqual([m.device_id for m in self.open(self.other)], [theirs.pk])

    def test_a_host_exception_covers_package_matches(self):
        cve = Cve.objects.get(vuln_id="CVE-2024-5535")
        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=cve, device=self.d12, status="not_applicable",
            reason="not reachable")
        matching.recompute(self.tenant)
        by = {m.device_id: m.excepted_id for m in self.open()}
        self.assertIsNotNone(by[self.d12.pk])
        self.assertIsNone(by[self.d11.pk])

    def test_cost_does_not_grow_with_packages_or_hosts(self):
        def queries():
            with CaptureQueriesContext(connection) as ctx:
                matching.recompute(self.tenant)
            return len(ctx.captured_queries)

        queries()  # settle
        small = queries()
        for i in range(40):
            d = Device.objects.create(tenant=self.tenant, name=f"h{i}", site=self.site)
            pkg(self.tenant, d, "libssl3", "3.0.14-1~deb12u2", source="openssl")
            for j in range(25):
                pkg(self.tenant, d, f"other{j}", "1.0-1")
        first = queries()  # creates 40 matches in bulk
        again = queries()
        self.assertLessEqual(first, small + 3)
        self.assertLessEqual(again, small + 1)
        self.assertEqual(self.open().count(), 42)


@override_settings(DISCOVERY_ENABLED=True)
class PackageMatchApiTests(APITestCase, Base):
    def setUp(self):
        super().setUp()
        matching.recompute(self.tenant)

    def member(self, name, grants):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for slug, actions in grants.items():
            p = ObjectPermission.objects.create(name=f"{name}{slug}", object_types=[slug],
                                                actions=actions)
            p.users.add(user)
            p.tenants.add(self.tenant)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.pk)
        s.save()

    def test_package_matches_need_installed_software_view(self):
        url = f"/api/devices/{self.d12.pk}/vulnerabilities/"
        self.member("dev", {"device": ["view"]})
        self.assertEqual(self.client.get(url).json()["results"], [])
        self.member("both", {"device": ["view"], "installedsoftware": ["view"]})
        rows = self.client.get(url).json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["via"], "package")
        self.assertIsNone(rows[0]["mapping"])
        self.assertEqual(rows[0]["host_package"]["name"], "libssl3")
        self.assertEqual(rows[0]["host_package"]["source_name"], "openssl")

    def test_via_filter_and_record_page(self):
        su = User.objects.create_superuser("root", "r@example.com", "x")
        self.client.force_login(su)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.pk)
        s.save()
        r = self.client.get("/api/vulnerabilities/matches/?via=package")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["count"], 2)
        r = self.client.get("/api/vulnerabilities/CVE-2024-5535/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["affected_count"], 2)
        json.dumps(r.json(), default=str)


def opensuse_curl() -> bytes:
    """A SUSE advisory as OSV writes it (SUSE-SU-2024:2784-1, cut down): one
    entry per product, openSUSE's purl with "&" for "?"."""
    def entry(eco, purl):
        return {"package": {"ecosystem": eco, "name": "curl", "purl": purl},
                "ranges": [{"type": "ECOSYSTEM", "events": [
                    {"introduced": "0"}, {"fixed": "8.6.0-150600.4.3.1"}]}]}

    return json.dumps({
        "id": "SUSE-SU-2024:2784-1", "modified": "2024-08-05T00:00:00Z",
        "upstream": ["CVE-2024-6197"],
        "affected": [
            entry("SUSE:Linux Enterprise Module for Basesystem 15 SP6",
                  "pkg:rpm/suse/curl&distro=SUSE%20Linux%20Enterprise%20Module%20for%20"
                  "Basesystem%2015%20SP6"),
            entry("openSUSE:Leap 15.6",
                  "pkg:rpm/opensuse/curl&distro=openSUSE%20Leap%2015.6")]}).encode()


class OpenSuseLeapTests(Base):
    """openSUSE Leap has an OSV ecosystem (``openSUSE:Leap 15.6``, verified
    against OSV's querybatch): its packages match per release."""

    def test_identifiers(self):
        from .identifiers import (
            distro_release,
            ecosystem_release,
            osv_ecosystems,
            package_key,
        )

        self.assertEqual(ecosystem_release("openSUSE:Leap 15.6"), ("opensuse", "15.6"))
        self.assertEqual(ecosystem_release("openSUSE:Tumbleweed"), ("opensuse", "tumbleweed"))
        self.assertEqual(ecosystem_release("openSUSE:Leap Micro 6.0"),
                         ("opensuse", "leap micro 6.0"))
        self.assertEqual(osv_ecosystems(("opensuse", "15.6")), ["openSUSE:Leap 15.6"])
        self.assertEqual(distro_release("rpm", "opensuse", "15.6"), ("opensuse", "15.6"))
        self.assertEqual(package_key("openSUSE:Leap 15.6", "curl",
                                     "pkg:rpm/opensuse/curl&distro=openSUSE%20Leap%2015.6"),
                         ("rpm", "opensuse/curl"))
        # A well-formed purl still wins.
        self.assertEqual(package_key("Debian:12", "openssl", "pkg:deb/debian/openssl?a=b"),
                         ("deb", "debian/openssl"))

    def test_a_leap_host_matches_on_its_release_only(self):
        from discovery.packages import release_of

        self.assertEqual(release_of({"id": "opensuse-leap", "version_id": "15.6"}, "rpm"),
                         ("opensuse", "openSUSE:Leap 15.6"))
        leap = Device.objects.create(tenant=self.tenant, name="leap", site=self.site)
        other = Device.objects.create(tenant=self.tenant, name="leap16", site=self.site)
        pkg(self.tenant, leap, "curl", "8.0.1-150400.5.1", ecosystem="openSUSE:Leap 15.6",
            ns="opensuse", ptype="rpm")
        pkg(self.tenant, other, "curl", "8.0.1-150400.5.1", ecosystem="openSUSE:Leap 16.0",
            ns="opensuse", ptype="rpm")
        load_osv(opensuse_curl())
        matching.recompute(self.tenant)
        hits = {m.device_id for m in self.open() if m.host_package_id}
        self.assertIn(leap.pk, hits)
        self.assertNotIn(other.pk, hits)
