"""SSO provisioning — JIT create, group mapping, and the pre-created-only gate.

These drive :func:`auth_api.sso.resolve_user` with claim dicts directly, so the
provisioning logic is covered without a live IdP (the OIDC network dance is thin
glue over this).
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from django.test import TestCase

from core.models import Organization, Tenant

from .models import IdentityProvider, SsoGroupMapping, UserProfile
from .sso import SsoError, resolve_user


class SsoProvisioningTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        # Deployment-wide provider (tenant NULL) so group mapping isn't gated by
        # tenant-safety; JIT users land in `default_tenant`.
        self.provider = IdentityProvider.objects.create(
            name="Entra", slug="entra", protocol="oidc",
            oidc_issuer="https://issuer.example", oidc_client_id="cid",
            jit_provisioning=True, default_tenant=self.tenant,
        )
        self.group = Group.objects.create(name="Net Admins")
        SsoGroupMapping.objects.create(
            provider=self.provider, idp_group="NetAdmins", group=self.group
        )

    def _claims(self, **over):
        base = {
            "preferred_username": "alice",
            "email": "alice@example.com",
            "given_name": "Alice",
            "family_name": "Ng",
            "groups": ["NetAdmins"],
        }
        base.update(over)
        return base

    def test_jit_creates_user_maps_group_and_tenant(self):
        user = resolve_user(self.provider, self._claims())
        self.assertTrue(User.objects.filter(username="alice").exists())
        self.assertEqual(user.email, "alice@example.com")
        self.assertEqual(user.first_name, "Alice")
        self.assertIn(self.group, user.groups.all())
        prof = UserProfile.objects.get(user=user)
        self.assertEqual(prof.auth_source, "sso")
        self.assertIn(self.tenant, prof.tenants.all())
        self.assertEqual(prof.current_tenant_id, self.tenant.id)
        self.assertFalse(user.has_usable_password())

    def test_jit_off_refuses_unknown_user(self):
        self.provider.jit_provisioning = False
        self.provider.save(update_fields=["jit_provisioning"])
        with self.assertRaises(SsoError):
            resolve_user(self.provider, self._claims(preferred_username="bob"))
        self.assertFalse(User.objects.filter(username="bob").exists())

    def test_jit_off_allows_precreated_user(self):
        self.provider.jit_provisioning = False
        self.provider.save(update_fields=["jit_provisioning"])
        User.objects.create_user("carol", email="carol@example.com")
        user = resolve_user(
            self.provider, self._claims(preferred_username="carol", email="carol@example.com")
        )
        self.assertEqual(user.username, "carol")
        self.assertIn(self.group, user.groups.all())

    def test_unmapped_group_grants_nothing(self):
        user = resolve_user(self.provider, self._claims(groups=["Randoms"]))
        self.assertEqual(list(user.groups.all()), [])

    def test_groups_resync_on_each_login(self):
        # First login in the group, second login without it → membership drops.
        resolve_user(self.provider, self._claims())
        user = resolve_user(self.provider, self._claims(groups=[]))
        self.assertEqual(list(user.groups.all()), [])

    def test_default_group_grants_baseline_access(self):
        # A provider default group is applied even when no mapping matches, so a
        # new SSO user isn't stranded with no access.
        baseline = Group.objects.create(name="All SSO users")
        self.provider.default_group = baseline
        self.provider.save(update_fields=["default_group"])
        user = resolve_user(self.provider, self._claims(groups=["Unmapped"]))
        self.assertIn(baseline, user.groups.all())
        # And it stacks with a matched mapping.
        user2 = resolve_user(self.provider, self._claims())
        self.assertEqual(
            {g.name for g in user2.groups.all()}, {"Net Admins", "All SSO users"}
        )

    def test_missing_identity_is_rejected(self):
        with self.assertRaises(SsoError):
            resolve_user(self.provider, {"groups": ["NetAdmins"]})

    def test_same_subject_matches_after_username_and_email_change(self):
        # Binding is by stable subject, so a renamed IdP account stays one user.
        u1 = resolve_user(self.provider, self._claims(sub="stable-1"))
        u2 = resolve_user(self.provider, self._claims(
            sub="stable-1", preferred_username="alice2", email="alice2@x.com"
        ))
        self.assertEqual(u1.pk, u2.pk)
        prof = UserProfile.objects.get(user=u1)
        self.assertEqual(prof.sso_subject, "stable-1")
        self.assertEqual(prof.sso_provider_id, self.provider.id)

    def test_local_account_with_password_is_not_hijacked(self):
        # An IdP asserting an existing local admin's username must NOT seize it.
        local = User.objects.create_user(
            "alice", email="alice@example.com", password="s3cret"
        )
        with self.assertRaises(SsoError):
            resolve_user(self.provider, self._claims(sub="attacker-sub"))
        local.refresh_from_db()
        self.assertTrue(local.has_usable_password())
        self.assertFalse(
            UserProfile.objects.filter(user=local, sso_subject="attacker-sub").exists()
        )

    def test_unverified_email_does_not_link_existing_account(self):
        existing = User.objects.create_user("alice-old", email="shared@x.com")
        existing.set_unusable_password()
        existing.save()
        # Different username, same email, no email_verified → new account, no link.
        user = resolve_user(self.provider, self._claims(
            preferred_username="newname", email="shared@x.com", sub="s1"
        ))
        self.assertNotEqual(user.pk, existing.pk)

    def test_verified_email_links_existing_account(self):
        existing = User.objects.create_user("alice-old2", email="shared2@x.com")
        existing.set_unusable_password()
        existing.save()
        user = resolve_user(self.provider, self._claims(
            preferred_username="newname2", email="shared2@x.com",
            email_verified=True, sub="s2",
        ))
        self.assertEqual(user.pk, existing.pk)
