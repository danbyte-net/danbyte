"""LDAP group-mapping + sync tests (no live directory needed) and a guard that
local auth is unaffected when LDAP is disabled."""
from __future__ import annotations

from django.contrib.auth import authenticate
from django.contrib.auth.models import Group, User
from django.test import TestCase

from auth_api.ldap import (
    DanbyteLDAPBackend,
    danbyte_groups_for_dns,
    sync_user_groups,
)
from auth_api.models import LDAPGroupMapping
from core.models import DeploymentSettings


class LDAPGroupMappingTests(TestCase):
    def setUp(self):
        self.admins = Group.objects.create(name="LDAP Net Admins")
        self.readers = Group.objects.create(name="LDAP Viewers")
        LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=Network Admins,OU=Groups,DC=acme,DC=local",
            ldap_group_cn="Network Admins",
            group=self.admins,
        )
        LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=Viewers,OU=Groups,DC=acme,DC=local",
            ldap_group_cn="Viewers",
            group=self.readers,
        )

    def test_maps_dns_case_insensitively(self):
        # AD DNs are case-insensitive - a differently-cased DN still maps.
        groups = set(
            danbyte_groups_for_dns(
                {"cn=network admins,ou=groups,dc=acme,dc=local"}
            )
        )
        self.assertEqual(groups, {self.admins})

    def test_unmapped_dn_grants_nothing(self):
        groups = set(
            danbyte_groups_for_dns({"CN=Random,OU=Groups,DC=acme,DC=local"})
        )
        self.assertEqual(groups, set())

    def test_sync_replaces_membership(self):
        u = User.objects.create_user("ldapuser")
        # starts in a stray group that isn't backed by the directory
        stray = Group.objects.create(name="stray")
        u.groups.add(stray)
        sync_user_groups(
            u,
            {
                "CN=Network Admins,OU=Groups,DC=acme,DC=local",
                "CN=Viewers,OU=Groups,DC=acme,DC=local",
            },
        )
        self.assertEqual(set(u.groups.all()), {self.admins, self.readers})
        # the stray (unmapped) membership is gone - directory is source of truth
        self.assertNotIn(stray, u.groups.all())


class LDAPDisabledTests(TestCase):
    def test_backend_returns_none_when_disabled(self):
        dep = DeploymentSettings.load()
        dep.ldap_enabled = False
        dep.save()
        self.assertIsNone(
            DanbyteLDAPBackend().authenticate(None, username="x", password="y")
        )

    def test_local_login_unaffected(self):
        # With the LDAP backend registered but disabled, local password auth
        # still works via ModelBackend.
        User.objects.create_user("local", password="pw12345!")
        self.assertIsNotNone(authenticate(username="local", password="pw12345!"))
        self.assertIsNone(authenticate(username="local", password="wrong"))


class LDAPLoginGrantsTests(TestCase):
    """A directory login gets everything its mapped groups say: the tenants
    their grants name, and superuser when the mapping arms it."""

    def setUp(self):
        from core.models import Organization, Tenant

        from .models import ObjectPermission

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Beta", slug="beta")
        self.group = Group.objects.create(name="Net Admins")
        perm = ObjectPermission.objects.create(
            name="admins", object_types=["device"], actions=["view", "change"]
        )
        perm.groups.add(self.group)
        perm.tenants.add(self.tenant)
        self.mapping = LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=Net Admins,DC=acme,DC=local", group=self.group
        )
        self.user = User.objects.create_user("jane")

    def _login(self, tenant=None):
        sync_user_groups(self.user, ["cn=net admins,dc=acme,dc=local"], tenant=tenant)
        self.user.refresh_from_db()

    def test_granted_tenant_lands_on_the_profile(self):
        self._login()
        prof = self.user.profile
        self.assertEqual(list(prof.tenants.values_list("slug", flat=True)), ["acme"])
        self.assertEqual(prof.current_tenant_id, self.tenant.id)
        self.assertFalse(self.user.is_superuser)

    def test_mapping_can_grant_superuser_and_never_revokes(self):
        self.mapping.grants_superuser = True
        self.mapping.save()
        self._login()
        self.assertTrue(self.user.is_superuser)
        # The directory later omits the group: still a superuser.
        sync_user_groups(self.user, [], tenant=None)
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_superuser)
        self.assertEqual(self.user.groups.count(), 0)

    def test_tenant_directory_mapping_never_mints_superuser(self):
        from .models import ObjectPermission

        scoped = Group.objects.create(name="Acme only")
        p = ObjectPermission.objects.create(name="s", object_types=["device"], actions=["view"])
        p.groups.add(scoped)
        p.tenants.add(self.tenant)
        LDAPGroupMapping.objects.create(
            ldap_group_dn="CN=T,DC=acme", group=scoped, tenant=self.tenant,
            grants_superuser=True,
        )
        sync_user_groups(self.user, ["CN=T,DC=acme"], tenant=self.tenant)
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_superuser)
        self.assertEqual(list(self.user.groups.values_list("name", flat=True)), ["Acme only"])

    def test_arming_the_flag_needs_grant_superuser(self):
        from django.test import Client

        admin = User.objects.create_user("admin", password="x", is_staff=True)
        from .models import ObjectPermission, UserProfile

        UserProfile.objects.create(user=admin, role="admin")
        manage = ObjectPermission.objects.create(
            name="users", object_types=["user"], actions=["view", "add", "change"]
        )
        manage.users.add(admin)
        c = Client()
        c.force_login(admin)
        r = c.patch(
            f"/api/ldap-group-mappings/{self.mapping.id}/",
            data='{"grants_superuser": true}',
            content_type="application/json",
        )
        self.assertIn(r.status_code, (400, 403), r.content)
        root = User.objects.create_superuser("root", "r@e.com", "x")
        c.force_login(root)
        r = c.patch(
            f"/api/ldap-group-mappings/{self.mapping.id}/",
            data='{"grants_superuser": true}',
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["grants_superuser"])
