"""Invite / reset links against disabled accounts (#322).

A link that is still valid must not re-enable an account an administrator has
since disabled, and it never changes ``is_active`` at all. A first-time invite
(an active account with no usable password yet) keeps working.
"""
from __future__ import annotations

import json
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from django.contrib.auth.models import User
from django.test import Client, RequestFactory, TestCase

from auth_api.login_api import build_set_password_url
from auth_api.models import UserProfile


def _link(user) -> dict[str, str]:
    url = build_set_password_url(RequestFactory().get("/"), user)
    q = parse_qs(urlparse(url).query)
    return {"uid": q["uid"][0], "token": q["token"][0]}


def _set_password(link, password="Str0ngPazz99"):
    return Client().post(
        "/api/auth/set-password/",
        data=json.dumps({**link, "password": password}),
        content_type="application/json",
    )


def _login(username, password):
    return Client().post(
        "/api/auth/login/",
        data=json.dumps({"username": username, "password": password}),
        content_type="application/json",
    )


class SetPasswordDisabledAccountTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user("admin1", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin)
        self.api = Client()
        self.api.force_login(self.admin)

    def _invited(self, username="newbie"):
        r = self.api.post(
            "/api/users/",
            data=json.dumps(
                {"username": username, "email": f"{username}@x.com", "send_invite": True}
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        return User.objects.get(username=username)

    def test_reset_link_refused_once_account_disabled(self):
        user = User.objects.create_user("u1", email="u1@x.com", password="Old-pass-1!")
        link = _link(user)
        r = self.api.patch(
            f"/api/users/{user.id}/",
            data=json.dumps({"is_active": False}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

        self.assertEqual(_set_password(link).status_code, 400)
        user.refresh_from_db()
        self.assertFalse(user.is_active)
        self.assertTrue(user.check_password("Old-pass-1!"))
        self.assertEqual(_login("u1", "Str0ngPazz99").status_code, 400)
        self.assertEqual(_login("u1", "Old-pass-1!").status_code, 400)

    def test_invite_link_refused_once_account_disabled(self):
        user = self._invited()
        link = _link(user)
        user.is_active = False
        user.save(update_fields=["is_active"])

        self.assertEqual(_set_password(link).status_code, 400)
        user.refresh_from_db()
        self.assertFalse(user.is_active)
        self.assertFalse(user.has_usable_password())

    def test_first_time_invite_still_works(self):
        user = self._invited()
        self.assertTrue(user.is_active)
        self.assertFalse(user.has_usable_password())
        self.assertEqual(_set_password(_link(user)).status_code, 200)
        user.refresh_from_db()
        self.assertTrue(user.is_active)
        self.assertTrue(user.check_password("Str0ngPazz99"))
        self.assertEqual(_login("newbie", "Str0ngPazz99").status_code, 200)

    def test_reset_link_on_active_account_still_works(self):
        user = User.objects.create_user("u2", email="u2@x.com", password="Old-pass-1!")
        self.assertEqual(_set_password(_link(user)).status_code, 200)
        user.refresh_from_db()
        self.assertTrue(user.check_password("Str0ngPazz99"))

    def test_link_works_again_once_account_is_re_enabled(self):
        user = User.objects.create_user("u3", email="u3@x.com", password="Old-pass-1!")
        link = _link(user)
        user.is_active = False
        user.save(update_fields=["is_active"])
        self.assertEqual(_set_password(link).status_code, 400)
        user.is_active = True
        user.save(update_fields=["is_active"])
        self.assertEqual(_set_password(link).status_code, 200)

    def test_send_reset_refused_for_disabled_account(self):
        user = User.objects.create_user(
            "u4", email="u4@x.com", password="Old-pass-1!", is_active=False
        )
        r = self.api.post(f"/api/users/{user.id}/send-reset/")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("disabled", r.json()["detail"])

    def test_no_invite_sent_to_an_account_created_disabled(self):
        with patch("auth_api.login_api.send_invite_email") as send:
            r = self.api.post(
                "/api/users/",
                data=json.dumps(
                    {
                        "username": "off",
                        "email": "off@x.com",
                        "send_invite": True,
                        "is_active": False,
                    }
                ),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        send.assert_not_called()
        self.assertFalse(User.objects.get(username="off").is_active)

    def test_disabling_edit_sends_no_reset_link(self):
        # The edit form ticks "Email a password-reset link" by default, so a
        # disabling edit must still save - it just sends nothing.
        user = User.objects.create_user("u5", email="u5@x.com", password="Old-pass-1!")
        with patch("auth_api.login_api.send_invite_email") as send:
            r = self.api.patch(
                f"/api/users/{user.id}/",
                data=json.dumps({"is_active": False, "send_invite": True}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        send.assert_not_called()
        user.refresh_from_db()
        self.assertFalse(user.is_active)

    def test_reset_link_sent_to_an_active_account(self):
        user = User.objects.create_user("u6", email="u6@x.com", password="Old-pass-1!")
        with patch("auth_api.login_api.send_invite_email") as send:
            r = self.api.patch(
                f"/api/users/{user.id}/",
                data=json.dumps({"send_invite": True}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        send.assert_called_once()
