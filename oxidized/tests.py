"""Device configuration backups through Oxidized (#35).

Every test talks to a real HTTP server in this process that answers like
oxidized-web, so the client, the SSRF guard, basic auth and the size cap are
exercised end to end rather than mocked.
"""
from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock
from urllib.parse import parse_qs, unquote, urlparse

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Prefix, Site
from auth_api.builtin_groups import BUILTINS
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import CAPABILITY_VERBS
from core.models import DeploymentSettings, Organization, Tenant
from integrations.models import IntegrationSettings

from . import client as client_mod
from .models import OxidizedConnection, OxidizedNodeLink
from .sync import sync_nodes

OID1 = "a" * 40
OID2 = "b" * 40

#: What the fake server answers with; reset per test.
FAKE: dict = {}


def _reset():
    FAKE.clear()
    FAKE.update(
        nodes=[],
        configs={},  # full_name -> text
        versions={},  # full_name -> [rows]
        blobs={},  # oid -> text
        auth=None,  # (user, password) the server insists on
        requests=[],
        redirect=False,
        next=[],
    )


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def _send(self, status, body, ctype="text/plain"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj):
        self._send(200, json.dumps(obj), "application/json")

    def _authorised(self) -> bool:
        want = FAKE.get("auth")
        if not want:
            return True
        token = base64.b64encode(f"{want[0]}:{want[1]}".encode()).decode()
        return self.headers.get("Authorization") == f"Basic {token}"

    def do_PUT(self):
        FAKE["requests"].append(("PUT", self.path))
        if not self._authorised():
            return self._send(401, "auth")
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        FAKE["next"].append((unquote(urlparse(self.path).path), body))
        self._json("ok")

    def do_GET(self):
        FAKE["requests"].append(("GET", self.path))
        if not self._authorised():
            return self._send(401, "auth")
        if FAKE.get("redirect"):
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()
            return
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        path = url.path
        if path == "/nodes.json":
            return self._json(FAKE["nodes"])
        if path.startswith("/node/fetch/"):
            parts = [unquote(p) for p in path[len("/node/fetch/"):].split("/")]
            name, group = parts[-1], "/".join(parts[:-1])
            full = f"{group}/{name}" if group else name
            if full in FAKE["configs"]:
                return self._send(200, FAKE["configs"][full])
            return self._send(200, f"unable to find '{name}'")
        if path == "/node/version.json":
            rows = FAKE["versions"].get(q.get("node_full"))
            return self._json(rows if rows is not None else ["node not found"])
        if path == "/node/version/view":
            FAKE.setdefault("view_formats", []).append(q.get("format"))
            blob = FAKE["blobs"].get(q.get("oid"))
            return self._send(200, blob if blob is not None else "version not found")
        return self._send(404, "<h1>Not Found</h1>", "text/html")


class _Server:
    def __init__(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def node(name, ip="", group=None, model="IOS"):
    full = f"{group}/{name}" if group else name
    return {
        "name": name, "full_name": full, "ip": ip, "group": group or "default",
        "model": model, "status": "success", "time": "2026-10-01 10:00:00 +0000",
        "last": None, "vars": {}, "mtime": "unknown",
    }


LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


@override_settings(CACHES=LOCMEM)
class _Base(APITestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.server = _Server()

    @classmethod
    def tearDownClass(cls):
        cls.server.close()
        super().tearDownClass()

    def setUp(self):
        _reset()
        from django.core.cache import cache

        cache.clear()  # the locmem cache of this test class only
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = ["127.0.0.1/32"]
        ds.save()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other_tenant = Tenant.objects.create(org=org, name="U", slug="u")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"oxidized_enabled": True}
        )
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        self.conn = OxidizedConnection.objects.create(
            tenant=self.tenant, name="ox", url=f"http://127.0.0.1:{self.server.port}",
        )
        self.device = Device.objects.create(tenant=self.tenant, name="sw1", site=self.site_a)
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.10/24", prefix=self.prefix,
            assigned_device=self.device, site=self.site_a,
        )
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")

    def login(self, user=None, tenant=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str((tenant or self.tenant).id)
        sess.save()

    def member(self, *grants, username="m"):
        """A tenant member holding ``grants``: (types, actions, site or None)."""
        user = get_user_model().objects.create_user(username, f"{username}@x.io", "pw")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for i, (types, actions, site) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"{username}-{i}", object_types=types, actions=actions
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            if site is not None:
                perm.sites.add(site)
        return user

    def link(self, device=None, full="sw1", how=OxidizedNodeLink.HOW_ADDRESS):
        name = full.rpartition("/")[2]
        group = full.rpartition("/")[0]
        return OxidizedNodeLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=device or self.device,
            full_name=full, node_name=name, node_group=group, matched_by=how,
        )

    def cfg(self, device=None, query=""):
        return self.client.get(
            f"/api/oxidized/devices/{(device or self.device).id}/config/{query}"
        )


# ─── connection ──────────────────────────────────────────────────────────────


class ConnectionTests(_Base):
    def test_password_is_write_only_and_encrypted(self):
        self.login()
        r = self.client.post("/api/oxidized/connections/", {
            "name": "two", "url": "https://ox.example.com/", "username": "danbyte",
            "password": "s3cret",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("password", r.json())
        self.assertTrue(r.json()["password_set"])
        self.assertEqual(r.json()["url"], "https://ox.example.com")
        conn = OxidizedConnection.objects.get(name="two")
        self.assertEqual(conn.credentials, {"password": "s3cret"})
        from django.db import connection as db

        with db.cursor() as cur:
            cur.execute("SELECT credentials FROM oxidized_oxidizedconnection WHERE id=%s",
                        [conn.id])
            self.assertNotIn("s3cret", cur.fetchone()[0])

    def test_moving_the_url_to_another_host_drops_the_password(self):
        self.conn.username, self.conn.credentials = "u", {"password": "p"}
        self.conn.save()
        self.login()
        url = f"/api/oxidized/connections/{self.conn.id}/"
        self.client.patch(url, {"url": self.conn.url + "/"}, format="json")
        self.conn.refresh_from_db()
        self.assertTrue(self.conn.password_set)  # same origin keeps it
        self.client.patch(url, {"url": "https://evil.example.net"}, format="json")
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.password_set)

    def test_test_counts_nodes(self):
        FAKE["nodes"] = [node("sw1"), node("sw2")]
        self.login()
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/test/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["nodes"], 2)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.node_count, 2)

    def test_basic_auth_is_sent_and_a_refusal_is_reported(self):
        FAKE["auth"] = ("danbyte", "right")
        self.conn.username, self.conn.credentials = "danbyte", {"password": "wrong"}
        self.conn.save()
        self.login()
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertIn("refused the credentials", r.json()["detail"])
        self.conn.credentials = {"password": "right"}
        self.conn.save()
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/test/")
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_ssrf_guard_refuses_an_internal_address_not_allow_listed(self):
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = []
        ds.save()
        self.login()
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertIn("non-public", r.json()["detail"])
        self.assertEqual(FAKE["requests"], [])

    def test_a_redirect_is_not_followed(self):
        FAKE["redirect"] = True
        self.login()
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertIn("redirects are not followed", r.json()["detail"])
        self.assertEqual(len(FAKE["requests"]), 1)

    def test_switched_off_the_surface_is_404(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(oxidized_enabled=False)
        self.login()
        self.assertEqual(self.client.get("/api/oxidized/connections/").status_code, 404)
        self.link()
        self.assertEqual(self.cfg().status_code, 404)

    def test_another_tenants_connection_is_invisible(self):
        OxidizedConnection.objects.create(tenant=self.other_tenant, name="theirs", url="http://x")
        self.login()
        names = [c["name"] for c in self.client.get("/api/oxidized/connections/").json()["results"]]
        self.assertEqual(names, ["ox"])


# ─── node mapping ────────────────────────────────────────────────────────────


class SyncTests(_Base):
    def test_matching_by_address_name_and_fqdn(self):
        Device.objects.create(tenant=self.tenant, name="core1", site=self.site_a)
        Device.objects.create(tenant=self.tenant, name="edge.example.net", site=self.site_a)
        FAKE["nodes"] = [
            node("10.9.0.10", ip="10.9.0.10"),  # sw1 by address
            node("core1.example.net", ip="192.0.2.1", group="core"),  # by short name
            node("edge", ip="192.0.2.2"),  # device's FQDN short part
            node("nobody", ip="192.0.2.3"),
        ]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 3)
        got = {lk.full_name: (lk.device.name, lk.matched_by, lk.node_group)
               for lk in OxidizedNodeLink.objects.all()}
        self.assertEqual(got["10.9.0.10"], ("sw1", "address", ""))
        self.assertEqual(got["core/core1.example.net"], ("core1", "name", "core"))
        self.assertEqual(got["edge"], ("edge.example.net", "name", ""))
        self.assertEqual([u["full_name"] for u in summary["unmatched"]], ["nobody"])

    def test_ambiguity_links_nothing(self):
        Device.objects.create(tenant=self.tenant, name="dup", site=self.site_a)
        Device.objects.create(tenant=self.tenant, name="DUP", site=self.site_b)
        FAKE["nodes"] = [
            node("dup"),
            node("a", ip="10.9.0.10"), node("b", ip="10.9.0.10"),  # two nodes, one device
        ]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 0)
        reasons = {u["full_name"]: u["reason"] for u in summary["unmatched"]}
        self.assertIn("2 devices share", reasons["dup"])
        self.assertIn("2 nodes match sw1", reasons["a"])
        self.assertIn("2 nodes match sw1", reasons["b"])

    def test_match_by_name_ignores_addresses(self):
        self.conn.match_by = OxidizedConnection.MATCH_NAME
        self.conn.save()
        FAKE["nodes"] = [node("router", ip="10.9.0.10")]
        self.assertEqual(sync_nodes(self.conn)["linked"], 0)

    def test_another_tenants_device_is_never_matched(self):
        Device.objects.create(tenant=self.other_tenant, name="theirs")
        FAKE["nodes"] = [node("theirs")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 0)
        self.assertEqual(summary["unmatched_count"], 1)

    def test_a_gone_node_drops_its_matched_link_but_keeps_a_pinned_one(self):
        pinned_dev = Device.objects.create(tenant=self.tenant, name="p", site=self.site_a)
        self.link(full="old")
        self.link(device=pinned_dev, full="grp/pinned", how=OxidizedNodeLink.HOW_MANUAL)
        FAKE["nodes"] = [node("p")]  # would match pinned_dev by name
        summary = sync_nodes(self.conn)
        self.assertEqual(
            list(OxidizedNodeLink.objects.values_list("full_name", flat=True)), ["grp/pinned"]
        )
        self.assertEqual(summary["missing_pinned"], 1)
        self.assertIn("pinned to another node", summary["unmatched"][0]["reason"])

    def test_sync_and_unmatched_endpoints(self):
        FAKE["nodes"] = [node("sw1"), node("ghost", ip="192.0.2.9")]
        self.login()
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/sync/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["linked"], 1)
        r = self.client.get(f"/api/oxidized/connections/{self.conn.id}/unmatched/")
        self.assertEqual(r.json()["count"], 1)
        self.assertEqual(r.json()["results"][0]["ip"], "192.0.2.9")
        row = self.client.get(f"/api/oxidized/connections/{self.conn.id}/").json()
        self.assertEqual(row["sync"]["unmatched_count"], 1)
        self.assertEqual(row["link_count"], 1)

    def test_pinning_a_node_by_hand(self):
        FAKE["nodes"] = [node("ghost", ip="192.0.2.9")]
        sync_nodes(self.conn)
        self.login()
        r = self.client.post("/api/oxidized/links/", {
            "connection_id": str(self.conn.id), "device_id": str(self.device.id),
            "full_name": "ghost",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["matched_by"], "manual")
        self.assertEqual(r.json()["node_ip"], "192.0.2.9")
        sync_nodes(self.conn)  # survives the next pass
        self.assertEqual(OxidizedNodeLink.objects.get().matched_by, "manual")

    def test_pinning_a_foreign_device_is_refused(self):
        theirs = Device.objects.create(tenant=self.other_tenant, name="theirs")
        self.login()
        r = self.client.post("/api/oxidized/links/", {
            "connection_id": str(self.conn.id), "device_id": str(theirs.id),
            "full_name": "x",
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_id", r.json())
        self.assertFalse(OxidizedNodeLink.objects.exists())


# ─── the device's config ─────────────────────────────────────────────────────


class PermissionTests(_Base):
    def setUp(self):
        super().setUp()
        self.link()
        FAKE["configs"]["sw1"] = "hostname sw1\nsnmp-server community s3cret RO\n"

    def test_superuser_reads_the_config(self):
        self.login()
        r = self.cfg()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("community s3cret", r.json()["config"])

    def test_device_view_alone_is_refused(self):
        self.login(self.member((["device"], ["view", "add", "change", "delete"], None)))
        r = self.cfg()
        self.assertEqual(r.status_code, 403)
        self.assertNotIn("s3cret", r.content.decode())
        self.assertEqual(FAKE["requests"], [])

    def test_the_built_in_wildcard_grants_do_not_carry_it(self):
        for _name, _desc, actions, _types in BUILTINS:
            self.assertNotIn("view_config", actions)
        user = self.member((["*"], ["view", "add", "change", "delete"], None), username="w")
        self.login(user)
        self.assertEqual(self.cfg().status_code, 403)

    def test_the_verb_is_advertised_on_devices(self):
        self.assertIn("view_config", CAPABILITY_VERBS["device"])

    def test_view_config_grants_it(self):
        self.login(self.member((["device"], ["view", "view_config"], None)))
        self.assertEqual(self.cfg().status_code, 200)

    def test_view_config_is_site_scoped(self):
        other = Device.objects.create(tenant=self.tenant, name="sw9", site=self.site_b)
        self.link(device=other, full="sw9")
        FAKE["configs"]["sw9"] = "hostname sw9\n"
        user = self.member(
            (["device"], ["view"], None),
            (["device"], ["view_config"], self.site_a),
        )
        self.login(user)
        self.assertEqual(self.cfg().status_code, 200)
        self.assertEqual(self.cfg(other).status_code, 403)

    def test_a_device_the_user_cannot_see_is_404(self):
        user = self.member((["device"], ["view", "view_config"], self.site_b))
        self.login(user)
        self.assertEqual(self.cfg().status_code, 404)

    def test_another_tenants_device_is_404(self):
        theirs = Device.objects.create(tenant=self.other_tenant, name="sw1")
        self.login()
        self.assertEqual(self.cfg(theirs).status_code, 404)
        self.assertEqual(
            self.client.get(f"/api/oxidized/devices/{theirs.id}/versions/").status_code, 404
        )

    def test_a_link_from_another_device_cannot_be_borrowed(self):
        other = Device.objects.create(tenant=self.tenant, name="sw2", site=self.site_a)
        theirs = self.link(device=other, full="sw2")
        FAKE["configs"]["sw2"] = "hostname sw2\n"
        self.login()
        r = self.cfg(query=f"?link={theirs.id}")
        self.assertEqual(r.status_code, 404)

    def test_a_disabled_connection_serves_nothing(self):
        self.conn.enabled = False
        self.conn.save()
        self.login()
        self.assertEqual(self.cfg().status_code, 404)
        self.assertEqual(
            self.client.get(f"/api/oxidized/devices/{self.device.id}/").json()["links"], []
        )

    def test_the_cache_is_behind_the_permission_check(self):
        self.login()
        self.assertEqual(self.cfg().status_code, 200)  # now cached
        self.login(self.member((["device"], ["view"], None)))
        self.assertEqual(self.cfg().status_code, 403)


class ConfigTests(_Base):
    def setUp(self):
        super().setUp()
        self.link(full="core/sw1")
        self.login()

    def test_a_grouped_node_is_fetched_by_group_and_name(self):
        FAKE["configs"]["core/sw1"] = "hostname sw1\n"
        r = self.cfg()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["lines"], 1)
        self.assertEqual(r.json()["link"]["full_name"], "core/sw1")
        self.assertIn(("GET", "/node/fetch/core/sw1"), FAKE["requests"])

    def test_an_unknown_node_is_404_not_a_config(self):
        r = self.cfg()
        self.assertEqual(r.status_code, 404)
        self.assertIn("unable to find", r.json()["detail"])

    def test_a_device_without_a_node_is_404(self):
        bare = Device.objects.create(tenant=self.tenant, name="bare", site=self.site_a)
        self.assertEqual(self.cfg(bare).status_code, 404)

    def test_reads_are_cached_briefly_and_refresh_skips_it(self):
        FAKE["configs"]["core/sw1"] = "one\n"
        self.assertFalse(self.cfg().json()["cached"])
        FAKE["configs"]["core/sw1"] = "two\n"
        r = self.cfg()
        self.assertTrue(r.json()["cached"])
        self.assertEqual(r.json()["config"], "one\n")
        self.assertEqual(self.cfg(query="?refresh=1").json()["config"], "two\n")

    def test_config_text_is_never_stored(self):
        FAKE["configs"]["core/sw1"] = "hostname UNIQUE-MARKER\n"
        self.cfg()
        from django.db import connection as db

        with db.cursor() as cur:
            for table in ("oxidized_oxidizedconnection", "oxidized_oxidizednodelink"):
                cur.execute(f"SELECT * FROM {table}")  # noqa: S608 - fixed names
                self.assertNotIn("UNIQUE-MARKER", repr(cur.fetchall()))

    def test_markup_comes_back_as_plain_json_text(self):
        evil = 'banner motd ^<script>alert(1)</script><img src=x onerror=alert(2)>^\n'
        FAKE["configs"]["core/sw1"] = evil
        r = self.cfg()
        self.assertEqual(r["Content-Type"], "application/json")
        self.assertEqual(r.json()["config"], evil)  # not escaped, not stripped

    def test_a_large_config_comes_back_whole(self):
        big = "".join(f"interface Gi0/{i}\n description port {i}\n" for i in range(60_000))
        FAKE["configs"]["core/sw1"] = big
        r = self.cfg()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["config"], big)
        self.assertEqual(r.json()["lines"], 120_000)

    def test_past_the_cap_is_refused(self):
        FAKE["configs"]["core/sw1"] = "x" * 5000
        with mock.patch.object(client_mod, "MAX_BYTES", 1000):
            r = self.cfg()
        self.assertEqual(r.status_code, 413)


class HistoryTests(_Base):
    def setUp(self):
        super().setUp()
        self.link()
        self.login()
        FAKE["versions"]["sw1"] = [
            {"oid": OID2, "date": "2026-10-02 09:00:00 +0200",
             "time": "2026-10-02 09:00:00 +0200",
             "author": {"name": "oxidized", "email": "o@x", "time": "2026-10-02"},
             "message": "update sw1\n"},
            {"oid": OID1, "date": "2026-10-01 09:00:00 +0200",
             "author": {"name": "alice", "email": "a@x"}, "message": "first"},
        ]
        FAKE["blobs"] = {OID1: "hostname sw1\nntp server 1.1.1.1\n",
                         OID2: "hostname sw1\nntp server 9.9.9.9\n"}
        FAKE["configs"]["sw1"] = "hostname sw1\nntp server 9.9.9.9\nlogging host 2.2.2.2\n"

    def url(self, rest=""):
        return f"/api/oxidized/devices/{self.device.id}/{rest}"

    def test_versions_are_normalised(self):
        r = self.client.get(self.url("versions/"))
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertEqual([v["oid"] for v in rows], [OID2, OID1])
        self.assertEqual(rows[0]["author"], "oxidized")
        self.assertEqual(rows[0]["message"], "update sw1")
        self.assertEqual(rows[0]["date"], "2026-10-02T09:00:00+02:00")
        self.assertTrue(r.json()["history"])

    def test_no_history_is_not_an_error(self):
        del FAKE["versions"]["sw1"]
        r = self.client.get(self.url("versions/"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["results"], [])

    def test_one_version_is_read_as_raw_text(self):
        r = self.client.get(self.url(f"versions/{OID1}/"))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("1.1.1.1", r.json()["config"])
        self.assertEqual(FAKE["view_formats"], ["text"])

    def test_diff_between_versions_and_against_current(self):
        r = self.client.get(self.url(f"diff/?from={OID1}&to={OID2}"))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertIn("-ntp server 1.1.1.1", body["diff"])
        self.assertIn("+ntp server 9.9.9.9", body["diff"])
        self.assertEqual((body["added"], body["removed"]), (1, 1))
        r = self.client.get(self.url(f"diff/?from={OID2}&to=current"))
        self.assertIn("+logging host 2.2.2.2", r.json()["diff"])
        self.assertEqual((r.json()["added"], r.json()["removed"]), (1, 0))

    def test_bad_refs_are_400(self):
        self.assertEqual(self.client.get(self.url("diff/?from=../x&to=current")).status_code, 400)
        self.assertEqual(self.client.get(self.url("versions/zz/")).status_code, 400)

    def test_an_unknown_version_is_404(self):
        r = self.client.get(self.url(f"versions/{'c' * 40}/"))
        self.assertEqual(r.status_code, 404)

    def test_history_needs_view_config_too(self):
        self.login(self.member((["device"], ["view"], None)))
        for rest in ("versions/", f"versions/{OID1}/", f"diff/?from={OID1}&to={OID2}"):
            self.assertEqual(self.client.get(self.url(rest)).status_code, 403, rest)

    def test_fetch_now_queues_the_node_and_forgets_the_cache(self):
        self.client.get(self.url("config/"))
        FAKE["configs"]["sw1"] = "fresh\n"
        r = self.client.post(self.url("fetch-now/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        path, body = FAKE["next"][0]
        self.assertEqual(path, "/node/next/sw1.json")
        self.assertEqual(body["user"], "root")
        self.assertEqual(self.client.get(self.url("config/")).json()["config"], "fresh\n")

    def test_fetch_now_needs_view_config(self):
        self.login(self.member((["device"], ["view", "change"], None)))
        self.assertEqual(self.client.post(self.url("fetch-now/")).status_code, 403)
        self.assertEqual(FAKE["next"], [])
