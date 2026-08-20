"""Milestone 11 tests - reverse-DNS enrichment (PTR → dns_name)."""
from __future__ import annotations

from unittest.mock import patch

from django.test import TestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .models import CheckKind, CheckState, CheckTemplate, MonitoringSettings
from .worker import _sync_dns


from api.test_utils import status_for


class DnsSyncTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.template = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )

    def _state(self, status="up"):
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind="icmp", status=status,
        )

    def _cfg(self, **over):
        base = {
            "dns_sync": True,
            "dns_clear_on_missing": False,
            "dns_preserve_if_alive": True,
        }
        base.update(over)
        return {self.tenant.id: base}

    def test_disabled_does_nothing(self):
        st = self._state()
        with patch("monitoring.worker._resolve_ptrs") as r:
            _sync_dns([st], {self.tenant.id: {"dns_sync": False}})
            r.assert_not_called()

    def test_writes_resolved_name(self):
        st = self._state()
        with patch(
            "monitoring.worker.asyncio.run",
            return_value={(): {"10.0.0.5": "host5.example.com"}},
        ):
            _sync_dns([st], self._cfg())
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "host5.example.com")

    def test_preserve_if_alive_keeps_name_on_miss(self):
        self.ip.dns_name = "old.example.com"
        self.ip.save()
        st = self._state(status="up")
        with patch("monitoring.worker.asyncio.run", return_value={(): {"10.0.0.5": None}}):
            _sync_dns([st], self._cfg(dns_preserve_if_alive=True))
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "old.example.com")  # preserved

    def test_clear_on_missing_when_not_preserving(self):
        self.ip.dns_name = "old.example.com"
        self.ip.save()
        st = self._state(status="down")  # not alive → preserve doesn't apply
        with patch("monitoring.worker.asyncio.run", return_value={(): {"10.0.0.5": None}}):
            _sync_dns([st], self._cfg(dns_preserve_if_alive=True, dns_clear_on_missing=True))
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "")  # cleared


class ResolverParsingTests(TestCase):
    def test_split_resolver(self):
        from .worker import _split_resolver

        self.assertEqual(_split_resolver("10.0.0.45"), ("10.0.0.45", 53))
        self.assertEqual(_split_resolver("10.0.0.45:5353"), ("10.0.0.45", 5353))
        # A bare IPv6 address is all colons, so it must not be read as host:port.
        self.assertEqual(_split_resolver("2001:db8::1"), ("2001:db8::1", 53))
        self.assertEqual(_split_resolver("[2001:db8::1]:5353"), ("2001:db8::1", 5353))
        self.assertEqual(_split_resolver("[2001:db8::1]"), ("2001:db8::1", 53))


class ResolverRoutingTests(DnsSyncTests):
    """Which server gets asked, and who sees the answer."""

    def setUp(self):
        super().setUp()
        # A second tenant holding the *same address string* as the first.
        self.other = Tenant.objects.create(org=self.org, name="Beta", slug="beta")
        self.other_prefix = Prefix.objects.create(
            tenant=self.other, cidr="10.0.0.0/8",
            status=status_for(self.other, "container"),
        )
        self.other_ip = IPAddress.objects.create(
            tenant=self.other, ip_address="10.0.0.5", prefix=self.other_prefix
        )
        self.other_template = CheckTemplate.objects.create(
            tenant=self.other, name="p", slug="p", kind=CheckKind.ICMP
        )

    def test_tenants_with_different_resolvers_do_not_share_answers(self):
        """The bug this grouping exists to prevent: the same address resolved
        by two different servers must not collapse into one answer."""
        mine = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind="icmp", status="up",
        )
        theirs = CheckState.objects.create(
            tenant=self.other, target_ip=self.other_ip,
            template=self.other_template, kind="icmp", status="up",
        )
        cfg = {
            self.tenant.id: {"dns_sync": True, "dns_clear_on_missing": False,
                             "dns_preserve_if_alive": True,
                             "dns_resolvers": ("10.0.0.45",)},
            self.other.id: {"dns_sync": True, "dns_clear_on_missing": False,
                            "dns_preserve_if_alive": True,
                            "dns_resolvers": ("10.9.9.9",)},
        }
        with patch("monitoring.worker.asyncio.run", return_value={
            ("10.0.0.45",): {"10.0.0.5": "internal.example.com"},
            ("10.9.9.9",): {"10.0.0.5": "external.example.com"},
        }):
            _sync_dns([mine, theirs], cfg)
        self.ip.refresh_from_db()
        self.other_ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "internal.example.com")
        self.assertEqual(self.other_ip.dns_name, "external.example.com")

    def test_configured_resolvers_never_fall_back_to_the_system_one(self):
        """A resolver setting that quietly ignores itself is worse than none:
        the operator gets plausible answers from the wrong server."""
        st = self._state()
        groups = {}

        async def _capture(g):
            groups.update(g)
            return {k: {} for k in g}

        with patch("monitoring.worker._resolve_batches", _capture), \
                patch("monitoring.worker._resolve_ptrs") as system:
            _sync_dns([st], self._cfg(dns_resolvers=("10.0.0.45",)))
        self.assertEqual(list(groups), [("10.0.0.45",)])
        system.assert_not_called()

    def test_no_resolvers_uses_the_host_resolver(self):
        """Empty list means today's behaviour, so upgrading changes nothing."""
        st = self._state()
        seen = {}

        async def _capture(g):
            seen.update(g)
            return {k: {} for k in g}

        with patch("monitoring.worker._resolve_batches", _capture):
            _sync_dns([st], self._cfg())
        self.assertEqual(list(seen), [()])  # the empty key = system resolver


class ResolverValidationTests(TestCase):
    """The setting takes IP addresses, and says so rather than failing later."""

    def _clean(self, value):
        from .serializers import MonitoringSettingsSerializer

        s = MonitoringSettingsSerializer()
        return s.validate_dns_resolvers(value)

    def test_accepts_addresses_with_and_without_ports(self):
        self.assertEqual(
            self._clean(["10.0.0.45", "10.0.0.46:5353", "[2001:db8::1]"]),
            ["10.0.0.45", "10.0.0.46:5353", "[2001:db8::1]"],
        )
        self.assertEqual(self._clean(["", "  "]), [])  # blanks dropped, not errors

    def test_rejects_a_hostname(self):
        from rest_framework.exceptions import ValidationError

        with self.assertRaises(ValidationError) as e:
            self._clean(["dc1.danbyte.lan"])
        # The message has to say why, since "put DNS here" is the obvious guess.
        self.assertIn("not an IP address", str(e.exception))

    def test_caps_the_list(self):
        from rest_framework.exceptions import ValidationError

        with self.assertRaises(ValidationError):
            self._clean(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"])


class OutpostReportedPtrTests(DnsSyncTests):
    """An Outpost that resolved the name itself is the better source: it asked
    from where the target lives. The core must defer to it, and must be able to
    tell 'looked, found nothing' from 'never looked'."""

    class _Outcome:
        def __init__(self, detail):
            self.detail = detail

    def test_a_reported_name_wins_and_skips_the_central_lookup(self):
        st = self._state()
        called = {}

        async def _never(groups):
            called["yes"] = groups
            return {}

        with patch("monitoring.worker._resolve_batches", _never):
            _sync_dns([st], self._cfg(),
                      [self._Outcome({"ptr": "branch.example.com"})])
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "branch.example.com")
        self.assertEqual(called, {})  # the core never looked it up itself

    def test_reported_empty_means_no_ptr_not_no_answer(self):
        """The Outpost looked and found nothing, so the clear policy applies."""
        self.ip.dns_name = "stale.example.com"
        self.ip.save()
        st = self._state(status="down")  # not alive, so preserve doesn't apply
        with patch("monitoring.worker._resolve_batches") as central:
            _sync_dns([st], self._cfg(dns_clear_on_missing=True),
                      [self._Outcome({"ptr": ""})])
            central.assert_not_called()
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "")

    def test_an_agent_that_never_looked_still_gets_a_central_lookup(self):
        """Older Outposts send no ptr key at all. Their silence must not be
        read as 'no name' - that would wipe names across an estate on upgrade."""
        self.ip.dns_name = "keep.example.com"
        self.ip.save()
        st = self._state(status="down")
        with patch("monitoring.worker.asyncio.run",
                   return_value={(): {"10.0.0.5": "central.example.com"}}):
            _sync_dns([st], self._cfg(), [self._Outcome({"latency_ms": 4})])
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "central.example.com")

    def test_no_outcomes_at_all_behaves_as_before(self):
        st = self._state()
        with patch("monitoring.worker.asyncio.run",
                   return_value={(): {"10.0.0.5": "central.example.com"}}):
            _sync_dns([st], self._cfg())
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "central.example.com")


class NoAnswerVsNoPtrTests(TestCase):
    """"Nobody answered" and "there is no name" are different facts.

    If they collapse, an Outpost whose local DNS is down reports every address
    as nameless, and a Danbyte set to clear missing names wipes them estate-wide.
    """

    def test_an_unanswered_lookup_is_absent_not_none(self):
        import asyncio

        from danbyte_checks.reverse_dns import resolve_ptrs

        # TEST-NET-1 is guaranteed unroutable, so this can only time out.
        got = asyncio.run(
            resolve_ptrs(["10.0.0.45"], ["192.0.2.1"], timeout=1.0)
        )
        self.assertEqual(got, {})  # absent - not {"10.0.0.45": None}

    def test_an_empty_address_list_is_cheap(self):
        import asyncio

        from danbyte_checks.reverse_dns import resolve_ptrs

        self.assertEqual(asyncio.run(resolve_ptrs([], ["192.0.2.1"])), {})
