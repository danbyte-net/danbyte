"""Shared credentials (#451): scope matching, order, the API's secret and
site rules, tenant isolation, audit and key rotation."""
from __future__ import annotations

import json
from unittest import mock

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    Manufacturer,
    Platform,
    Site,
    VirtualMachine,
)
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

from .credentials import CredentialResolver, attempts, matching_hosts
from .models import DeviceCredential, SharedCredential

SECRET = "shared-SECRET-77a1"


class Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        cls.hq = Site.objects.create(tenant=cls.tenant, name="HQ")
        cls.branch = Site.objects.create(tenant=cls.tenant, name="Branch")
        cls.linux = DeviceRole.objects.create(tenant=cls.tenant, name="Linux", slug="linux",
                                              color="#00aa00")
        cls.switch = DeviceRole.objects.create(tenant=cls.tenant, name="Switch",
                                               slug="switch")
        mfr = Manufacturer.objects.create(tenant=cls.tenant, name="M", slug="m")
        cls.dtype = DeviceType.objects.create(tenant=cls.tenant, manufacturer=mfr,
                                              name="R1", model="R1")
        cls.debian = Platform.objects.create(tenant=cls.tenant, name="Debian", slug="debian")
        cls.tag = Tag.objects.create(tenant=cls.tenant, name="ops", slug="ops")
        ct = ClusterType.objects.create(tenant=cls.tenant, name="CT", slug="ct")
        cls.cluster = Cluster.objects.create(tenant=cls.tenant, name="pve", type=ct)
        cls.a = Device.objects.create(tenant=cls.tenant, name="a", site=cls.hq, role=cls.linux,
                                      device_type=cls.dtype, platform=cls.debian)
        cls.b = Device.objects.create(tenant=cls.tenant, name="b", site=cls.branch,
                                      role=cls.switch)
        cls.v = VirtualMachine.objects.create(tenant=cls.tenant, name="v", site=cls.hq,
                                              role=cls.linux, cluster=cls.cluster)
        cls.su = User.objects.create_superuser("root", "r@example.com", "x")

    def shared(self, name, *, tenant=None, **kw):
        m2m = {k: kw.pop(k) for k in ("roles", "device_types", "platforms", "sites", "tags")
               if k in kw}
        kw.setdefault("kind", "ssh_password")
        kw.setdefault("username", "ops")
        kw.setdefault("secret_managed", False)
        kw.setdefault("secret_path", f"ext/{name}")
        row = SharedCredential.objects.create(tenant=tenant or self.tenant, name=name, **kw)
        for k, v in m2m.items():
            getattr(row, k).set(v)
        return row

    def names(self, host, **kw):
        r = CredentialResolver(self.tenant, kinds=("ssh_key", "ssh_password"), **kw)
        kind = "virtual_machine" if isinstance(host, VirtualMachine) else "device"
        r.load_hosts([(kind, host)])
        return [login.source for login in r.logins(host)]


class MatchingTests(Base):
    def test_each_dimension(self):
        self.shared("role", roles=[self.linux])
        self.shared("type", device_types=[self.dtype])
        self.shared("platform", platforms=[self.debian])
        self.shared("site", sites=[self.branch])
        self.shared("tag", tags=[self.tag])
        self.assertEqual(set(self.names(self.a)),
                         {"shared: role", "shared: type", "shared: platform"})
        self.assertEqual(self.names(self.b), ["shared: site"])
        self.b.tags.add(self.tag)
        self.assertEqual(set(self.names(self.b)), {"shared: site", "shared: tag"})
        # A VM has no device type; a role scope matches it.
        self.assertEqual(self.names(self.v), ["shared: role"])

    def test_dimensions_and_together(self):
        self.shared("both", roles=[self.linux], sites=[self.branch])
        self.assertEqual(self.names(self.a), [])

    def test_no_implicit_match_all(self):
        self.shared("empty")
        self.assertEqual(self.names(self.a), [])
        self.shared("everything", all_hosts=True)
        self.assertEqual(self.names(self.a), ["shared: everything"])
        SharedCredential.objects.filter(name="everything").update(applies_to_devices=False)
        self.assertEqual(self.names(self.a), [])
        self.assertEqual(self.names(self.v), ["shared: everything"])

    def test_disabled_and_other_tenants_never_match(self):
        self.shared("off", all_hosts=True, enabled=False)
        self.shared("theirs", tenant=self.other, all_hosts=True)
        self.assertEqual(self.names(self.a), [])

    def test_order_weight_then_specificity_then_name(self):
        self.shared("z-broad", all_hosts=True, weight=10)
        self.shared("b-role", roles=[self.linux], weight=10)
        self.shared("a-role-site", roles=[self.linux], sites=[self.hq], weight=10)
        self.shared("first", all_hosts=True, weight=1)
        self.assertEqual(self.names(self.a), ["shared: first", "shared: a-role-site",
                                              "shared: b-role", "shared: z-broad"])

    def test_host_then_pinned_then_matching(self):
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="own",
                                        kind="ssh_key", secret_path="x", secret_managed=False)
        pinned = self.shared("pinned", weight=500)
        self.shared("match", roles=[self.linux])
        self.assertEqual(self.names(self.a, pinned=pinned),
                         ["host", "shared: pinned", "shared: match"])
        # Another tenant's credential can never be pinned.
        theirs = self.shared("theirs", tenant=self.other, all_hosts=True)
        self.assertEqual(self.names(self.a, pinned=theirs), ["host", "shared: match"])

    def test_only_the_first_is_tried_unless_it_falls_through(self):
        self.shared("one", all_hosts=True, weight=1)
        self.shared("two", all_hosts=True, weight=2)
        self.shared("three", all_hosts=True, weight=3)
        self.shared("four", all_hosts=True, weight=4, fall_through=True)
        r = CredentialResolver(self.tenant, kinds=("ssh_password",))
        r.load_hosts([("device", self.a)])
        logins = r.logins(self.a)
        self.assertEqual([x.source for x in attempts(logins)], ["shared: one"])
        SharedCredential.objects.filter(name__in=["one", "two", "three"]).update(
            fall_through=True)
        r = CredentialResolver(self.tenant, kinds=("ssh_password",))
        r.load_hosts([("device", self.a)])
        self.assertEqual(len(attempts(r.logins(self.a))), 3)

    def test_kinds_filter(self):
        self.shared("https", kind="https_login", all_hosts=True)
        self.assertEqual(self.names(self.a), [])

    def test_matching_hosts_preview(self):
        s = self.shared("role", roles=[self.linux])
        devices, vms = matching_hosts(s)
        self.assertEqual(list(devices), [self.a])
        self.assertEqual(list(vms), [self.v])
        devices, vms = matching_hosts(self.shared("empty"))
        self.assertEqual((devices.count(), vms.count()), (0, 0))

    def test_a_viewer_uses_only_what_they_may_view(self):
        self.shared("hidden", all_hosts=True)
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        self.assertEqual(self.names(self.a, user=user), [])


class ApiTests(APITestCase, Base):
    URL = "/api/monitoring/shared-credentials/"

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).pk)
        s.save()

    def member(self, name, actions, sites=()):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name=name, object_types=["sharedcredential"],
                                               actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        self.login(user)
        return user

    def test_secret_is_write_only_and_redacted(self):
        self.login(self.su)
        store = mock.MagicMock()
        with mock.patch("monitoring.secret_store.require_secret_store", return_value=store):
            r = self.client.post(self.URL, {
                "name": "ops", "kind": "ssh_password", "username": "ops",
                "password": SECRET, "role_ids": [str(self.linux.pk)]}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn(SECRET, r.content.decode())
        self.assertTrue(r.json()["secret_set"])
        row = SharedCredential.objects.get(name="ops")
        self.assertEqual(row.secret_path, f"shared-credentials/{row.pk}")
        self.assertEqual(store.put.call_args[0][2], {"password": SECRET})
        self.assertNotIn(SECRET, self.client.get(f"{self.URL}{row.pk}/").content.decode())
        entries = ChangeLogEntry.objects.filter(object_type="monitoring.sharedcredential")
        self.assertTrue(entries.exists())
        self.assertNotIn(SECRET, json.dumps(list(entries.values_list("changes", flat=True))))
        self.assertEqual(r.json()["scope"]["roles"][0]["color"], "#00aa00")

    def test_tenant_isolation(self):
        theirs = self.shared("theirs", tenant=self.other, all_hosts=True)
        self.login(self.su)
        self.assertEqual(self.client.get(f"{self.URL}{theirs.pk}/").status_code, 404)
        self.assertEqual(self.client.get(self.URL).json()["count"], 0)
        other_site = Site.objects.create(tenant=self.other, name="X")
        r = self.client.post(self.URL, {"name": "x", "kind": "ssh_password", "username": "u",
                                        "secret_managed": False, "secret_path": "ext/x",
                                        "site_ids": [str(other_site.pk)]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("site_ids", r.json())

    def test_default_closed(self):
        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        self.login(user)
        self.shared("s", all_hosts=True)
        self.assertEqual(self.client.get(self.URL).json().get("count", 0), 0)
        r = self.client.post(self.URL, {"name": "x", "kind": "ssh_password"}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_site_limited_user_only_within_their_sites(self):
        self.member("site", ["view", "add", "change"], sites=[self.hq])
        base = {"kind": "ssh_password", "username": "ops", "password": SECRET}
        patcher = mock.patch("monitoring.secret_store.require_secret_store",
                             return_value=mock.MagicMock())
        patcher.start()
        self.addCleanup(patcher.stop)
        for body in ({"name": "all", "all_hosts": True},
                     {"name": "none"},
                     {"name": "other", "site_ids": [str(self.branch.pk)]}):
            r = self.client.post(self.URL, {**base, **body}, format="json")
            self.assertEqual(r.status_code, 400, (body, r.content))
        r = self.client.post(self.URL, {**base, "name": "mine",
                                        "site_ids": [str(self.hq.pk)]}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        broad = self.shared("broad", all_hosts=True)
        names = [x["name"] for x in self.client.get(self.URL).json()["results"]]
        self.assertEqual(names, ["mine"])
        self.assertEqual(self.client.patch(f"{self.URL}{broad.pk}/", {"weight": 1},
                                           format="json").status_code, 404)

    def test_an_ssh_login_needs_a_user_name(self):
        self.login(self.su)
        body = {"name": "n", "kind": "ssh_password", "secret_managed": False,
                "secret_path": "ext/n", "all_hosts": True}
        for user in ("", "  "):
            r = self.client.post(self.URL, {**body, "username": user}, format="json")
            self.assertEqual(r.status_code, 400)
            self.assertIn("username", r.json())
        # A WinRM certificate names no user: the certificate maps to one.
        r = self.client.post(self.URL, {**body, "kind": "winrm_cert"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        # An older row without one still loads and takes other changes.
        old = self.shared("old", all_hosts=True, username="")
        self.assertEqual(self.client.get(f"{self.URL}{old.pk}/").status_code, 200)
        r = self.client.patch(f"{self.URL}{old.pk}/", {"weight": 5}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"{self.URL}{old.pk}/", {"username": ""}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_reveal_needs_its_verb(self):
        s = self.shared("s", all_hosts=True)
        self.member("viewer", ["view", "change"])
        self.assertEqual(self.client.post(f"{self.URL}{s.pk}/reveal/").status_code, 403)
        self.member("revealer", ["view", "reveal"])
        with mock.patch.object(SharedCredential, "resolve_secret",
                               lambda self: {"password": SECRET}):
            r = self.client.post(f"{self.URL}{s.pk}/reveal/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="monitoring.sharedcredential", action="reveal").exists())

    def test_preview_and_matches(self):
        self.login(self.su)
        r = self.client.post(f"{self.URL}preview/", {"role_ids": [str(self.linux.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["count"], 2)
        self.assertEqual(self.client.post(f"{self.URL}preview/", {},
                                          format="json").json()["count"], 0)
        s = self.shared("s", sites=[self.branch])
        self.assertEqual(self.client.get(f"{self.URL}{s.pk}/matches/").json()["count"], 1)


class RotationTests(TestCase):
    def test_rotation_has_nothing_extra_to_walk(self):
        """A shared credential holds only a reference; its value lives in
        the StoredSecret table, which the rotation already walks."""
        from monitoring.management.commands.rotate_monitoring_key import encrypted_columns

        labels = {m._meta.label for m, _f in encrypted_columns()}
        self.assertIn("monitoring.StoredSecret", labels)
        self.assertNotIn("monitoring.SharedCredential", labels)
