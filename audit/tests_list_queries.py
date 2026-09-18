"""The change log resolves the FK ids in a page's diffs to labels in one
query per related model, not one per changed relation per row (#190)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import Prefix, Site
from core.models import Organization, Tenant

User = get_user_model()


class ChangeLogLabelBatchingTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.hq = Site.objects.create(tenant=self.tenant, name="HQ")
        self.dc = Site.objects.create(tenant=self.tenant, name="DC")
        for i in range(12):
            p = Prefix.objects.create(tenant=self.tenant, cidr=f"10.{i}.0.0/24", site=self.hq)
            p.site = self.dc
            p.save()

    def _queries(self, url):
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()

    def test_page_cost_is_flat_and_labels_resolve(self):
        small, _ = self._queries("/api/changelog/?action=update&page_size=2")
        big, body = self._queries("/api/changelog/?action=update&page_size=12")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        updates = [r for r in body["results"] if r["action"] == "update"]
        self.assertGreaterEqual(len(updates), 12)
        site = updates[0]["changes"]["site"]
        self.assertEqual(site["old_label"], "HQ")
        self.assertEqual(site["new_label"], "DC")
