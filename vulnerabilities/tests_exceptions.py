"""Exceptions (#451 Phase 8): validation, scopes, the ``excepted`` flag and
counts, RBAC with tenant and site isolation, expiry, purge, notifications."""
from __future__ import annotations

import importlib
from datetime import date, timedelta
from unittest import mock

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Application,
    Cluster,
    ClusterType,
    Device,
    InstalledSoftware,
    Platform,
    Site,
    VirtualMachine,
)
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Notification, Organization, Tenant

from . import exceptions, maintenance, matching, notifications
from .models import (
    ProductMapping,
    VulnerabilityException,
    VulnerabilityMatch,
    VulnerabilityPolicy,
    VulnerabilitySettings,
)
from .tests_matching import make_cve, xe_range

User = get_user_model()
URL = "/api/vulnerability-exceptions/"
NOTIFY = "monitoring.notify.notify_event"


def pg_range(end):
    m = {"vulnerable": True, "criteria": "cpe:2.3:a:postgresql:postgresql:*:*:*:*:*:*:*:*",
         "versionEndExcluding": end}
    return [{"nodes": [{"operator": "OR", "negate": False, "cpeMatch": [m]}]}]


class Fixture:
    @classmethod
    def build(cls):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        cls.site_a = Site.objects.create(tenant=cls.tenant, name="HQ")
        cls.site_b = Site.objects.create(tenant=cls.tenant, name="Branch")
        cls.xe = Platform.objects.create(tenant=cls.tenant, name="IOS-XE", slug="ios-xe")
        cls.mapping = ProductMapping.objects.create(
            tenant=cls.tenant, platform=cls.xe, kind="cpe", part="o", vendor="cisco",
            product="ios_xe")
        cls.pg = Application.objects.create(tenant=cls.tenant, name="PostgreSQL",
                                            slug="postgresql")
        ProductMapping.objects.create(tenant=cls.tenant, application=cls.pg, kind="cpe",
                                      part="a", vendor="postgresql", product="postgresql")
        cls.kev = make_cve("CVE-2024-0001", xe_range("17.9.5"), score=9.8, kev=True)
        cls.mid = make_cve("CVE-2024-0002", xe_range("17.9.5"), score=5.0)
        cls.pgcve = make_cve("CVE-2024-0003", pg_range("16.5"), score=8.8)
        cls.d_a = Device.objects.create(tenant=cls.tenant, name="a1", site=cls.site_a,
                                        platform=cls.xe, software_version="17.9.4")
        cls.d_b = Device.objects.create(tenant=cls.tenant, name="b1", site=cls.site_b,
                                        platform=cls.xe, software_version="17.9.4")
        ct = ClusterType.objects.create(tenant=cls.tenant, name="CT", slug="ct")
        cluster = Cluster.objects.create(tenant=cls.tenant, name="pve", type=ct)
        cls.vm = VirtualMachine.objects.create(tenant=cls.tenant, cluster=cluster, name="db1",
                                               site=cls.site_a)
        cls.install = InstalledSoftware.objects.create(
            tenant=cls.tenant, application=cls.pg, virtual_machine=cls.vm, version="16.4")
        matching.recompute(cls.tenant)
        cls.admin = User.objects.create_superuser("root", "r@example.com", "x")
        cls.owner = User.objects.create_user("alice", password="x", first_name="Alice")
        UserProfile.objects.create(user=cls.owner, role="custom").tenants.add(cls.tenant)
        cls.stranger = User.objects.create_user("eve", password="x")
        UserProfile.objects.create(user=cls.stranger, role="custom").tenants.add(cls.other)


def open_rows(tenant, **kw):
    return VulnerabilityMatch.objects.filter(tenant=tenant, resolved_at__isnull=True, **kw)


def exc(tenant, cve, status="not_applicable", expires=None, **scope):
    return VulnerabilityException.objects.create(
        tenant=tenant, cve=cve, status=status, reason="r", expires_on=expires, **scope)


class FlagTests(Fixture, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.build()

    def excepted(self):
        return {(m.cve.vuln_id, m.device_id or m.virtual_machine_id): m.excepted_id
                for m in open_rows(self.tenant).select_related("cve")}

    def test_scopes(self):
        e_dev = exc(self.tenant, self.kev, device=self.d_a)
        got = self.excepted()
        self.assertEqual(got[("CVE-2024-0001", self.d_a.pk)], e_dev.pk)
        self.assertIsNone(got[("CVE-2024-0001", self.d_b.pk)])
        self.assertIsNone(got[("CVE-2024-0002", self.d_a.pk)])

        e_plat = exc(self.tenant, self.mid, platform=self.xe)
        got = self.excepted()
        self.assertEqual(got[("CVE-2024-0002", self.d_a.pk)], e_plat.pk)
        self.assertEqual(got[("CVE-2024-0002", self.d_b.pk)], e_plat.pk)

        e_app = exc(self.tenant, self.pgcve, application=self.pg)
        self.assertEqual(self.excepted()[("CVE-2024-0003", self.vm.pk)], e_app.pk)
        e_app.delete()
        e_vm = exc(self.tenant, self.pgcve, virtual_machine=self.vm)
        self.assertEqual(self.excepted()[("CVE-2024-0003", self.vm.pk)], e_vm.pk)

    def test_most_specific_wins_and_delete_reopens(self):
        e_all = exc(self.tenant, self.kev)
        e_dev = exc(self.tenant, self.kev, status="risk_accepted",
                    expires=timezone.localdate() + timedelta(days=30), device=self.d_a)
        got = self.excepted()
        self.assertEqual(got[("CVE-2024-0001", self.d_a.pk)], e_dev.pk)
        self.assertEqual(got[("CVE-2024-0001", self.d_b.pk)], e_all.pk)
        e_dev.delete()
        self.assertEqual(self.excepted()[("CVE-2024-0001", self.d_a.pk)], e_all.pk)
        e_all.delete()
        self.assertFalse(open_rows(self.tenant, excepted__isnull=False).exists())

    def test_recompute_keeps_the_flag(self):
        e = exc(self.tenant, self.kev, device=self.d_a)
        VulnerabilityMatch.objects.update(excepted=None)  # drifted
        d = Device.objects.create(tenant=self.tenant, name="a2", site=self.site_a,
                                  platform=self.xe, software_version="17.9.4")
        e2 = exc(self.tenant, self.mid, device=d)
        VulnerabilityMatch.objects.update(excepted=None)
        matching.recompute(self.tenant)
        got = self.excepted()
        self.assertEqual(got[("CVE-2024-0001", self.d_a.pk)], e.pk)
        self.assertEqual(got[("CVE-2024-0002", d.pk)], e2.pk)  # a row the recompute made

    def test_expired_does_not_apply_and_other_tenant_untouched(self):
        exc(self.tenant, self.kev, status="risk_accepted",
            expires=timezone.localdate() - timedelta(days=1))
        self.assertFalse(open_rows(self.tenant, excepted__isnull=False).exists())
        other_xe = Platform.objects.create(tenant=self.other, name="XE", slug="xe")
        ProductMapping.objects.create(tenant=self.other, platform=other_xe, kind="cpe",
                                      part="o", vendor="cisco", product="ios_xe")
        Device.objects.create(tenant=self.other, name="t", platform=other_xe,
                              software_version="17.9.4")
        matching.recompute(self.other)
        exc(self.tenant, self.kev)
        self.assertFalse(open_rows(self.other, excepted__isnull=False).exists())

    def test_cyclonedx_analysis(self):
        na = exc(self.tenant, self.kev, device=self.d_a)
        na.analysis_justification = "code_not_reachable"
        self.assertEqual(exceptions.cyclonedx_analysis(na), {
            "state": "not_affected", "justification": "code_not_reachable", "detail": "r"})
        ra = exc(self.tenant, self.mid, status="risk_accepted", expires=date(2027, 1, 31))
        out = exceptions.cyclonedx_analysis(ra)
        self.assertEqual((out["state"], out["response"]), ("exploitable", ["will_not_fix"]))
        self.assertIn("2027-01-31", out["detail"])


class ApiBase(Fixture, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.build()

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).pk)
        s.save()

    def member(self, name, grants, sites=(), tenant=None):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(tenant or self.tenant)
        for i, (types, actions) in enumerate(grants):
            perm = ObjectPermission.objects.create(name=f"{name}{i}", object_types=list(types),
                                                   actions=list(actions))
            perm.users.add(user)
            perm.tenants.add(tenant or self.tenant)
            if sites:
                perm.sites.set(sites)
        self.login(user, tenant)
        return user

    def body(self, **kw):
        out = {"vuln_id": "CVE-2024-0001", "status": "not_applicable",
               "reason": "Feature not enabled", "owner_id": self.owner.pk,
               "device_id": str(self.d_a.pk)}
        out.update(kw)
        return {k: v for k, v in out.items() if v is not None}


class ValidationTests(ApiBase):
    def setUp(self):
        self.login(self.admin)

    def test_create_and_read(self):
        r = self.client.post(URL, self.body(), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        row = r.json()
        self.assertEqual((row["scope"], row["status"], row["analysis_state"]),
                         ("device", "not_applicable", "not_affected"))
        self.assertEqual(row["owner_name"], "Alice")
        self.assertEqual(row["matches"], 1)
        self.assertTrue(row["active"])
        self.assertIsNotNone(row["numid"])
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="vulnerabilities.vulnerabilityexception", object_id=row["id"]).exists())
        m = open_rows(self.tenant, device=self.d_a, cve=self.kev).get()
        self.assertEqual(str(m.excepted_id), row["id"])
        listed = self.client.get(f"{URL}?scope=device&vuln_id=CVE-2024-0001").json()
        self.assertEqual(listed["count"], 1)
        self.assertEqual(listed["results"][0]["matches"], 1)

    def test_reason_owner_and_record_required(self):
        for kw, field in (({"reason": "  "}, "reason"), ({"reason": None}, "reason"),
                          ({"owner_id": None}, "owner_id"),
                          ({"owner_id": self.stranger.pk}, "owner_id"),
                          ({"vuln_id": None}, "vuln_id"),
                          ({"vuln_id": "CVE-1999-0001"}, "vuln_id"),
                          ({"status": None}, "status")):
            with self.subTest(field=field, kw=kw):
                r = self.client.post(URL, self.body(**kw), format="json")
                self.assertEqual(r.status_code, 400)
                self.assertIn(field, r.json())

    def test_risk_accepted_expiry_rules(self):
        today = timezone.localdate()
        for expires, ok in ((None, False), (today - timedelta(days=1), False),
                            (today + timedelta(days=366), False),
                            (today + timedelta(days=365), True)):
            with self.subTest(expires=expires):
                VulnerabilityException.objects.all().delete()
                r = self.client.post(URL, self.body(
                    status="risk_accepted",
                    expires_on=expires.isoformat() if expires else None), format="json")
                self.assertEqual(r.status_code, 201 if ok else 400, r.content)
                if not ok:
                    self.assertIn("expires_on", r.json())
        row = VulnerabilityException.objects.get()
        self.assertEqual((row.analysis_state, row.analysis_response),
                         ("exploitable", ["will_not_fix"]))

    def test_not_applicable_expiry_optional_not_past(self):
        today = timezone.localdate()
        r = self.client.post(URL, self.body(expires_on=(today + timedelta(days=800)).isoformat()),
                             format="json")
        self.assertEqual(r.status_code, 201)
        r = self.client.post(URL, self.body(device_id=str(self.d_b.pk),
                                            expires_on=(today - timedelta(days=1)).isoformat()),
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_analysis_checked_against_status(self):
        r = self.client.post(URL, self.body(analysis_state="exploitable"), format="json")
        self.assertIn("analysis_state", r.json())
        r = self.client.post(URL, self.body(status="risk_accepted",
                                            expires_on=str(timezone.localdate()),
                                            analysis_justification="code_not_present"),
                             format="json")
        self.assertIn("analysis_justification", r.json())
        r = self.client.post(URL, self.body(analysis_response=["nope"]), format="json")
        self.assertIn("analysis_response", r.json())

    def test_one_scope_one_active_and_immutable(self):
        r = self.client.post(URL, self.body(platform_id=str(self.xe.pk)), format="json")
        self.assertIn("scope", r.json())
        self.assertEqual(self.client.post(URL, self.body(), format="json").status_code, 201)
        r = self.client.post(URL, self.body(), format="json")
        self.assertEqual(r.status_code, 400)
        pk = VulnerabilityException.objects.get().pk
        r = self.client.patch(f"{URL}{pk}/", {"device_id": str(self.d_b.pk)}, format="json")
        self.assertIn("scope", r.json())
        r = self.client.patch(f"{URL}{pk}/", {"status": "risk_accepted"}, format="json")
        self.assertIn("expires_on", r.json())
        r = self.client.patch(f"{URL}{pk}/", {"status": "risk_accepted",
                                              "expires_on": str(timezone.localdate())},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["analysis_state"], "exploitable")

    def test_other_tenants_objects_refused(self):
        other_dev = Device.objects.create(tenant=self.other, name="x")
        r = self.client.post(URL, self.body(device_id=str(other_dev.pk)), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_id", r.json())

    def test_off_is_404(self):
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        self.assertEqual(self.client.get(URL).status_code, 404)

    def test_unknown_params_named(self):
        r = self.client.get(f"{URL}?zz=1")
        self.assertEqual(r.get("X-Danbyte-Unknown-Params"), "zz")
        r = self.client.get(f"{URL}?status=risk_accepted&scope=tenant&active=true&q=x"
                            f"&device={self.d_a.pk}&owner={self.owner.pk}")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("X-Danbyte-Unknown-Params", r)


class CountTests(ApiBase):
    def test_excepted_drop_out_of_counts_and_lists(self):
        self.login(self.admin)
        exc(self.tenant, self.kev)  # tenant-wide
        s = self.client.get("/api/vulnerabilities/summary/").json()
        self.assertEqual((s["kev"], s["by_priority"]["fix_first"], s["excepted"],
                          s["excepted_records"]), (0, 0, 2, 1))
        ids = [r["vuln_id"] for r in self.client.get("/api/vulnerabilities/").json()["results"]]
        self.assertNotIn("CVE-2024-0001", ids)
        rows = self.client.get("/api/vulnerabilities/?excepted=true").json()["results"]
        self.assertEqual([(r["vuln_id"], r["devices"], r["excepted"]) for r in rows],
                         [("CVE-2024-0001", 2, 2)])
        self.assertEqual(self.client.get(
            "/api/vulnerabilities/matches/?excepted=all").json()["count"], 5)
        m = self.client.get("/api/vulnerabilities/matches/?excepted=true").json()["results"]
        self.assertEqual(m[0]["exception"]["scope"], "tenant")
        dev = self.client.get(f"/api/devices/{self.d_a.pk}/vulnerabilities/").json()
        self.assertEqual([r["cve"]["vuln_id"] for r in dev["results"]], ["CVE-2024-0002"])
        detail = self.client.get("/api/vulnerabilities/CVE-2024-0001/").json()
        self.assertEqual((detail["affected_count"], detail["excepted_count"]), (2, 2))
        self.assertEqual(self.client.get(
            "/api/vulnerabilities/matches/?excepted=maybe").status_code, 400)


class AccessTests(ApiBase):
    def test_site_editor_own_site_only(self):
        self.member("site", [(["device", "virtualmachine", "vulnerabilityexception"],
                              ["view", "add", "change", "delete"])], sites=[self.site_a])
        r = self.client.post(URL, self.body(), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.post(URL, self.body(device_id=str(self.d_b.pk)), format="json")
        self.assertEqual(r.status_code, 400)
        for kw in ({"device_id": None, "platform_id": str(self.xe.pk)}, {"device_id": None}):
            with self.subTest(kw=kw):
                r = self.client.post(URL, self.body(vuln_id="CVE-2024-0002", **kw),
                                     format="json")
                self.assertEqual(r.status_code, 400)
                self.assertIn("scope", r.json())

    def test_site_viewer_sees_own_site_and_shared(self):
        mine = exc(self.tenant, self.kev, device=self.d_a)
        exc(self.tenant, self.kev, device=self.d_b)
        shared = exc(self.tenant, self.mid)
        self.member("viewer", [(["device", "vulnerabilityexception"], ["view"])],
                    sites=[self.site_a])
        got = {r["id"] for r in self.client.get(URL).json()["results"]}
        self.assertEqual(got, {str(mine.pk), str(shared.pk)})
        self.assertEqual(self.client.post(URL, self.body(), format="json").status_code, 403)

    def test_type_grant_needed(self):
        self.member("devs", [(["device"], ["view"])])
        self.assertEqual(self.client.get(URL).status_code, 403)

    def test_subject_must_be_visible(self):
        exc(self.tenant, self.pgcve, application=self.pg)
        self.member("noapps", [(["device", "vulnerabilityexception"],
                                ["view", "add", "change", "delete"])])
        self.assertEqual(self.client.get(URL).json()["count"], 0)
        r = self.client.post(URL, self.body(vuln_id="CVE-2024-0003", device_id=None,
                                            application_id=str(self.pg.pk)), format="json")
        self.assertEqual(r.status_code, 400)

    def test_tenant_isolation(self):
        exc(self.tenant, self.kev)
        self.login(self.admin, self.other)
        self.assertEqual(self.client.get(URL).json()["count"], 0)
        # The other tenant never matched or maps the record.
        r = self.client.post(URL, self.body(device_id=None), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("vuln_id", r.json())

    def test_bulk_delete_reopens(self):
        a = exc(self.tenant, self.kev, device=self.d_a)
        b = exc(self.tenant, self.mid, device=self.d_a)
        self.login(self.admin)
        r = self.client.post(f"{URL}bulk-delete/", {"ids": [str(a.pk), str(b.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(VulnerabilityException.objects.exists())
        self.assertFalse(open_rows(self.tenant, excepted__isnull=False).exists())


    def test_scopes_follow_the_role(self):
        self.login(self.admin)
        r = self.client.get(f"{URL}scopes/").json()
        self.assertEqual(r, {"scopes": ["device", "virtual_machine", "platform",
                                        "application", "tenant"], "site_limited": False})
        self.member("site", [(["device", "virtualmachine", "vulnerabilityexception"],
                              ["view", "add"])], sites=[self.site_a])
        self.assertEqual(self.client.get(f"{URL}scopes/").json(),
                         {"scopes": ["device", "virtual_machine"], "site_limited": True})
        self.member("devonly", [(["device", "vulnerabilityexception"], ["view", "add"])])
        self.assertEqual(self.client.get(f"{URL}scopes/").json()["scopes"],
                         ["device", "tenant"])
        self.member("reader", [(["device", "vulnerabilityexception"], ["view"])])
        self.assertEqual(self.client.get(f"{URL}scopes/").status_code, 403)

    def test_exception_writers_may_pick_the_owner(self):
        self.member("writer", [(["device", "vulnerabilityexception"], ["view", "add"])])
        r = self.client.get("/api/people/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("alice", [p["username"] for p in r.json()["results"]])
        self.member("reader", [(["device", "vulnerabilityexception"], ["view"])])
        self.assertEqual(self.client.get("/api/people/").status_code, 403)

    def test_match_names_its_mapping_platform(self):
        self.login(self.admin)
        rows = self.client.get(f"/api/devices/{self.d_a.pk}/vulnerabilities/").json()["results"]
        self.assertEqual(rows[0]["mapping"]["platform"],
                         {"id": str(self.xe.pk), "name": "IOS-XE"})


class SiteRoleMigrationTests(TestCase):
    """0052 gives the site roles built before it vulnerability exceptions."""

    def test_roles_gain_the_type(self):
        mig = importlib.import_module(
            "auth_api.migrations.0052_site_roles_vulnerability_exceptions")
        base = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        site = Site.objects.create(tenant=tenant, name="A")
        types = sorted(base.CORE)

        def role(name, actions, types=types):
            p = ObjectPermission.objects.create(name=name, object_types=list(types),
                                                actions=actions)
            p.sites.set([site])
            return p

        view = role("A - site view", ["view"])
        edit = role("A - site edit", ["view", "add", "change", "delete"])
        custom = role("Ops - site view", ["view"], types=["device"])
        mig.forwards(django_apps, None)
        mig.forwards(django_apps, None)
        for p in (view, edit, custom):
            p.refresh_from_db()
        self.assertEqual(view.object_types.count("vulnerabilityexception"), 1)
        self.assertIn("vulnerabilityexception", edit.object_types)
        self.assertEqual(custom.object_types, ["device"])


class ExpiryTests(Fixture, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.build()

    def test_expiry_reopens_and_notifies_once(self):
        today = timezone.localdate()
        e = exc(self.tenant, self.kev, status="risk_accepted", expires=today, device=self.d_a)
        e.owner, e.owner_name = self.owner, "Alice"
        e.save()
        self.assertTrue(open_rows(self.tenant, excepted=e).exists())
        with mock.patch(NOTIFY) as sent:
            self.assertEqual(maintenance.expire_exceptions(today=today)["exceptions"], 0)
            counts = maintenance.expire_exceptions(today=today + timedelta(days=1))
            self.assertEqual((counts["exceptions"], counts["reopened"]), (1, 1))
            maintenance.expire_exceptions(today=today + timedelta(days=2))
        self.assertEqual(sent.call_count, 1)
        self.assertIn("1 vulnerability exception expired", sent.call_args.args[1])
        self.assertIn("1 match reopened", sent.call_args.args[2])
        self.assertFalse(open_rows(self.tenant, excepted__isnull=False).exists())
        self.assertEqual(Notification.objects.filter(
            user=self.owner, kind="vulnerability_exception_expired").count(), 1)
        e.refresh_from_db()
        self.assertIsNotNone(e.expiry_notified_at)
        # The reopened match was named in the expiry message: not again as new.
        m = open_rows(self.tenant, device=self.d_a, cve=self.kev).get()
        self.assertTrue(m.notified_kev)

    def test_inactive_tenant_skipped(self):
        exc(self.tenant, self.kev, status="risk_accepted",
            expires=timezone.localdate() - timedelta(days=1))
        Tenant.objects.filter(pk=self.tenant.pk).update(is_active=False)
        with mock.patch(NOTIFY) as sent:
            self.assertEqual(maintenance.expire_exceptions()["exceptions"], 0)
        sent.assert_not_called()

    def test_purge_resolved_after_365_days(self):
        now = timezone.now()
        rows = list(open_rows(self.tenant)[:3])
        VulnerabilityMatch.objects.filter(pk=rows[0].pk).update(
            resolved_at=now - timedelta(days=366))
        VulnerabilityMatch.objects.filter(pk=rows[1].pk).update(
            resolved_at=now - timedelta(days=300))
        self.assertEqual(maintenance.purge_resolved(now=now), 1)
        self.assertFalse(VulnerabilityMatch.objects.filter(pk=rows[0].pk).exists())
        self.assertTrue(VulnerabilityMatch.objects.filter(pk=rows[1].pk).exists())
        self.assertTrue(VulnerabilityMatch.objects.filter(pk=rows[2].pk).exists())

    def test_command(self):
        with mock.patch(NOTIFY):
            call_command("vuln_maintenance", stdout=mock.MagicMock())
        from core.models import ScheduledRun

        self.assertEqual(ScheduledRun.objects.filter(name="vuln-maintenance").count(), 1)


class NotificationTests(Fixture, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.build()

    def test_one_message_then_silent(self):
        with mock.patch(NOTIFY) as sent:
            self.assertEqual(notifications.after_recompute(self.tenant), 2)
            matching.recompute(self.tenant)
            self.assertEqual(notifications.after_recompute(self.tenant), 0)
        self.assertEqual(sent.call_count, 1)
        tenant_id, subject, body, payload = sent.call_args.args
        self.assertEqual(tenant_id, self.tenant.pk)
        # The KEV record on two devices; the medium and the 8.8 are not asked for.
        self.assertIn("1 new vulnerability to fix first on 2 devices", subject)
        self.assertIn("CVE-2024-0001 (KEV, CVSS 9.8, fix first) on 2 devices", body)
        self.assertEqual((payload["event"], payload["count"]), ("vulnerabilities_matched", 2))
        self.assertIsNone(sent.call_args.kwargs["site_id"])  # two sites

    def test_one_site_passes_the_site(self):
        Device.objects.filter(pk=self.d_b.pk).update(site=self.site_a)
        with mock.patch(NOTIFY) as sent:
            notifications.after_recompute(self.tenant)
        self.assertEqual(sent.call_args.kwargs["site_id"], str(self.site_a.pk))

    def test_excepted_never_named(self):
        exc(self.tenant, self.kev, device=self.d_a)
        with mock.patch(NOTIFY) as sent:
            self.assertEqual(notifications.after_recompute(self.tenant), 1)
        self.assertEqual(sent.call_args.args[3]["matches"][0]["host"]["name"], "b1")

    def test_policy_off_and_notify_on(self):
        policy = VulnerabilityPolicy.for_tenant(self.tenant)
        policy.notify_enabled = False
        policy.save()
        with mock.patch(NOTIFY) as sent:
            self.assertEqual(notifications.after_recompute(self.tenant), 0)
            policy.notify_enabled, policy.notify_on = True, ["critical"]
            policy.save()
            notifications.after_recompute(self.tenant)
        self.assertEqual(sent.call_count, 1)
        self.assertEqual({m["vuln_id"] for m in sent.call_args.args[3]["matches"]},
                         {"CVE-2024-0001"})

    def test_joining_kev_is_told_once(self):
        policy = VulnerabilityPolicy.for_tenant(self.tenant)
        policy.notify_on = ["critical", "kev"]
        policy.save()
        crit = make_cve("CVE-2024-0009", xe_range("17.9.5"), score=9.9)
        matching.recompute(self.tenant)
        with mock.patch(NOTIFY) as sent:
            notifications.after_recompute(self.tenant)
            type(crit).objects.filter(pk=crit.pk).update(kev_added=date(2024, 6, 1))
            notifications.after_recompute(self.tenant)
            notifications.after_recompute(self.tenant)
        self.assertEqual(sent.call_count, 2)
        second = sent.call_args.args
        self.assertIn("1 now in CISA KEV on 2 devices", second[1])
        self.assertEqual({m["kind"] for m in second[3]["matches"]}, {"kev"})

    def test_job_notifies_after_recompute(self):
        from . import jobs

        VulnerabilityMatch.objects.all().delete()
        with mock.patch(NOTIFY) as sent:
            counts = jobs.run_recompute(str(self.tenant.pk))
        self.assertEqual(counts["notified"], 2)
        self.assertEqual(sent.call_count, 1)
