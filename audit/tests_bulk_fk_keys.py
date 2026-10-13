"""A bulk edit of a relation reads like a single edit in the change log.

``bulk-update`` writes with ``queryset.update(status_id=…)``. The entry is
keyed by the field (``status``) so the change log resolves the status name,
and older entries keyed by the column still show as the field.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import VLAN, Site
from api.test_utils import status_for
from audit.models import ChangeAction, ChangeLogEntry
from core.models import Organization, Tenant

User = get_user_model()


class BulkRelationKeyTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=self.tenant, name="Kyiv")
        self.active = status_for(self.tenant, "active")
        self.reserved = status_for(self.tenant, "reserved")
        self.vlan = VLAN.objects.create(
            tenant=self.tenant, site=site, vlan_id=10, name="v10", status=self.active
        )
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def changes(self):
        r = self.client.get(
            f"/api/changelog/?object_type=api.vlan&object_id={self.vlan.id}"
        )
        self.assertEqual(r.status_code, 200)
        return r.json()["results"][0]["changes"]

    def test_bulk_status_logged_under_field_name(self):
        r = self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(self.vlan.id)], "fields": {"status_id": str(self.reserved.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        entry = ChangeLogEntry.objects.get(
            object_id=str(self.vlan.id), action=ChangeAction.UPDATE
        )
        self.assertEqual(list(entry.changes), ["status"])
        status = self.changes()["status"]
        self.assertEqual(status["old_label"], str(self.active))
        self.assertEqual(status["new_label"], str(self.reserved))

    def test_old_column_keyed_entry_reads_as_field(self):
        ChangeLogEntry.objects.create(
            tenant=self.tenant,
            action=ChangeAction.UPDATE,
            object_type="api.vlan",
            object_label="VLAN",
            object_id=str(self.vlan.id),
            object_repr=str(self.vlan),
            changes={"status_id": {"old": str(self.active.id), "new": str(self.reserved.id)}},
        )
        changes = self.changes()
        self.assertNotIn("status_id", changes)
        self.assertEqual(changes["status"]["new_label"], str(self.reserved))
