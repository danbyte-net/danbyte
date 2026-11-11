"""Discovery (#451 B2): gates, scope, the run job, storage and the API -
tenant isolation and RBAC on every endpoint."""
from __future__ import annotations

import json
from datetime import time, timedelta
from pathlib import Path
from unittest import mock

from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    Prefix,
    Site,
    Status,
    VirtualMachine,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from danbyte_checks import inventory as inv
from integrations.models import IntegrationSettings
from monitoring.models import (
    DeviceCredential,
    EventImpact,
    MaintenanceEvent,
    MonitoringDenySubnet,
    SSHHostKey,
)

from . import packages, runner, scope
from .models import (
    DiscoverySettings,
    HostOsFact,
    HostPackage,
    InventoryHostResult,
    InventoryProfile,
    InventoryRun,
)

DATA = Path(__file__).resolve().parent / "testdata"
SECRET = "pw-SECRET-9f3c"
KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIGq0vFkqK9xq9pV0p3Yb9cS5Qj6O0Z1m3c8a7Q9Wm0bX"


def result(os_file="debian12-os-release.txt", pkg_file="debian12-dpkg.txt", manager="dpkg"):
    os_facts = inv.parse_os_release((DATA / os_file).read_text())
    parsed = inv.PARSERS[manager]((DATA / pkg_file).read_text())
    return inv.InventoryResult(inv.OK, os=os_facts, manager=manager, packages=parsed.packages)


@override_settings(DISCOVERY_ENABLED=True)
class Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        for t in (cls.tenant, cls.other):
            IntegrationSettings.objects.create(tenant=t, discovery_enabled=True)
        cls.site = Site.objects.create(tenant=cls.tenant, name="HQ")
        cls.branch = Site.objects.create(tenant=cls.tenant, name="Branch")
        cls.prefix = Prefix.objects.create(tenant=cls.tenant, cidr="10.0.0.0/24")
        cls.prefix2 = Prefix.objects.create(tenant=cls.tenant, cidr="10.9.0.0/24")
        ct = ClusterType.objects.create(tenant=cls.tenant, name="CT", slug="ct")
        cls.cluster = Cluster.objects.create(tenant=cls.tenant, name="pve", type=ct)
        cls.su = User.objects.create_superuser("root", "r@example.com", "x")

    def host(self, name, address, *, site=None, vm=False, cred="ssh_password", key=True,
             prefix=None, tenant=None):
        tenant = tenant or self.tenant
        prefix = prefix or (self.prefix if tenant == self.tenant else
                            Prefix.objects.get_or_create(tenant=tenant, cidr="10.0.0.0/24")[0])
        if vm:
            h = VirtualMachine.objects.create(tenant=tenant, name=name, site=site,
                                              cluster=self.cluster if tenant == self.tenant
                                              else None)
            ip = IPAddress.objects.create(tenant=tenant, ip_address=address, prefix=prefix,
                                          assigned_vm=h)
        else:
            h = Device.objects.create(tenant=tenant, name=name, site=site)
            ip = IPAddress.objects.create(tenant=tenant, ip_address=address, prefix=prefix,
                                          assigned_device=h)
        h.primary_ip = ip
        h.save()
        field = "virtual_machine" if vm else "device"
        if cred:
            DeviceCredential.objects.create(
                tenant=tenant, name="login", kind=cred, username="inv",
                secret_managed=False, secret_provider="local", secret_path=f"x/{name}",
                **{field: h})
        if key:
            SSHHostKey.objects.create(tenant=tenant, key_type="ssh-ed25519", public_key=KEY,
                                      fingerprint_sha256=f"SHA256:{name}", uploaded=True,
                                      **{field: h})
        return h

    def profile(self, tenant=None, **kw):
        defaults = {"name": "p", "enabled": True, "authorisation": "Change 42, by ops",
                    "authorised_at": timezone.now(), "authorised_by_name": "root"}
        defaults.update(kw)
        p = InventoryProfile.objects.create(tenant=tenant or self.tenant, **defaults)
        return p


class GateTests(Base):
    def test_both_switches_are_needed(self):
        from . import gate

        self.assertTrue(gate.active(self.tenant))
        with override_settings(DISCOVERY_ENABLED=False):
            self.assertFalse(gate.active(self.tenant))
            self.assertEqual(gate.active_tenant_ids(), set())
        IntegrationSettings.objects.filter(tenant=self.tenant).update(discovery_enabled=False)
        self.assertFalse(gate.active(self.tenant))

    def test_off_by_default(self):
        self.assertFalse(IntegrationSettings._meta.get_field("discovery_enabled").default)
        with self.settings(DISCOVERY_ENABLED=False):
            from django.conf import settings

            self.assertFalse(settings.DISCOVERY_ENABLED)


class ScopeTests(Base):
    def statuses(self, profile, user=None):
        return {str(t.host): t.skip or "ready" for t in scope.resolve(profile, user=user)}

    def test_members_sites_and_prefixes(self):
        a = self.host("a", "10.0.0.1", site=self.site)
        b = self.host("b", "10.0.0.2", site=self.branch)
        c = self.host("c", "10.9.0.3", prefix=self.prefix2)
        v = self.host("v", "10.0.0.4", vm=True)
        self.host("theirs", "10.0.0.5", tenant=self.other)
        p = self.profile()
        p.sites.add(self.site)
        p.devices.add(b)
        p.prefixes.add(self.prefix2)
        p.virtual_machines.add(v)
        self.assertEqual(self.statuses(p), {"a": "ready", "b": "ready", "c": "ready",
                                            "v": "ready"})
        self.assertNotIn(str(c.pk), [str(a.pk)])

    def test_reasons_not_to_contact(self):
        exempt = self.host("exempt", "10.0.0.10", site=self.site)
        exempt.scan_exempt = True
        exempt.save()
        ip_exempt = self.host("ipx", "10.0.0.11", site=self.site)
        IPAddress.objects.filter(pk=ip_exempt.primary_ip_id).update(scan_exempt=True)
        self.host("denied", "10.0.0.12", site=self.site)
        DiscoverySettings.objects.create(tenant=self.tenant, deny_subnets=["10.0.0.12/32"])
        self.host("mondeny", "10.0.0.13", site=self.site)
        MonitoringDenySubnet.objects.create(tenant=self.tenant, cidr="10.0.0.13/32")
        maint = self.host("maint", "10.0.0.14", site=self.site)
        status = Status.objects.create(tenant=self.tenant, name="Open", slug="open-m",
                                       available_to=["maintenanceevent"])
        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, status=status, name="w", starts_at=timezone.now()
            - timedelta(hours=1), ends_at=timezone.now() + timedelta(hours=1))
        EventImpact.objects.create(tenant=self.tenant, event=ev, object_type="api.device",
                                   object_id=maint.pk)
        self.host("nocred", "10.0.0.15", site=self.site, cred=None)
        self.host("nokey", "10.0.0.16", site=self.site, key=False)
        self.host("linklocal", "169.254.169.254",
                  prefix=Prefix.objects.create(tenant=self.tenant, cidr="169.254.0.0/16"),
                  site=self.site)
        Device.objects.create(tenant=self.tenant, name="noaddr", site=self.site)
        p = self.profile()
        p.sites.add(self.site)
        self.assertEqual(self.statuses(p), {
            "exempt": "exempt", "ipx": "exempt", "denied": "denied", "mondeny": "denied",
            "maint": "maintenance", "nocred": "no_credential", "nokey": "host_key_refused",
            "linklocal": "blocked", "noaddr": "no_address"})

    def test_an_exempt_prefix_covers_its_addresses(self):
        self.host("a", "10.0.0.1", site=self.site)
        Prefix.objects.filter(pk=self.prefix.pk).update(scan_exempt=True)
        p = self.profile()
        p.sites.add(self.site)
        self.assertEqual(self.statuses(p), {"a": "exempt"})

    def test_an_observed_key_is_not_an_accepted_one(self):
        h = self.host("a", "10.0.0.1", site=self.site, key=False)
        SSHHostKey.objects.create(tenant=self.tenant, device=h, key_type="ssh-ed25519",
                                  public_key=KEY, fingerprint_sha256="SHA256:o",
                                  observed=True, uploaded=False)
        p = self.profile()
        p.sites.add(self.site)
        self.assertEqual(self.statuses(p), {"a": "host_key_refused"})

    def test_a_key_login_wins_and_known_hosts_pin_the_address(self):
        h = self.host("a", "10.0.0.1", site=self.site)
        DeviceCredential.objects.create(tenant=self.tenant, device=h, name="key",
                                        kind="ssh_key", port=2222, secret_path="x/k",
                                        secret_managed=False)
        p = self.profile()
        p.sites.add(self.site)
        (t,) = scope.resolve(p)
        self.assertEqual(t.credential.kind, "ssh_key")
        self.assertIn(f"[10.0.0.1]:2222 ssh-ed25519 {KEY}\n".encode(), t.known_hosts)

    def test_a_person_reads_only_what_they_may_view(self):
        self.host("a", "10.0.0.1", site=self.site)
        self.host("b", "10.0.0.2", site=self.branch)
        p = self.profile()
        p.sites.add(self.site, self.branch)
        user = User.objects.create_user("site", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="s", object_types=["device", "devicecredential"], actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.set([self.site])
        self.assertEqual(self.statuses(p, user=user), {"a": "ready"})


class StoreTests(Base):
    def test_full_read_replaces_the_set(self):
        h = self.host("a", "10.0.0.1")
        r = result()
        first = packages.store(self.tenant, h, None, r)
        self.assertEqual((first["packages"], first["added"], first["removed"]), (88, 88, 0))
        bash = HostPackage.objects.get(device=h, name="bash")
        self.assertEqual((bash.match_name, bash.match_version, bash.ecosystem),
                         ("debian/bash", "5.2.15-2", "Debian:12"))
        self.assertTrue(bash.purl.startswith("pkg:deb/debian/bash@5.2.15-2%2Bb13?arch=amd64"))
        self.assertIn("distro=bookworm", bash.purl)
        fact = HostOsFact.objects.get(device=h)
        self.assertEqual((fact.os_id, fact.ecosystem), ("debian", "Debian:12"))
        # The next read lacks bash and has a newer apt.
        r.packages = [p for p in r.packages if p.name != "bash"]
        for p in r.packages:
            if p.name == "apt":
                p.version = p.source_version = "2.6.1+1"
        second = packages.store(self.tenant, h, None, r)
        self.assertEqual((second["added"], second["removed"], second["updated"]), (0, 1, 1))
        self.assertIsNotNone(HostPackage.objects.get(device=h, name="bash").removed_at)
        # It comes back.
        third = packages.store(self.tenant, h, None, result())
        self.assertEqual(third["added"], 1)
        self.assertIsNone(HostPackage.objects.get(device=h, name="bash").removed_at)

    def test_unchanged_read_changes_nothing_and_costs_few_queries(self):
        h = self.host("a", "10.0.0.1")
        packages.store(self.tenant, h, None, result())
        with self.assertNumQueries(6):
            out = packages.store(self.tenant, h, None, result())
        self.assertFalse(out["changed"])

    def test_releases(self):
        ubu = inv.parse_os_release((DATA / "ubuntu2604-os-release.txt").read_text())
        self.assertEqual(packages.release_of(ubu, "dpkg"), ("ubuntu", "Ubuntu:26.04:LTS"))
        rocky = inv.parse_os_release((DATA / "rocky9-os-release.txt").read_text())
        self.assertEqual(packages.release_of(rocky, "rpm"), ("rocky", "Rocky Linux:9"))
        alp = inv.parse_os_release((DATA / "alpine322-os-release.txt").read_text())
        self.assertEqual(packages.release_of(alp, "apk"), ("alpine", "Alpine:v3.22"))
        self.assertEqual(packages.release_of({"id": "rhel", "version_id": "9.4"}, "rpm"),
                         ("redhat", "Red Hat:enterprise_linux:9"))
        self.assertEqual(packages.release_of({"id": "gentoo"}, "rpm"), ("gentoo", ""))

    def test_rpm_and_apk_names(self):
        h = self.host("r", "10.0.0.1")
        packages.store(self.tenant, h, None, result("rocky9-os-release.txt", "rocky9-rpm.txt",
                                                    "rpm"))
        nm = HostPackage.objects.get(device=h, name="NetworkManager")
        self.assertEqual((nm.match_name, nm.match_version), ("rocky/networkmanager",
                                                             "1:1.46.0-8.el9_4"))
        a = self.host("al", "10.0.0.2")
        packages.store(self.tenant, a, None, result("alpine322-os-release.txt",
                                                    "alpine322-installed.txt", "apk"))
        lib = HostPackage.objects.get(device=a, name="libcrypto3")
        self.assertEqual(lib.match_name, "alpine/openssl")

    def test_purge_after_thirty_days(self):
        h = self.host("a", "10.0.0.1")
        packages.store(self.tenant, h, None, result())
        HostPackage.objects.filter(device=h, name="bash").update(
            removed_at=timezone.now() - timedelta(days=31))
        self.assertEqual(packages.purge_removed(), 1)

    def test_tracked_keys_follow_the_gate(self):
        h = self.host("a", "10.0.0.1")
        packages.store(self.tenant, h, None, result())
        self.assertIn(("purl", "", "deb", "debian/bash"), packages.tracked_keys())
        self.assertEqual(packages.tracked_releases()[("purl", "", "deb", "debian/bash")],
                         {("debian", "12")})
        with override_settings(DISCOVERY_ENABLED=False):
            self.assertEqual(packages.tracked_keys(), set())


class FakeCollector:
    def __init__(self, results):
        self.results = results
        self.calls = []

    async def collect(self, host, *, port=22, timeout=60.0, **cred):
        self.calls.append((host, port, cred))
        r = self.results.get(host)
        return r() if callable(r) else r

    async def observe(self, host, *, port=22, timeout=10):
        return {"key_type": "ssh-ed25519", "public_key": KEY, "fingerprint": "SHA256:seen"}


@mock.patch.object(DeviceCredential, "resolve_secret", lambda self: {"password": SECRET})
class RunnerTests(Base):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site)
        self.b = self.host("b", "10.0.0.2", site=self.site, vm=True)
        self.p = self.profile()
        self.p.sites.add(self.site)

    def run_now(self, results, user=None, trigger="manual"):
        with mock.patch.object(runner, "enqueue"), self.captureOnCommitCallbacks(execute=True):
            run = runner.start(self.p, user=user or self.su, trigger=trigger)
        fake = FakeCollector(results)
        with self.assertLogs("discovery", level="DEBUG") as logs:
            runner.log.debug("start")
            runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe)
        run.refresh_from_db()
        return run, fake, "\n".join(logs.output)

    def test_ok_run_stores_and_keeps_no_secret(self):
        refused = inv.InventoryResult(inv.AUTH_FAILED, "The host refused the credential.")
        run, fake, logs = self.run_now({"10.0.0.1": result, "10.0.0.2": refused})
        self.assertEqual(run.status, "partial")
        self.assertEqual(run.counts["ok"], 1)
        self.assertEqual(run.counts["auth_failed"], 1)
        self.assertEqual(HostPackage.objects.filter(device=self.a).count(), 88)
        # An auth failure leaves no packages.
        self.assertFalse(HostPackage.objects.filter(virtual_machine=self.b).exists())
        # The collector got the secret; nothing kept it.
        self.assertEqual({c[2]["password"] for c in fake.calls}, {SECRET})
        blob = json.dumps({"counts": run.counts, "errors": run.errors}) + json.dumps(
            list(InventoryHostResult.objects.values("message", "address", "status")))
        self.assertNotIn(SECRET, blob)
        self.assertNotIn(SECRET, logs)
        res = {h.status for h in InventoryHostResult.objects.filter(run=run)}
        self.assertEqual(res, {"ok", "auth_failed"})
        self.assertEqual(InventoryHostResult.objects.get(run=run, device=self.a).transport,
                         "ssh_password")

    def test_refused_host_key_is_recorded_as_observed_only(self):
        r = inv.InventoryResult(inv.HOST_KEY_REFUSED, "The host key does not match.")
        run, _fake, _ = self.run_now({"10.0.0.1": r, "10.0.0.2": result})
        seen = SSHHostKey.objects.get(device=self.a, fingerprint_sha256="SHA256:seen")
        self.assertTrue(seen.observed)
        self.assertFalse(seen.uploaded)
        self.assertEqual(run.status, "partial")

    def test_a_host_without_an_accepted_key_is_never_contacted(self):
        SSHHostKey.objects.filter(device=self.a).delete()
        run, fake, _ = self.run_now({"10.0.0.2": result})
        self.assertEqual([c[0] for c in fake.calls], ["10.0.0.2"])
        self.assertEqual(InventoryHostResult.objects.get(run=run, device=self.a).status,
                         "host_key_refused")

    def test_the_job_rechecks_everything(self):
        cases = {
            "disabled": lambda: InventoryProfile.objects.filter(pk=self.p.pk).update(
                enabled=False),
            "unauthorised": lambda: InventoryProfile.objects.filter(pk=self.p.pk).update(
                authorised_at=None),
            "integration off": lambda: IntegrationSettings.objects.filter(
                tenant=self.tenant).update(discovery_enabled=False),
        }
        for name, change in cases.items():
            with self.subTest(name):
                with mock.patch.object(runner, "enqueue"):
                    run = runner.start(self.p, user=self.su)
                change()
                fake = FakeCollector({"10.0.0.1": result})
                runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe)
                run.refresh_from_db()
                self.assertEqual(run.status, "skipped")
                self.assertEqual(fake.calls, [])
                InventoryProfile.objects.filter(pk=self.p.pk).update(
                    enabled=True, authorised_at=timezone.now())
                IntegrationSettings.objects.filter(tenant=self.tenant).update(
                    discovery_enabled=True)

    def test_a_starter_who_lost_scan_stops_the_run(self):
        user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="op", object_types=["inventoryprofile"],
                                               actions=["view", "scan"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        with mock.patch.object(runner, "enqueue"):
            run = runner.start(self.p, user=user)
        perm.actions = ["view"]
        perm.save()
        fake = FakeCollector({"10.0.0.1": result})
        runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe)
        run.refresh_from_db()
        self.assertEqual(run.status, "skipped")
        self.assertEqual(fake.calls, [])

    def test_a_host_that_became_exempt_after_queueing_is_left_alone(self):
        with mock.patch.object(runner, "enqueue"):
            run = runner.start(self.p, user=self.su)
        Device.objects.filter(pk=self.a.pk).update(scan_exempt=True)
        fake = FakeCollector({"10.0.0.2": result})
        runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe)
        self.assertEqual([c[0] for c in fake.calls], ["10.0.0.2"])

    def test_one_open_run_per_profile_and_the_window(self):
        with mock.patch.object(runner, "enqueue"):
            runner.start(self.p, user=self.su)
            with self.assertRaises(runner.RunRefused):
                runner.start(self.p, user=self.su)
        InventoryRun.objects.all().delete()
        now = timezone.localtime().time()
        start = (timezone.localtime() + timedelta(hours=2)).time()
        end = (timezone.localtime() + timedelta(hours=3)).time()
        InventoryProfile.objects.filter(pk=self.p.pk).update(window_start=start, window_end=end)
        self.p.refresh_from_db()
        self.assertFalse(runner.in_window(self.p))
        with self.assertRaises(runner.RunRefused):
            runner.start(self.p, user=self.su)
        self.assertTrue(now)

    def test_windows_spanning_midnight(self):
        p = InventoryProfile(window_start=time(22, 0), window_end=time(2, 0))
        at = timezone.make_aware(timezone.datetime(2026, 11, 10, 23, 30))
        self.assertTrue(runner.in_window(p, at))
        at = timezone.make_aware(timezone.datetime(2026, 11, 10, 12, 0))
        self.assertFalse(runner.in_window(p, at))

    def test_dispatch_queues_due_profiles(self):
        with mock.patch.object(runner, "enqueue") as enq, \
                self.captureOnCommitCallbacks(execute=True):
            out = runner.dispatch()
        self.assertEqual(out["queued"], 1)
        enq.assert_called_once()
        with mock.patch.object(runner, "enqueue"):
            self.assertEqual(runner.dispatch()["queued"], 0)  # already open
        InventoryRun.objects.update(status="ok")
        InventoryProfile.objects.update(last_run_at=timezone.now())
        with mock.patch.object(runner, "enqueue"):
            self.assertEqual(runner.dispatch()["queued"], 0)  # not due
        with override_settings(DISCOVERY_ENABLED=False):
            InventoryProfile.objects.update(last_run_at=None)
            InventoryRun.objects.all().delete()
            with mock.patch.object(runner, "enqueue"):
                self.assertEqual(runner.dispatch()["queued"], 0)

    def test_changed_hosts_are_rematched(self):
        from vulnerabilities.models import VulnerabilitySettings

        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        with mock.patch("vulnerabilities.jobs.enqueue_objects") as enq:
            self.run_now({"10.0.0.1": result, "10.0.0.2": result})
        args = enq.call_args[0]
        self.assertEqual(args[0], self.tenant.pk)
        self.assertEqual(args[1]["device"], {self.a.pk})
        self.assertEqual(args[1]["virtual_machine"], {self.b.pk})


# ─── API ─────────────────────────────────────────────────────────────────────


@override_settings(DISCOVERY_ENABLED=True)
class ApiBase(APITestCase, Base):
    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).pk)
        s.save()

    def member(self, name, grants, sites=(), tenant=None):
        """``grants``: {slug: [actions]}, one permission each."""
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(tenant or self.tenant)
        for slug, actions in grants.items():
            perm = ObjectPermission.objects.create(name=f"{name}-{slug}", object_types=[slug],
                                                   actions=list(actions))
            perm.users.add(user)
            perm.tenants.add(tenant or self.tenant)
            if sites:
                perm.sites.set(sites)
        self.login(user, tenant)
        return user


class ApiGateTests(ApiBase):
    URLS = ["/api/discovery/settings/", "/api/discovery/profiles/", "/api/discovery/runs/"]

    def test_everything_404s_while_off(self):
        self.login(self.su)
        for url in self.URLS:
            self.assertEqual(self.client.get(url).status_code, 200, url)
        with override_settings(DISCOVERY_ENABLED=False):
            for url in self.URLS:
                self.assertEqual(self.client.get(url).status_code, 404, url)
            r = self.client.get("/api/discovery/status/")
            body = r.json()
            self.assertEqual({k: body[k] for k in ("deployment_enabled", "enabled", "active",
                                                   "can_manage", "first_use_keys_allowed")},
                             {"deployment_enabled": False, "enabled": True,
                              "active": False, "can_manage": True,
                              "first_use_keys_allowed": True})
            self.assertEqual(body["deployment"]["source"], "env")

    def test_status_needs_a_login(self):
        self.assertIn(self.client.get("/api/discovery/status/").status_code, (401, 403))


class ProfileApiTests(ApiBase):
    URL = "/api/discovery/profiles/"

    def test_authorisation_is_stamped_and_scope_changes_clear_it(self):
        self.login(self.su)
        r = self.client.post(self.URL, {"name": "Linux", "site_ids": [str(self.site.pk)],
                                        "enabled": True, "authorisation": "CAB-17"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["authorised_by_name"], "root")
        self.assertTrue(body["authorised"])
        pid = body["id"]
        r = self.client.patch(f"{self.URL}{pid}/", {"interval_hours": 12}, format="json")
        self.assertTrue(r.json()["authorised"])
        r = self.client.patch(f"{self.URL}{pid}/", {"site_ids": [str(self.branch.pk)]},
                              format="json")
        self.assertFalse(r.json()["authorised"])
        self.assertIsNone(r.json()["authorised_at"])
        self.assertIn("authorised", r.json()["blocked_reason"])

    def test_validation(self):
        self.login(self.su)
        for body in ({"name": "x", "max_concurrency": 99}, {"name": "x", "timeout_seconds": 1},
                     {"name": ""}):
            self.assertEqual(self.client.post(self.URL, body, format="json").status_code, 400)

    def test_tenant_isolation(self):
        mine = self.profile(name="mine")
        theirs = self.profile(tenant=self.other, name="theirs")
        self.login(self.su, self.other)
        ids = [p["id"] for p in self.client.get(self.URL).json()["results"]]
        self.assertEqual(ids, [str(theirs.pk)])
        for url in (f"{self.URL}{mine.pk}/", f"{self.URL}{mine.pk}/hosts/"):
            self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.post(f"{self.URL}{mine.pk}/run/").status_code, 404)
        r = self.client.post(self.URL, {"name": "x", "site_ids": [str(self.site.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"{self.URL}{theirs.pk}/",
                              {"device_ids": [str(self.host("a", "10.0.0.1").pk)]},
                              format="json")
        self.assertEqual(r.status_code, 400)

    def test_run_needs_scan_and_credential_view(self):
        p = self.profile()
        url = f"{self.URL}{p.pk}/run/"
        self.member("viewer", {"inventoryprofile": ["view", "add", "change", "delete"],
                               "devicecredential": ["view"]})
        self.assertEqual(self.client.post(url).status_code, 403)
        self.member("scanner", {"inventoryprofile": ["view", "scan"]})
        self.assertEqual(self.client.post(url).status_code, 403)
        self.member("both", {"inventoryprofile": ["view", "scan"],
                             "devicecredential": ["view"]})
        with mock.patch.object(runner, "enqueue"), self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(url)
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()["status"], "queued")
        self.assertEqual(self.client.post(url).status_code, 409)

    def test_no_builtin_role_scans(self):
        from auth_api.builtin_groups import BUILTINS

        for _name, _desc, actions, _types in BUILTINS:
            self.assertNotIn("scan", actions)

    def test_a_site_role_scopes_only_its_sites(self):
        self.member("site", {"inventoryprofile": ["view", "add", "change"],
                             "site": ["view"]}, sites=[self.site])
        r = self.client.post(self.URL, {"name": "x", "site_ids": [str(self.branch.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.post(self.URL, {"name": "x", "site_ids": [str(self.site.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_hosts_preview_follows_host_view(self):
        self.host("a", "10.0.0.1", site=self.site)
        self.host("b", "10.0.0.2", site=self.branch)
        p = self.profile()
        p.sites.add(self.site, self.branch)
        self.member("site", {"inventoryprofile": ["view"], "device": ["view"],
                             "devicecredential": ["view"]}, sites=[self.site])
        r = self.client.get(f"{self.URL}{p.pk}/hosts/")
        self.assertEqual([h["name"] for h in r.json()["results"]], ["a"])
        self.assertEqual(r.json()["results"][0]["status"], "ready")
        self.assertEqual(r.json()["results"][0]["credential"]["name"], "login")


class RunApiTests(ApiBase):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site)
        self.b = self.host("b", "10.0.0.2", site=self.branch)
        self.p = self.profile()
        self.run = InventoryRun.objects.create(tenant=self.tenant, profile=self.p,
                                               status="ok", counts={"hosts": 2})
        for h in (self.a, self.b):
            InventoryHostResult.objects.create(tenant=self.tenant, run=self.run, device=h,
                                               address=str(h.primary_ip.ip_address),
                                               status="ok", transport="ssh", packages=3)

    def test_runs_and_host_results_follow_scope(self):
        self.member("site", {"inventoryprofile": ["view"], "device": ["view"]},
                    sites=[self.site])
        r = self.client.get(f"/api/discovery/runs/?profile={self.p.pk}")
        self.assertEqual([x["id"] for x in r.json()["results"]], [str(self.run.pk)])
        r = self.client.get(f"/api/discovery/runs/{self.run.pk}/hosts/")
        self.assertEqual([x["device"]["name"] for x in r.json()["results"]], ["a"])

    def test_runs_need_profile_view(self):
        self.member("nobody", {"device": ["view"]})
        self.assertEqual(self.client.get("/api/discovery/runs/").status_code, 403)

    def test_tenant_isolation(self):
        self.login(self.su, self.other)
        self.assertEqual(self.client.get("/api/discovery/runs/").json()["results"], [])
        self.assertEqual(self.client.get(f"/api/discovery/runs/{self.run.pk}/").status_code,
                         404)
        self.assertEqual(
            self.client.get(f"/api/discovery/runs/{self.run.pk}/hosts/").status_code, 404)


class PackagesApiTests(ApiBase):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site)
        packages.store(self.tenant, self.a, None, result())

    def test_list_and_os(self):
        self.login(self.su)
        r = self.client.get(f"/api/devices/{self.a.pk}/packages/?search=bash")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([p["name"] for p in r.json()["results"]], ["bash"])
        self.assertEqual(r.json()["os"]["ecosystem"], "Debian:12")

    def test_needs_installed_software_view(self):
        url = f"/api/devices/{self.a.pk}/packages/"
        self.member("dev", {"device": ["view"]})
        self.assertEqual(self.client.get(url).status_code, 403)
        self.member("both", {"device": ["view"], "installedsoftware": ["view"]})
        self.assertEqual(self.client.get(url).status_code, 200)
        self.member("other-site", {"device": ["view"], "installedsoftware": ["view"]},
                    sites=[self.branch])
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_tenant_isolation(self):
        self.login(self.su, self.other)
        self.assertEqual(self.client.get(f"/api/devices/{self.a.pk}/packages/").status_code,
                         404)


class ExemptAndSettingsApiTests(ApiBase):
    def test_exempt_needs_change_and_stays_in_tenant(self):
        a = self.host("a", "10.0.0.1", site=self.site)
        body = {"kind": "device", "id": str(a.pk), "exempt": True}
        self.member("viewer", {"device": ["view"]})
        self.assertEqual(self.client.post("/api/discovery/exempt/", body,
                                          format="json").status_code, 403)
        self.member("editor", {"device": ["view", "change"]})
        r = self.client.post("/api/discovery/exempt/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        self.assertTrue(a.scan_exempt)
        self.login(self.su, self.other)
        self.assertEqual(self.client.post("/api/discovery/exempt/", body,
                                          format="json").status_code, 404)
        for kind, obj in (("prefix", self.prefix), ("ipaddress", a.primary_ip)):
            self.login(self.su)
            r = self.client.post("/api/discovery/exempt/",
                                 {"kind": kind, "id": str(obj.pk), "exempt": True},
                                 format="json")
            self.assertEqual(r.status_code, 200, r.content)

    def test_exempt_is_change_logged(self):
        from audit.models import ChangeLogEntry

        a = self.host("a", "10.0.0.1", site=self.site)
        self.login(self.su)
        self.client.post("/api/discovery/exempt/",
                         {"kind": "device", "id": str(a.pk), "exempt": True}, format="json")
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=str(a.pk),
                                                      changes__has_key="scan_exempt").exists())

    def test_the_flag_reads_on_every_object_and_a_patch_cannot_set_it(self):
        a = self.host("a", "10.0.0.1", site=self.site)
        vm = self.host("v", "10.0.0.2", vm=True)
        self.login(self.su)
        for url in (f"/api/devices/{a.pk}/", f"/api/virtual-machines/{vm.pk}/",
                    f"/api/ips/{a.primary_ip.pk}/", f"/api/prefixes/{self.prefix.pk}/"):
            self.assertIs(self.client.get(url).json()["scan_exempt"], False, url)
            r = self.client.patch(url, {"scan_exempt": True}, format="json")
            self.assertIn(r.status_code, (200, 400), url)
            self.assertIs(self.client.get(url).json()["scan_exempt"], False, url)
        rows = self.client.get("/api/devices/").json()["results"]
        self.assertTrue(all("scan_exempt" in r for r in rows))

    def test_an_address_names_the_prefix_it_is_exempt_through(self):
        from api.models import Prefix

        a = self.host("a", "10.0.0.1", site=self.site)
        url = f"/api/ips/{a.primary_ip.pk}/"
        self.login(self.su)
        self.assertIsNone(self.client.get(url).json()["scan_exempt_via"])
        # Another tenant's exempt prefix around the same address counts for nothing.
        Prefix.objects.create(tenant=self.other, cidr="10.0.0.0/8", scan_exempt=True)
        self.assertIsNone(self.client.get(url).json()["scan_exempt_via"])
        wide = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16", scan_exempt=True)
        self.assertEqual(self.client.get(url).json()["scan_exempt_via"],
                         {"id": str(wide.pk), "cidr": "10.0.0.0/16"})
        Prefix.objects.filter(pk=self.prefix.pk).update(scan_exempt=True)
        self.assertEqual(self.client.get(url).json()["scan_exempt_via"]["cidr"],
                         "10.0.0.0/24")
        # A reader without prefix view learns it is exempt, not which prefix.
        self.member("ip-only", {"ipaddress": ["view"]})
        self.assertEqual(self.client.get(url).json()["scan_exempt_via"],
                         {"id": None, "cidr": None})
        # Lists never pay for it.
        self.login(self.su)
        rows = self.client.get("/api/ips/").json()["results"]
        self.assertTrue(all(r["scan_exempt_via"] is None for r in rows))

    def test_deny_subnets(self):
        self.login(self.su)
        r = self.client.patch("/api/discovery/settings/",
                              {"deny_subnets": ["10.0.0.7", "10.1.0.0/16", "10.1.0.0/16"]},
                              format="json")
        self.assertEqual(r.json()["deny_subnets"], ["10.0.0.7/32", "10.1.0.0/16"])
        bad = self.client.patch("/api/discovery/settings/", {"deny_subnets": ["nope"]},
                                format="json")
        self.assertEqual(bad.status_code, 400)
        self.member("viewer", {"inventoryprofile": ["view"]})
        self.assertEqual(self.client.get("/api/discovery/settings/").status_code, 200)
        self.assertEqual(self.client.patch("/api/discovery/settings/", {"deny_subnets": []},
                                           format="json").status_code, 403)
        self.login(self.su, self.other)
        self.assertEqual(self.client.get("/api/discovery/settings/").json()["deny_subnets"],
                         [])


class CredentialsForVmsTests(ApiBase):
    def test_a_vm_credential_and_host_key(self):
        v = self.host("v", "10.0.0.9", vm=True, cred=None, key=False)
        self.login(self.su)
        r = self.client.post("/api/monitoring/device-credentials/", {
            "virtual_machine": str(v.pk), "name": "inv", "kind": "ssh_password",
            "secret_managed": False, "secret_provider": "local", "secret_path": "x/v"},
            format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["virtual_machine_name"], "v")
        r = self.client.get(f"/api/monitoring/device-credentials/?virtual_machine={v.pk}")
        self.assertEqual(len(r.json()["results"]), 1)
        both = self.client.post("/api/monitoring/device-credentials/", {
            "virtual_machine": str(v.pk), "device": str(self.host("d", "10.0.0.8").pk),
            "name": "x", "kind": "ssh_password", "secret_managed": False,
            "secret_provider": "local", "secret_path": "x/y"}, format="json")
        self.assertEqual(both.status_code, 400)
        r = self.client.post("/api/monitoring/ssh-host-keys/", {
            "virtual_machine": str(v.pk), "public_key_line": f"ssh-ed25519 {KEY} v"},
            format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(SSHHostKey.objects.get(virtual_machine=v).uploaded)

    def test_a_foreign_vm_is_refused(self):
        ct = ClusterType.objects.create(tenant=self.other, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=self.other, name="c", type=ct)
        theirs = VirtualMachine.objects.create(tenant=self.other, name="t", cluster=cl)
        self.login(self.su)
        r = self.client.post("/api/monitoring/ssh-host-keys/", {
            "virtual_machine": str(theirs.pk), "public_key_line": f"ssh-ed25519 {KEY} v"},
            format="json")
        self.assertEqual(r.status_code, 400)
