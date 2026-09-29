"""Sign-in secrets never go through a relay a tenant admin runs, unless the
account works in that tenant alone.

A tenant's admin controls its SMTP override and can read what passes through
it. An invite or reset link, or a sign-in code, for an account that reaches
further - a deployment admin, someone in another tenant too - would let that
tenant admin take the account over from the relay's log.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import Group, User
from django.test import RequestFactory, TestCase

from auth_api.builtin_groups import ensure_builtin_groups
from auth_api.login_api import mail_tenant_for, send_invite_email
from auth_api.models import UserProfile
from core.models import Organization, Tenant


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

    def test_only_a_tenant_local_account_uses_the_tenant_relay(self):
        self.assertEqual(mail_tenant_for(self.local, self.tenant), self.tenant)
        self.assertEqual(mail_tenant_for(self.local, self.tenant.pk), self.tenant.pk)
        for user in (self.both, self.admin, self.root):
            with self.subTest(user=user.username):
                self.assertIsNone(mail_tenant_for(user, self.tenant))
        self.assertIsNone(mail_tenant_for(self.local, None))
        # A tenant the account does not work in is never its relay.
        self.assertIsNone(mail_tenant_for(self.local, self.other))

    def test_invite_for_an_admin_goes_through_the_deployment_relay(self):
        request = RequestFactory().post("/")
        request.user = self.admin
        request.session = {"current_tenant_id": str(self.tenant.id)}
        with mock.patch("core.email.send_html_email") as send, mock.patch(
            "api.views._get_active_tenant", return_value=self.tenant
        ):
            send_invite_email(request, self.admin)
            self.assertIsNone(send.call_args.kwargs["tenant"])
            send_invite_email(request, self.local)
            self.assertEqual(send.call_args.kwargs["tenant"], self.tenant)

    def test_sign_in_code_follows_the_same_rule(self):
        from auth_api.login_api import _send_email_code

        for user in (self.admin, self.local):
            user.profile.current_tenant = self.tenant
            user.profile.save(update_fields=["current_tenant"])
        with mock.patch("core.email.send_html_email") as send:
            _send_email_code(self.admin, "123456")
            self.assertIsNone(send.call_args.kwargs["tenant"])
            _send_email_code(self.local, "123456")
            self.assertEqual(send.call_args.kwargs["tenant"], self.tenant.pk)
