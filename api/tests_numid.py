"""Tests for per-tenant human-readable object numbers (numid) — issue #82."""
from __future__ import annotations

from django.core.management import call_command
from django.test import TestCase

from api.models import Cable, NumIdSequence
from core.models import Organization, Tenant


class NumIdTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.t_a = Tenant.objects.create(org=org, name="A", slug="a")
        self.t_b = Tenant.objects.create(org=org, name="B", slug="b")

    def test_numbering_is_per_tenant_and_monotonic(self):
        a1 = Cable.objects.create(tenant=self.t_a)
        b1 = Cable.objects.create(tenant=self.t_b)
        a2 = Cable.objects.create(tenant=self.t_a)
        # Each tenant counts from 1 independently — A's #1 and B's #1 are
        # different objects that don't collide.
        self.assertEqual(a1.numid, 1)
        self.assertEqual(b1.numid, 1)
        self.assertEqual(a2.numid, 2)
        self.assertNotEqual(a1.pk, b1.pk)

    def test_numid_stable_across_resave(self):
        c = Cable.objects.create(tenant=self.t_a)
        first = c.numid
        c.description = "moved"
        c.save()
        c.refresh_from_db()
        self.assertEqual(c.numid, first)

    def test_allocation_persists_under_scoped_update_fields(self):
        # A null-numid row saved with update_fields= that omits "numid" (the
        # common ip.save(update_fields=["role"]) pattern) must still persist the
        # freshly allocated numid — not burn the sequence and leave it NULL.
        c = Cable.objects.create(tenant=self.t_a)
        Cable.objects.filter(pk=c.pk).update(numid=None)
        NumIdSequence.objects.all().delete()

        c.refresh_from_db()
        self.assertIsNone(c.numid)
        c.description = "edited"
        c.save(update_fields=["description", "updated_at"])

        c.refresh_from_db()
        self.assertIsNotNone(c.numid)  # persisted despite not being in update_fields
        first = c.numid
        # And it's stable: a subsequent scoped save doesn't re-allocate.
        c.description = "again"
        c.save(update_fields=["description", "updated_at"])
        c.refresh_from_db()
        self.assertEqual(c.numid, first)

    def test_str_prefers_label_then_numid_then_uuid(self):
        c = Cable.objects.create(tenant=self.t_a)
        self.assertEqual(str(c), f"Cable #{c.numid}")
        c.label = "Patch-27"
        self.assertEqual(str(c), "Patch-27")

    def test_backfill_assigns_missing_numids(self):
        c1 = Cable.objects.create(tenant=self.t_a)
        c2 = Cable.objects.create(tenant=self.t_a)
        # Simulate rows that predate the field / were bulk_created.
        Cable.objects.update(numid=None)
        NumIdSequence.objects.all().delete()

        call_command("assign_numids")

        c1.refresh_from_db()
        c2.refresh_from_db()
        # Assigned in creation order, 1-based, no gaps.
        self.assertEqual(c1.numid, 1)
        self.assertEqual(c2.numid, 2)
        # The sequence is advanced so the next create continues at 3.
        c3 = Cable.objects.create(tenant=self.t_a)
        self.assertEqual(c3.numid, 3)
