"""First-run onboarding endpoint — member-readable state + dismiss, per-tenant."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from api.models import Site
from core.models import Organization, Tenant, TenantSettings

User = get_user_model()


class OnboardingEndpointTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        # A plain member (not a superuser) — the endpoint must be member-readable.
        from auth_api.models import UserProfile

        self.user = User.objects.create_user("member", "m@x.com", "x")
        prof, _ = UserProfile.objects.get_or_create(user=self.user)
        prof.tenants.add(self.tenant, self.other)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _get(self):
        return self.client.get("/api/onboarding/")

    def test_fresh_tenant_reports_not_dismissed_no_sites(self):
        r = self._get()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"dismissed": False, "has_sites": False})

    def test_has_sites_flips_once_a_site_exists(self):
        Site.objects.create(tenant=self.tenant, name="S")
        self.assertTrue(self._get().json()["has_sites"])

    def test_post_dismisses_and_persists(self):
        r = self.client.post("/api/onboarding/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["dismissed"])
        self.assertTrue(self._get().json()["dismissed"])
        self.assertTrue(
            TenantSettings.objects.get(tenant=self.tenant).onboarding_dismissed
        )

    def test_dismiss_is_per_tenant(self):
        self.client.post("/api/onboarding/")
        # Switch the active tenant → still fresh.
        s = self.client.session
        s["current_tenant_id"] = str(self.other.id)
        s.save()
        self.assertFalse(self._get().json()["dismissed"])
