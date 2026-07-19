"""Custom-field group API tests — CRUD, auto-slug, tenant scoping, and the
group read-fields the frontend renders sections from."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from auth_api.object_types import is_registered
from core.models import Organization, Tenant
from customization.models import CustomField, CustomFieldGroup


class RbacRegistrationTests(SimpleTestCase):
    """Guard against the dead-path bug: these models live in `customization`,
    so an `api.CustomField` registry path silently fails to resolve and leaves
    them RBAC-uncontrolled."""

    def test_custom_field_types_are_registered(self):
        self.assertTrue(is_registered("customfield"))
        self.assertTrue(is_registered("customfieldgroup"))


class CustomFieldGroupTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Beta", slug="beta")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _make_group(self, name="Monitoring", **extra):
        r = self.client.post(
            "/api/custom-field-groups/", {"name": name, **extra}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def test_create_auto_slugs_and_defaults(self):
        g = self._make_group("Monitoring Stack")
        self.assertEqual(g["slug"], "monitoring-stack")
        self.assertEqual(g["weight"], 0)
        self.assertFalse(g["collapsed"])
        self.assertEqual(g["field_count"], 0)

    def test_slug_unique_per_tenant(self):
        self._make_group("Monitoring")
        r = self.client.post(
            "/api/custom-field-groups/", {"name": "Monitoring"}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_assign_group_to_field_and_read_back(self):
        g = self._make_group("Monitoring", weight=5, collapsed=True)
        r = self.client.post(
            "/api/custom-fields/",
            {"key": "install_btop", "label": "Install btop", "type": "boolean",
             "applies_to": ["device"], "group": g["id"]},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["group"], g["id"])
        self.assertEqual(body["group_name"], "Monitoring")
        self.assertEqual(body["group_weight"], 5)
        self.assertTrue(body["group_collapsed"])
        # field_count reflects the assignment.
        g2 = self.client.get(f"/api/custom-field-groups/{g['id']}/").json()
        self.assertEqual(g2["field_count"], 1)

    def test_cannot_assign_other_tenants_group(self):
        foreign = CustomFieldGroup.objects.create(
            tenant=self.other, name="Foreign", slug="foreign"
        )
        r = self.client.post(
            "/api/custom-fields/",
            {"key": "x", "label": "X", "type": "text",
             "applies_to": ["device"], "group": str(foreign.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_deleting_group_ungroups_its_fields(self):
        g = self._make_group("Temp")
        cf = CustomField.objects.create(
            tenant=self.tenant, key="k", label="K", applies_to=["device"],
            group=CustomFieldGroup.objects.get(id=g["id"]),
        )
        r = self.client.delete(f"/api/custom-field-groups/{g['id']}/")
        self.assertEqual(r.status_code, 204, r.content)
        cf.refresh_from_db()
        self.assertIsNone(cf.group_id)

    def test_group_list_tenant_scoped(self):
        CustomFieldGroup.objects.create(
            tenant=self.other, name="Foreign", slug="foreign"
        )
        self._make_group("Mine")
        rows = self.client.get("/api/custom-field-groups/").json()["results"]
        names = {r["name"] for r in rows}
        self.assertIn("Mine", names)
        self.assertNotIn("Foreign", names)
