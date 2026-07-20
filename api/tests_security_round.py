"""Security-round regression tests (issue #111): RBAC on SNMP/discovery
writes, secrets encrypted at rest, and bulk tag edits that actually work and
land in the change log."""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from django.db import connection
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Prefix
from api.test_utils import status_for
from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import Organization, Tag, Tenant


class _TenantClientMixin:
    @classmethod
    def _base(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        cls.prefix = Prefix.objects.create(
            tenant=cls.tenant, cidr="10.0.0.0/30", status=status_for(cls.tenant)
        )

    def _user(self, name, group=None, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        if group:
            u.groups.add(Group.objects.get(name=group))
        return u

    def _client(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class SnmpDiscoveryRbacTests(_TenantClientMixin, APITestCase):
    """Read-only members must not manage SNMP credentials, rebind them, or
    seed IPs via discovery/sweeps — all were IsAuthenticated-only before."""

    @classmethod
    def setUpTestData(cls):
        cls._base()

    def test_reader_cannot_manage_snmp_profiles(self):
        self._client(self._user("ro", group="Read-only"))
        self.assertEqual(
            self.client.get("/api/monitoring/snmp-profiles/").status_code, 200
        )
        r = self.client.post(
            "/api/monitoring/snmp-profiles/",
            {"name": "evil", "slug": "evil", "version": "v2c",
             "params": {"community": "public"}},
            format="json",
        )
        self.assertEqual(r.status_code, 403)

    def test_reader_cannot_rebind_snmp_profile(self):
        self._client(self._user("ro2", group="Read-only"))
        r = self.client.put(
            f"/api/monitoring/snmp-binding/device/{self.prefix.id}/",
            {"profile_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, 403)

    def test_reader_cannot_discover(self):
        self._client(self._user("ro3", group="Read-only"))
        for url in (
            f"/api/monitoring/prefixes/{self.prefix.id}/discover/",
            "/api/monitoring/bulk-discover/",
        ):
            r = self.client.post(url, {}, format="json")
            self.assertEqual(r.status_code, 403, url)

    def test_operator_passes_the_gate(self):
        # Operator holds ipaddress.add — the gate opens. bulk-discover with no
        # ids returns the early empty summary; no network activity involved.
        self._client(self._user("op", group="Operator"))
        r = self.client.post("/api/monitoring/bulk-discover/", {}, format="json")
        self.assertEqual(r.status_code, 200)

    def test_bulk_status_prefix_list_capped(self):
        self._client(self._user("ro4", group="Read-only"))
        ids = ",".join(str(self.prefix.id) for _ in range(501))
        r = self.client.get(f"/api/monitoring/status/?prefixes={ids}")
        self.assertEqual(r.status_code, 400)


class BulkTagTests(_TenantClientMixin, APITestCase):
    """Bulk tag add/remove previously passed raw pks to taggit (ValueError on
    add, silent no-op on remove) and never reached the change log."""

    @classmethod
    def setUpTestData(cls):
        cls._base()
        cls.p2 = Prefix.objects.create(
            tenant=cls.tenant, cidr="10.0.1.0/30", status=status_for(cls.tenant)
        )
        cls.tag = Tag.objects.create(name="prod", slug="prod")

    def setUp(self):
        self._client(self._user("admin", superuser=True))

    def test_bulk_add_and_remove_tags_apply_and_log(self):
        ids = [str(self.prefix.id), str(self.p2.id)]
        r = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": ids, "fields": {"add_tag_ids": [self.tag.id]}},
            format="json",
        )
        self.assertEqual(r.status_code, 200)
        self.prefix.refresh_from_db()
        self.assertEqual(
            list(self.prefix.tags.values_list("name", flat=True)), ["prod"]
        )
        logged = ChangeLogEntry.objects.filter(
            object_type="api.prefix", action="update",
            changes__tags__new__contains=["prod"],
        )
        self.assertEqual(logged.count(), 2)

        r = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": ids, "fields": {"remove_tag_ids": [self.tag.id]}},
            format="json",
        )
        self.assertEqual(r.status_code, 200)
        self.prefix.refresh_from_db()
        self.assertEqual(self.prefix.tags.count(), 0)
        removed = ChangeLogEntry.objects.filter(
            object_type="api.prefix", action="update",
            changes__tags__old__contains=["prod"],
        )
        self.assertEqual(removed.count(), 2)

    def test_noop_tag_add_not_logged(self):
        self.prefix.tags.add(self.tag)
        before = ChangeLogEntry.objects.count()
        r = self.client.post(
            "/api/prefixes/bulk-update/",
            {"ids": [str(self.prefix.id)], "fields": {"add_tag_ids": [self.tag.id]}},
            format="json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(ChangeLogEntry.objects.count(), before)


class SecretsAtRestTests(TestCase):
    """Webhook signing secrets and AWX tokens must be ciphertext in the DB."""

    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _raw(self, table, column, pk):
        with connection.cursor() as cur:
            cur.execute(f"SELECT {column} FROM {table} WHERE id = %s", [str(pk)])
            return cur.fetchone()[0]

    def test_webhook_secret_encrypted(self):
        from integrations.models import Webhook

        w = Webhook.objects.create(
            tenant=self.tenant, name="hook",
            payload_url="https://example.com/x", secret="tophat-123",
        )
        raw = self._raw("integrations_webhook", "secret", w.id)
        self.assertNotIn("tophat-123", raw)
        w.refresh_from_db()
        self.assertEqual(w.secret, "tophat-123")

    def test_awx_token_encrypted(self):
        from integrations.models import AutomationTarget

        t = AutomationTarget.objects.create(
            tenant=self.tenant, name="awx", kind="awx",
            base_url="https://awx.local", token="bearer-xyz",
        )
        raw = self._raw("integrations_automationtarget", "token", t.id)
        self.assertNotIn("bearer-xyz", raw)
        t.refresh_from_db()
        self.assertEqual(t.token, "bearer-xyz")
