"""Placement: which Site a synced host or VM lands in (#34).

The evaluator is pure - no queries - so these are fast unit tests over the
resolution rules themselves. Wiring into the sync engines is covered in
tests_virt_sync.
"""
from __future__ import annotations

from django.test import TestCase

from api.models import Location, Site
from core.models import Organization, Tenant
from integrations.models import VirtPlacementRule, VirtualizationSource
from integrations.placement import (
    PlacementPath,
    resolve,
    strip_builtin_folders,
    unplaced_warning,
)


class PlacementPathTests(TestCase):
    def test_builtin_folders_are_stripped(self):
        """vCenter's own plumbing folders carry no operator meaning."""
        self.assertEqual(
            strip_builtin_folders(["vm", "Test site", "Linux"]),
            ["Test site", "Linux"],
        )

    def test_folder_candidates_are_innermost_first(self):
        """So the closest matching ancestor is the one that wins."""
        path = PlacementPath(folders=["Test site", "Linux"])
        self.assertEqual(
            path.values_for("folder"),
            ["Linux", "Test site/Linux", "Test site", "Test site"],
        )


class ResolveTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", host="192.0.2.20",
            credentials={"username": "u", "password": "p"}, kind="vcenter",
        )
        self.lab = Site.objects.create(tenant=self.tenant, name="Lab")
        self.dr = Site.objects.create(tenant=self.tenant, name="DR")
        self.branch = Site.objects.create(tenant=self.tenant, name="Branch")

    def _rule(self, scope, pattern, site, **kw):
        return VirtPlacementRule.objects.create(
            source=self.source, scope=scope, pattern=pattern, site=site, **kw
        )

    def _resolve(self, path, *, fallback=True):
        by_name = (
            {s.name.lower(): s for s in Site.objects.all()} if fallback else None
        )
        return resolve(path, list(self.source.placement_rules.all()),
                       site_by_name=by_name)

    # ── rules ────────────────────────────────────────────────────────────
    def test_a_glob_rule_matches(self):
        self._rule("cluster", "cl-*", self.dr)
        got = self._resolve(PlacementPath(cluster="cl-01"), fallback=False)
        self.assertEqual(got.site, self.dr)
        self.assertIn("rule:", got.reason)

    def test_a_regex_rule_matches(self):
        self._rule("host", r"regex:^esxi-0[12]$", self.dr)
        self.assertEqual(
            self._resolve(PlacementPath(host="esxi-02"), fallback=False).site,
            self.dr,
        )
        self.assertIsNone(
            self._resolve(PlacementPath(host="esxi-99"), fallback=False).site
        )

    def test_a_broken_regex_matches_nothing_instead_of_raising(self):
        self._rule("host", "regex:[unclosed", self.dr)
        self.assertIsNone(
            self._resolve(PlacementPath(host="anything"), fallback=False).site
        )

    # ── the inheritance the owner asked for ──────────────────────────────
    def test_a_folder_rule_covers_its_subfolders(self):
        """A rule on "Test site" must cover "Test site / Linux"."""
        self._rule("folder", "Test site", self.lab)
        got = self._resolve(
            PlacementPath(folders=["Test site", "Linux"]), fallback=False
        )
        self.assertEqual(got.site, self.lab)

    def test_a_nearer_folder_beats_an_ancestor(self):
        self._rule("folder", "Test site", self.lab)
        self._rule("folder", "Linux", self.dr)
        got = self._resolve(
            PlacementPath(folders=["Test site", "Linux"]), fallback=False
        )
        self.assertEqual(got.site, self.dr, "the closest folder should win")

    def test_a_full_path_can_be_matched(self):
        self._rule("folder", "Test site/Win*", self.branch)
        got = self._resolve(
            PlacementPath(folders=["Test site", "Windows"]), fallback=False
        )
        self.assertEqual(got.site, self.branch)

    # ── precedence ───────────────────────────────────────────────────────
    def test_specificity_beats_weight(self):
        """A host rule wins over a datacenter rule whatever the weights say.

        Weight is a tie-break within one level, so overriding one machine
        never means reasoning about global ordering.
        """
        self._rule("datacenter", "Lab", self.lab, weight=1)
        self._rule("host", "esxi-01", self.dr, weight=250)
        got = self._resolve(
            PlacementPath(datacenter="Lab", host="esxi-01"), fallback=False
        )
        self.assertEqual(got.site, self.dr)

    def test_weight_breaks_a_tie_within_one_scope(self):
        self._rule("cluster", "cl-*", self.lab, weight=200)
        self._rule("cluster", "cl-01", self.dr, weight=10)
        got = self._resolve(PlacementPath(cluster="cl-01"), fallback=False)
        self.assertEqual(got.site, self.dr)

    # ── the hierarchy fallback ───────────────────────────────────────────
    def test_the_datacenter_name_matches_a_site(self):
        got = self._resolve(PlacementPath(datacenter="Lab"))
        self.assertEqual(got.site, self.lab)
        self.assertIn("named after", got.reason)

    def test_matching_is_case_insensitive(self):
        self.assertEqual(
            self._resolve(PlacementPath(datacenter="lab")).site, self.lab
        )

    def test_a_rule_beats_the_hierarchy(self):
        self._rule("datacenter", "Lab", self.dr)
        self.assertEqual(self._resolve(PlacementPath(datacenter="Lab")).site,
                         self.dr)

    def test_an_unknown_name_places_nothing_and_explains(self):
        """A Site is a physical fact - the sync never invents one."""
        got = self._resolve(PlacementPath(datacenter="Nowhere"))
        self.assertIsNone(got.site)
        self.assertEqual(Site.objects.count(), 3)
        msg = unplaced_warning(PlacementPath(datacenter="Nowhere"))
        self.assertIn("Nowhere", msg)
        self.assertIn("add a rule", msg)

    # ── location ─────────────────────────────────────────────────────────
    def test_a_location_rides_along_with_its_site(self):
        rack = Location.objects.create(
            tenant=self.tenant, site=self.lab, name="Row 2", slug="row-2"
        )
        self._rule("cluster", "cl-01", self.lab, location=rack)
        got = self._resolve(PlacementPath(cluster="cl-01"), fallback=False)
        self.assertEqual(got.location, rack)

    def test_a_location_from_another_site_is_ignored(self):
        """It would otherwise put a device in a location that isn't there."""
        elsewhere = Location.objects.create(
            tenant=self.tenant, site=self.dr, name="Row 9", slug="row-9"
        )
        self._rule("cluster", "cl-01", self.lab, location=elsewhere)
        got = self._resolve(PlacementPath(cluster="cl-01"), fallback=False)
        self.assertEqual(got.site, self.lab)
        self.assertIsNone(got.location)


class PlacementRuleApiTests(TestCase):
    """The rules API. The create path had a real trap worth pinning.

    `VirtPlacementRule` is tenant-scoped *through* its source, so the base
    viewset's `perform_create` would try to pass `source__tenant=` as a model
    kwarg and raise TypeError. The source is validated instead.
    """

    def setUp(self):
        from django.contrib.auth import get_user_model

        from integrations.models import IntegrationSettings

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.create(
            tenant=self.tenant, virtualization_enabled=True
        )
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", host="192.0.2.20", kind="vcenter",
            credentials={"username": "u", "password": "p"},
        )
        self.site = Site.objects.create(tenant=self.tenant, name="Lab")
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _post(self, **over):
        body = {"source": str(self.source.id), "scope": "cluster",
                "pattern": "cl-*", "site_id": str(self.site.id)}
        body.update(over)
        return self.client.post(
            "/api/virt-placement-rules/", body, content_type="application/json"
        )

    def test_creating_a_rule(self):
        r = self._post()
        self.assertEqual(r.status_code, 201, r.content)
        rule = VirtPlacementRule.objects.get()
        self.assertEqual(rule.site_id, self.site.id)
        self.assertEqual(r.json()["site"]["name"], "Lab")

    def test_a_foreign_tenants_source_is_refused(self):
        other_org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=other_org, name="X", slug="x")
        foreign = VirtualizationSource.objects.create(
            tenant=other, name="theirs", host="192.0.2.99", kind="vcenter",
            credentials={"username": "u", "password": "p"},
        )
        r = self._post(source=str(foreign.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(VirtPlacementRule.objects.count(), 0)

    def test_a_foreign_tenants_site_is_refused(self):
        other_org = Organization.objects.create(name="Y", slug="y")
        other = Tenant.objects.create(org=other_org, name="Y", slug="y")
        foreign = Site.objects.create(tenant=other, name="Theirs")
        r = self._post(site_id=str(foreign.id))
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_location_outside_the_site_is_refused(self):
        elsewhere = Site.objects.create(tenant=self.tenant, name="Other")
        loc = Location.objects.create(
            tenant=self.tenant, site=elsewhere, name="Row 1", slug="row-1"
        )
        r = self._post(location_id=str(loc.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("location_id", r.json())

    def test_listing_is_filtered_by_source(self):
        self._post()
        r = self.client.get(f"/api/virt-placement-rules/?source={self.source.id}")
        self.assertEqual(len(r.json()["results"]), 1)

    def test_editing_a_rule(self):
        """Rules were create/delete only - a typo meant recreating them."""
        r = self._post()
        rid = r.json()["id"]
        patched = self.client.patch(
            f"/api/virt-placement-rules/{rid}/",
            {"pattern": "cl-9*", "weight": 5}, content_type="application/json",
        )
        self.assertEqual(patched.status_code, 200, patched.content)
        rule = VirtPlacementRule.objects.get(pk=rid)
        self.assertEqual(rule.pattern, "cl-9*")
        self.assertEqual(rule.weight, 5)

    def test_a_location_can_be_set_and_cleared(self):
        loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Row 3", slug="row-3"
        )
        rid = self._post(location_id=str(loc.id)).json()["id"]
        self.assertEqual(VirtPlacementRule.objects.get(pk=rid).location_id, loc.id)

        cleared = self.client.patch(
            f"/api/virt-placement-rules/{rid}/",
            {"location_id": None}, content_type="application/json",
        )
        self.assertEqual(cleared.status_code, 200, cleared.content)
        self.assertIsNone(VirtPlacementRule.objects.get(pk=rid).location_id)


class IpScopeTests(TestCase):
    """The reporter's ask: 192.168.110.* = UA, 10.0.9.* = RS.

    Management subnets really are per-site in most estates, so an address is a
    legitimate way to say where a machine lives."""

    def _rule(self, pattern, site, weight=100):
        from integrations.placement import SCOPE_ORDER  # noqa: F401

        class R:
            scope = "ip"
        R.pattern, R.site, R.weight = pattern, site, weight
        R.location, R.location_id, R.site_id = None, None, id(site)
        return R

    def test_glob_and_cidr_both_place(self):
        ua, rs = object(), object()
        rules = [self._rule("192.168.110.*", ua), self._rule("10.0.9.0/24", rs)]
        for addr, expected in (("192.168.110.7", ua), ("10.0.9.5", rs)):
            path = PlacementPath(ips=[addr])
            self.assertIs(resolve(path, rules).site, expected)

    def test_a_cidr_expresses_masks_a_glob_cannot(self):
        """The reason CIDR is supported at all: no glob describes a /22."""
        site = object()
        rules = [self._rule("10.0.12.0/22", site)]
        self.assertIs(resolve(PlacementPath(ips=["10.0.14.9"]), rules).site, site)
        self.assertIsNone(resolve(PlacementPath(ips=["10.0.16.9"]), rules).site)

    def test_a_machine_with_several_addresses_matches_on_any(self):
        site = object()
        rules = [self._rule("10.0.9.0/24", site)]
        path = PlacementPath(ips=["169.254.1.1", "10.0.9.5"])
        self.assertIs(resolve(path, rules).site, site)

    def test_ip_beats_a_structural_rule(self):
        """An operator who writes an address rule means it - it names one
        machine, so it outranks the folder or cluster it happens to sit in."""
        by_ip, by_cluster = object(), object()

        class ClusterRule:
            scope, pattern, weight = "cluster", "cl-*", 1  # even at weight 1
            location = location_id = None
            site, site_id = by_cluster, 2

        path = PlacementPath(cluster="cl-01", ips=["10.0.9.5"])
        rules = [ClusterRule, self._rule("10.0.9.0/24", by_ip, weight=999)]
        self.assertIs(resolve(path, rules).site, by_ip)

    def test_a_malformed_cidr_matches_nothing_rather_than_exploding(self):
        rules = [self._rule("10.0.9.0/99", object())]
        self.assertIsNone(resolve(PlacementPath(ips=["10.0.9.5"]), rules).site)

    def test_no_addresses_reported_places_nothing(self):
        rules = [self._rule("10.0.9.0/24", object())]
        self.assertIsNone(resolve(PlacementPath(ips=[]), rules).site)
