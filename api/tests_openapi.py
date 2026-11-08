"""OpenAPI schema + interactive docs (drf-spectacular) wiring."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase


class OpenApiSchemaTests(APITestCase):
    def test_schema_requires_auth(self):
        # Default-closed: no session, no schema.
        r = self.client.get("/api/schema/")
        self.assertIn(r.status_code, (401, 403))

    def test_api_root_redirects_to_docs(self):
        r = self.client.get("/api/")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], "/api/docs/")

    def test_authed_schema_is_openapi3_and_grouped(self):
        User.objects.create_superuser("root", "root@acme.com", "pw")
        self.client.force_login(User.objects.get(username="root"))
        r = self.client.get("/api/schema/", HTTP_ACCEPT="application/vnd.oai.openapi")
        self.assertEqual(r.status_code, 200)
        body = r.content.decode()
        self.assertIn("openapi: 3", body)
        self.assertIn("Danbyte API", body)
        # Core object groups are present as paths.
        self.assertIn("/api/prefixes/", body)
        self.assertIn("/api/ips/", body)
        self.assertIn("/api/devices/", body)

    def test_docs_view_renders_for_authed_user(self):
        User.objects.create_superuser("root", "root@acme.com", "pw")
        self.client.force_login(User.objects.get(username="root"))
        r = self.client.get("/api/docs/")
        self.assertEqual(r.status_code, 200)

    def test_cached_schema_is_not_served_to_anonymous(self):
        # A token client (no session cookie) fills the cache; an anonymous
        # request after it must still be refused, not handed that copy.
        from django.core.cache import cache
        from django.test import override_settings
        from rest_framework.test import APIClient

        root = User.objects.create_superuser("root", "root@acme.com", "pw")
        with override_settings(
            CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                                "LOCATION": "openapi-tests"}}
        ):
            cache.clear()
            token_like = APIClient()
            token_like.force_authenticate(root)
            self.assertEqual(token_like.get("/api/schema/").status_code, 200)
            self.assertIn(APIClient().get("/api/schema/").status_code, (401, 403))
            # The second authenticated read comes from the cache.
            self.assertEqual(token_like.get("/api/schema/").status_code, 200)

