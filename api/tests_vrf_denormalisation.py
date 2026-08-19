"""IPAddress.vrf and IPRange.vrf are derived from the parent prefix.

Both are denormalised columns: the prefix decides the routing context and the
row follows it. Two ways that used to leak:

* a scoped ``save(update_fields=[...])`` wrote only the listed columns, so the
  derived VRF was computed and then thrown away;
* ``IPRange`` had no ``save()`` at all - only the serializer applied the rule,
  so anything created straight through the ORM kept the wrong VRF.
"""
from __future__ import annotations

from django.test import TestCase

from api.models import VRF, IPAddress, IPRange, Prefix
from core.models import Organization, Tenant


class VrfDenormalisationTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.vrf = VRF.objects.create(tenant=self.tenant, name="prod")
        self.globl = Prefix.objects.create(
            tenant=self.tenant, cidr="10.80.0.0/24"
        )
        self.in_vrf = Prefix.objects.create(
            tenant=self.tenant, cidr="10.81.0.0/24", vrf=self.vrf
        )

    # ── IPAddress ────────────────────────────────────────────────────────
    def test_ip_takes_its_prefixs_vrf(self):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.81.0.5", prefix=self.in_vrf
        )
        self.assertEqual(ip.vrf_id, self.vrf.id)

    def test_scoped_save_still_persists_the_derived_vrf(self):
        """A save(update_fields=…) that omits "vrf" must not drop it.

        Re-fetch rather than trusting the in-memory object - the value was
        always right in memory, which is exactly what hid this.
        """
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.80.0.5", prefix=self.globl
        )
        self.assertIsNone(ip.vrf_id)

        ip.prefix = self.in_vrf
        ip.save(update_fields=["prefix"])

        self.assertEqual(
            IPAddress.objects.get(pk=ip.pk).vrf_id, self.vrf.id,
            "vrf was computed but not written",
        )

    def test_scoped_save_without_a_vrf_change_is_untouched(self):
        """The helper only widens update_fields when it actually derives."""
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.81.0.6", prefix=self.in_vrf,
            description="before",
        )
        ip.description = "after"
        ip.save(update_fields=["description"])
        row = IPAddress.objects.get(pk=ip.pk)
        self.assertEqual(row.description, "after")
        self.assertEqual(row.vrf_id, self.vrf.id)

    # ── IPRange ──────────────────────────────────────────────────────────
    def test_range_takes_its_prefixs_vrf_through_the_orm(self):
        rng = IPRange.objects.create(
            tenant=self.tenant, prefix=self.in_vrf,
            start_address="10.81.0.10", end_address="10.81.0.20",
        )
        self.assertEqual(IPRange.objects.get(pk=rng.pk).vrf_id, self.vrf.id)

    def test_range_vrf_follows_a_prefix_change_on_a_scoped_save(self):
        rng = IPRange.objects.create(
            tenant=self.tenant, prefix=self.globl,
            start_address="10.80.0.10", end_address="10.80.0.20",
        )
        self.assertIsNone(rng.vrf_id)
        rng.prefix = self.in_vrf
        rng.save(update_fields=["prefix"])
        self.assertEqual(IPRange.objects.get(pk=rng.pk).vrf_id, self.vrf.id)

    def test_range_without_a_prefix_keeps_the_vrf_it_was_given(self):
        """No prefix means nothing to derive from - the operator's choice holds."""
        rng = IPRange.objects.create(
            tenant=self.tenant, vrf=self.vrf,
            start_address="10.99.0.10", end_address="10.99.0.20",
        )
        self.assertEqual(IPRange.objects.get(pk=rng.pk).vrf_id, self.vrf.id)

    # ── Moving a prefix between VRFs ─────────────────────────────────────
    def test_moving_a_prefix_into_a_vrf_carries_its_children(self):
        """Children denormalise the prefix's VRF, so the move must reach them.

        They only ever re-derived it on their own save, so a prefix moved into a
        VRF used to leave every address and range behind in the old one -
        silently, and wrong for every VRF-filtered query.
        """
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.80.0.7", prefix=self.globl
        )
        rng = IPRange.objects.create(
            tenant=self.tenant, prefix=self.globl,
            start_address="10.80.0.30", end_address="10.80.0.40",
        )
        self.assertIsNone(ip.vrf_id)

        self.globl.vrf = self.vrf
        self.globl.save(update_fields=["vrf"])

        self.assertEqual(IPAddress.objects.get(pk=ip.pk).vrf_id, self.vrf.id)
        self.assertEqual(IPRange.objects.get(pk=rng.pk).vrf_id, self.vrf.id)

    def test_moving_a_prefix_back_to_global_carries_its_children(self):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.81.0.7", prefix=self.in_vrf
        )
        self.assertEqual(ip.vrf_id, self.vrf.id)

        self.in_vrf.vrf = None
        self.in_vrf.save(update_fields=["vrf"])

        self.assertIsNone(IPAddress.objects.get(pk=ip.pk).vrf_id)

    def test_saving_a_prefix_without_moving_it_leaves_children_alone(self):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.81.0.8", prefix=self.in_vrf
        )
        self.in_vrf.description = "touched"
        self.in_vrf.save(update_fields=["description"])
        self.assertEqual(IPAddress.objects.get(pk=ip.pk).vrf_id, self.vrf.id)
