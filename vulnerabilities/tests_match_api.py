"""Mapping, match, record, policy, summary and coverage endpoints: gate,
RBAC, tenant and site isolation."""
from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Application, Device, DeviceType, InstalledSoftware, Platform, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import matching
from .models import ProductMapping, VulnerabilityMatch, VulnerabilityPolicy, VulnerabilitySettings
from .tests_matching import make_cve, xe_range

User = get_user_model()
HEADER = "X-Danbyte-Unknown-Params"


class ApiBase(APITestCase):
    @classmethod
    def setUpTestData(cls):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        cls.site_a = Site.objects.create(tenant=cls.tenant, name="HQ")
        cls.site_b = Site.objects.create(tenant=cls.tenant, name="Branch")
        cls.xe = Platform.objects.create(
            tenant=cls.tenant, name="IOS-XE", slug="ios-xe",
            cpe_template="cpe:2.3:o:cisco:ios_xe:{version}:*:*:*:*:*:*:*")
        cls.mapping = ProductMapping.objects.create(
            tenant=cls.tenant, platform=cls.xe, kind="cpe", part="o", vendor="cisco",
            product="ios_xe")
        cls.cve = make_cve("CVE-2024-0001", xe_range("17.9.5"), score=9.8, epss=0.9)
        make_cve("CVE-2024-0002", xe_range("17.9.5"), score=5.0)
        cls.d_a = Device.objects.create(tenant=cls.tenant, name="a1", site=cls.site_a,
                                        platform=cls.xe, software_version="17.9.4")
        cls.d_b = Device.objects.create(tenant=cls.tenant, name="b1", site=cls.site_b,
                                        platform=cls.xe, software_version="17.9.4")
        matching.recompute(cls.tenant)
        cls.admin = User.objects.create_superuser("root", "r@example.com", "x")

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).pk)
        s.save()

    def member(self, name, types, actions, sites=(), tenant=None):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(tenant or self.tenant)
        perm = ObjectPermission.objects.create(name=name, object_types=list(types),
                                               actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(tenant or self.tenant)
        if sites:
            perm.sites.set(sites)
        self.login(user, tenant)
        return user


class GateTests(ApiBase):
    URLS = ["/api/vulnerabilities/", "/api/vulnerabilities/matches/",
            "/api/vulnerabilities/mappings/", "/api/vulnerabilities/policy/",
            "/api/vulnerabilities/summary/", "/api/vulnerabilities/coverage/",
            "/api/vulnerabilities/CVE-2024-0001/"]

    def test_off_is_404(self):
        self.login(self.admin)
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        for url in [*self.URLS, f"/api/devices/{self.d_a.pk}/vulnerabilities/"]:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 404)

    def test_anonymous_refused(self):
        for url in self.URLS:
            with self.subTest(url=url):
                self.assertIn(self.client.get(url).status_code, (401, 403))

    def test_settings_routes_are_not_shadowed(self):
        self.login(self.admin)
        self.assertEqual(self.client.get("/api/vulnerabilities/settings/").status_code, 200)

    def test_unknown_params_are_named(self):
        self.login(self.admin)
        known = {
            "/api/vulnerabilities/": f"site={self.site_a.pk}&priority=high&kev=true&q=x",
            "/api/vulnerabilities/matches/": f"device={self.d_a.pk}&status=all&severity=high",
            "/api/vulnerabilities/mappings/": f"platform={self.xe.pk}&kind=cpe&enabled=true",
        }
        for url, params in known.items():
            with self.subTest(url=url):
                r = self.client.get(f"{url}?zz_probe=1")
                self.assertEqual(r.get(HEADER), "zz_probe")
                r = self.client.get(f"{url}?{params}&page_size=5")
                self.assertEqual(r.status_code, 200)
                self.assertNotIn(HEADER, r)


class MatchApiTests(ApiBase):
    def test_lists_for_admin(self):
        self.login(self.admin)
        r = self.client.get("/api/vulnerabilities/")
        self.assertEqual(r.status_code, 200)
        rows = r.json()["results"]
        self.assertEqual([x["vuln_id"] for x in rows], ["CVE-2024-0001", "CVE-2024-0002"])
        self.assertEqual((rows[0]["priority"], rows[0]["devices"]), ("fix_first", 2))
        r = self.client.get("/api/vulnerabilities/matches/?priority=medium")
        self.assertEqual(r.json()["count"], 2)
        r = self.client.get("/api/vulnerabilities/?severity=critical&kev=false")
        self.assertEqual([x["vuln_id"] for x in r.json()["results"]], ["CVE-2024-0001"])
        r = self.client.get("/api/vulnerabilities/?epss_min=2")
        self.assertEqual(r.status_code, 400)
        r = self.client.get(f"/api/vulnerabilities/?site={self.site_b.pk}")
        self.assertEqual(r.json()["results"][0]["devices"], 1)

    def test_record_detail(self):
        self.login(self.admin)
        r = self.client.get("/api/vulnerabilities/CVE-2024-0001/")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["affected_count"], 2)
        self.assertEqual(body["priority"], "fix_first")
        self.assertEqual(self.client.get("/api/vulnerabilities/CVE-1999-0001/").status_code,
                         404)

    def test_site_role_sees_its_sites_only(self):
        self.member("local", ["device", "platform"], ["view"], sites=[self.site_a])
        r = self.client.get("/api/vulnerabilities/matches/")
        self.assertEqual({m["device"]["id"] for m in r.json()["results"]}, {str(self.d_a.pk)})
        r = self.client.get("/api/vulnerabilities/CVE-2024-0001/")
        self.assertEqual(r.json()["affected_count"], 1)
        r = self.client.get("/api/vulnerabilities/")
        self.assertEqual(r.json()["results"][0]["devices"], 1)
        self.assertEqual(self.client.get(
            f"/api/devices/{self.d_b.pk}/vulnerabilities/").status_code, 404)
        r = self.client.get(f"/api/devices/{self.d_a.pk}/vulnerabilities/")
        self.assertEqual(r.json()["count"], 2)
        r = self.client.get(f"/api/platforms/{self.xe.pk}/vulnerabilities/")
        self.assertEqual(r.json()["count"], 2)
        r = self.client.get("/api/vulnerabilities/summary/")
        self.assertEqual((r.json()["devices"], r.json()["records"]), (1, 2))

    def test_no_device_view_sees_nothing(self):
        self.member("ipam", ["prefix"], ["view"])
        self.assertEqual(self.client.get("/api/vulnerabilities/matches/").json()["count"], 0)
        self.assertEqual(self.client.get(
            f"/api/devices/{self.d_a.pk}/vulnerabilities/").status_code, 404)

    def test_other_tenant_sees_nothing(self):
        self.member("bee", ["*"], ["view", "add", "change", "delete"], tenant=self.other)
        self.assertEqual(self.client.get("/api/vulnerabilities/").json()["count"], 0)
        self.assertEqual(self.client.get("/api/vulnerabilities/matches/").json()["count"], 0)
        # The record is in the store, but B maps nothing that names it.
        self.assertEqual(self.client.get("/api/vulnerabilities/CVE-2024-0001/").status_code,
                         404)
        self.assertEqual(self.client.get(
            f"/api/devices/{self.d_a.pk}/vulnerabilities/").status_code, 404)
        self.assertEqual(self.client.get("/api/vulnerabilities/mappings/").json()["count"], 0)
        self.assertEqual(self.client.get(
            f"/api/vulnerabilities/mappings/{self.mapping.pk}/").status_code, 404)

    def test_resolved_status(self):
        self.login(self.admin)
        Device.objects.filter(pk=self.d_b.pk).update(software_version="17.9.5")
        matching.recompute(self.tenant)
        url = f"/api/devices/{self.d_b.pk}/vulnerabilities/"
        self.assertEqual(self.client.get(url).json()["count"], 0)
        self.assertEqual(self.client.get(f"{url}?status=resolved").json()["count"], 2)
        self.assertEqual(self.client.get(f"{url}?status=nope").status_code, 400)


class MappingApiTests(ApiBase):
    URL = "/api/vulnerabilities/mappings/"

    def test_create_from_identifier_and_template(self):
        self.login(self.admin)
        eos = Platform.objects.create(tenant=self.tenant, name="EOS", slug="eos")
        r = self.client.post(self.URL, {"platform": str(eos.pk),
                                        "identifier": "cpe:2.3:o:arista:eos:4.28.3m:*:*:*:*:*:*:*"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["identifier"], r.json()["scheme"]),
                         ("cpe:2.3:o:arista:eos", "arista_eos"))
        app = Application.objects.create(tenant=self.tenant, name="Django", slug="django",
                                         purl_template="pkg:pypi/Django@{version}")
        r = self.client.post(self.URL, {"application": str(app.pk)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["kind"], r.json()["product"], r.json()["scheme"]),
                         ("purl", "django", "pep440"))
        r = self.client.post(self.URL, {"application": str(app.pk)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("identifier", r.json())

    def test_validation(self):
        self.login(self.admin)
        dt = DeviceType.objects.create(tenant=self.tenant, name="C9300")
        bad = [
            ({"device_type": str(dt.pk), "identifier": "cpe:2.3:o:cisco:ios_xe"}, "identifier"),
            ({"platform": str(self.xe.pk), "identifier": "cpe:2.3:h:cisco:c9300"},
             "identifier"),
            ({"platform": str(self.xe.pk), "identifier": "cpe:2.3:o:*:ios_xe"}, "identifier"),
            ({"platform": str(self.xe.pk), "identifier": "nonsense"}, "identifier"),
            ({"platform": str(self.xe.pk), "identifier": "pkg:pypi/x",
              "version_scheme": "magic"}, "version_scheme"),
            ({"identifier": "pkg:pypi/x"}, "subject"),
            ({"platform": str(self.xe.pk), "device_type": str(dt.pk)}, "subject"),
        ]
        for body, field in bad:
            with self.subTest(body=body):
                r = self.client.post(self.URL, body, format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(field, r.json())
        r = self.client.post(self.URL, {"device_type": str(dt.pk),
                                        "identifier": "cpe:2.3:h:cisco:catalyst_9300"},
                             format="json")
        self.assertEqual(r.status_code, 201)

    def test_other_tenants_subject_is_not_found(self):
        theirs = Platform.objects.create(tenant=self.other, name="X", slug="x")
        self.login(self.admin)
        r = self.client.post(self.URL, {"platform": str(theirs.pk),
                                        "identifier": "cpe:2.3:o:cisco:ios_xe"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"platform": "Not found."})

    def test_writes_need_change_on_the_subject(self):
        self.member("viewer", ["platform", "device"], ["view"])
        r = self.client.post(self.URL, {"platform": str(self.xe.pk),
                                        "identifier": "cpe:2.3:o:cisco:ios"}, format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.patch(f"{self.URL}{self.mapping.pk}/", {"enabled": False},
                              format="json")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.get(self.URL).json()["count"], 1)

    def test_change_and_delete(self):
        self.member("editor", ["platform"], ["view", "change"])
        r = self.client.patch(f"{self.URL}{self.mapping.pk}/",
                              {"version_scheme": "generic", "enabled": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["scheme"], r.json()["enabled"]), ("generic", False))
        r = self.client.patch(f"{self.URL}{self.mapping.pk}/", {"platform": str(self.xe.pk)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.get(f"{self.URL}?platform={self.xe.pk}&enabled=false")
        self.assertEqual(r.json()["count"], 1)
        self.assertEqual(self.client.delete(f"{self.URL}{self.mapping.pk}/").status_code, 204)
        self.assertFalse(VulnerabilityMatch.objects.exists())

    def test_change_log(self):
        from audit.models import ChangeLogEntry

        self.login(self.admin)
        app = Application.objects.create(tenant=self.tenant, name="Django", slug="django")
        self.client.post(self.URL, {"application": str(app.pk),
                                    "identifier": "pkg:pypi/django"}, format="json")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type__icontains="productmapping").exists())
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_type__icontains="vulnerabilitymatch").exists())

    def test_coverage(self):
        self.login(self.admin)
        Device.objects.create(tenant=self.tenant, name="blank", site=self.site_a,
                              platform=self.xe)
        Device.objects.create(tenant=self.tenant, name="odd", site=self.site_a,
                              platform=self.xe, software_version="Everest")
        r = self.client.get(f"/api/vulnerabilities/coverage/?platform={self.xe.pk}")
        row = r.json()["results"][0]
        self.assertEqual((row["objects"], row["matched"], row["blank_version"],
                          row["version_not_understood"]), (4, 2, 1, 1))
        self.assertEqual(row["records"]["candidates"], 2)


class PolicyApiTests(ApiBase):
    URL = "/api/vulnerabilities/policy/"

    def test_read_and_change(self):
        self.login(self.admin)
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(Decimal(r.json()["fix_first_epss"]), Decimal("0.5"))
        r = self.client.patch(self.URL, {"fix_first_epss": "0.95", "medium_cvss": 11},
                              format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(list(r.json()), ["medium_cvss"])
        r = self.client.patch(self.URL, {"fix_first_epss": "0.95", "notify_on": ["kev"]},
                              format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(VulnerabilityPolicy.objects.get(tenant=self.tenant).notify_on, ["kev"])
        matching.reprioritise(self.tenant)
        self.assertEqual(set(VulnerabilityMatch.objects.filter(
            cve=self.cve).values_list("priority", flat=True)), {"high"})

    def test_members_read_admins_write(self):
        self.member("viewer", ["device"], ["view"])
        self.assertEqual(self.client.get(self.URL).json()["can_change"], False)
        self.assertEqual(self.client.patch(self.URL, {"high_cvss": 8},
                                           format="json").status_code, 403)
        self.member("nobody", ["prefix"], ["view"])
        self.assertEqual(self.client.get(self.URL).status_code, 403)


class InstallMatchVisibilityTests(ApiBase):
    def test_application_match_needs_install_view(self):
        app = Application.objects.create(tenant=self.tenant, name="Django", slug="django")
        ProductMapping.objects.create(tenant=self.tenant, application=app, kind="purl",
                                      vendor="pypi", product="django")
        make_cve("GHSA-zzzz-0001", osv={"GHSA-zzzz-0001": {"modified": "", "fixed_in": [],
                 "affected": [{"ecosystem": "PyPI", "name": "django", "purl_type": "pypi",
                               "package": "django", "versions": ["4.2.1"], "ranges": []}]}},
                 score=7.5)
        InstalledSoftware.objects.create(tenant=self.tenant, application=app,
                                         device=self.d_a, version="4.2.1")
        matching.recompute(self.tenant)
        self.member("dev-only", ["device"], ["view"])
        r = self.client.get("/api/vulnerabilities/matches/?via=application")
        self.assertEqual(r.json()["count"], 0)
        self.member("with-installs", ["device", "installedsoftware", "application"], ["view"])
        r = self.client.get("/api/vulnerabilities/matches/?via=application")
        self.assertEqual(r.json()["count"], 1)
        r = self.client.get(f"/api/applications/{app.pk}/vulnerabilities/")
        self.assertEqual(r.json()["count"], 1)
        r = self.client.get("/api/vulnerabilities/GHSA-zzzz-0001/")
        self.assertEqual(r.status_code, 200)
