"""Tests for per-tenant human-readable object numbers (numid) - issue #82."""
from __future__ import annotations

from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from api.management.commands.assign_numids import Command
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
        # Each tenant counts from 1 independently - A's #1 and B's #1 are
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
        # freshly allocated numid - not burn the sequence and leave it NULL.
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


class AssignNumidsBatchTests(TestCase):
    """``assign_numids`` numbers in bounded batches, one transaction each (#362)."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.t_a = Tenant.objects.create(org=org, name="A", slug="a")
        self.t_b = Tenant.objects.create(org=org, name="B", slug="b")

    def _unnumbered(self, tenant, n):
        cables = [Cable.objects.create(tenant=tenant) for _ in range(n)]
        Cable.objects.filter(tenant=tenant).update(numid=None)
        NumIdSequence.objects.filter(tenant=tenant).delete()
        return cables

    def _numids(self, cables):
        return [Cable.objects.get(pk=c.pk).numid for c in cables]

    def test_batches_number_in_creation_order_without_gaps(self):
        cables = self._unnumbered(self.t_a, 7)
        with patch.object(
            Command, "_assign_batch", autospec=True, side_effect=Command._assign_batch,
        ) as spy:
            call_command("assign_numids", batch_size=3, stdout=StringIO())
        self.assertEqual(self._numids(cables), [1, 2, 3, 4, 5, 6, 7])
        # 3 + 3 + 1 rows: three batches, the short one ends the tenant.
        cable_batches = [c for c in spy.call_args_list if c.args[1] is Cable]
        self.assertEqual(len(cable_batches), 3)
        seq = NumIdSequence.objects.get(tenant=self.t_a, model_label="api.cable")
        self.assertEqual(seq.last_value, 7)
        self.assertEqual(Cable.objects.create(tenant=self.t_a).numid, 8)

    def test_exact_multiple_of_batch_size(self):
        cables = self._unnumbered(self.t_a, 4)
        call_command("assign_numids", batch_size=2, stdout=StringIO())
        self.assertEqual(self._numids(cables), [1, 2, 3, 4])

    def test_continues_after_existing_numbers_and_counter(self):
        cables = [Cable.objects.create(tenant=self.t_a) for _ in range(5)]
        # 1-2 keep their numbers, 3-5 lose them, and the counter sits past
        # them as if later creates had been deleted.
        Cable.objects.filter(pk__in=[c.pk for c in cables[2:]]).update(numid=None)
        NumIdSequence.objects.filter(tenant=self.t_a).update(last_value=10)
        call_command("assign_numids", batch_size=2, stdout=StringIO())
        self.assertEqual(self._numids(cables), [1, 2, 11, 12, 13])

    def test_starts_above_numbers_the_counter_never_saw(self):
        cables = [Cable.objects.create(tenant=self.t_a) for _ in range(3)]
        Cable.objects.filter(pk=cables[0].pk).update(numid=40)
        Cable.objects.filter(pk__in=[c.pk for c in cables[1:]]).update(numid=None)
        NumIdSequence.objects.filter(tenant=self.t_a).delete()
        call_command("assign_numids", batch_size=1, stdout=StringIO())
        self.assertEqual(self._numids(cables), [40, 41, 42])

    def test_tenants_numbered_independently(self):
        a = self._unnumbered(self.t_a, 3)
        b = self._unnumbered(self.t_b, 2)
        call_command("assign_numids", batch_size=2, stdout=StringIO())
        self.assertEqual(self._numids(a), [1, 2, 3])
        self.assertEqual(self._numids(b), [1, 2])

    def test_interrupted_run_keeps_finished_batches_and_resumes(self):
        cables = self._unnumbered(self.t_a, 5)
        calls = {"n": 0}
        real = Command._assign_batch

        def stop_on_second(cmd, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise KeyboardInterrupt
            return real(cmd, *args, **kwargs)

        with patch.object(
            Command, "_assign_batch", autospec=True, side_effect=stop_on_second,
        ), self.assertRaises(KeyboardInterrupt):
            call_command("assign_numids", batch_size=2, stdout=StringIO())
        # The first batch is committed and the counter matches it.
        self.assertEqual(self._numids(cables), [1, 2, None, None, None])
        seq = NumIdSequence.objects.get(tenant=self.t_a, model_label="api.cable")
        self.assertEqual(seq.last_value, 2)

        call_command("assign_numids", batch_size=2, stdout=StringIO())
        self.assertEqual(self._numids(cables), [1, 2, 3, 4, 5])

    def test_rerun_is_a_no_op(self):
        cables = self._unnumbered(self.t_a, 3)
        call_command("assign_numids", stdout=StringIO())
        out = StringIO()
        call_command("assign_numids", stdout=out)
        self.assertIn("Assigned 0 numid(s).", out.getvalue())
        self.assertEqual(self._numids(cables), [1, 2, 3])

    def test_rejects_non_positive_batch_size(self):
        with self.assertRaises(CommandError):
            call_command("assign_numids", batch_size=0, stdout=StringIO())
