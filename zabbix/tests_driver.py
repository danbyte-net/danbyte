"""The Zabbix engine seam (#162), Phase 0.

Two things are being asserted: that a driver kind plugs into engine resolution
without the resolver knowing what Zabbix is, and that turning the integration
off makes the engine *unchosen* rather than *unreachable* - the difference
between a quiet switch and one that pages somebody.

No network: the client is mocked. The request shapes are what the Zabbix
JSON-RPC API expects, verified separately against a real 7.0 server.
"""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.engine_drivers import (
    driver_for,
    engine_kinds,
    engine_usable,
    register_monitoring_engine,
)
from monitoring.models import MonitoringEngine

from .client import ZabbixError, ZabbixUnreachable
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
