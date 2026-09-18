"""The ``?custom_field=`` list filter applies a field's scope rules to the
caller's own list - only for a field the active tenant owns (#192). Another
tenant's id must neither apply its rules here nor answer differently from an
id that does not exist."""
from __future__ import annotations

import uuid

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from customization.models import CustomField

from .models import Prefix

User = get_user_model()


class CustomFieldScopeFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24")
        Prefix.objects.create(tenant=self.tenant, cidr="10.2.0.0/24")
        rules = {"name_patterns": {"include": ["10.1."]}}
        self.mine = CustomField.objects.create(
            tenant=self.tenant, key="own", label="Own", applies_to=["prefix"], scope_rules=rules
        )
        self.theirs = CustomField.objects.create(
            tenant=self.other, key="foreign", label="Foreign", applies_to=["prefix"],
            scope_rules=rules,
        )

    def _cidrs(self, field_id) -> list[str]:
        r = self.client.get(f"/api/prefixes/?custom_field={field_id}")
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(p["cidr"] for p in r.json()["results"])

    def test_own_field_scopes_the_list(self):
        self.assertEqual(self._cidrs(self.mine.id), ["10.1.0.0/24"])

    def test_another_tenants_field_is_indistinguishable_from_a_missing_one(self):
        self.assertEqual(self._cidrs(self.theirs.id), [])
        self.assertEqual(self._cidrs(uuid.uuid4()), [])
        self.assertEqual(self._cidrs("not-a-uuid"), [])
