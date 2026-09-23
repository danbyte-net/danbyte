"""A request survives the cache being down (#230). Sessions live in the
database; the one per-request cache read is only a shortcut."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase

from core import middleware


class CacheOutageTests(TestCase):
    def test_the_idle_timeout_falls_back_to_the_database(self):
        boom = ConnectionError("redis is down")
        with mock.patch.object(middleware.cache, "get", side_effect=boom), \
                mock.patch.object(middleware.cache, "set", side_effect=boom):
            from core.models import DeploymentSettings

            expected = int(DeploymentSettings.load().session_idle_timeout_minutes or 0)
            self.assertEqual(middleware.idle_timeout_minutes(), expected)

    def test_an_authenticated_request_still_answers(self):
        user = get_user_model().objects.create_superuser("a", "a@x.y", "x")
        self.client.force_login(user)
        boom = ConnectionError("redis is down")
        with mock.patch.object(middleware.cache, "get", side_effect=boom), \
                mock.patch.object(middleware.cache, "set", side_effect=boom):
            r = self.client.get("/api/me/")
        self.assertEqual(r.status_code, 200, r.content)
