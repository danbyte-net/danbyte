"""The scope registry is the only place a scope is declared.

A scope used to be spelled out in five places that had to agree - the model's
choices, the resolver's chain and its rank, the serializer's required-target
check, and the viewset's RBAC map and query filters. Two of those fail silently
when they drift: the RBAC filter hides every global policy from every
non-superuser, and the site-scoping helper swallows a bad ORM path and returns
nothing. These tests hold the copies together.
"""
from __future__ import annotations

from django.test import TestCase

from auth_api.object_types import model_for

from . import policy_scopes
from .models import MonitoringPolicy


class RegistryTests(TestCase):
    def test_the_model_offers_exactly_the_registered_scopes(self):
        self.assertEqual(
            [v for v, _ in MonitoringPolicy.SCOPE_CHOICES],
            [s.value for s in policy_scopes.SCOPES],
        )

    def test_every_scope_constant_is_registered(self):
        """`SCOPE_DEVICE` and friends are still used all over; a constant with
        no registry row would resolve to nothing."""
        constants = {
            getattr(MonitoringPolicy, name)
            for name in dir(MonitoringPolicy)
            if name.startswith("SCOPE_") and name != "SCOPE_CHOICES"
        }
        self.assertEqual(constants, set(policy_scopes.BY_VALUE))

    def test_every_target_field_exists_on_the_model(self):
        fields = {f.name for f in MonitoringPolicy._meta.get_fields()}
        for field in policy_scopes.TARGET_FIELDS:
            self.assertIn(field, fields)

    def test_every_target_field_is_nullable(self):
        """The RBAC visibility filter builds its global branch by asserting
        every target field is null. A non-nullable one makes that match
        nothing, hiding every global policy from every non-superuser."""
        for field in policy_scopes.TARGET_FIELDS:
            self.assertTrue(
                MonitoringPolicy._meta.get_field(field).null,
                f"{field} must be nullable or global policies vanish",
            )

    def test_every_scope_with_a_target_names_a_real_rbac_type(self):
        """An unresolvable slug fails closed - the policies become invisible
        rather than unfiltered - but invisible with no error is still a bug."""
        for scope in policy_scopes.SCOPES:
            if not scope.field:
                continue
            self.assertIsNotNone(
                model_for(scope.rbac_slug),
                f"{scope.value} names rbac slug {scope.rbac_slug!r}",
            )

    def test_global_is_the_only_scope_without_a_target(self):
        without = [s.value for s in policy_scopes.SCOPES if not s.field]
        self.assertEqual(without, ["global"])

    def test_ranks_are_distinct_and_ordered(self):
        ranked = [s.rank for s in policy_scopes.SCOPES if s.rank is not None]
        self.assertEqual(ranked, sorted(ranked))
        self.assertEqual(len(ranked), len(set(ranked)))

    def test_only_the_prefix_scope_computes_its_own_rank(self):
        computed = [s.value for s in policy_scopes.SCOPES if s.rank is None]
        self.assertEqual(computed, ["prefix"])

    def test_a_device_shaped_scope_has_a_matcher(self):
        for scope in policy_scopes.SCOPES:
            if scope.rank is not None:
                self.assertIsNotNone(scope.match, scope.value)

    def test_target_field_maps_scope_to_its_column(self):
        self.assertIsNone(policy_scopes.target_field("global"))
        self.assertEqual(policy_scopes.target_field("device_role"), "device_role")
        self.assertIsNone(policy_scopes.target_field("nonsense"))
