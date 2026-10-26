"""The PRTG connection API: secrets, scoping, the toggle and the test action."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection as db
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant
from integrations.models import IntegrationSettings
from prtg.models import PrtgConnection

from .fake_server import FakePrtg

URL = "/api/prtg/connections/"
KEY = "s3cret-prtg-api-key"


class _Base(APITestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.fake = FakePrtg().start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()
        super().tearDownClass()

    def setUp(self):
        self.fake.reset()
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = ["127.0.0.1/32"]
        ds.save()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        for tenant in (self.tenant, self.other):
            IntegrationSettings.objects.update_or_create(
                tenant=tenant, defaults={"prtg_enabled": True}
            )
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.conn = PrtgConnection.objects.create(
            tenant=self.tenant, name="prtg", url=self.fake.url,
            api_v2_url=self.fake.v2_url, credentials={"api_key": self.fake.api_key},
        )

    def login(self, user=None, tenant=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str((tenant or self.tenant).id)
        sess.save()

    def member(self, actions, username="m"):
        user = get_user_model().objects.create_user(username, f"{username}@x.io", "pw")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        if actions:
            perm = ObjectPermission.objects.create(
                name=username, object_types=["prtgconnection"], actions=actions
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
        return user


class ConnectionSecretTests(_Base):
    def test_the_key_is_write_only_and_encrypted_at_rest(self):
        self.login()
        r = self.client.post(URL, {
            "name": "two", "url": "https://prtg.example.com/", "api_key": KEY,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertNotIn("api_key", body)
        self.assertNotIn("credentials", body)
        self.assertTrue(body["api_key_set"])
        self.assertEqual(body["url"], "https://prtg.example.com")
        self.assertEqual(body["v2_base"], "https://prtg.example.com:1616/api/v2")
        self.assertEqual(body["provision_scope"], "policies")
        self.assertEqual(body["status_interval_seconds"], 120)

        conn = PrtgConnection.objects.get(name="two")
        self.assertEqual(conn.api_key, KEY)
        with db.cursor() as cur:
            cur.execute(
                "SELECT credentials FROM prtg_prtgconnection WHERE id=%s", [conn.id]
            )
            stored = cur.fetchone()[0]
        self.assertTrue(stored)
        self.assertNotIn(KEY, stored)

        for path in (URL, f"{URL}{conn.id}/"):
            self.assertNotIn(KEY, self.client.get(path).content.decode())
        for entry in ChangeLogEntry.objects.filter(object_id=str(conn.id)):
            self.assertNotIn(KEY, str(entry.__dict__))

    def test_a_blank_key_keeps_the_stored_one(self):
        self.login()
        r = self.client.patch(f"{URL}{self.conn.id}/", {"api_key": "", "name": "renamed"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.api_key, self.fake.api_key)

    def test_moving_the_url_to_another_host_drops_the_key(self):
        self.login()
        url = f"{URL}{self.conn.id}/"
        self.client.patch(url, {"url": self.fake.url + "/"}, format="json")
        self.conn.refresh_from_db()
        self.assertTrue(self.conn.api_key_set)  # same origin keeps it
        r = self.client.patch(
            url, {"url": "https://evil.example.net", "api_v2_url": ""}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.api_key_set)

    def test_v2_url_must_name_the_same_host(self):
        self.login()
        r = self.client.patch(f"{URL}{self.conn.id}/", {
            "api_v2_url": "https://elsewhere.example.net:1616/api/v2",
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("api_v2_url", r.json())

    def test_validation(self):
        self.login()
        for payload, field in (
            ({"name": "x", "url": "prtg.example.com"}, "url"),
            ({"name": "x", "url": "https://prtg.example.com/api"}, "url"),
            ({"name": "x", "url": "https://p.example.com", "status_interval_seconds": 10},
             "status_interval_seconds"),
            ({"name": "prtg", "url": "https://p.example.com"}, "name"),
            ({"name": "x", "url": "https://p.example.com", "provision_scope": "all"},
             "provision_scope"),
        ):
            with self.subTest(field=field):
                r = self.client.post(URL, payload, format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(field, r.json())

    def test_same_name_in_another_tenant_is_fine(self):
        self.login(tenant=self.other)
        r = self.client.post(URL, {"name": "prtg", "url": "https://p.example.com"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(PrtgConnection.objects.get(pk=r.json()["id"]).tenant, self.other)


class ScopeTests(_Base):
    def test_toggle_off_hides_the_surface(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.login()
        self.assertEqual(self.client.get(URL).status_code, 404)
        self.assertEqual(self.client.post(f"{URL}{self.conn.id}/test/").status_code, 404)

    def test_another_tenants_connection_is_invisible(self):
        self.login(tenant=self.other)
        self.assertEqual(self.client.get(URL).json()["count"], 0)
        self.assertEqual(self.client.get(f"{URL}{self.conn.id}/").status_code, 404)
        self.assertEqual(self.client.post(f"{URL}{self.conn.id}/test/").status_code, 404)
        self.assertEqual(self.client.delete(f"{URL}{self.conn.id}/").status_code, 404)
        self.assertTrue(PrtgConnection.objects.filter(pk=self.conn.pk).exists())
        self.assertEqual(self.fake.requests, [])

    def test_default_closed(self):
        self.login(self.member([]))
        self.assertEqual(self.client.get(URL).status_code, 403)

    def test_view_does_not_allow_changes_or_tests(self):
        self.login(self.member(["view"]))
        self.assertEqual(self.client.get(URL).status_code, 200)
        r = self.client.post(URL, {"name": "x", "url": "https://p.example.com"}, format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.patch(f"{URL}{self.conn.id}/", {"name": "y"}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.post(f"{URL}{self.conn.id}/test/").status_code, 403)
        self.assertEqual(self.fake.requests, [])

    def test_anonymous_is_refused(self):
        self.assertIn(self.client.get(URL).status_code, (401, 403))


class TestActionTests(_Base):
    def test_reports_version_and_counts(self):
        self.login()
        r = self.client.post(f"{URL}{self.conn.id}/test/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["version"], "26.3.124.1727")
        self.assertEqual(body["probes"], 1)
        self.assertEqual(body["sensors"], 6)
        self.assertTrue(body["v2_available"])
        self.assertIn("1 probe, 6 sensors", body["detail"])
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.version, "26.3.124.1727")
        self.assertTrue(self.conn.v2_available)
        self.assertTrue(self.conn.supported)
        self.assertIsNotNone(self.conn.last_checked_at)
        self.assertEqual(self.conn.last_error, "")
        listed = self.client.get(f"{URL}{self.conn.id}/").json()
        self.assertEqual(listed["version"], "26.3.124.1727")

    def test_no_v2_still_passes(self):
        self.fake.v2 = False
        self.login()
        r = self.client.post(f"{URL}{self.conn.id}/test/")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["v2_available"])
        self.conn.refresh_from_db()
        self.assertIs(self.conn.v2_available, False)

    def test_a_refused_key_is_recorded(self):
        self.conn.credentials = {"api_key": "wrong"}
        self.conn.save()
        self.login()
        r = self.client.post(f"{URL}{self.conn.id}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertFalse(r.json()["ok"])
        self.assertIn("refused the API key", r.json()["detail"])
        self.conn.refresh_from_db()
        self.assertIn("refused the API key", self.conn.last_error)

    def test_no_key_does_not_call_prtg(self):
        self.conn.credentials = {}
        self.conn.save()
        self.login()
        r = self.client.post(f"{URL}{self.conn.id}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["detail"], "No API key is set.")
        self.assertEqual(self.fake.requests, [])

    def test_below_the_floor(self):
        self.fake.status = {**self.fake.status, "Version": "23.4.90.1299+"}
        self.login()
        r = self.client.post(f"{URL}{self.conn.id}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertIn("below the supported floor (24.1)", r.json()["detail"])

    def test_a_private_address_the_deployment_has_not_allowed(self):
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = []
        ds.save()
        self.login()
        r = self.client.post(f"{URL}{self.conn.id}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertIn("Could not reach", r.json()["detail"])
        self.assertEqual(self.fake.requests, [])


class ModelTests(_Base):
    def test_v2_base_derivation(self):
        conn = PrtgConnection(url="https://prtg.example.com")
        self.assertEqual(conn.v2_base, "https://prtg.example.com:1616/api/v2")
        conn.url = "http://10.0.0.60:8080"
        self.assertEqual(conn.v2_base, "http://10.0.0.60:1615/api/v2")
        conn.api_v2_url = "https://prtg.example.com:9443/api/v2/"
        self.assertEqual(conn.v2_base, "https://prtg.example.com:9443/api/v2")

    def test_column_defaults_cover_an_insert_that_names_no_optional_column(self):
        """A row inserted by code that knows only the required columns gets
        every default from the database."""
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO prtg_prtgconnection (id, tenant_id, name, url, created_at, "
                "updated_at) VALUES (gen_random_uuid(), %s, 'raw', 'https://r', now(), now()) "
                "RETURNING id",
                [self.tenant.id],
            )
            pk = cur.fetchone()[0]
        conn = PrtgConnection.objects.get(pk=pk)
        self.assertEqual(conn.provision_scope, "policies")
        self.assertEqual(conn.status_interval_seconds, 120)
        self.assertTrue(conn.verify_tls)
        self.assertTrue(conn.enabled)
        self.assertEqual(conn.credentials, {})
        self.assertFalse(conn.api_key_set)
        self.assertIsNone(conn.v2_available)
