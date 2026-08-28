"""The grant_superuser capability verb (#feature): who may flip is_superuser.

The rule stays fail-closed: only a superuser, or the holder of the verb on a
tenant-UNSCOPED grant, may set or clear the flag. Everyone else's attempt is
silently stripped, exactly as before - and every flip leaves a change-log
entry, which nothing wrote until now.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


def _grant(user, actions, *, tenants=()):
    perm = ObjectPermission.objects.create(
        name="user-admin", enabled=True,
        object_types=["user"], actions=list(actions),
    )
    perm.users.add(user)
    perm.tenants.set(tenants)
    return perm


class GrantSuperuserTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _admin(self, name, actions, *, tenants=()):
        """A user-admin: RBAC verbs on `user`, unscoped, so DeploymentAdmin
        passes; `actions` decides whether the new verb is included."""
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        _grant(u, actions, tenants=tenants)
        return u

    def _target(self, name="target", superuser=False):
        return User.objects.create_user(
            name, password="x", is_superuser=superuser
        )

    def _patch(self, actor, target, body):
        self.client.force_login(actor)
        return self.client.patch(
            f"/api/users/{target.id}/", body, format="json"
        )

    def test_without_the_verb_the_flag_is_stripped_not_erred(self):
        actor = self._admin("plain", ["view", "add", "change", "delete"])
        target = self._target()
        r = self._patch(actor, target, {"is_superuser": True})
        self.assertEqual(r.status_code, 200, r.content)
        target.refresh_from_db()
        self.assertFalse(target.is_superuser)

    def test_an_unscoped_grant_with_the_verb_may_promote(self):
        actor = self._admin(
            "holder", ["view", "add", "change", "delete", "grant_superuser"]
        )
        target = self._target()
        r = self._patch(actor, target, {"is_superuser": True})
        self.assertEqual(r.status_code, 200, r.content)
        target.refresh_from_db()
        self.assertTrue(target.is_superuser)

    def test_a_tenant_scoped_verb_does_not_count(self):
        # Superuser is global; a tenant-narrowed grant must not mint one. The
        # actor still needs an unscoped change grant to pass the write gate,
        # so the verb rides a second, scoped grant here.
        actor = self._admin("scoped", ["view", "add", "change", "delete"])
        _grant(actor, ["grant_superuser"], tenants=[self.tenant])
        target = self._target()
        r = self._patch(actor, target, {"is_superuser": True})
        self.assertEqual(r.status_code, 200, r.content)
        target.refresh_from_db()
        self.assertFalse(target.is_superuser)

    def test_the_verb_may_revoke_with_a_flag_only_patch(self):
        actor = self._admin(
            "revoker", ["view", "add", "change", "delete", "grant_superuser"]
        )
        target = self._target("boss", superuser=True)
        r = self._patch(actor, target, {"is_superuser": False})
        self.assertEqual(r.status_code, 200, r.content)
        target.refresh_from_db()
        self.assertFalse(target.is_superuser)

    def test_the_verb_still_cannot_touch_a_superusers_password(self):
        # The takeover protection stays: anything beyond the flags on a
        # superuser target remains superuser-only.
        actor = self._admin(
            "sneaky", ["view", "add", "change", "delete", "grant_superuser"]
        )
        target = self._target("boss2", superuser=True)
        r = self._patch(
            actor, target, {"is_superuser": False, "password": "mine-now"}
        )
        self.assertEqual(r.status_code, 403, r.content)
        r = self.client.post(f"/api/users/{target.id}/send-reset/")
        self.assertEqual(r.status_code, 403, r.content)

    def test_every_flip_lands_in_the_change_log(self):
        actor = self._admin(
            "auditor", ["view", "add", "change", "delete", "grant_superuser"]
        )
        target = self._target("promoted")
        self._patch(actor, target, {"is_superuser": True})
        entry = ChangeLogEntry.objects.filter(
            object_type="auth.user", object_id=str(target.id)
        ).first()
        self.assertIsNotNone(entry)
        self.assertEqual(
            entry.changes, {"is_superuser": {"new": True, "old": False}}
        )
        self.assertEqual(entry.user_name, "auditor")

    def test_creating_a_superuser_is_logged_too(self):
        actor = self._admin(
            "creator", ["view", "add", "change", "delete", "grant_superuser"]
        )
        self.client.force_login(actor)
        r = self.client.post(
            "/api/users/",
            {"username": "newsuper", "password": "pw-pw-pw",
             "is_superuser": True},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        made = User.objects.get(username="newsuper")
        self.assertTrue(made.is_superuser)
        self.assertTrue(
            ChangeLogEntry.objects.filter(
                object_type="auth.user", object_id=str(made.id)
            ).exists()
        )

    def test_me_reports_the_power(self):
        holder = self._admin(
            "me-holder", ["view", "add", "change", "delete", "grant_superuser"]
        )
        plain = self._admin("me-plain", ["view", "add", "change", "delete"])
        self.client.force_login(holder)
        self.assertTrue(self.client.get("/api/me/").json()["can_grant_superuser"])
        self.client.force_login(plain)
        self.assertFalse(self.client.get("/api/me/").json()["can_grant_superuser"])


class SsoMappingBypassTests(APITestCase):
    """grants_superuser on an SSO mapping is itself a superuser grant."""

    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _mapping_body(self):
        from django.contrib.auth.models import Group

        from auth_api.models import IdentityProvider

        prov = IdentityProvider.objects.create(
            name="entra", protocol="oidc", enabled=True
        )
        group = Group.objects.create(name=f"g-{prov.pk}")
        return {"provider": str(prov.id), "idp_group": "IdPAdmins",
                "group": group.pk, "grants_superuser": True}

    def test_a_deployment_admin_without_the_verb_cannot_arm_it(self):
        actor = User.objects.create_user("depadmin", password="x")
        UserProfile.objects.create(user=actor, role="custom")
        _grant(actor, ["view", "add", "change", "delete"])
        self.client.force_login(actor)
        r = self.client.post(
            "/api/sso-group-mappings/", self._mapping_body(), format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("grants_superuser", r.json())

    def test_a_verb_holder_may(self):
        actor = User.objects.create_user("armed", password="x")
        UserProfile.objects.create(user=actor, role="custom")
        _grant(actor, ["view", "add", "change", "delete", "grant_superuser"])
        self.client.force_login(actor)
        r = self.client.post(
            "/api/sso-group-mappings/", self._mapping_body(), format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
