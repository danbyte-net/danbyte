"""Hiding the local sign-in form (#119) - de-emphasis, never lockout.

The flag hides the username/password form behind a link on the login page.
The API keeps accepting local credentials with the flag on: that IS the
break-glass for a broken IdP, and LDAP rides the same form.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import DeploymentSettings, Organization, Tenant


def _set_flag(value: bool) -> None:
    ds = DeploymentSettings.load()
    ds.hide_local_login = value
    ds.save(update_fields=["hide_local_login"])


class HideLocalLoginTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def test_the_anonymous_me_payload_carries_the_flag(self):
        r = self.client.get("/api/me/")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["hide_local_login"])
        _set_flag(True)
        r = self.client.get("/api/me/")
        self.assertTrue(r.json()["hide_local_login"])

    def test_local_login_still_works_with_the_flag_on(self):
        # The whole point: hiding the form must not disable the credentials.
        _set_flag(True)
        u = User.objects.create_user("localadmin", password="pw-pw-pw")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        r = self.client.post(
            "/api/auth/login/",
            {"username": "localadmin", "password": "pw-pw-pw"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_only_a_deployment_admin_may_flip_it(self):
        u = User.objects.create_user("pleb", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        self.client.force_login(u)
        r = self.client.put(
            "/api/deployment/email/",
            {"hide_local_login": True},
            format="json",
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(DeploymentSettings.load().hide_local_login)

    def test_a_deployment_admin_can(self):
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        r = self.client.put(
            "/api/deployment/email/",
            {"hide_local_login": True},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(DeploymentSettings.load().hide_local_login)
