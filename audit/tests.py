"""Change-log signal behaviour."""
from __future__ import annotations

from django.test import TestCase

from api.models import Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from .models import ChangeLogEntry


class ChangeLogTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")

    def test_create_logged(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", status=status_for(self.tenant)
        )
        e = ChangeLogEntry.objects.get(object_id=str(p.id))
        self.assertEqual(e.action, "create")
        self.assertEqual(e.object_type, "api.prefix")
        self.assertEqual(e.tenant_id, self.tenant.id)

    def test_update_logs_field_diff(self):
        reserved = status_for(self.tenant, "reserved")
        active = status_for(self.tenant)
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", status=reserved
        )
        p.status = active
        p.save()
        upd = ChangeLogEntry.objects.filter(object_id=str(p.id), action="update").get()
        # status is a FK now → the diff records the Status UUIDs (status_id).
        self.assertEqual(
            upd.changes["status"], {"old": str(reserved.id), "new": str(active.id)}
        )

    def test_noop_save_not_logged(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.3.0.0/24", status=status_for(self.tenant)
        )
        before = ChangeLogEntry.objects.filter(object_id=str(p.id)).count()
        p.save()  # nothing changed
        after = ChangeLogEntry.objects.filter(object_id=str(p.id)).count()
        self.assertEqual(before, after)

    def test_delete_logged(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.4.0.0/24", status=status_for(self.tenant)
        )
        pid = str(p.id)
        p.delete()
        self.assertTrue(
            ChangeLogEntry.objects.filter(object_id=pid, action="delete").exists()
        )
