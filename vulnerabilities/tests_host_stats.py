"""The stored per-host vulnerability summaries (#526): kept in step with
the matches, and answering on the Devices list exactly as the live per-row
query does."""
from __future__ import annotations

from unittest import mock

from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Platform, Site
from api.tests_device_list_cost import ListFixture
from core.models import Organization, Tenant


class HostColumnsTests(ListFixture):
    def setUp(self):
        super().setUp()
        self._with_scoped()

    def test_vulnerability_counts_agree_with_the_vulnerability_filter(self):
        counts = self._bucket_counts("vulnerabilities")
        self.assertEqual(sum(counts.values()), 32)
        self.assertTrue(counts.get("none"))
        for bucket in ("fix_first", "high", "medium", "low", "none"):
            with self.subTest(bucket=bucket):
                self.assertEqual(
                    counts.get(bucket, 0), self._filtered_count("vulnerabilities", bucket))
        kev = self._bucket_counts("vuln_kev")
        for bucket in ("yes", "no"):
            self.assertEqual(kev.get(bucket, 0), self._filtered_count("vuln_kev", bucket))
        # Narrowed by another facet, the counts narrow with it.
        body = self.client.get(f"/api/devices/facets/?f_role={self.role.id}").json()
        narrowed = {o["value"]: o["count"] for o in body["facets"]["vulnerabilities"]}
        self.assertEqual(sum(narrowed.values()), 16)

    def test_stored_vulnerability_summaries_answer_as_the_live_query(self):
        """Read from the host summaries for an admin, the column, the facets
        and both sorts say what the per-row query over the matches says."""
        urls = [
            "/api/devices/facets/",
            f"/api/devices/facets/?f_role={self.role.id}",
            "/api/devices/facets/?f_tags=core",
            "/api/devices/?view=table&page_size=50&ordering=-vulnerabilities",
            "/api/devices/?view=table&page_size=50&ordering=vulnerabilities",
            "/api/devices/?view=table&page_size=50&ordering=-vuln_score",
            "/api/devices/?view=table&page=2&page_size=9&ordering=vuln_score",
            "/api/devices/?view=table&page_size=50&f_vulnerabilities=fix_first,low",
            "/api/devices/?view=table&page_size=50&f_vuln_kev=yes",
            "/api/devices/?page_size=50&vuln_priority=high&vuln_kev=false",
        ]
        self._login(self.admin)
        stored = self._answers(urls)
        with mock.patch("vulnerabilities.host_columns.stored", return_value=False):
            live = self._answers(urls)
        self.assertEqual(stored, live)
        self.assertTrue(stored["/api/devices/facets/"][1]["facets"]["vuln_kev"])

    def test_a_site_bound_user_reads_the_matches_they_may_see(self):
        from vulnerabilities import host_columns

        seen = []
        real = host_columns.stored

        def spy(request):
            seen.append(real(request))
            return seen[-1]

        self._login(self.scoped)
        with mock.patch.object(host_columns, "stored", side_effect=spy):
            body = self.client.get("/api/devices/facets/").json()["facets"]
        self.assertTrue(seen)
        self.assertFalse(any(seen))
        visible = Device.objects.filter(tenant=self.tenant, site=self.site).count()
        self.assertEqual(sum(o["count"] for o in body["vulnerabilities"]), visible)



class HostStatTests(APITestCase):
    """The per-host summaries follow the matches (#526)."""

    def setUp(self):
        from vulnerabilities.models import Cve, ProductMapping, VulnerabilitySettings

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        self.platform = Platform.objects.create(tenant=t, name="XE", slug="xe")
        self.site = Site.objects.create(tenant=t, name="Alpha")
        self.mapping = ProductMapping.objects.create(
            tenant=t, platform=self.platform, kind="cpe", part="o", vendor="cisco",
            product="ios_xe")
        self.cves = [Cve.objects.create(vuln_id=f"CVE-2026-{i:04d}", cvss_score=9 - i,
                                        kev_added=timezone.localdate() if i == 1 else None)
                     for i in range(3)]
        self.a = Device.objects.create(tenant=t, name="a", site=self.site)
        self.b = Device.objects.create(tenant=t, name="b", site=self.site)

    def _match(self, device, cve, priority):
        from vulnerabilities import priority as prio
        from vulnerabilities.models import VulnerabilityMatch

        now = timezone.now()
        return VulnerabilityMatch.objects.create(
            tenant=self.tenant, cve=cve, device=device, via="platform",
            mapping=self.mapping, confidence="exact", priority=priority,
            rank=prio.RANK[priority], cvss_score=cve.cvss_score,
            first_seen_at=now, last_seen_at=now)

    def _stats(self):
        from vulnerabilities.models import VulnerabilityHostStat

        return {r.device.name: (r.rank, r.open_records, r.kev, float(r.max_cvss))
                for r in VulnerabilityHostStat.objects.select_related("device")}

    def test_refresh_follows_the_matches(self):
        from vulnerabilities import host_stats, record_stats

        m1 = self._match(self.a, self.cves[0], "medium")
        self._match(self.a, self.cves[1], "high")
        self._match(self.b, self.cves[2], "low")
        record_stats.refresh(self.tenant.pk)
        self.assertEqual(self._stats(), {"a": (1, 2, True, 9.0), "b": (3, 1, False, 7.0)})
        # Nothing changed: nothing written.
        self.assertEqual(host_stats.refresh(self.tenant.pk), 0)
        # A narrower refresh by record reaches the hosts of that record.
        m1.resolved_at = timezone.now()
        m1.save()
        record_stats.refresh(self.tenant.pk, {self.cves[0].pk})
        self.assertEqual(self._stats()["a"], (1, 1, True, 8.0))
        # The host's last live match resolved: its row goes.
        from vulnerabilities.models import VulnerabilityMatch

        VulnerabilityMatch.objects.filter(device=self.b).update(resolved_at=timezone.now())
        record_stats.refresh(self.tenant.pk, {self.cves[2].pk})
        self.assertNotIn("b", self._stats())
        # A deleted host takes its row.
        self.a.delete()
        self.assertEqual(self._stats(), {})

    def test_excepted_matches_are_not_counted(self):
        from vulnerabilities import record_stats
        from vulnerabilities.models import VulnerabilityException

        m = self._match(self.a, self.cves[0], "fix_first")
        self._match(self.a, self.cves[2], "low")
        exc = VulnerabilityException.objects.create(
            tenant=self.tenant, cve=self.cves[0], device=self.a, status="not_applicable",
            reason="lab")
        m.excepted = exc
        m.save()
        record_stats.refresh(self.tenant.pk)
        self.assertEqual(self._stats(), {"a": (3, 1, False, 7.0)})
