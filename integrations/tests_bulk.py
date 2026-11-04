"""Bulk select on the Webhooks and Automation targets lists: enable and
disable through the bulk edit, safe bulk delete, export of the selection
without the write-only secrets, all inside the caller's tenant and grant."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import AutomationTarget, Webhook


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("int-root", password="x")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def member(self, slug, actions):
        user = User.objects.create_user(f"m-{slug}-{'-'.join(actions)}", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name="m", object_types=[slug],
                                            actions=list(actions))
        p.users.add(user)
        p.tenants.add(self.tenant)
        self.login(user)

    def post(self, action, ids, **body):
        return self.client.post(f"{self.URL}{action}/",
                                {"ids": [str(i) for i in ids], **body}, format="json")

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None

    def export(self, slug, ids):
        r = self.client.post(f"/api/io/{slug}/export/",
                             {"fmt": "json", "ids": [str(i) for i in ids]}, format="json")
        self.assertEqual(r.status_code, 200)
        return b"".join(r.streaming_content).decode()


class WebhookBulkTests(_Base):
    URL = "/api/webhooks/"

    def setUp(self):
        super().setUp()
        kw = {"object_types": ["device"], "payload_url": "https://hooks.example/x"}
        self.a = Webhook.objects.create(tenant=self.tenant, name="A", secret="s3cr3t-sign",
                                        additional_headers="Authorization: Bearer t0k3n",
                                        **kw)
        self.b = Webhook.objects.create(tenant=self.tenant, name="B", **kw)
        self.theirs = Webhook.objects.create(tenant=self.other, name="Theirs", **kw)

    def test_describes_its_fields(self):
        body = self.ok(self.client.get(f"{self.URL}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]],
                         ["enabled", "on_create", "on_update", "on_delete"])

    def test_disable_writes_this_tenants_rows_and_logs_them(self):
        body = self.ok(self.post("bulk-update", [self.a.id, self.b.id, self.theirs.id],
                                 fields={"enabled": False}))
        self.assertEqual(body["updated"], 2)
        self.assertFalse(Webhook.objects.filter(tenant=self.tenant, enabled=True).exists())
        self.theirs.refresh_from_db()
        self.assertTrue(self.theirs.enabled)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="integrations.webhook", object_id=str(self.a.pk)).exists())

    def test_secrets_are_no_bulk_edit(self):
        for fields in ({"secret": "x"}, {"additional_headers": "X: y"},
                       {"payload_url": "https://evil.example/"}, {"enabled": "yes"}):
            self.assertEqual(self.post("bulk-update", [self.a.id], fields=fields).status_code,
                             400, fields)
        self.a.refresh_from_db()
        self.assertEqual((self.a.secret, self.a.payload_url),
                         ("s3cr3t-sign", "https://hooks.example/x"))

    def test_export_selected_leaves_the_secrets_out(self):
        text = self.export("webhook", [self.a.id, self.theirs.id])
        self.assertIn(str(self.a.id), text)
        self.assertNotIn(str(self.theirs.id), text)
        self.assertNotIn("s3cr3t-sign", text)
        self.assertNotIn("t0k3n", text)

    def test_bulk_delete_previews_then_deletes_this_tenants(self):
        body = self.ok(self.post("bulk-delete", [self.a.id, self.theirs.id], dry_run=True))
        self.assertEqual(body["deleted_ids"], [str(self.a.id)])
        self.assertTrue(Webhook.objects.filter(pk=self.a.pk).exists())
        self.ok(self.post("bulk-delete", [self.a.id, self.theirs.id]))
        self.assertFalse(Webhook.objects.filter(pk=self.a.pk).exists())
        self.assertTrue(Webhook.objects.filter(pk=self.theirs.pk).exists())

    def test_grants(self):
        self.member("webhook", ["view", "delete"])
        self.assertEqual(self.post("bulk-update", [self.a.id],
                                   fields={"enabled": False}).status_code, 403)
        self.member("webhook", ["view", "change"])
        self.assertEqual(self.post("bulk-delete", [self.a.id]).status_code, 403)
        self.assertTrue(Webhook.objects.filter(pk=self.a.pk, enabled=True).exists())


class AutomationTargetBulkTests(_Base):
    URL = "/api/automation-targets/"

    def setUp(self):
        super().setUp()
        kw = {"kind": "awx", "base_url": "https://awx.example"}
        self.a = AutomationTarget.objects.create(tenant=self.tenant, name="A",
                                                 token="awx-t0k3n", **kw)
        self.theirs = AutomationTarget.objects.create(tenant=self.other, name="Theirs", **kw)

    def test_enable_disable_and_auto(self):
        body = self.ok(self.client.get(f"{self.URL}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]], ["enabled", "auto_on_change"])
        self.ok(self.post("bulk-update", [self.a.id, self.theirs.id],
                          fields={"enabled": False, "auto_on_change": True}))
        self.a.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual((self.a.enabled, self.a.auto_on_change), (False, True))
        self.assertTrue(self.theirs.enabled)
        self.assertEqual(self.post("bulk-update", [self.a.id],
                                   fields={"token": "x"}).status_code, 400)

    def test_export_selected_leaves_the_token_out(self):
        text = self.export("automationtarget", [self.a.id])
        self.assertIn(str(self.a.id), text)
        self.assertNotIn("awx-t0k3n", text)

    def test_bulk_delete(self):
        body = self.ok(self.post("bulk-delete", [self.a.id, self.theirs.id]))
        self.assertEqual(body["deleted"], 1)
        self.assertTrue(AutomationTarget.objects.filter(pk=self.theirs.pk).exists())

    def test_grants(self):
        self.member("automationtarget", ["view"])
        self.assertEqual(self.post("bulk-update", [self.a.id],
                                   fields={"enabled": False}).status_code, 403)
        self.assertEqual(self.post("bulk-delete", [self.a.id]).status_code, 403)
