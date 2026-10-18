"""The legacy login view only follows a ``next`` on this site."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from django.contrib.sessions.backends.db import SessionStore
from django.test import RequestFactory, TestCase

from auth_api import views


class LoginNextRedirectTests(TestCase):
    def setUp(self):
        User.objects.create_user("alice", "a@example.com", "s3cret-pw")
        self.factory = RequestFactory()

    def _login(self, next_url):
        request = self.factory.post(
            f"/login/?next={next_url}",
            {"username": "alice", "password": "s3cret-pw"},
        )
        request.session = SessionStore()
        request.user = mock.Mock(is_authenticated=False)
        with mock.patch.object(views, "reverse", return_value="/home/"):
            return views.login_view(request)

    def test_local_next_is_followed(self):
        self.assertEqual(self._login("/devices/")["Location"], "/devices/")

    def test_offsite_next_falls_back_home(self):
        for target in ("https://evil.example/", "//evil.example/", "javascript:alert(1)"):
            with self.subTest(target=target):
                self.assertEqual(self._login(target)["Location"], "/home/")
