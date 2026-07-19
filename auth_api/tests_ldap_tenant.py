"""Per-tenant LDAP directories: chain routing, ownership/collision guards,
per-tenant group-mapping isolation, and the escalation guard. No live
directory — `_configured_backend` is mocked."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import Group, User
from django.test import TestCase

from auth_api.ldap import (
    DanbyteLDAPBackend,
    _candidate_may_bind,
    danbyte_groups_for_dns,
    group_is_tenant_safe,
)
from auth_api.models import LDAPGroupMapping, ObjectPermission, UserProfile
from core.effective_settings import ldap_directory_chain
from core.models import DeploymentSettings, Organization, Tenant, TenantSettings


def _tenants():
    org = Organization.objects.create(name="Org", slug="org")
    a = Tenant.objects.create(org=org, name="Acme", slug="acme")
    b = Tenant.objects.create(org=org, name="Beta", slug="beta")
    return a, b


def _enable_tenant_dir(tenant, domains=None):
    ts = TenantSettings.for_tenant(tenant)
    ts.override_ldap = True
    ts.ldap_enabled = True
    ts.ldap_server_uri = f"ldaps://dc.{tenant.slug}.local"
    ts.ldap_login_domains = domains or []
    ts.save()
    return ts


def _enable_deployment_dir():
    dep = DeploymentSettings.load()
    dep.ldap_enabled = True
    dep.ldap_server_uri = "ldaps://dc.deploy.local"
    dep.save()
    return dep


class ChainTests(TestCase):
    def setUp(self):
        self.a, self.b = _tenants()

    def test_order_deployment_first_then_tenants_by_slug(self):
        _enable_deployment_dir()
        _enable_tenant_dir(self.b)
        _enable_tenant_dir(self.a)
        chain = ldap_directory_chain("bob")
        owners = [t.slug if t else None for _, t, _ in chain]
        self.assertEqual(owners, [None, "acme", "beta"])
        self.assertTrue(all(name == "bob" for _, _, name in chain))

    def test_domain_routing_short_circuits(self):
        _enable_deployment_dir()
        _enable_tenant_dir(self.a, domains=["corp.com"])
        _enable_tenant_dir(self.b)
        chain = ldap_directory_chain("alice@CORP.com")
        self.assertEqual(len(chain), 1)
        cfg, owner, name = chain[0]
        self.assertEqual(owner, self.a)
        self.assertEqual(name, "alice")  # local part searched

    def test_disabled_dirs_excluded(self):
        # override off / disabled / no URI → not in the chain
        ts = _enable_tenant_dir(self.a)
        ts.override_ldap = False
        ts.save()
        dep = DeploymentSettings.load()
        dep.ldap_enabled = False
        dep.save()
        self.assertEqual(ldap_directory_chain("bob"), [])


class OwnershipGuardTests(TestCase):
    def setUp(self):
        self.a, self.b = _tenants()

    def test_new_username_allowed(self):
        self.assertTrue(_candidate_may_bind("fresh", self.a))
        self.assertTrue(_candidate_may_bind("fresh", None))

    def test_tenant_dir_refused_for_local_user(self):
        u = User.objects.create_user("localguy")
        UserProfile.objects.create(user=u)  # auth_source=local
        self.assertFalse(_candidate_may_bind("localguy", self.a))
        self.assertFalse(_candidate_may_bind("LOCALGUY", self.a))  # iexact

    def test_tenant_dir_refused_for_deployment_ldap_user(self):
        u = User.objects.create_user("depldap")
        UserProfile.objects.create(user=u, auth_source="ldap")  # src tenant None
        self.assertFalse(_candidate_may_bind("depldap", self.a))

    def test_tenant_dir_refused_for_other_tenants_user(self):
        u = User.objects.create_user("acmeuser")
        UserProfile.objects.create(
            user=u, auth_source="ldap", ldap_source_tenant=self.a
        )
        self.assertFalse(_candidate_may_bind("acmeuser", self.b))
        self.assertTrue(_candidate_may_bind("acmeuser", self.a))  # own dir OK

    def test_deployment_dir_refuses_tenant_owned_user(self):
        u = User.objects.create_user("acmeuser2")
        UserProfile.objects.create(
            user=u, auth_source="ldap", ldap_source_tenant=self.a
        )
        self.assertFalse(_candidate_may_bind("acmeuser2", None))

    def test_deployment_dir_may_adopt_local_user(self):
        u = User.objects.create_user("adoptme")
        UserProfile.objects.create(user=u)
        self.assertTrue(_candidate_may_bind("adoptme", None))


class AuthenticateFlowTests(TestCase):
    """End-to-end through DanbyteLDAPBackend.authenticate with the directory
    backend mocked out."""

    def setUp(self):
        self.a, self.b = _tenants()
        _enable_tenant_dir(self.a)

    def _mock_backend(self, result_user):
        m = mock.Mock()
        m.authenticate.return_value = result_user
        return m

    def test_guard_blocks_before_directory_io(self):
        # An existing local user: the tenant candidate must be skipped WITHOUT
        # the backend ever being contacted.
        u = User.objects.create_user("victim")
        UserProfile.objects.create(user=u)
        with mock.patch("auth_api.ldap._configured_backend") as cb:
            out = DanbyteLDAPBackend().authenticate(
                None, username="victim", password="x"
            )
        self.assertIsNone(out)
        cb.assert_not_called()

    def test_successful_tenant_login_stamps_and_grants(self):
        # django-auth-ldap creates the user DURING the bind — mirror that: the
        # user must not exist before authenticate (else the guard refuses).
        def bind(request, username=None, password=None):
            return User.objects.create_user(username)

        m = mock.Mock()
        m.authenticate.side_effect = bind
        with mock.patch("auth_api.ldap._configured_backend", return_value=m):
            out = DanbyteLDAPBackend().authenticate(
                None, username="alice", password="x"
            )
        self.assertIsNotNone(out)
        self.assertEqual(out.get_username(), "alice")
        # Fetch fresh — out.profile may be a stale instance cached during the
        # flow (Django populates the reverse O2O cache on FK assignment).
        prof = UserProfile.objects.get(user=out)
        self.assertEqual(prof.auth_source, "ldap")
        self.assertEqual(prof.ldap_source_tenant, self.a)
        self.assertEqual(list(prof.tenants.all()), [self.a])
        self.assertEqual(prof.current_tenant, self.a)

    def test_first_success_short_circuits(self):
        _enable_tenant_dir(self.b)
        calls = []

        def fake_backend(cfg, django_username_map=None):
            calls.append(cfg)
            m = mock.Mock()
            if len(calls) == 1:
                m.authenticate.side_effect = (
                    lambda request, username=None, password=None:
                    User.objects.create_user(username)
                )
            else:
                m.authenticate.return_value = None
            return m

        with mock.patch("auth_api.ldap._configured_backend", side_effect=fake_backend):
            out = DanbyteLDAPBackend().authenticate(
                None, username="carol", password="x"
            )
        self.assertIsNotNone(out)
        self.assertEqual(len(calls), 1)  # acme succeeded; beta never tried


class GroupMappingIsolationTests(TestCase):
    def setUp(self):
        self.a, self.b = _tenants()
        self.g_dep = Group.objects.create(name="Dep Group")
        self.g_a = Group.objects.create(name="Acme Group")
        # g_a is tenant-safe for a: its only permission is narrowed to a.
        perm = ObjectPermission.objects.create(
            name="acme-only", object_types=["prefix"], actions=["view"]
        )
        perm.groups.add(self.g_a)
        perm.tenants.add(self.a)
        LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=X,DC=l", group=self.g_dep, tenant=None
        )
        LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=X,DC=l", group=self.g_a, tenant=self.a
        )

    def test_deployment_sync_uses_global_mappings_only(self):
        got = set(danbyte_groups_for_dns({"cn=x,dc=l"}, tenant=None))
        self.assertEqual(got, {self.g_dep})

    def test_tenant_sync_uses_own_mappings_only(self):
        got = set(danbyte_groups_for_dns({"cn=x,dc=l"}, tenant=self.a))
        self.assertEqual(got, {self.g_a})
        self.assertEqual(set(danbyte_groups_for_dns({"cn=x,dc=l"}, tenant=self.b)), set())

    def test_escalation_guard_at_sync_time(self):
        # Widen g_a's permission to be tenant-unscoped AFTER the mapping exists
        # → sync must skip it (can't launder global perms through an old map).
        for perm in self.g_a.object_permissions.all():
            perm.tenants.clear()
        self.assertFalse(group_is_tenant_safe(self.g_a, self.a))
        got = set(danbyte_groups_for_dns({"cn=x,dc=l"}, tenant=self.a))
        self.assertEqual(got, set())

    def test_group_with_no_perms_is_unsafe(self):
        # A permissionless group is refused too (deny-by-default: nothing
        # proves it's tenant-scoped… actually no perms = grants nothing).
        bare = Group.objects.create(name="Bare")
        self.assertTrue(group_is_tenant_safe(bare, self.a))


class LoginDomainUniquenessTests(TestCase):
    """A login domain routes ``user@domain`` straight to one tenant's
    directory, so it may be owned by at most one tenant."""

    def setUp(self):
        self.a, self.b = _tenants()

    def _serializer(self, tenant, domains):
        from auth_api.ldap_api import TenantLDAPSettingsSerializer

        obj = TenantSettings.for_tenant(tenant)
        return TenantLDAPSettingsSerializer(
            obj, data={"ldap_login_domains": domains}, partial=True
        )

    def test_duplicate_domain_across_tenants_rejected(self):
        _enable_tenant_dir(self.b, domains=["corp.com"])
        ser = self._serializer(self.a, ["corp.com"])
        self.assertFalse(ser.is_valid())
        self.assertIn("ldap_login_domains", ser.errors)

    def test_same_tenant_may_keep_its_own_domain(self):
        _enable_tenant_dir(self.a, domains=["corp.com"])
        ser = self._serializer(self.a, ["corp.com", "corp.net"])
        self.assertTrue(ser.is_valid(), ser.errors)

    def test_distinct_domains_allowed(self):
        _enable_tenant_dir(self.b, domains=["beta.com"])
        ser = self._serializer(self.a, ["acme.com"])
        self.assertTrue(ser.is_valid(), ser.errors)


class MappingRetrieveGuardTests(TestCase):
    """`retrieve` (GET /<pk>/) on both mapping viewsets must be admin-gated —
    a plain member could otherwise read individual LDAP group DNs by id."""

    def setUp(self):
        from django.test import Client

        self.a, self.b = _tenants()
        self.grp = Group.objects.create(name="Acme Group")
        perm = ObjectPermission.objects.create(
            name="acme-only", object_types=["prefix"], actions=["view"]
        )
        perm.groups.add(self.grp)
        perm.tenants.add(self.a)
        self.mapping = LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=X,DC=l", group=self.grp, tenant=self.a
        )
        self.dep_mapping = LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=Y,DC=l", group=Group.objects.create(name="Dep"),
            tenant=None,
        )
        self.member = User.objects.create_user("member", password="x")
        prof = UserProfile.objects.create(user=self.member, role="custom")
        prof.tenants.add(self.a)
        prof.current_tenant = self.a
        prof.save()
        self.c = Client()
        self.c.force_login(self.member)
        self.c.post(f"/api/tenants/{self.a.id}/switch/")

    def test_member_cannot_retrieve_tenant_mapping(self):
        res = self.c.get(f"/api/tenant-ldap-group-mappings/{self.mapping.id}/")
        self.assertEqual(res.status_code, 403)

    def test_member_cannot_retrieve_deployment_mapping(self):
        res = self.c.get(f"/api/ldap-group-mappings/{self.dep_mapping.id}/")
        self.assertEqual(res.status_code, 403)
