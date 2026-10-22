"""A token whose tenant is gone for its user is dead, never moved (#442).

An API token is issued for one tenant. When that tenant is no longer allowed
for the token's user - membership removed, or the tenant deactivated - the
token used to fall back to the user's session or home tenant and read and
write a tenant it was never issued for.
"""
from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.test import RequestFactory
from rest_framework.test import APITestCase

from api.models import Site
from api.views import _get_active_tenant
from auth_api.models import ApiToken, ObjectPermission, UserProfile, generate_api_key, hash_api_key
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings

User = get_user_model()


class TokenTenantRevokedTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.ta = Tenant.objects.create(org=org, name="TenantA", slug="ta")
        self.tb = Tenant.objects.create(org=org, name="TenantB", slug="tb")
        Site.objects.create(tenant=self.ta, name="a-site")
        Site.objects.create(tenant=self.tb, name="b-secret-site")

    def _runner(self):
        """A non-superuser member of A and B with every action on everything,
        whose home tenant is B (the old fallback target)."""
        u = User.objects.create_user("runner", "r@e.com", "Pw-123456-x")
        prof = UserProfile.objects.create(user=u, role="custom", current_tenant=self.tb)
        prof.tenants.add(self.ta, self.tb)
        p = ObjectPermission.objects.create(
            name="all", object_types=["*"], actions=["view", "add", "change", "delete"]
        )
        p.users.add(u)
        return u, prof

    def _superuser(self):
        u = User.objects.create_user("root", "s@e.com", "Pw-123456-x", is_superuser=True)
        prof = UserProfile.objects.create(user=u, current_tenant=self.tb)
        prof.tenants.add(self.ta, self.tb)
        return u

    def _token(self, user, tenant, **extra):
        key = generate_api_key()
        token = ApiToken.objects.create(
            user=user, tenant=tenant, name="runner",
            key_hash=hash_api_key(key), prefix=key[:11], **extra,
        )
        return key, token

    def _auth(self, key):
        return {"HTTP_AUTHORIZATION": f"Token {key}"}

    def _names(self, key):
        r = self.client.get("/api/sites/", **self._auth(key))
        self.assertEqual(r.status_code, 200, r.content[:200])
        return sorted(s["name"] for s in r.json()["results"])

    def _assert_refused(self, key):
        """Read and write both refused; nothing lands in either tenant."""
        r = self.client.get("/api/sites/", **self._auth(key))
        self.assertEqual(r.status_code, 401, r.content[:200])
        self.assertIn("no longer available", r.json()["detail"])
        self.assertNotIn(b"b-secret-site", r.content)

        w = self.client.post(
            "/api/sites/", {"name": "written-by-tenant-A-token"}, format="json",
            **self._auth(key),
        )
        self.assertEqual(w.status_code, 401, w.content[:200])
        self.assertFalse(Site.objects.filter(name="written-by-tenant-A-token").exists())

    # ── PoC: user removed from the token's tenant ────────────────────────────

    def test_member_removed_from_token_tenant(self):
        u, prof = self._runner()
        key, _ = self._token(u, self.ta)
        self.assertEqual(self._names(key), ["a-site"])
        prof.tenants.remove(self.ta)  # an admin takes tenant A away
        self._assert_refused(key)

    def test_tenant_deactivated_member(self):
        u, _ = self._runner()
        key, _ = self._token(u, self.ta)
        self.assertEqual(self._names(key), ["a-site"])
        Tenant.objects.filter(pk=self.ta.pk).update(is_active=False)
        self._assert_refused(key)

    def test_tenant_deactivated_superuser(self):
        u = self._superuser()
        key, _ = self._token(u, self.ta)
        self.assertEqual(self._names(key), ["a-site"])
        Tenant.objects.filter(pk=self.ta.pk).update(is_active=False)
        self._assert_refused(key)

    def test_session_choice_does_not_rescue_the_token(self):
        """A browser session pointed at B plus the dead A token: the token
        wins authentication and is refused, it does not borrow the session."""
        u, prof = self._runner()
        key, _ = self._token(u, self.ta)
        self.client.force_login(u)
        self.client.post(f"/api/tenants/{self.tb.id}/switch/")
        prof.tenants.remove(self.ta)
        r = self.client.get("/api/sites/", **self._auth(key))
        self.assertEqual(r.status_code, 401)

    def test_read_only_token_refused_too(self):
        u, prof = self._runner()
        key, _ = self._token(u, self.ta, scope="read")
        prof.tenants.remove(self.ta)
        r = self.client.get("/api/sites/", **self._auth(key))
        self.assertEqual(r.status_code, 401)

    def test_token_works_again_when_access_returns(self):
        """Not a revocation: restoring access restores the token, still on A."""
        u, prof = self._runner()
        key, _ = self._token(u, self.ta)
        prof.tenants.remove(self.ta)
        self.assertEqual(self.client.get("/api/sites/", **self._auth(key)).status_code, 401)
        prof.tenants.add(self.ta)
        self.assertEqual(self._names(key), ["a-site"])

    # ── Other surfaces that take the same token ──────────────────────────────

    def test_mcp_endpoint_refuses(self):
        u, prof = self._runner()
        key, _ = self._token(u, self.ta)
        for t in (self.ta, self.tb):
            IntegrationSettings.objects.create(tenant=t, ai_access_enabled=True)
        prof.tenants.remove(self.ta)
        r = self.client.post(
            "/api/mcp/",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
            content_type="application/json", **self._auth(key),
        )
        self.assertEqual(r.status_code, 401)

    def test_ical_feed_refuses(self):
        u, prof = self._runner()
        key, _ = self._token(u, self.ta)
        prof.tenants.remove(self.ta)
        r = self.client.get(f"/api/planning/calendar.ics?token={key}")
        self.assertEqual(r.status_code, 401)

    # ── The resolver itself never falls back for a token ─────────────────────

    def test_resolver_returns_none_not_another_tenant(self):
        u, prof = self._runner()
        _, token = self._token(u, self.ta)
        prof.tenants.remove(self.ta)
        request = RequestFactory().get("/")
        request.user = u
        request.auth = token
        request.session = {"current_tenant_id": str(self.tb.id)}
        self.assertIsNone(_get_active_tenant(request))

    def test_resolver_honours_allowed_token_tenant(self):
        u, _ = self._runner()
        _, token = self._token(u, self.ta)
        request = RequestFactory().get("/")
        request.user = u
        request.auth = token
        request.session = {"current_tenant_id": str(self.tb.id)}
        self.assertEqual(_get_active_tenant(request), self.ta)
