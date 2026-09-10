"""What actually wins, pinned.

Policy specificity is a bare integer, and prefix policies use their **mask
length** as that integer. So the two number lines share a space: a /24 prefix
policy scores 24 and outranks a device-role policy's 21, while a /8 scores 8 and
loses to a VRF policy's 10. Whether that is what anybody meant is a separate
question - these tests record what the resolver does **today**, so that changing
it is a decision somebody makes on purpose and reads in a diff, rather than a
side effect of adding a scope.

Ties are worse than collisions: the winner loop keeps the first candidate at a
given specificity, and candidates arrive in ``Meta.ordering`` order, which sorts
policies by the *alphabetical* scope string. Nothing about that is intentional.
"""
from __future__ import annotations

from django.test import TestCase

from api.models import (
    VRF,
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Manufacturer,
    Platform,
    Prefix,
    Region,
    Site,
)
from core.models import Organization, Tenant

from .models import CheckKind, CheckTemplate, MonitoringPolicy
from .resolver import resolve_effective_checks


class PrecedenceBase(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        vendor = Manufacturer.objects.create(tenant=self.tenant, name="V", slug="v")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=vendor, model="M"
        )
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        # One template, so every policy competes for the same winner slot and
        # the interval is what says which policy won.
        self.tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP,
            interval_seconds=300,
        )

    def prefix(self, cidr, **kw):
        return Prefix.objects.create(tenant=self.tenant, cidr=cidr, **kw)

    def device_ip(self, prefix, host="10"):
        device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dtype,
            role=self.role, site=self.site,
        )
        base = prefix.cidr.split("/")[0].rsplit(".", 1)[0]
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"{base}.{host}",
            prefix=prefix, assigned_device=device,
        )
        device.primary_ip = ip
        device.save(update_fields=["primary_ip"])
        return device, ip

    def policy(self, scope, *, interval, **kw):
        p = MonitoringPolicy.objects.create(
            tenant=self.tenant, scope=scope, inherit=False,
            interval_seconds=interval, **kw
        )
        p.templates.add(self.tmpl)
        return p

    def winning_interval(self, ip) -> int:
        """Which policy won, read off the interval it stamped."""
        checks = resolve_effective_checks(ip)
        self.assertEqual(len(checks), 1, checks)
        return checks[0].interval_seconds


class LadderTests(PrecedenceBase):
    """The intended ordering, where the numbers do not collide."""

    def test_device_beats_role_beats_type_beats_vrf_beats_global(self):
        pfx = self.prefix("10.1.0.0/24")
        device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100)
        self.assertEqual(self.winning_interval(ip), 100)

        self.policy(MonitoringPolicy.SCOPE_VRF, vrf=None, interval=200)
        self.assertEqual(self.winning_interval(ip), 200)

        self.policy(MonitoringPolicy.SCOPE_DEVICE_TYPE, device_type=self.dtype,
                    interval=300)
        self.assertEqual(self.winning_interval(ip), 300)

        self.policy(MonitoringPolicy.SCOPE_DEVICE_ROLE, device_role=self.role,
                    interval=400)
        self.assertEqual(self.winning_interval(ip), 400)

        self.policy(MonitoringPolicy.SCOPE_DEVICE, device=device, interval=500)
        self.assertEqual(self.winning_interval(ip), 500)


class CollisionTests(PrecedenceBase):
    """Where a prefix mask length lands in the middle of the scope ladder.

    Recorded, not endorsed. Each of these is a place an operator would have to
    know the mask length to predict the winner.
    """

    def test_a_slash_24_prefix_policy_outranks_a_device_role_policy(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_DEVICE_ROLE, device_role=self.role,
                    interval=400)
        self.policy(MonitoringPolicy.SCOPE_PREFIX, prefix=pfx, interval=900)
        # 24 > 21.
        self.assertEqual(self.winning_interval(ip), 900)

    def test_a_vrf_policy_outranks_a_slash_8_prefix_policy(self):
        vrf = VRF.objects.create(tenant=self.tenant, name="blue", rd="65000:1")
        pfx = self.prefix("10.0.0.0/8", vrf=vrf)
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=pfx, vrf=vrf,
        )
        self.policy(MonitoringPolicy.SCOPE_PREFIX, prefix=pfx, interval=900)
        self.policy(MonitoringPolicy.SCOPE_VRF, vrf=vrf, interval=200)
        # 10 > 8: an explicit prefix policy loses to the VRF it sits in.
        self.assertEqual(self.winning_interval(ip), 200)

    def test_a_device_policy_beats_a_slash_128_prefix_policy_on_a_tie(self):
        """Both score 128; the winner is whichever candidate was appended
        first, which is decided by the alphabetical scope string."""
        pfx = self.prefix("2001:db8::/128")
        device = Device.objects.create(
            tenant=self.tenant, name="v6", device_type=self.dtype,
            role=self.role, site=self.site,
        )
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="2001:db8::", prefix=pfx,
            assigned_device=device,
        )
        self.policy(MonitoringPolicy.SCOPE_PREFIX, prefix=pfx, interval=900)
        self.policy(MonitoringPolicy.SCOPE_DEVICE, device=device, interval=500)
        # "device" sorts before "prefix", so the device policy is added first
        # and the strict > in the winner loop keeps it.
        self.assertEqual(self.winning_interval(ip), 500)


class TargetGuardTests(PrecedenceBase):
    """A device-shaped policy never sees an address with no device."""

    def test_a_device_type_policy_skips_an_unassigned_address(self):
        pfx = self.prefix("10.1.0.0/24")
        loose = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.99", prefix=pfx,
        )
        self.policy(MonitoringPolicy.SCOPE_DEVICE_TYPE, device_type=self.dtype,
                    interval=300)
        self.assertEqual(resolve_effective_checks(loose), [])

    def test_a_primary_target_policy_skips_a_secondary_address(self):
        pfx = self.prefix("10.1.0.0/24")
        device, _primary = self.device_ip(pfx)
        second = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.11", prefix=pfx,
            assigned_device=device,
        )
        self.policy(MonitoringPolicy.SCOPE_DEVICE, device=device, interval=500,
                    target=MonitoringPolicy.TARGET_PRIMARY)
        self.assertEqual(resolve_effective_checks(second), [])


class QueryCountTests(PrecedenceBase):
    """Resolution must not re-query per policy.

    ``policy.templates.filter(enabled=True)`` ignores a prefetch, so every
    policy cost two extra queries per IP - and one enabled policy makes every
    IP in the tenant a candidate, so it multiplied by the whole estate.
    """

    def _resolve_queries(self, ip) -> int:
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as ctx:
            resolve_effective_checks(ip)
        return len(ctx.captured_queries)

    def test_tag_filters_do_not_cost_a_query_each(self):
        """`device.tags.all()` per policy is the same N+1 the policy prefetch
        had - one read per address, not per rule."""
        pfx = self.prefix("10.1.0.0/24")
        device, ip = self.device_ip(pfx)
        from core.models import Tag

        tag, _ = Tag.objects.get_or_create(
            tenant=self.tenant, slug="edge", defaults={"name": "Edge"}
        )
        device.tags.add(tag)
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100,
                    match_tags=["edge"])
        one = self._resolve_queries(ip)
        self.policy(MonitoringPolicy.SCOPE_DEVICE_TYPE, device_type=self.dtype,
                    interval=300, match_tags=["edge"])
        self.policy(MonitoringPolicy.SCOPE_DEVICE_ROLE, device_role=self.role,
                    interval=400, match_tags=["edge"])
        self.policy(MonitoringPolicy.SCOPE_DEVICE, device=device, interval=500,
                    match_tags=["edge"])
        four = self._resolve_queries(ip)
        self.assertEqual(one, four, f"{one} then {four} - tags re-read per rule")

    def test_more_policies_do_not_cost_more_queries(self):
        pfx = self.prefix("10.1.0.0/24")
        device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100)
        one = self._resolve_queries(ip)

        # Four more policies, all matching this IP.
        self.policy(MonitoringPolicy.SCOPE_VRF, vrf=None, interval=200)
        self.policy(MonitoringPolicy.SCOPE_DEVICE_TYPE, device_type=self.dtype,
                    interval=300)
        self.policy(MonitoringPolicy.SCOPE_DEVICE_ROLE, device_role=self.role,
                    interval=400)
        self.policy(MonitoringPolicy.SCOPE_DEVICE, device=device, interval=500)
        five = self._resolve_queries(ip)

        self.assertEqual(
            one, five,
            f"{one} queries for one policy, {five} for five - the prefetch is "
            "being ignored again",
        )


class NewScopeTests(PrecedenceBase):
    """Site, region and platform."""

    def setUp(self):
        super().setUp()
        self.europe = Region.objects.create(tenant=self.tenant, name="Europe", slug="europe")
        self.dk = Region.objects.create(
            tenant=self.tenant, name="Denmark", slug="dk", parent=self.europe
        )
        self.site.region = self.dk
        self.site.save(update_fields=["region"])
        self.platform = Platform.objects.create(
            tenant=self.tenant, name="IOS-XE", slug="ios-xe"
        )

    def test_a_site_policy_matches_a_device_at_that_site(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_SITE, target_site=self.site, interval=600)
        self.assertEqual(self.winning_interval(ip), 600)

    def test_a_site_policy_reaches_an_address_with_no_device(self):
        """A site has addresses nothing is plugged into, and they are still at
        the site - so this scope must not require a device."""
        pfx = self.prefix("10.1.0.0/24", site=self.site)
        loose = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.99", prefix=pfx,
        )
        self.policy(MonitoringPolicy.SCOPE_SITE, target_site=self.site, interval=600)
        self.assertEqual(self.winning_interval(loose), 600)

    def test_a_site_policy_honours_its_target(self):
        pfx = self.prefix("10.1.0.0/24")
        device, _primary = self.device_ip(pfx)
        second = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.11", prefix=pfx,
            assigned_device=device,
        )
        self.policy(MonitoringPolicy.SCOPE_SITE, target_site=self.site, interval=600,
                    target=MonitoringPolicy.TARGET_PRIMARY)
        self.assertEqual(resolve_effective_checks(second), [])

    def test_a_region_policy_reaches_a_site_below_it(self):
        """A policy on Europe has to reach a site in Denmark."""
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_REGION, region=self.europe,
                    interval=700)
        self.assertEqual(self.winning_interval(ip), 700)

    def test_a_region_policy_on_a_sibling_does_not_match(self):
        other = Region.objects.create(tenant=self.tenant, name="Norway",
                                      slug="no", parent=self.europe)
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_REGION, region=other, interval=700)
        self.assertEqual(resolve_effective_checks(ip), [])

    def test_a_site_policy_beats_the_region_above_it(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_REGION, region=self.europe,
                    interval=700)
        self.policy(MonitoringPolicy.SCOPE_SITE, target_site=self.site, interval=600)
        self.assertEqual(self.winning_interval(ip), 600)

    def test_a_platform_policy_matches_the_devices_platform(self):
        pfx = self.prefix("10.1.0.0/24")
        device, ip = self.device_ip(pfx)
        device.platform = self.platform
        device.save(update_fields=["platform"])
        self.policy(MonitoringPolicy.SCOPE_PLATFORM, platform=self.platform,
                    interval=800)
        self.assertEqual(self.winning_interval(ip), 800)

    def test_a_device_type_policy_beats_a_platform_policy(self):
        """One platform spans many models, so the model is the finer statement."""
        pfx = self.prefix("10.1.0.0/24")
        device, ip = self.device_ip(pfx)
        device.platform = self.platform
        device.save(update_fields=["platform"])
        self.policy(MonitoringPolicy.SCOPE_PLATFORM, platform=self.platform,
                    interval=800)
        self.policy(MonitoringPolicy.SCOPE_DEVICE_TYPE, device_type=self.dtype,
                    interval=300)
        self.assertEqual(self.winning_interval(ip), 300)

    def test_a_slash_18_prefix_policy_ties_the_platform_rank(self):
        """Platform sits at 18 and a /18 is an ordinary prefix, so the two land
        on the same rank and the alphabetical scope string decides. Recorded so
        the collision I introduced is as visible as the ones I inherited."""
        pfx = self.prefix("10.64.0.0/18")
        device = Device.objects.create(
            tenant=self.tenant, name="sw18", device_type=self.dtype,
            role=self.role, site=self.site, platform=self.platform,
        )
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.64.0.5", prefix=pfx,
            assigned_device=device,
        )
        self.policy(MonitoringPolicy.SCOPE_PREFIX, prefix=pfx, interval=900)
        self.policy(MonitoringPolicy.SCOPE_PLATFORM, platform=self.platform,
                    interval=800)
        # "platform" sorts before "prefix", so platform is appended first and
        # the strict > in the winner loop keeps it.
        self.assertEqual(self.winning_interval(ip), 800)

    def test_a_platform_policy_skips_a_device_with_no_platform(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_PLATFORM, platform=self.platform,
                    interval=800)
        self.assertEqual(resolve_effective_checks(ip), [])

    def test_a_region_cycle_does_not_hang_resolution(self):
        """Region.parent is validated on save, but the resolver runs against
        whatever is in the table."""
        Region.objects.filter(pk=self.europe.pk).update(parent=self.dk)
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_REGION, region=self.europe,
                    interval=700)
        self.assertEqual(self.winning_interval(ip), 700)


class FilterTests(PrecedenceBase):
    """Tags and a name pattern narrow a scope rather than being scopes.

    A scope needs a target object the RBAC query can test, and a name pattern
    has none. As filters they AND with the scope's match, which is safe because
    a policy can only ever add a check, never disable one.
    """

    def tag(self, device, *names):
        from core.models import Tag

        for name in names:
            tag, _ = Tag.objects.get_or_create(
                tenant=self.tenant, slug=name, defaults={"name": name.title()}
            )
            device.tags.add(tag)

    def test_no_filters_matches_everything(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100)
        self.assertEqual(self.winning_interval(ip), 100)

    def test_a_name_pattern_narrows_the_scope(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)  # named sw1
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100,
                    match_name="core-*")
        self.assertEqual(resolve_effective_checks(ip), [])

    def test_a_matching_name_still_applies(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100,
                    match_name="sw*")
        self.assertEqual(self.winning_interval(ip), 100)

    def test_a_name_pattern_ignores_case(self):
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100,
                    match_name="SW*")
        self.assertEqual(self.winning_interval(ip), 100)

    def test_all_tags_must_be_present(self):
        pfx = self.prefix("10.1.0.0/24")
        device, ip = self.device_ip(pfx)
        self.tag(device, "edge")
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100,
                    match_tags=["edge", "critical"])
        self.assertEqual(resolve_effective_checks(ip), [])
        self.tag(device, "critical")
        self.assertEqual(self.winning_interval(ip), 100)

    def test_a_filtered_policy_does_not_reach_a_device_less_address(self):
        """A tag belongs to a thing; an address with nothing on it has none.
        Narrower is the safe direction for a rule that can only add checks."""
        pfx = self.prefix("10.1.0.0/24")
        loose = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.99", prefix=pfx,
        )
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100,
                    match_tags=["edge"])
        self.assertEqual(resolve_effective_checks(loose), [])

    def test_filters_narrow_a_prefix_policy_too(self):
        """The prefix branch returns early, so it needs the filter applied
        separately - an easy place to leave a hole."""
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_PREFIX, prefix=pfx, interval=900,
                    match_name="core-*")
        self.assertEqual(resolve_effective_checks(ip), [])

    def test_a_filter_never_disables_a_broader_policy(self):
        """Filters narrow which policies apply; they cannot remove a check a
        looser policy already added."""
        pfx = self.prefix("10.1.0.0/24")
        _device, ip = self.device_ip(pfx)
        self.policy(MonitoringPolicy.SCOPE_GLOBAL, interval=100)
        self.policy(MonitoringPolicy.SCOPE_PREFIX, prefix=pfx, interval=900,
                    match_name="core-*")
        self.assertEqual(self.winning_interval(ip), 100)
