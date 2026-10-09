"""API-token auth + self-service tests."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from django.test import Client, TestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant


class ApiTokenTests(TestCase):
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
        self.c.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _make(self):
        r = self.c.post(
            "/api/api-tokens/",
            data=json.dumps({"name": "runner", "tenant_id": str(self.tenant.id)}),
            content_type="application/json",
        )
        return r

    def test_create_returns_key_once_then_authenticates(self):
        r = self._make()
        self.assertEqual(r.status_code, 201)
        key = r.json()["key"]
        self.assertTrue(key.startswith("dbt_"))
        # listing never returns the key
        self.assertNotIn("key", self.c.get("/api/api-tokens/").json()["results"][0])
        # a cookieless client authenticates with the token
        anon = Client()
        inv = anon.get(
            "/api/inventory/ansible/", HTTP_AUTHORIZATION=f"Token {key}"
        )
        self.assertEqual(inv.status_code, 200)

    def test_bad_token_rejected(self):
        anon = Client()
        r = anon.get(
            "/api/inventory/ansible/", HTTP_AUTHORIZATION="Token dbt_nope"
        )
        self.assertEqual(r.status_code, 401)

    def test_revoke(self):
        key = self._make().json()["key"]
        tid = self.c.get("/api/api-tokens/").json()["results"][0]["id"]
        self.c.delete(f"/api/api-tokens/{tid}/")
        anon = Client()
        r = anon.get(
            "/api/inventory/ansible/", HTTP_AUTHORIZATION=f"Token {key}"
        )
        self.assertEqual(r.status_code, 401)

    def test_token_scoped_to_its_tenant(self):
        # second tenant the user can also access
        org2 = Organization.objects.create(name="O2", slug="o2")
        t2 = Tenant.objects.create(org=org2, name="T2", slug="t2")
        self.user.profile.tenants.add(t2)
        key = self._make().json()["key"]  # scoped to self.tenant
        anon = Client()
        # active tenant resolves to the token's tenant, not t2
        from api.models import Site

        Site.objects.create(tenant=self.tenant, name="in-t")
        Site.objects.create(tenant=t2, name="in-t2")
        sites = anon.get(
            "/api/sites/", HTTP_AUTHORIZATION=f"Token {key}"
        ).json()
        names = {s["name"] for s in sites["results"]}
        self.assertIn("in-t", names)
        self.assertNotIn("in-t2", names)

    def test_read_only_token_refuses_writes(self):
        r = self.c.post(
            "/api/api-tokens/",
            data=json.dumps(
                {"name": "ro", "tenant_id": str(self.tenant.id), "scope": "read"}
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["scope"], "read")
        key = r.json()["key"]
        anon = Client()
        auth = {"HTTP_AUTHORIZATION": f"Token {key}"}
        self.assertEqual(anon.get("/api/inventory/ansible/", **auth).status_code, 200)
        w = anon.post(
            "/api/tags/",
            data=json.dumps({"name": "nope", "slug": "nope"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(w.status_code, 403)
        self.assertIn("read-only", w.json()["detail"])
        from core.models import Tag

        self.assertFalse(Tag.objects.filter(slug="nope").exists())

    def test_run_tokens_hidden_from_self_service(self):
        from auth_api.models import ApiToken, generate_api_key, hash_api_key

        key = generate_api_key()
        ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="run", kind="run",
            key_hash=hash_api_key(key), prefix=key[:11],
        )
        names = [t["name"] for t in self.c.get("/api/api-tokens/").json()["results"]]
        self.assertNotIn("run", names)
        # ...but it still authenticates
        anon = Client()
        r = anon.get("/api/inventory/ansible/", HTTP_AUTHORIZATION=f"Token {key}")
        self.assertEqual(r.status_code, 200)
        # and kind can't be set through the API
        r = self.c.post(
            "/api/api-tokens/",
            data=json.dumps(
                {"name": "x", "tenant_id": str(self.tenant.id), "kind": "run"}
            ),
            content_type="application/json",
        )
        self.assertEqual(r.json()["kind"], "user")


class ApiTokenSessionOnlyTests(TestCase):
    """Tokens are managed from a signed-in session only (#318). A token used
    to authenticate must not create, list or revoke tokens - otherwise a
    short-lived or read-only token, or a script's run token, could mint a
    permanent full-scope one for any tenant its owner can reach."""

    def setUp(self):
        from auth_api.models import ApiToken, generate_api_key, hash_api_key

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        org2 = Organization.objects.create(name="O2", slug="o2")
        self.tenant2 = Tenant.objects.create(org=org2, name="T2", slug="t2")
        self.user = User.objects.create_user("u", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.user)
        prof.tenants.add(self.tenant, self.tenant2)
        prof.current_tenant = self.tenant
        prof.save()
        self.key = generate_api_key()
        self.token = ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="t", kind="user",
            key_hash=hash_api_key(self.key), prefix=self.key[:11],
        )
        self.anon = Client()
        self.auth = {"HTTP_AUTHORIZATION": f"Token {self.key}"}

    def _create_with_token(self, key, **body):
        body.setdefault("name", "minted")
        body.setdefault("tenant_id", str(self.tenant2.id))
        return self.anon.post(
            "/api/api-tokens/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Token {key}",
        )

    def test_token_cannot_create_token(self):
        from auth_api.models import ApiToken

        before = ApiToken.objects.count()
        r = self._create_with_token(self.key, scope="full")
        self.assertEqual(r.status_code, 403, r.content)
        self.assertNotIn("key", r.json())
        self.assertEqual(ApiToken.objects.count(), before)

    def test_run_token_cannot_create_token(self):
        from django.utils import timezone

        from auth_api.models import ApiToken, generate_api_key, hash_api_key

        key = generate_api_key()
        ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="run", kind="run",
            key_hash=hash_api_key(key), prefix=key[:11],
            expires_at=timezone.now() + timezone.timedelta(seconds=90),
        )
        before = ApiToken.objects.count()
        r = self._create_with_token(key)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(ApiToken.objects.count(), before)
        # The run token itself still works against the ordinary API.
        self.assertEqual(
            self.anon.get("/api/sites/", HTTP_AUTHORIZATION=f"Token {key}").status_code,
            200,
        )

    def test_token_cannot_list_or_revoke_tokens(self):
        from auth_api.models import ApiToken

        self.assertEqual(self.anon.get("/api/api-tokens/", **self.auth).status_code, 403)
        self.assertEqual(
            self.anon.get(f"/api/api-tokens/{self.token.id}/", **self.auth).status_code,
            403,
        )
        r = self.anon.delete(f"/api/api-tokens/{self.token.id}/", **self.auth)
        self.assertEqual(r.status_code, 403)
        self.assertTrue(ApiToken.objects.filter(pk=self.token.pk).exists())

    def test_session_still_manages_tokens(self):
        c = Client()
        c.force_login(self.user)
        r = c.post(
            "/api/api-tokens/",
            data=json.dumps({"name": "ok", "tenant_id": str(self.tenant2.id)}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(c.get("/api/api-tokens/").status_code, 200)
        self.assertEqual(c.delete(f"/api/api-tokens/{r.json()['id']}/").status_code, 204)
