"""The deployment-wide "light up ports marked connected" flag reaches the
SPA through /api/me."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from core.models import DeploymentSettings, Organization, Tenant


class FaceplateMarkedLitTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.client.force_login(User.objects.create_superuser("admin", "a@b.c", "x"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_flag_defaults_off_and_reaches_me(self):
        self.assertIs(self.client.get("/api/me/").json()["faceplate_mark_connected_lit"], False)
        ds, _ = DeploymentSettings.objects.get_or_create(pk=1)
        ds.faceplate_mark_connected_lit = True
        ds.save()
        self.assertIs(self.client.get("/api/me/").json()["faceplate_mark_connected_lit"], True)
