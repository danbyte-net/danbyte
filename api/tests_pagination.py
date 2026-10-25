"""A list without ?page_size= answers a small page with a `next` link; a
bigger page is the caller's explicit opt-in, up to the cap (#447)."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.settings import api_settings
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Site
from .pagination import StandardResultsSetPagination
from .viewsets import StandardPagination

User = get_user_model()

ROWS = 150


class ListPaginationTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        Site.objects.bulk_create(
            Site(tenant=self.tenant, name=f"site-{i:03d}") for i in range(ROWS)
        )

    def get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_defaults(self):
        self.assertEqual(settings.API_PAGE_SIZE, 100)
        self.assertEqual(settings.API_MAX_PAGE_SIZE, 10000)
        self.assertEqual(api_settings.PAGE_SIZE, 100)
        self.assertTrue(issubclass(StandardPagination, StandardResultsSetPagination))

    def test_no_page_size_answers_the_default_page_and_a_next_link(self):
        body = self.get("/api/sites/")
        self.assertEqual(set(body), {"count", "next", "previous", "results"})
        self.assertEqual(body["count"], ROWS)
        self.assertEqual(len(body["results"]), 100)
        self.assertIsNone(body["previous"])
        nxt = urlparse(body["next"])
        self.assertEqual(nxt.path, "/api/sites/")
        self.assertEqual(parse_qs(nxt.query)["page"], ["2"])

    def test_walking_next_returns_every_row_once(self):
        seen: list[str] = []
        url = "/api/sites/?page_size=40"
        while url:
            body = self.get(url)
            seen += [r["id"] for r in body["results"]]
            url = body["next"]
        self.assertEqual(len(seen), ROWS)
        self.assertEqual(len(set(seen)), ROWS)

    def test_page_size_up_to_the_cap_is_an_explicit_opt_in(self):
        body = self.get("/api/sites/?page_size=10000")
        self.assertEqual(len(body["results"]), ROWS)
        self.assertIsNone(body["next"])

    def test_the_cap_holds(self):
        with override_settings(API_MAX_PAGE_SIZE=60):
            body = self.get("/api/sites/?page_size=10000")
        self.assertEqual(len(body["results"]), 60)
        self.assertIsNotNone(body["next"])

    def test_the_default_follows_the_setting(self):
        with override_settings(API_PAGE_SIZE=25):
            body = self.get("/api/sites/")
        self.assertEqual(len(body["results"]), 25)

    def test_a_bad_page_size_falls_back_to_the_default(self):
        for bad in ("abc", "0", "-5"):
            body = self.get(f"/api/sites/?page_size={bad}")
            self.assertEqual(len(body["results"]), 100, bad)

    def test_picker_lists_page_the_same_way(self):
        body = self.get("/api/sites/?picker=1")
        self.assertEqual(len(body["results"]), 100)
        self.assertIsNotNone(body["next"])
        body = self.get("/api/sites/?picker=1&page_size=1000")
        self.assertEqual(len(body["results"]), ROWS)
