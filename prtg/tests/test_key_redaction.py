"""The API key never leaves in error text, whatever the server answers (#459)."""
from __future__ import annotations

from importlib import import_module
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from core.redaction import redact_secrets, redact_value
from integrations.models import IntegrationSettings
from prtg import client as client_mod
from prtg import client_v2 as client_v2_mod
from prtg.client import PrtgClient, PrtgError, PrtgUnauthorized
from prtg.client_v2 import PrtgV2Client
from prtg.models import PrtgChange, PrtgConnection

KEY = "k3y-0123456789abcdef"
URL = "https://prtg.example.com"


class _Resp:
    def __init__(self, code, text="", headers=None, json_body=None):
        self.status_code = code
        self.text = text
        self.headers = headers or {}
        self._json = json_body

    def json(self):
        if self._json is None:
            raise ValueError("not json")
        return self._json


def _echo(code):
    """An error page that repeats the request, the way a proxy or WAF does."""
    def answer(method, url, params=None, headers=None, **kw):
        query = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        return _Resp(code, (
            f"<html><body>{code} error while handling {url}?{query} "
            f"(Authorization: {(headers or {}).get('Authorization', '-')})</body></html>"
        ))
    return answer


class RedactHelperTests(SimpleTestCase):
    def test_known_secret_plain_and_url_encoded(self):
        key = "a/b+c=d&e"
        text = f"x {key} y a%2Fb%2Bc%3Dd%26e z"
        self.assertEqual(redact_secrets(text, key), "x REDACTED y REDACTED z")

    def test_credential_query_parameters_and_bearer(self):
        self.assertEqual(
            redact_secrets("/api/x?id=1&apitoken=abc&passhash=99&token=t&page=2"),
            "/api/x?id=1&apitoken=REDACTED&passhash=REDACTED&token=REDACTED&page=2",
        )
        self.assertEqual(
            redact_secrets("Authorization: Bearer 0123456789abcdefXYZ"),
            "Authorization: Bearer REDACTED",
        )
        # Ordinary words survive.
        self.assertEqual(redact_secrets("Bearer header refused"), "Bearer header refused")
        self.assertEqual(redact_secrets("id=1&mytoken_count=3"), "id=1&mytoken_count=3")

    def test_json_values(self):
        value, changed = redact_value({"a": [f"x {KEY}"], "b": 1}, KEY)
        self.assertTrue(changed)
        self.assertEqual(value, {"a": ["x REDACTED"], "b": 1})
        self.assertEqual(redact_value({"a": "fine"}, KEY), ({"a": "fine"}, False))


class ClassicClientTests(SimpleTestCase):
    def prtg(self):
        return PrtgClient(URL, KEY, v2_url=f"{URL}:1616/api/v2", page_gap=0)

    def assertClean(self, exc):
        text = str(exc)
        self.assertNotIn(KEY, text)
        self.assertNotIn(KEY[:12], text)
        return text

    def test_every_error_status_is_redacted(self):
        for code in (400, 404, 500, 502, 503):
            with self.subTest(code=code), \
                    mock.patch.object(client_mod, "safe_request", side_effect=_echo(code)):
                with self.assertRaises(PrtgError) as ctx:
                    self.prtg().version()
                text = self.assertClean(ctx.exception)
                self.assertIn(f"HTTP {code}", text)
                self.assertIn("apitoken=REDACTED", text)

    def test_a_refused_key_is_redacted(self):
        for code in (401, 403):
            with self.subTest(code=code), \
                    mock.patch.object(client_mod, "safe_request", side_effect=_echo(code)):
                with self.assertRaises(PrtgUnauthorized) as ctx:
                    self.prtg().version()
                self.assertIn("refused the API key", self.assertClean(ctx.exception))

    def test_a_redirect_is_redacted(self):
        long = "x" * 190
        resp = _Resp(302, headers={"Location": f"/{long}/error.htm?apitoken={KEY}"})
        with mock.patch.object(client_mod, "safe_request", return_value=resp):
            with self.assertRaises(PrtgError) as ctx:
                self.prtg().version()
        self.assertClean(ctx.exception)

    def test_a_history_error_is_redacted(self):
        from datetime import datetime

        body = f'<?xml version="1.0"?><prtg><error>bad call ?apitoken={KEY}</error></prtg>'
        with mock.patch.object(client_mod, "safe_request", return_value=_Resp(200, body)):
            with self.assertRaises(PrtgError) as ctx:
                self.prtg().historic(1, datetime(2026, 1, 1), datetime(2026, 1, 2), 60)
        self.assertClean(ctx.exception)

    def test_a_transport_error_is_redacted(self):
        def boom(method, url, params=None, **kw):
            raise OSError(f"connection reset on {url}?apitoken={params['apitoken']}")

        with mock.patch.object(client_mod, "safe_request", side_effect=boom):
            with self.assertRaises(PrtgError) as ctx:
                self.prtg().version()
        self.assertClean(ctx.exception)


class V2ClientTests(SimpleTestCase):
    def test_error_bodies_are_redacted(self):
        client = PrtgV2Client(f"{URL}:1616/api/v2", KEY, write_gap=0)
        for code, kind in ((401, PrtgUnauthorized), (500, PrtgError), (400, PrtgError)):
            with self.subTest(code=code), \
                    mock.patch.object(client_v2_mod, "safe_request", side_effect=_echo(code)):
                with self.assertRaises(kind) as ctx:
                    client._call("GET", "/experimental/sensors")
                self.assertNotIn(KEY, str(ctx.exception))
                self.assertIn("Bearer REDACTED", str(ctx.exception))


class ZabbixClientTests(SimpleTestCase):
    def test_error_text_is_redacted(self):
        from zabbix.client import ZabbixClient, ZabbixError, ZabbixUnreachable

        token = "zbx-0123456789abcdef0123"
        client = ZabbixClient("https://z.example.com/api_jsonrpc.php", token)
        page = _Resp(502, f"bad gateway; request had Authorization: Bearer {token}")
        with mock.patch("zabbix.client.safe_post", return_value=page):
            with self.assertRaises(ZabbixError) as ctx:
                client.call("host.get")
        self.assertNotIn(token, str(ctx.exception))
        with mock.patch("zabbix.client.safe_post", side_effect=OSError(f"reset {token}")):
            with self.assertRaises(ZabbixUnreachable) as ctx:
                client.call("host.get")
        self.assertNotIn(token, str(ctx.exception))
        self.assertIsNone(ctx.exception.__cause__)


class ConnectionApiTests(TestCase):
    """The reported path: Test connection against a server whose error page
    repeats the URL, then a read-only user lists the connections."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"prtg_enabled": True})
        self.conn = PrtgConnection.objects.create(
            tenant=self.tenant, name="prtg", url=URL, credentials={"api_key": KEY},
        )
        User = get_user_model()
        self.admin = User.objects.create_superuser("root459", "r@x.io", "pw")
        self.viewer = User.objects.create_user("view459", "v@x.io", "pw")
        UserProfile.objects.create(user=self.viewer, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["prtgconnection"], actions=["view"])
        perm.users.add(self.viewer)
        perm.tenants.add(self.tenant)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_test_connection_and_the_list_never_show_the_key(self):
        self.login(self.admin)
        for code in (500, 401):
            with self.subTest(code=code), \
                    mock.patch.object(client_mod, "safe_request", side_effect=_echo(code)):
                r = self.client.post(f"/api/prtg/connections/{self.conn.id}/test/")
                self.assertNotIn(KEY, r.content.decode())
                self.assertIn("REDACTED", r.content.decode())
                self.conn.refresh_from_db()
                self.assertNotIn(KEY, self.conn.last_error)
                self.assertIn("REDACTED", self.conn.last_error)
        self.login(self.viewer)
        r = self.client.get("/api/prtg/connections/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn(KEY, r.content.decode())
        for entry in ChangeLogEntry.objects.filter(object_type="prtg.prtgconnection"):
            self.assertNotIn(KEY, str(entry.changes) + str(entry.post_change))


class ScrubMigrationTests(TestCase):
    """0018 masks keys that error text already stored."""

    def test_stored_rows_are_scrubbed(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        conn = PrtgConnection.objects.create(
            tenant=tenant, name="prtg", url=URL, credentials={"api_key": KEY},
        )
        leaked = f"HTTP 500: error handling {URL}/api/getstatus.htm?id=0&apitoken={KEY}"
        PrtgConnection.objects.filter(pk=conn.pk).update(
            last_error=leaked, write_detail=f"failed {KEY}"[:255],
            last_status_summary={"error": leaked},
            last_apply_summary={"failures": [leaked]},
        )
        change = PrtgChange.objects.create(
            tenant=tenant, connection=conn, kind=PrtgChange.ADOPT, key="1",
            detail={"error": leaked},
        )
        entry = ChangeLogEntry.objects.create(
            object_type="prtg.prtgconnection", object_id=str(conn.pk), action="update",
            object_label="PRTG connection", object_repr="prtg",
            changes={"last_error": {"old": "", "new": leaked}},
            post_change={"last_error": "x?apitoken=other-key-entirely"},
        )
        mig = import_module("prtg.migrations.0018_scrub_api_key_from_errors")
        from django.apps import apps

        mig.scrub(apps, None)
        mig.scrub(apps, None)  # idempotent

        conn.refresh_from_db()
        change.refresh_from_db()
        entry.refresh_from_db()
        self.assertEqual(
            conn.last_error,
            f"HTTP 500: error handling {URL}/api/getstatus.htm?id=0&apitoken=REDACTED",
        )
        self.assertEqual(conn.write_detail, "failed REDACTED")
        self.assertNotIn(KEY, str(conn.last_status_summary) + str(conn.last_apply_summary))
        self.assertNotIn(KEY, str(change.detail))
        self.assertNotIn(KEY, str(entry.changes))
        self.assertEqual(entry.post_change, {"last_error": "x?apitoken=REDACTED"})
        self.assertEqual(conn.api_key, KEY)  # the key itself is untouched
