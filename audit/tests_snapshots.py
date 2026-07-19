"""Change-log pre/post snapshots + the detail endpoint that serves them.

The snapshots power the NetBox-style changelog detail page (Difference +
Pre-/Post-Change Data panels): create stores the post state, update stores
both, delete stores the pre state.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from .models import ChangeLogEntry

User = get_user_model()


class SnapshotSignalTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def test_create_stores_post_only(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", status=status_for(self.tenant)
        )
        e = ChangeLogEntry.objects.get(object_id=str(p.id), action="create")
        self.assertIsNone(e.pre_change)
        self.assertEqual(e.post_change["cidr"], "10.1.0.0/24")

    def test_update_stores_both(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", status=status_for(self.tenant)
        )
        p.description = "core range"
        p.save()
        e = ChangeLogEntry.objects.get(object_id=str(p.id), action="update")
        self.assertEqual(e.pre_change["description"], "")
        self.assertEqual(e.post_change["description"], "core range")
        # The full row is snapshotted, not just the changed field.
        self.assertEqual(e.pre_change["cidr"], "10.2.0.0/24")
        self.assertEqual(e.post_change["cidr"], "10.2.0.0/24")

    def test_delete_stores_pre_only(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.3.0.0/24", status=status_for(self.tenant)
        )
        pid = str(p.id)
        p.delete()
        e = ChangeLogEntry.objects.get(object_id=pid, action="delete")
        self.assertEqual(e.pre_change["cidr"], "10.3.0.0/24")
        self.assertIsNone(e.post_change)


class ChangeLogDetailApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", status=status_for(self.tenant)
        )
        p.description = "changed"
        p.save()
        self.entry = ChangeLogEntry.objects.get(
            object_id=str(p.id), action="update"
        )

    def test_detail_returns_snapshots(self):
        resp = self.client.get(f"/api/changelog/{self.entry.id}/")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["pre_change"]["description"], "")
        self.assertEqual(data["post_change"]["description"], "changed")
        self.assertEqual(data["changes"]["description"]["new"], "changed")

    def test_list_omits_snapshots(self):
        resp = self.client.get("/api/changelog/")
        self.assertEqual(resp.status_code, 200)
        row = resp.json()["results"][0]
        self.assertNotIn("pre_change", row)
        self.assertNotIn("post_change", row)

    def test_related_labels_resolve_fk_uuids(self):
        """FK UUIDs anywhere in the entry (snapshots + diff) get a human label
        in the flat related_labels map; non-FK fields are absent from it."""
        resp = self.client.get(f"/api/changelog/{self.entry.id}/")
        labels = resp.json()["related_labels"]
        # The prefix's tenant FK is in the snapshots — its UUID resolves to the
        # tenant's name.
        self.assertEqual(labels.get(str(self.tenant.id)), str(self.tenant))
        # A plain scalar value ("changed") is never treated as a relation.
        self.assertNotIn("changed", labels)

    def test_related_labels_absent_from_list(self):
        resp = self.client.get("/api/changelog/")
        self.assertNotIn("related_labels", resp.json()["results"][0])

    def test_foreign_tenant_entry_404s(self):
        foreign = Prefix.objects.create(
            tenant=self.other, cidr="10.10.0.0/24", status=status_for(self.other)
        )
        e = ChangeLogEntry.objects.get(object_id=str(foreign.id))
        resp = self.client.get(f"/api/changelog/{e.id}/")
        self.assertEqual(resp.status_code, 404)


class SecretRedactionTests(TestCase):
    """Credentials must never enter the change log in cleartext — not in the
    field diff, not in the snapshots. EncryptedJSONField columns decrypt
    transparently on read, so without redaction the SMTP/LDAP passwords and
    check credentials would be logged decrypted (and DeploymentSettings entries
    are tenant-less, i.e. readable by any authenticated user)."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _entry_json(self, entry) -> str:
        import json

        return json.dumps(
            [entry.changes, entry.pre_change, entry.post_change], default=str
        )

    def test_deployment_secrets_redacted(self):
        from core.models import DeploymentSettings

        s = DeploymentSettings.objects.create(
            id=2, secrets={"password": "hunter2-smtp"}
        )
        s.secrets = {"password": "rotated-smtp"}
        s.save()
        for e in ChangeLogEntry.objects.filter(
            object_type="core.deploymentsettings"
        ):
            blob = self._entry_json(e)
            self.assertNotIn("hunter2-smtp", blob)
            self.assertNotIn("rotated-smtp", blob)
        created = ChangeLogEntry.objects.get(
            object_type="core.deploymentsettings", action="create"
        )
        # Presence is still recorded — just never the value.
        self.assertEqual(created.post_change["secrets"], "•••")

    def test_webhook_secret_redacted(self):
        from integrations.models import Webhook

        w = Webhook.objects.create(
            tenant=self.tenant, name="hook", payload_url="https://example.com/x",
            secret="signing-key-123",
        )
        w.secret = "signing-key-456"
        w.save()
        for e in ChangeLogEntry.objects.filter(object_type="integrations.webhook"):
            blob = self._entry_json(e)
            self.assertNotIn("signing-key-123", blob)
            self.assertNotIn("signing-key-456", blob)

    def test_check_template_secret_params_redacted(self):
        from monitoring.models import CheckTemplate

        t = CheckTemplate.objects.create(
            tenant=self.tenant, name="ssh", slug="ssh", kind="ssh",
            secret_params={"password": "root-pw"},
        )
        t.delete()
        for e in ChangeLogEntry.objects.filter(
            object_type="monitoring.checktemplate"
        ):
            self.assertNotIn("root-pw", self._entry_json(e))

    def test_non_secret_fields_still_logged(self):
        from integrations.models import Webhook

        w = Webhook.objects.create(
            tenant=self.tenant, name="hook2", payload_url="https://example.com/y",
            secret="sh",
        )
        w.name = "hook2-renamed"
        w.save()
        upd = ChangeLogEntry.objects.get(
            object_type="integrations.webhook", object_id=str(w.id),
            action="update",
        )
        self.assertEqual(upd.changes["name"]["new"], "hook2-renamed")
        self.assertEqual(upd.post_change["payload_url"], "https://example.com/y")
