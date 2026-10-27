"""The page-size cap comes from the environment, large pages are limited per
token or user, and the internal readers page past the cap (#452)."""
from __future__ import annotations

import io
import urllib.error
from unittest import mock

from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpResponse
from django.test import Client, RequestFactory, TestCase, override_settings

from auth_api.models import ApiToken, UserProfile, generate_api_key, hash_api_key
from core.middleware import LargePageGuardMiddleware
from core.models import Organization, Tenant
from danbyte.settings import api_paging

from .models import Site

ROWS = 25


class PageSizeSettingTests(TestCase):
    def test_defaults(self):
        self.assertEqual(api_paging({}), (100, 2000, 1000, 2))

    def test_from_the_environment(self):
        env = {"API_PAGE_SIZE": "50", "API_MAX_PAGE_SIZE": "5000",
               "API_LARGE_PAGE_THRESHOLD": "1500", "API_LARGE_PAGE_CONCURRENCY": "4"}
        self.assertEqual(api_paging(env), (50, 5000, 1500, 4))

    def test_an_unset_cap_holds_a_larger_default_page(self):
        self.assertEqual(api_paging({"API_PAGE_SIZE": "3000"})[:3], (3000, 3000, 3000))

    def test_an_unset_threshold_stays_under_a_lower_cap(self):
        self.assertEqual(api_paging({"API_MAX_PAGE_SIZE": "500"})[1:3], (500, 500))

    def test_bad_values_refuse_to_start(self):
        for env in (
            {"API_MAX_PAGE_SIZE": "abc"},
            {"API_MAX_PAGE_SIZE": "0"},
            {"API_MAX_PAGE_SIZE": "-5"},
            {"API_PAGE_SIZE": "0"},
            {"API_LARGE_PAGE_CONCURRENCY": "0"},
            {"API_PAGE_SIZE": "500", "API_MAX_PAGE_SIZE": "200"},
            {"API_LARGE_PAGE_THRESHOLD": "0"},
            {"API_LARGE_PAGE_THRESHOLD": "50"},
            {"API_LARGE_PAGE_THRESHOLD": "2001"},
        ):
            with self.assertRaises(ImproperlyConfigured, msg=env):
                api_paging(env)


class _TokenBase(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = User.objects.create_user("u452", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.user)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        self.key = generate_api_key()
        ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="t", kind="user",
            key_hash=hash_api_key(self.key), prefix=self.key[:11], scope="read",
        )
        self.slots = [f"api:large-page:t:{hash_api_key(self.key)}:{n}" for n in range(2)]
        cache.delete_many(self.slots)
        self.addCleanup(cache.delete_many, self.slots)
        Site.objects.bulk_create(
            Site(tenant=self.tenant, name=f"site-{i:03d}") for i in range(ROWS)
        )
        self.client = Client(HTTP_AUTHORIZATION=f"Token {self.key}")


class LargePageGuardTests(_TokenBase):
    def test_two_large_pages_in_flight_then_429_then_released(self):
        factory = RequestFactory()
        seen: list[int] = []

        def req():
            return factory.get("/api/sites/?page_size=2000",
                               HTTP_AUTHORIZATION=f"Token {self.key}")

        # Each request's view starts the next one while it is still running,
        # so three are in flight at once.
        def third(_request):
            return HttpResponse("third")

        def second(_request):
            r = LargePageGuardMiddleware(third)(req())
            seen.append(r.status_code)
            if r.status_code == 429:
                seen.append(int(r["Retry-After"]))
            return HttpResponse("second")

        def first(_request):
            r = LargePageGuardMiddleware(second)(req())
            seen.append(r.status_code)
            return HttpResponse("first")

        r = LargePageGuardMiddleware(first)(req())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(seen, [429, 2, 200])
        # Both slots were given back.
        self.assertEqual(cache.get_many(self.slots), {})
        self.assertEqual(LargePageGuardMiddleware(third)(req()).status_code, 200)

    def test_a_failing_view_gives_its_slot_back(self):
        def boom(_request):
            raise RuntimeError("boom")

        request = RequestFactory().get("/api/sites/?page_size=2000",
                                       HTTP_AUTHORIZATION=f"Token {self.key}")
        with self.assertRaises(RuntimeError):
            LargePageGuardMiddleware(boom)(request)
        self.assertEqual(cache.get_many(self.slots), {})

    def test_through_the_api(self):
        for key in self.slots:  # two large pages already in flight
            cache.set(key, 1, 60)
        r = self.client.get("/api/sites/?page_size=1001")
        self.assertEqual(r.status_code, 429, r.content)
        self.assertEqual(r["Retry-After"], "2")
        self.assertIn("follow `next`", r.json()["detail"])
        # A page at the threshold (1,000) or smaller is never held back.
        self.assertEqual(self.client.get("/api/sites/").status_code, 200)
        self.assertEqual(self.client.get("/api/sites/?page_size=1000").status_code, 200)
        cache.delete(self.slots[0])
        r = self.client.get("/api/sites/?page_size=2000")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["results"]), ROWS)
        self.assertIsNotNone(cache.get(self.slots[1]))
        self.assertIsNone(cache.get(self.slots[0]))

    @override_settings(API_LARGE_PAGE_CONCURRENCY=3)
    def test_the_limit_follows_the_setting(self):
        for key in self.slots:
            cache.set(key, 1, 60)
        third = f"api:large-page:t:{hash_api_key(self.key)}:2"
        self.addCleanup(cache.delete, third)
        self.assertEqual(self.client.get("/api/sites/?page_size=2000").status_code, 200)

    def test_another_token_has_its_own_slots(self):
        for key in self.slots:
            cache.set(key, 1, 60)
        other = User.objects.create_superuser("other452", "o@example.com", "x")
        client = Client()
        client.force_login(other)
        s = client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.addCleanup(cache.delete_many,
                        [f"api:large-page:u:{other.pk}:{n}" for n in range(2)])
        self.assertEqual(client.get("/api/sites/?page_size=2000").status_code, 200)


class _UrlopenToTestClient:
    """``urllib.request.urlopen`` answered by the Django test client, so the
    SDK walks the real API, middleware and all."""

    def __init__(self, client: Client):
        self.client = client
        self.calls: list[str] = []

    def __call__(self, req, timeout=None):
        url = req.full_url.removeprefix("http://testserver")
        self.calls.append(url)
        r = self.client.get(url, HTTP_AUTHORIZATION=req.get_header("Authorization"))
        if r.status_code >= 400:
            raise urllib.error.HTTPError(
                req.full_url, r.status_code, "err", dict(r.items()), io.BytesIO(r.content)
            )
        return _Resp(r.content)


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SdkPagingTests(_TokenBase):
    def sdk(self):
        from danbyte_sdk.client import Client as SdkClient

        return SdkClient("http://testserver", self.key)

    def test_list_returns_every_row_across_pages_at_a_low_cap(self):
        fake = _UrlopenToTestClient(self.client)
        with override_settings(API_PAGE_SIZE=5, API_MAX_PAGE_SIZE=10), \
                mock.patch("urllib.request.urlopen", fake):
            rows = self.sdk().list("sites")
        self.assertEqual(len(rows), ROWS)
        self.assertEqual(len({r["id"] for r in rows}), ROWS)
        self.assertEqual(len(fake.calls), 3)

    def test_its_1000_row_pages_never_meet_the_guard(self):
        fake = _UrlopenToTestClient(self.client)
        for key in self.slots:
            cache.set(key, 1, 60)
        with mock.patch("urllib.request.urlopen", fake):
            self.assertEqual(len(self.sdk().list("sites")), ROWS)

    @override_settings(API_LARGE_PAGE_THRESHOLD=500)
    def test_a_429_is_retried_after_the_wait(self):
        fake = _UrlopenToTestClient(self.client)
        for key in self.slots:
            cache.set(key, 1, 60)

        def free_a_slot(_seconds):
            cache.delete(self.slots[0])

        with mock.patch("urllib.request.urlopen", fake), \
                mock.patch("danbyte_sdk.client.time.sleep", side_effect=free_a_slot) as slept:
            rows = self.sdk().list("sites")
        self.assertEqual(len(rows), ROWS)
        slept.assert_called_once_with(2.0)
        self.assertEqual(len(fake.calls), 2)
