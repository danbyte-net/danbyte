"""Bulk edit and delete on the VLAN list (#176).

The list ticks rows and sends them to ``bulk-update`` / ``bulk-delete``; the
edit page sets status, site, zone, VRF, description and tags. These pin the
endpoint half: fields land, clears land, another tenant's objects are refused
or untouched, and every row that changed leaves a change-log entry.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeAction, ChangeLogEntry
from core.models import Organization, Tenant

from .models import VLAN, VRF, Site

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        self.kyiv = Site.objects.create(tenant=self.tenant, name="Kyiv")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def vlan(self, vid, **kw):
        kw.setdefault("site", self.kyiv)
        return VLAN.objects.create(tenant=self.tenant, vlan_id=vid, name=f"v{vid}", **kw)

    def update(self, rows, **fields):
        return self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(r.id) for r in rows], "fields": fields},
            format="json",
        )

    def logged(self, action, rows):
        return set(
            ChangeLogEntry.objects.filter(
                action=action, object_id__in=[str(r.id) for r in rows]
            ).values_list("object_id", flat=True)
        )


class BulkEditTests(_Base):
    def test_sets_and_clears_the_vrf(self):
        prod = VRF.objects.create(tenant=self.tenant, name="PROD")
        a, b = self.vlan(10), self.vlan(20)
        r = self.update([a, b], vrf_id=str(prod.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.assertEqual(set(VLAN.objects.values_list("vrf_id", flat=True)), {prod.id})
        self.assertEqual(self.logged(ChangeAction.UPDATE, [a, b]), {str(a.id), str(b.id)})

        r = self.update([a], vrf_id=None)
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertIsNone(a.vrf_id)
        self.assertEqual(b.vrf_id, prod.id)

    def test_refuses_another_tenants_vrf(self):
        foreign = VRF.objects.create(tenant=self.other, name="THEIRS")
        a = self.vlan(10)
        r = self.update([a], vrf_id=str(foreign.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("vrf_id", r.json())
        a.refresh_from_db()
        self.assertIsNone(a.vrf_id)

    def test_sets_and_clears_the_description(self):
        a = self.vlan(10, description="old")
        b = self.vlan(20, description="")
        r = self.update([a, b], description="core uplinks")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            set(VLAN.objects.values_list("description", flat=True)), {"core uplinks"})

        r = self.update([a, b], description="")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(VLAN.objects.values_list("description", flat=True)), {""})

    def test_leaves_another_tenants_vlans_alone(self):
        mine = self.vlan(10)
        theirs = VLAN.objects.create(tenant=self.other, vlan_id=10, name="theirs")
        r = self.update([mine, theirs], description="touched")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 1)
        theirs.refresh_from_db()
        self.assertEqual(theirs.description, "")


class BulkDeleteTests(_Base):
    def delete(self, rows):
        return self.client.post(
            "/api/vlans/bulk-delete/", {"ids": [str(r.id) for r in rows]}, format="json")

    def test_deletes_the_selection_and_logs_each_row(self):
        a, b, keep = self.vlan(10), self.vlan(20), self.vlan(30)
        r = self.delete([a, b])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertEqual(list(VLAN.objects.values_list("id", flat=True)), [keep.id])
        self.assertEqual(self.logged(ChangeAction.DELETE, [a, b]), {str(a.id), str(b.id)})

    def test_another_tenants_vlan_survives(self):
        theirs = VLAN.objects.create(tenant=self.other, vlan_id=10, name="theirs")
        r = self.delete([theirs])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 0)
        self.assertTrue(VLAN.objects.filter(pk=theirs.pk).exists())

    def test_an_empty_selection_is_refused(self):
        r = self.client.post("/api/vlans/bulk-delete/", {"ids": []}, format="json")
        self.assertEqual(r.status_code, 400)
