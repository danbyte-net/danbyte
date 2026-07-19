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
        # AD DNs are case-insensitive — a differently-cased DN still maps.
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
        # the stray (unmapped) membership is gone — directory is source of truth
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
