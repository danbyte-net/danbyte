"""Which relay carries a sign-in secret - an invite or reset link, a sign-in
code.

A tenant's admin controls its SMTP override and can read what passes through
it. An invite or reset link, or a sign-in code, for an account that reaches
further - a deployment admin, someone in another tenant too - would let that
tenant admin take the account over from the relay's log, so those take the
deployment relay. When the deployment has no relay of its own they fall back
to the tenant's, so an install that only set up tenant mail keeps delivering.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import Group, User
from django.core import mail
from django.core.mail import get_connection
from django.test import RequestFactory, TestCase, override_settings

from auth_api.builtin_groups import ensure_builtin_groups
from auth_api.login_api import (
    _send_email_code,
    deployment_relay_configured,
    mail_tenant_for,
    send_invite_email,
)
from auth_api.models import UserProfile
from core.models import DeploymentSettings, Organization, Tenant, TenantSettings


class MailTenantTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        cls.other = Tenant.objects.create(org=org, name="B", slug="b")
        cls.local = cls._user("local", [cls.tenant])
        cls.both = cls._user("both", [cls.tenant, cls.other])
        cls.admin = cls._user("boss", [cls.tenant])
        cls.admin.groups.add(Group.objects.get(name="Administrator"))
        cls.root = User.objects.create_superuser("root", "root@example.com", "x")
        UserProfile.objects.create(user=cls.root).tenants.add(cls.tenant)

    @classmethod
    def _user(cls, name, tenants):
        user = User.objects.create_user(name, f"{name}@example.com", "x")
        UserProfile.objects.create(user=user, role="custom").tenants.set(tenants)
        return user

    def _deployment_relay(self, host="smtp.example.net"):
        dep = DeploymentSettings.load()
        dep.smtp_host = host
        dep.save(update_fields=["smtp_host"])

    def _invite_request(self):
        request = RequestFactory().post("/")
        request.user = self.admin
        request.session = {"current_tenant_id": str(self.tenant.id)}
        return request

    def test_with_a_deployment_relay_only_a_tenant_local_account_uses_the_tenant_relay(self):
        self._deployment_relay()
        self.assertEqual(mail_tenant_for(self.local, self.tenant), self.tenant)
        self.assertEqual(mail_tenant_for(self.local, self.tenant.pk), self.tenant.pk)
        for user in (self.both, self.admin, self.root):
            with self.subTest(user=user.username):
                self.assertIsNone(mail_tenant_for(user, self.tenant))
        self.assertIsNone(mail_tenant_for(self.local, None))
        # A tenant the account does not work in is never its relay.
        self.assertIsNone(mail_tenant_for(self.local, self.other))

    def test_without_a_deployment_relay_the_tenant_relay_carries_them(self):
        self.assertFalse(deployment_relay_configured())
        for user in (self.local, self.both, self.admin, self.root):
            with self.subTest(user=user.username):
                self.assertEqual(mail_tenant_for(user, self.tenant), self.tenant)
                self.assertEqual(mail_tenant_for(user, self.tenant.pk), self.tenant.pk)
        self.assertEqual(mail_tenant_for(self.local, self.other), self.other)
        self.assertIsNone(mail_tenant_for(self.admin, None))

    def test_a_delivering_email_backend_is_a_deployment_relay(self):
        self.assertFalse(deployment_relay_configured())
        with override_settings(EMAIL_BACKEND="django.core.mail.backends.smtp.EmailBackend"):
            self.assertTrue(deployment_relay_configured())
            self.assertIsNone(mail_tenant_for(self.admin, self.tenant))

    def test_invite_follows_the_rule(self):
        request = self._invite_request()
        with mock.patch("core.email.send_html_email") as send, mock.patch(
            "api.views._get_active_tenant", return_value=self.tenant
        ):
            send_invite_email(request, self.admin)
            self.assertEqual(send.call_args.kwargs["tenant"], self.tenant)
            self._deployment_relay()
            send_invite_email(request, self.admin)
            self.assertIsNone(send.call_args.kwargs["tenant"])
            send_invite_email(request, self.local)
            self.assertEqual(send.call_args.kwargs["tenant"], self.tenant)

    def test_sign_in_code_follows_the_rule(self):
        for user in (self.admin, self.local):
            user.profile.current_tenant = self.tenant
            user.profile.save(update_fields=["current_tenant"])
        with mock.patch("core.email.send_html_email") as send:
            _send_email_code(self.admin, "123456")
            self.assertEqual(send.call_args.kwargs["tenant"], self.tenant.pk)
            self._deployment_relay()
            _send_email_code(self.admin, "123456")
            self.assertIsNone(send.call_args.kwargs["tenant"])
            _send_email_code(self.local, "123456")
            self.assertEqual(send.call_args.kwargs["tenant"], self.tenant.pk)

    def test_the_relay_that_sends_an_admin_invite(self):
        TenantSettings.objects.update_or_create(
            tenant=self.tenant,
            defaults={"override_email": True, "smtp_host": "smtp.tenant.example"},
        )
        used = []

        def connection(eff):
            used.append(eff)
            return get_connection("django.core.mail.backends.locmem.EmailBackend")

        request = self._invite_request()
        with mock.patch(
            "monitoring.notify.build_email_connection", side_effect=connection
        ), mock.patch("api.views._get_active_tenant", return_value=self.tenant):
            send_invite_email(request, self.admin)
            self._deployment_relay()
            send_invite_email(request, self.admin)
        self.assertIsInstance(used[0], TenantSettings)
        self.assertIsInstance(used[1], DeploymentSettings)
        self.assertEqual(len(mail.outbox), 2)

    def test_no_relay_at_all_keeps_the_default_backend(self):
        request = self._invite_request()
        with mock.patch("api.views._get_active_tenant", return_value=self.tenant):
            send_invite_email(request, self.admin)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.admin.email])
