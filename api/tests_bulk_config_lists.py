"""Bulk select on the configuration lists: config contexts, config bundles,
export templates and label templates. Each list's bulk edit writes only the
simple fields it names, its bulk delete previews and keeps nothing it should
not touch, and both stay inside the caller's tenant and grant."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import ConfigBundle, ConfigContext, ExportTemplate, LabelTemplate


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("cfg-root", password="x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def member(self, slug, actions):
        user = User.objects.create_user(f"m-{slug}-{'-'.join(actions)}", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name="m", object_types=[slug],
                                            actions=list(actions))
        p.users.add(user)
        p.tenants.add(self.tenant)
        self.login(user)

    def post(self, url, action, ids, **body):
        return self.client.post(f"{url}{action}/", {"ids": [str(i) for i in ids], **body},
                                format="json")

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None


class ConfigContextBulkTests(_Base):
    URL = "/api/config-contexts/"

    def setUp(self):
        super().setUp()
        self.a = ConfigContext.objects.create(tenant=self.tenant, name="A", data={"x": 1})
        self.b = ConfigContext.objects.create(tenant=self.tenant, name="B")
        self.theirs = ConfigContext.objects.create(tenant=self.other, name="Theirs")

    def test_describes_its_fields(self):
        body = self.ok(self.client.get(f"{self.URL}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]],
                         ["is_active", "weight", "description"])
        self.assertFalse(body["tags"])

    def test_bulk_edit_writes_this_tenants_rows_and_logs_them(self):
        body = self.ok(self.post(self.URL, "bulk-update", [self.a.id, self.b.id, self.theirs.id],
                                 fields={"is_active": False, "weight": 500}))
        self.assertEqual(body["updated"], 2)
        self.a.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual((self.a.is_active, self.a.weight), (False, 500))
        self.assertTrue(self.theirs.is_active)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.configcontext", object_id=str(self.a.pk)).exists())

    def test_bulk_edit_refuses_what_it_does_not_offer(self):
        for fields in ({"data": {"y": 2}}, {"name": "Z"}, {"weight": "lots"}):
            r = self.post(self.URL, "bulk-update", [self.a.id], fields=fields)
            self.assertEqual(r.status_code, 400, fields)
        self.a.refresh_from_db()
        self.assertEqual((self.a.name, self.a.data), ("A", {"x": 1}))

    def test_bulk_delete_previews_then_deletes_only_this_tenants(self):
        body = self.ok(self.post(self.URL, "bulk-delete", [self.a.id, self.theirs.id],
                                 dry_run=True))
        self.assertEqual((body["deleted_ids"], body["skipped"]), ([str(self.a.id)], []))
        self.assertTrue(ConfigContext.objects.filter(pk=self.a.pk).exists())
        body = self.ok(self.post(self.URL, "bulk-delete", [self.a.id, self.theirs.id]))
        self.assertEqual(body["deleted"], 1)
        self.assertFalse(ConfigContext.objects.filter(pk=self.a.pk).exists())
        self.assertTrue(ConfigContext.objects.filter(pk=self.theirs.pk).exists())

    def test_grants(self):
        self.member("configcontext", ["view", "change"])
        self.assertEqual(self.post(self.URL, "bulk-delete", [self.a.id]).status_code, 403)
        self.member("configcontext", ["view", "delete"])
        self.assertEqual(self.post(self.URL, "bulk-update", [self.a.id],
                                   fields={"description": "x"}).status_code, 403)
        self.assertTrue(ConfigContext.objects.filter(pk=self.a.pk, description="").exists())


class ConfigBundleBulkTests(_Base):
    URL = "/api/config-bundles/"

    def setUp(self):
        super().setUp()
        self.a = ConfigBundle.objects.create(tenant=self.tenant, name="A")
        self.theirs = ConfigBundle.objects.create(tenant=self.other, name="Theirs")

    def test_edit_and_delete(self):
        body = self.ok(self.client.get(f"{self.URL}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]], ["description"])
        self.ok(self.post(self.URL, "bulk-update", [self.a.id, self.theirs.id],
                          fields={"description": "Core"}))
        self.a.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual((self.a.description, self.theirs.description), ("Core", ""))
        body = self.ok(self.post(self.URL, "bulk-delete", [self.a.id, self.theirs.id]))
        self.assertEqual(body["deleted_ids"], [str(self.a.id)])
        self.assertTrue(ConfigBundle.objects.filter(pk=self.theirs.pk).exists())

    def test_delete_needs_the_grant(self):
        self.member("configbundle", ["view", "change"])
        self.assertEqual(self.post(self.URL, "bulk-delete", [self.a.id]).status_code, 403)


class ExportTemplateBulkTests(_Base):
    URL = "/api/export-templates/"

    def setUp(self):
        super().setUp()
        self.a = ExportTemplate.objects.create(tenant=self.tenant, name="A",
                                               object_type="device", template_code="x")
        self.b = ExportTemplate.objects.create(tenant=self.tenant, name="B",
                                               object_type="device", template_code="y")
        self.bundle = ConfigBundle.objects.create(tenant=self.tenant, name="Core")
        self.bundle.templates.add(self.a)
        self.theirs = ExportTemplate.objects.create(tenant=self.other, name="Theirs",
                                                    object_type="device", template_code="z")

    def test_preview_names_the_template_in_a_bundle(self):
        body = self.ok(self.post(self.URL, "bulk-delete", [self.a.id, self.b.id], dry_run=True))
        self.assertEqual(sorted(body["deleted_ids"]), sorted([str(self.a.id), str(self.b.id)]))
        self.assertEqual(body["notes"], [{"id": str(self.a.id), "name": "A",
                                          "label": "In a config bundle",
                                          "detail": "Leaves 1 bundle."}])
        self.ok(self.post(self.URL, "bulk-delete", [self.a.id, self.theirs.id]))
        self.assertFalse(ExportTemplate.objects.filter(pk=self.a.pk).exists())
        self.assertEqual(list(self.bundle.templates.all()), [])
        self.assertTrue(ExportTemplate.objects.filter(pk=self.theirs.pk).exists())

    def test_edit_writes_the_simple_fields_only(self):
        self.ok(self.post(self.URL, "bulk-update", [self.a.id, self.b.id],
                          fields={"as_attachment": False, "description": "Inventory"}))
        self.a.refresh_from_db()
        self.assertEqual((self.a.as_attachment, self.a.description), (False, "Inventory"))
        r = self.post(self.URL, "bulk-update", [self.a.id], fields={"template_code": "{{ x }}"})
        self.assertEqual(r.status_code, 400)


class LabelTemplateBulkTests(_Base):
    URL = "/api/label-templates/"

    def setUp(self):
        super().setUp()
        self.a = LabelTemplate.objects.create(tenant=self.tenant, name="A", object_type="device")
        self.theirs = LabelTemplate.objects.create(tenant=self.other, name="Theirs",
                                                   object_type="device")

    def test_edit_and_delete(self):
        body = self.ok(self.client.get(f"{self.URL}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]], ["qr_enabled", "description"])
        self.ok(self.post(self.URL, "bulk-update", [self.a.id, self.theirs.id],
                          fields={"qr_enabled": False}))
        self.a.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual((self.a.qr_enabled, self.theirs.qr_enabled), (False, True))
        self.assertEqual(self.post(self.URL, "bulk-update", [self.a.id],
                                   fields={"is_default": True}).status_code, 400)
        body = self.ok(self.post(self.URL, "bulk-delete", [self.a.id, self.theirs.id]))
        self.assertEqual(body["deleted"], 1)
        self.assertTrue(LabelTemplate.objects.filter(pk=self.theirs.pk).exists())

    def test_edit_needs_the_grant(self):
        self.member("labeltemplate", ["view", "delete"])
        self.assertEqual(self.post(self.URL, "bulk-update", [self.a.id],
                                   fields={"description": "x"}).status_code, 403)
        self.assertEqual(self.client.get(f"{self.URL}bulk-edit-fields/").status_code, 403)

    def test_export_selected(self):
        r = self.client.post("/api/io/labeltemplate/export/",
                             {"fmt": "json", "ids": [str(self.a.id), str(self.theirs.id)]},
                             format="json")
        self.assertEqual(r.status_code, 200)
        text = b"".join(r.streaming_content).decode()
        self.assertIn(str(self.a.id), text)
        self.assertNotIn(str(self.theirs.id), text)
