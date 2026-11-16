"""The device list's cost stays flat as the list grows, and the faster
paths answer exactly what the old ones did: the page by id first (#524),
plain facet counts (#525) and the stored vulnerability summaries (#526)."""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from core.models import Organization, Tag, Tenant

from .list_table import fans_out, group_count
from .models import (
    Device,
    DeviceRole,
    DeviceType,
    Manufacturer,
    Platform,
    Site,
    SupportContract,
    SupportCoverage,
)
from .test_utils import status_for

User = get_user_model()


class ListFixture(APITestCase):
    def setUp(self):
        from vulnerabilities.models import Cve, ProductMapping, VulnerabilitySettings

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(t.id)
        s.save()
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        self.status = status_for(t)
        self.mfr = Manufacturer.objects.create(tenant=t, name="Acme Networks", slug="acme-n")
        self.dtype = DeviceType.objects.create(tenant=t, name="X1", manufacturer=self.mfr)
        self.platform = Platform.objects.create(tenant=t, name="XE", slug="xe")
        self.role = DeviceRole.objects.create(tenant=t, name="Leaf", slug="leaf")
        self.site = Site.objects.create(tenant=t, name="Alpha")
        self.tag = Tag.objects.create(tenant=t, name="core", slug="core")
        self.mapping = ProductMapping.objects.create(
            tenant=t, platform=self.platform, kind="cpe", part="o", vendor="cisco",
            product="ios_xe")
        self.cves = [
            Cve.objects.create(vuln_id=f"CVE-2026-{i:04d}", cvss_score=9.8 - i,
                               kev_added=timezone.localdate() if i == 0 else None)
            for i in range(3)
        ]
        today = timezone.localdate()
        self.contracts = {
            "expired": SupportContract.objects.create(
                tenant=t, manufacturer=self.mfr, contract_number="old",
                end_date=today - timedelta(days=5)),
            "expiring": SupportContract.objects.create(
                tenant=t, manufacturer=self.mfr, contract_number="soon",
                end_date=today + timedelta(days=5)),
            "covered": SupportContract.objects.create(
                tenant=t, manufacturer=self.mfr, contract_number="open", end_date=None),
        }
        self.n = 0
        self.admin = admin
        site_b = Site.objects.create(tenant=t, name="Bravo")
        self.sites = [self.site, site_b]
        self._grow(12)

    def _grow(self, n):
        """``n`` more devices, every few with tags, coverage, a warranty and
        open vulnerability matches of each priority."""
        from vulnerabilities.models import VulnerabilityMatch

        now = timezone.now()
        today = timezone.localdate()
        kinds = list(self.contracts)
        priorities = ["fix_first", "high", "medium", "low"]
        for _ in range(n):
            i = self.n
            self.n += 1
            d = Device.objects.create(
                tenant=self.tenant, name=f"dev-{i}", device_type=self.dtype,
                site=self.sites[i % 5 == 0] if hasattr(self, "sites") else self.site,
                status=self.status, role=self.role if i % 2 else None,
                platform=self.platform if i % 3 else None,
                warranty_end=today + timedelta(days=400) if i % 7 == 0 else None,
            )
            if i % 2:
                d.tags.add(self.tag)
            if i % 4:
                # Two contracts on some devices: the latest end counts.
                SupportCoverage.objects.create(
                    tenant=self.tenant, contract=self.contracts[kinds[i % 3]], device=d)
                if i % 5 == 0:
                    SupportCoverage.objects.create(
                        tenant=self.tenant, contract=self.contracts[kinds[(i + 1) % 3]],
                        device=d)
            if i % 3:
                for k, cve in enumerate(self.cves[: 1 + i % 3]):
                    VulnerabilityMatch.objects.create(
                        tenant=self.tenant, cve=cve, device=d, via="platform",
                        mapping=self.mapping, confidence="exact",
                        priority=priorities[(i + k) % 4], rank=(i + k) % 4,
                        cvss_score=cve.cvss_score, first_seen_at=now,
                        last_seen_at=now, resolved_at=now if i % 11 == 0 else None)
        # Written past the recompute: bring the per-record and per-host
        # counts in, as the recompute would.
        from vulnerabilities import record_stats

        record_stats.refresh(self.tenant.pk)

    def _bucket_counts(self, facet):
        body = self.client.get("/api/devices/facets/").json()
        return {o["value"]: o["count"] for o in body["facets"][facet]}

    def _filtered_count(self, facet, value):
        return self.client.get(f"/api/devices/?view=table&f_{facet}={value}").json()["count"]

    def _with_scoped(self):
        """More devices, and a user who may view one site's."""
        from auth_api.models import ObjectPermission, UserProfile

        self._grow(20)
        user = User.objects.create_user("scoped", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="alpha", object_types=["*"], actions=["view"])
        grant.users.add(user)
        grant.sites.set([self.site])
        grant.tenants.set([self.tenant])
        self.scoped = user

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _urls(self):
        sortable = self.client.get("/api/devices/facets/").json()["sortable"]
        urls = []
        for col in sortable:
            for page in (1, 3):
                urls.append(f"/api/devices/?view=table&page={page}&page_size=7&ordering={col}")
            urls.append(f"/api/devices/?view=table&page=2&page_size=7&ordering=-{col}")
        urls += [
            "/api/devices/?view=table&page=5&page_size=7",
            "/api/devices/?view=table&page=1&page_size=7&search=dev-1",
            "/api/devices/?view=table&page=2&page_size=5&f_tags=core&ordering=site",
            f"/api/devices/?view=table&page=2&page_size=5&f_role={self.role.id}"
            "&ordering=-vulnerabilities",
            "/api/devices/?view=table&page=1&page_size=5&f_vulnerabilities=high,none"
            "&ordering=vuln_score",
            "/api/devices/?view=table&page=2&page_size=5&include=serial_number,asset_tag"
            "&ordering=-updated",
            "/api/devices/?page=2&page_size=6",
            "/api/devices/?page=1&page_size=6&ordering=-name",
            "/api/devices/?page=3&page_size=4&tag=core",
        ]
        return urls

    def _answers(self, urls):
        out = {}
        for url in urls:
            r = self.client.get(url)
            self.assertIn(r.status_code, (200, 404), (url, r.content[:300]))
            out[url] = (r.status_code, r.json())
        return out


class DeviceListCostTests(ListFixture):
    def _count(self, url):
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries)

    def test_page_and_rail_cost_stay_flat_as_the_list_grows(self):
        urls = [
            "/api/devices/?view=table&page=1&page_size=10",
            "/api/devices/?view=table&page=2&page_size=10&ordering=-vulnerabilities",
            "/api/devices/facets/",
            "/api/devices/facets/?f_vulnerabilities=high&f_tags=core",
        ]
        before = [self._count(u) for u in urls]
        self._grow(36)
        self.assertEqual([self._count(u) for u in urls], before)

    def test_a_later_page_holds_the_rows_of_the_whole_sorted_list(self):
        self._grow(13)
        for ordering in ("name", "-vulnerabilities", "coverage", "-site", "tags"):
            with self.subTest(ordering=ordering):
                whole = self.client.get(
                    f"/api/devices/?view=table&page_size=100&ordering={ordering}").json()
                names = [r["name"] for r in whole["results"]]
                paged = []
                for page in (1, 2, 3, 4):
                    body = self.client.get(
                        f"/api/devices/?view=table&page={page}&page_size=7"
                        f"&ordering={ordering}").json()
                    paged += [r["name"] for r in body["results"]]
                    self.assertEqual(body["count"], 25)
                self.assertEqual(paged, names[:28])
                # The slim row still carries what the per-row subqueries feed.
                row = whole["results"][1]
                self.assertIn("vulnerabilities", row)
                self.assertIn("coverage", row)

    def test_coverage_counts_agree_with_the_coverage_filter(self):
        counts = self._bucket_counts("coverage")
        self.assertEqual(sum(counts.values()), 12)
        for bucket in ("covered", "expiring", "expired", "none"):
            with self.subTest(bucket=bucket):
                self.assertEqual(counts.get(bucket, 0), self._filtered_count("coverage", bucket))
        self.assertTrue(counts.get("none"))
        self.assertTrue(counts.get("covered"))

    def test_tag_counts_count_each_device_once(self):
        counts = self._bucket_counts("tags")
        self.assertEqual(counts, {"core": 6})

    def test_to_many_filters_are_counted_distinct(self):
        plain = Device.objects.filter(tenant=self.tenant)
        self.assertFalse(fans_out(plain))
        joined = plain.filter(support_coverage__contract__in=list(self.contracts.values()))
        self.assertTrue(fans_out(joined))
        self.assertTrue(fans_out(plain.distinct()))

    def test_group_count_of_nothing(self):
        from django.db.models import F

        rows = Device.objects.filter(pk__in=[]).annotate(_k=F("site_id")).values("_k")
        self.assertEqual(group_count(rows, "_k"), [])
        rows = Device.objects.filter(tenant=self.tenant).annotate(_k=F("site_id")).values("_k")
        self.assertEqual(sorted(group_count(rows, "_k")), sorted([(self.site.id, 9),
                                                                  (self.sites[1].id, 3)]))


class SameAnswersTests(ListFixture):
    """Every faster path against the one it replaced, response for response,
    as an admin and as a site-bound user."""

    def setUp(self):
        super().setUp()
        self._with_scoped()

    def test_paging_by_id_first_answers_as_before(self):
        from .list_table import TableListMixin

        compared = 0
        for user in (self.admin, self.scoped):
            with self.subTest(user=user.username):
                self._login(user)
                urls = self._urls()
                after = self._answers(urls)
                with mock.patch.object(TableListMixin, "page_ids_first", False):
                    before = self._answers(urls)
                for url in urls:
                    self.assertEqual(after[url], before[url], url)
                    compared += 1
                self.assertTrue(any(a[1].get("results") for a in after.values()))
        self.assertGreater(compared, 100)

    def test_plain_counts_answer_as_counting_distinct(self):
        """Counted with COUNT(DISTINCT) everywhere, the rail says the same -
        with and without a to-many filter (tags)."""
        urls = [
            "/api/devices/facets/",
            "/api/devices/facets/?f_tags=core",
            f"/api/devices/facets/?f_tags=core&f_role={self.role.id}",
            "/api/devices/facets/?search=dev-1",
        ]
        for user in (self.admin, self.scoped):
            with self.subTest(user=user.username):
                self._login(user)
                after = self._answers(urls)
                with mock.patch("api.list_table.fans_out", return_value=True):
                    before = self._answers(urls)
                self.assertEqual(after, before)
        # Narrowed by a tag, the counts are of tagged devices, each once.
        body = after["/api/devices/facets/?f_tags=core"][1]["facets"]
        self.assertEqual(sum(o["count"] for o in body["status"]), 13)

    def test_equal_counts_come_in_label_order(self):
        Device.objects.filter(tenant=self.tenant).update(role=None)
        for name in ("Zulu", "alpha", "Mike"):
            role = DeviceRole.objects.create(tenant=self.tenant, name=name, slug=name.lower())
            Device.objects.filter(pk__in=Device.objects.filter(
                tenant=self.tenant, role=None).values("pk")[:2]).update(role=role)
        Device.objects.filter(tenant=self.tenant, role=None).update(
            role=DeviceRole.objects.create(tenant=self.tenant, name="Most", slug="most"))
        body = self.client.get("/api/devices/facets/").json()["facets"]["role"]
        self.assertEqual([o["label"] for o in body], ["Most", "alpha", "Mike", "Zulu"])
