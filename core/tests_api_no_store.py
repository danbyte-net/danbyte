"""Signed-in API responses are never stored by a browser or proxy (#491)."""
from __future__ import annotations

import json

from django.contrib.auth.models import AnonymousUser, User
from django.http import HttpResponse
from django.test import Client, RequestFactory, SimpleTestCase, TestCase

from auth_api.models import UserProfile
from core.middleware import ApiNoStoreMiddleware
from core.models import Organization, Tenant


class ApiNoStoreTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = User.objects.create_user("u", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.user)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        self.c = Client()
        self.c.force_login(self.user)

    def test_session_api_response_is_no_store(self):
        for url in ("/api/me/", "/api/users/"):
            r = self.c.get(url)
            with self.subTest(url=url):
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r["Cache-Control"], "private, no-store")

    def test_token_api_response_is_no_store(self):
        r = self.c.post(
            "/api/api-tokens/",
            data=json.dumps({"name": "runner", "tenant_id": str(self.tenant.id)}),
            content_type="application/json",
        )
        key = r.json()["key"]
        r = Client().get("/api/inventory/ansible/", HTTP_AUTHORIZATION=f"Token {key}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r["Cache-Control"], "private, no-store")

    def test_errors_for_a_signed_in_caller_are_no_store_too(self):
        r = self.c.get("/api/users/999999/")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r["Cache-Control"], "private, no-store")

    def test_anonymous_responses_are_left_alone(self):
        r = Client().get("/api/health/")
        self.assertFalse(r.has_header("Cache-Control"))

    def test_paths_outside_the_api_are_left_alone(self):
        r = self.c.get("/admin/")
        self.assertNotEqual(r.get("Cache-Control"), "private, no-store")


class ApiNoStoreMiddlewareTests(SimpleTestCase):
    def _run(self, path, response, user=None, **extra):
        request = RequestFactory().get(path, **extra)
        request.user = user or AnonymousUser()
        return ApiNoStoreMiddleware(lambda req: response)(request)

    def _signed_in(self):
        return User(username="x")

    def test_a_views_own_cache_control_is_kept(self):
        resp = HttpResponse()
        resp["Cache-Control"] = "private, max-age=86400"
        out = self._run("/api/3d/thing/", resp, self._signed_in())
        self.assertEqual(out["Cache-Control"], "private, max-age=86400")

    def test_etag_and_not_modified_are_untouched(self):
        resp = HttpResponse(status=304)
        resp["ETag"] = '"abc"'
        out = self._run("/api/x/", resp, self._signed_in())
        self.assertEqual(out.status_code, 304)
        self.assertEqual(out["ETag"], '"abc"')
        self.assertEqual(out["Cache-Control"], "private, no-store")

    def test_an_authorization_header_counts_as_signed_in(self):
        out = self._run("/api/x/", HttpResponse(), HTTP_AUTHORIZATION="Token dbt_x")
        self.assertEqual(out["Cache-Control"], "private, no-store")

    def test_anonymous_and_non_api_are_untouched(self):
        self.assertFalse(self._run("/api/x/", HttpResponse()).has_header("Cache-Control"))
        out = self._run("/media/branding/logo.png", HttpResponse(), self._signed_in())
        self.assertFalse(out.has_header("Cache-Control"))
