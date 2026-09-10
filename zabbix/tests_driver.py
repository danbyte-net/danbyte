"""The Zabbix engine seam (#162), Phase 0.

Two things are being asserted: that a driver kind plugs into engine resolution
without the resolver knowing what Zabbix is, and that turning the integration
off makes the engine *unchosen* rather than *unreachable* - the difference
between a quiet switch and one that pages somebody.

No network: the client is mocked. The request shapes are what the Zabbix
JSON-RPC API expects, verified separately against a real 7.0 server.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.engine_drivers import (
    driver_for,
    engine_kinds,
    engine_usable,
    register_monitoring_engine,
)
from monitoring.models import MonitoringEngine

from .client import ZabbixClient, ZabbixError, ZabbixUnreachable
from .driver import ZabbixDriver, test_connection
from .models import ZabbixConnection

TOKEN = "a" * 64


def _resp(status=200, body=None):
    m = mock.Mock()
    m.status_code = status
    m.json.return_value = body if body is not None else {}
    m.text = ""
    return m


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"zabbix_enabled": True}
        )
        self.conn = ZabbixConnection.objects.create(
            tenant=self.tenant, name="zbx", url="https://zabbix.example.com",
            credentials={"token": TOKEN}, version="7.0.30",
        )
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix"
        )


class RegistryTests(_Base):
    def test_the_kind_is_registered_with_its_connection_fields(self):
        kinds = {k.kind: k for k in engine_kinds()}
        self.assertIn("zabbix", kinds)
        names = [f["name"] for f in kinds["zabbix"].payload()["fields"]]
        self.assertEqual(names, ["url", "token", "verify_tls"])

    def test_driver_resolves_from_the_engine(self):
        self.assertIsInstance(driver_for(self.engine), ZabbixDriver)

    def test_a_builtin_kind_has_no_driver(self):
        local = MonitoringEngine.local_for(self.tenant)
        self.assertIsNone(driver_for(local))
        self.assertTrue(engine_usable(local))

    def test_builtin_kinds_cannot_be_registered_over(self):
        for kind in ("local", "remote"):
            with self.assertRaises(ValueError):
                register_monitoring_engine(kind, "x", lambda: None)

    def test_an_unregistered_kind_is_never_usable(self):
        """A driver whose app was removed must not keep collecting work."""
        orphan = MonitoringEngine.objects.create(
            tenant=self.tenant, name="gone", slug="gone", kind="departed"
        )
        self.assertIsNone(driver_for(orphan))
        self.assertFalse(engine_usable(orphan))


class UsableTests(_Base):
    """The switch. Each of these is a reason NOT to hand the engine work."""

    def test_usable_when_everything_is_in_place(self):
        self.assertTrue(engine_usable(self.engine))

    def test_the_tenant_switch_wins_immediately(self):
        s = IntegrationSettings.objects.get(tenant=self.tenant)
        s.zabbix_enabled = False
        s.save()
        self.assertFalse(engine_usable(self.engine))

    def test_no_token_is_not_usable(self):
        self.conn.credentials = {}
        self.conn.save()
        self.assertFalse(engine_usable(self.engine))

    def test_no_connection_is_not_usable(self):
        self.conn.delete()
        self.assertFalse(engine_usable(self.engine))

    def test_a_disabled_engine_is_not_usable(self):
        self.engine.enabled = False
        self.engine.save()
        self.assertFalse(engine_usable(self.engine))

    def test_below_the_version_floor_is_not_usable(self):
        """5.0 predates named API tokens; Danbyte would be guessing."""
        self.conn.version = "5.0.42"
        self.conn.save()
        self.assertFalse(engine_usable(self.engine))

    def test_an_unprobed_server_is_not_usable(self):
        """Never answered means never send it work."""
        self.conn.version = ""
        self.conn.save()
        self.assertFalse(engine_usable(self.engine))

    def test_a_throwing_driver_does_not_break_resolution(self):
        with mock.patch.object(
            ZabbixDriver, "usable", side_effect=RuntimeError("boom")
        ):
            self.assertFalse(engine_usable(self.engine))


class ResolutionTests(_Base):
    """The point of the seam: the resolver never learns what Zabbix is."""

    def _bind_as_default(self):
        from monitoring.models import MonitoringSettings

        ms = MonitoringSettings.for_tenant(self.tenant)
        ms.default_engine = self.engine
        ms.save(update_fields=["default_engine"])

    def test_a_usable_driver_engine_is_chosen(self):
        from api.models import IPAddress, Prefix
        from monitoring.engines import engine_for_ip

        self._bind_as_default()
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.5/24", prefix=prefix
        )
        self.assertEqual(engine_for_ip(ip), self.engine)

    def test_switching_it_off_falls_back_to_local_not_to_nothing(self):
        """The bug this fixes: a target bound to a switched-off engine used to
        stay bound, go unclaimed, and then be reported unreachable."""
        from api.models import IPAddress, Prefix
        from monitoring.engines import engine_for_ip

        self._bind_as_default()
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.1.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.1.5/24", prefix=prefix
        )
        s = IntegrationSettings.objects.get(tenant=self.tenant)
        s.zabbix_enabled = False
        s.save()
        self.assertEqual(
            engine_for_ip(ip), MonitoringEngine.local_for(self.tenant)
        )

    def test_the_health_sweep_ignores_an_unusable_engine(self):
        """Turning the integration off must not fire engine-unreachable."""
        from monitoring.scheduler import check_engine_health

        s = IntegrationSettings.objects.get(tenant=self.tenant)
        s.zabbix_enabled = False
        s.save()
        self.engine.stale_since = None
        self.engine.save()
        with mock.patch("monitoring.notify.notify_event") as notify:
            check_engine_health()
        notify.assert_not_called()
        self.engine.refresh_from_db()
        self.assertIsNone(self.engine.stale_since)

    def test_dispatch_skips_a_driver_with_nothing_to_claim(self):
        """Phase 0 has no claim() - the scheduler must treat that as no work,
        not as an error."""
        from monitoring.scheduler import dispatch_drivers

        self.assertEqual(dispatch_drivers(), 0)


class ConnectionTestTests(_Base):
    """What the Test button says. Every branch is something an operator has to
    be able to act on."""

    def _call(self, side_effect=None, return_value=None):
        with mock.patch("zabbix.client.safe_post",
                        side_effect=side_effect, return_value=return_value):
            return test_connection(self.conn)

    def test_success_reports_version_and_host_count(self):
        out = self._call(side_effect=[
            _resp(body={"result": "7.0.30"}),
            _resp(body={"result": "12"}),
        ])
        self.assertTrue(out["ok"])
        self.assertEqual(out["version"], "7.0.30")
        self.assertEqual(out["hosts"], 12)
        self.assertIn("12 hosts", out["detail"])
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.version, "7.0.30")
        self.assertEqual(self.conn.last_error, "")
        self.assertIsNotNone(self.conn.last_checked_at)

    def test_one_host_is_not_pluralised(self):
        out = self._call(side_effect=[
            _resp(body={"result": "7.0.30"}), _resp(body={"result": "1"}),
        ])
        self.assertIn("1 host visible", out["detail"])

    def test_below_the_floor_says_so_and_does_not_authenticate(self):
        out = self._call(side_effect=[_resp(body={"result": "5.0.42"})])
        self.assertFalse(out["ok"])
        self.assertIn("below the supported floor", out["detail"])

    def test_no_token_is_distinguished_from_a_bad_one(self):
        self.conn.credentials = {}
        self.conn.save()
        out = self._call(side_effect=[_resp(body={"result": "7.0.30"})])
        self.assertFalse(out["ok"])
        self.assertIn("no API token is set", out["detail"])

    def test_a_rejected_token_is_named_as_such(self):
        """Zabbix says 'Session terminated, re-login' for a bad token, which
        reads like a Danbyte bug."""
        out = self._call(side_effect=[
            _resp(body={"result": "7.0.30"}),
            _resp(body={"error": {"data": "Session terminated, re-login, please."}}),
        ])
        self.assertFalse(out["ok"])
        self.assertIn("rejected the API token", out["detail"])

    def test_unreachable_names_the_url(self):
        out = self._call(side_effect=ZabbixUnreachable("no route to host"))
        self.assertFalse(out["ok"])
        self.assertIn("zabbix.example.com", out["detail"])

    def test_a_non_json_answer_blames_the_url_not_the_json(self):
        bad = _resp()
        bad.json.side_effect = ValueError("nope")
        out = self._call(return_value=bad)
        self.assertIn("frontend", out["detail"])

    def test_the_failure_is_recorded_on_the_connection(self):
        self._call(side_effect=ZabbixUnreachable("down"))
        self.conn.refresh_from_db()
        self.assertIn("down", self.conn.last_error)

    def test_the_version_probe_carries_no_auth_header(self):
        """apiinfo.version is rejected outright if it does - which is why it is
        the right probe before a token exists."""
        with mock.patch("zabbix.client.safe_post") as post:
            post.side_effect = [
                _resp(body={"result": "7.0.30"}), _resp(body={"result": "0"}),
            ]
            test_connection(self.conn)
        first = post.call_args_list[0]
        self.assertNotIn("Authorization", first.kwargs["headers"])
        second = post.call_args_list[1]
        self.assertEqual(
            second.kwargs["headers"]["Authorization"], f"Bearer {TOKEN}"
        )

    def test_the_api_endpoint_is_derived_from_the_frontend_url(self):
        self.assertEqual(
            self.conn.api_url, "https://zabbix.example.com/api_jsonrpc.php"
        )
        self.conn.url = "https://zabbix.example.com/"
        self.assertEqual(
            self.conn.api_url, "https://zabbix.example.com/api_jsonrpc.php"
        )

    def test_the_token_is_never_returned(self):
        """It lives encrypted; the API exposes only whether one is set."""
        self.assertTrue(self.conn.token_set)
        row = ZabbixConnection.objects.get(pk=self.conn.pk)
        self.assertEqual(row.credentials["token"], TOKEN)
        self.assertNotIn(
            TOKEN,
            str(ZabbixConnection.objects.filter(pk=self.conn.pk).query),
        )


class ErrorShapeTests(_Base):
    def test_an_http_error_is_a_zabbix_error_not_a_crash(self):
        from .client import ZabbixClient

        with mock.patch("zabbix.client.safe_post", return_value=_resp(500)):
            with self.assertRaises(ZabbixError):
                ZabbixClient("https://x/api_jsonrpc.php", TOKEN).version()

    def test_a_transport_failure_is_unreachable(self):
        from .client import ZabbixClient

        with mock.patch("zabbix.client.safe_post", side_effect=OSError("boom")):
            with self.assertRaises(ZabbixUnreachable):
                ZabbixClient("https://x/api_jsonrpc.php", TOKEN).version()


class SeverityMapTests(TestCase):
    """Zabbix severities are mapped onto Danbyte's six statuses, not added to
    them - the rollup, dashboard, site map, topology and faceplates all key off
    that set."""

    def test_defaults_treat_information_as_noise(self):
        from .severity import DEFAULT_MAP

        self.assertEqual(DEFAULT_MAP["0"], "up")
        self.assertEqual(DEFAULT_MAP["1"], "up")
        self.assertEqual(DEFAULT_MAP["2"], "degraded")
        self.assertEqual(DEFAULT_MAP["4"], "down")
        self.assertEqual(DEFAULT_MAP["5"], "down")

    def test_a_partial_map_is_filled_in_not_left_holey(self):
        """A hole would read as `up`, which is the one wrong way to fail."""
        from .severity import clean_map

        out = clean_map({"5": "degraded"})
        self.assertEqual(out["5"], "degraded")
        self.assertEqual(out["4"], "down")

    def test_junk_is_ignored(self):
        from .severity import clean_map

        out = clean_map({"4": "explodey", "nonsense": "down", "2": None})
        self.assertEqual(out["4"], "down")
        self.assertEqual(out["2"], "degraded")

    def test_a_non_dict_map_is_the_defaults(self):
        from .severity import DEFAULT_MAP, clean_map

        self.assertEqual(clean_map(None), DEFAULT_MAP)
        self.assertEqual(clean_map("nope"), DEFAULT_MAP)

    def test_worst_wins(self):
        """One Disaster among a dozen Warnings is a down host."""
        from .severity import DEFAULT_MAP, worst

        self.assertEqual(worst([], DEFAULT_MAP), "up")
        self.assertEqual(worst(["1", "1"], DEFAULT_MAP), "up")
        self.assertEqual(worst(["2", "1"], DEFAULT_MAP), "degraded")
        self.assertEqual(worst(["2", "2", "5"], DEFAULT_MAP), "down")
        # Integers and strings both arrive from the API depending on the call.
        self.assertEqual(worst([4], DEFAULT_MAP), "down")


class AnswerTests(_Base):
    """What one host's verdict is, given what Zabbix said about it."""

    def _for(self, rows, problems=None, mapping=None):
        from .severity import DEFAULT_MAP

        return ZabbixDriver._for_host(
            rows, problems or {}, mapping or DEFAULT_MAP
        )

    HOST = {"hostid": "1", "name": "sw1", "status": "0", "maintenance_status": "0"}

    def test_no_problems_is_up(self):
        out = self._for([self.HOST])
        self.assertEqual(out.status, "up")
        self.assertEqual(out.detail["zabbix_host"], "sw1")

    def test_a_high_problem_is_down(self):
        out = self._for([self.HOST], {"1": [{"name": "boom", "severity": "4"}]})
        self.assertEqual(out.status, "down")
        self.assertEqual(out.detail["problem_count"], 1)
        self.assertEqual(out.detail["problems"][0]["name"], "boom")

    def test_a_warning_is_degraded(self):
        out = self._for([self.HOST], {"1": [{"name": "warm", "severity": "2"}]})
        self.assertEqual(out.status, "degraded")

    def test_an_unknown_address_is_unknown_never_down(self):
        """Not being monitored is not the same as being off, and conflating
        them is how a monitoring system loses trust."""
        out = self._for([])
        self.assertEqual(out.status, "unknown")
        self.assertIn("No Zabbix host", out.detail["error"])

    def test_two_hosts_on_one_address_refuses_to_guess(self):
        out = self._for([self.HOST, {**self.HOST, "hostid": "2", "name": "sw2"}])
        self.assertEqual(out.status, "unknown")
        self.assertIn("sw1", out.detail["error"])
        self.assertIn("sw2", out.detail["error"])

    def test_a_host_disabled_in_zabbix_is_unknown(self):
        """Danbyte does not argue with a decision somebody already made."""
        out = self._for([{**self.HOST, "status": "1"}])
        self.assertEqual(out.status, "unknown")
        self.assertEqual(out.detail["state"], "disabled in Zabbix")

    def test_a_host_in_maintenance_is_unknown_not_down(self):
        out = self._for([{**self.HOST, "maintenance_status": "1"}])
        self.assertEqual(out.status, "unknown")
        self.assertEqual(out.detail["state"], "in maintenance")

    def test_the_problem_list_is_capped(self):
        many = [{"name": f"p{i}", "severity": "2"} for i in range(40)]
        out = self._for([self.HOST], {"1": many})
        self.assertEqual(out.detail["problem_count"], 40)
        self.assertEqual(len(out.detail["problems"]), 10)


class ClaimTests(_Base):
    """The bulk path: claim, ask twice, fold through ingest_results."""

    def setUp(self):
        super().setUp()
        from api.models import IPAddress, Prefix
        from monitoring.models import CheckState, CheckTemplate

        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.8.0.0/24")
        self.tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", kind="zabbix", interval_seconds=300
        )
        self.ips = [
            IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.8.0.{n}/24", prefix=self.prefix
            )
            for n in (10, 11)
        ]
        for ip in self.ips:
            CheckState.objects.create(
                tenant=self.tenant, target_ip=ip, template=self.tmpl,
                engine=self.engine, kind="zabbix", interval_seconds=300,
                next_run=timezone.now(),
            )

    def _run(self, hosts, problems):
        with mock.patch.object(ZabbixClient, "hosts_by_ip", return_value=hosts), \
             mock.patch.object(ZabbixClient, "problems_by_host", return_value=problems):
            return ZabbixDriver().claim(self.engine, timezone.now())

    def test_two_calls_settle_every_due_state(self):
        from monitoring.models import CheckState

        n = self._run(
            {"10.8.0.10": [{"hostid": "1", "name": "a", "status": "0",
                            "maintenance_status": "0"}]},
            {"1": [{"name": "boom", "severity": "5"}]},
        )
        self.assertEqual(n, 2)
        states = {s.target_ip.ip_address: s for s in
                  CheckState.objects.select_related("target_ip")}
        # Claimed and released - a state left in flight is one the reaper has
        # to rescue later.
        self.assertFalse(any(s.in_flight for s in states.values()))
        # And rescheduled, so a second tick does not re-answer them.
        self.assertTrue(all(s.next_run > timezone.now() for s in states.values()))

    def test_nothing_due_is_no_api_call_at_all(self):
        from monitoring.models import CheckState

        CheckState.objects.update(next_run=timezone.now() + timedelta(hours=1))
        with mock.patch.object(ZabbixClient, "hosts_by_ip") as h:
            self.assertEqual(ZabbixDriver().claim(self.engine, timezone.now()), 0)
        h.assert_not_called()

    def test_an_api_failure_answers_unknown_rather_than_stranding_states(self):
        """The states are already claimed; raising would leave them in flight
        until the reaper notices."""
        from monitoring.models import CheckResult, CheckState

        with mock.patch.object(
            ZabbixClient, "hosts_by_ip", side_effect=ZabbixError("gone away")
        ):
            n = ZabbixDriver().claim(self.engine, timezone.now())
        self.assertEqual(n, 2)
        self.assertFalse(CheckState.objects.filter(in_flight=True).exists())
        detail = CheckResult.objects.latest("id").detail
        self.assertIn("gone away", detail["error"])

    def test_it_only_claims_its_own_engine_and_kind(self):
        from monitoring.models import CheckState, MonitoringEngine

        other = MonitoringEngine.local_for(self.tenant)
        CheckState.objects.update(engine=other)
        with mock.patch.object(ZabbixClient, "hosts_by_ip") as h:
            self.assertEqual(ZabbixDriver().claim(self.engine, timezone.now()), 0)
        h.assert_not_called()

    def test_no_connection_claims_nothing(self):
        self.conn.delete()
        with mock.patch.object(ZabbixClient, "hosts_by_ip") as h:
            self.assertEqual(ZabbixDriver().claim(self.engine, timezone.now()), 0)
        h.assert_not_called()

    def test_the_mask_is_stripped_before_asking_zabbix(self):
        """Danbyte stores 10.8.0.10/24; Zabbix knows 10.8.0.10."""
        with mock.patch.object(ZabbixClient, "hosts_by_ip", return_value={}) as h, \
             mock.patch.object(ZabbixClient, "problems_by_host", return_value={}):
            ZabbixDriver().claim(self.engine, timezone.now())
        asked = h.call_args[0][0]
        self.assertEqual(asked, {"10.8.0.10", "10.8.0.11"})


class CheckerTests(TestCase):
    """The kind exists so templates and policies can target Zabbix. It must
    never actually run on the core."""

    def test_the_kind_is_selectable(self):
        from monitoring.models import check_kinds

        self.assertIn("zabbix", dict(check_kinds()))

    def test_running_it_locally_says_why_rather_than_reporting_down(self):
        import asyncio

        from .checker import ZabbixChecker

        out = asyncio.run(ZabbixChecker().run("10.0.0.1", {}, {}, 1000))
        self.assertEqual(out.status, "unknown")
        self.assertIn("answered by a Zabbix engine", out.detail["error"])

    def test_it_takes_no_params(self):
        from .checker import ZabbixChecker

        self.assertIsNone(ZabbixChecker().validate_params({"anything": 1}))
