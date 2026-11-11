"""The shipped nginx configs load, and every block that reaches Danbyte
says which scheme the request came in on (#239, #240), and each security
header leaves nginx once (#490)."""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest import skipUnless

from django.conf import settings
from django.test import SimpleTestCase

ROOT = Path(settings.BASE_DIR)
TEMPLATES = [
    ROOT / "deploy/nginx/danbyte.conf.template",
    ROOT / "deploy/nginx/danbyte.prod.conf.template",
]
DOCKER = ROOT / "deploy/docker/nginx.conf"
#: Blocks that answer the CA's HTTP-01 fetch; Danbyte exempts that path from
#: the HTTPS redirect, so they need no scheme.
EXEMPT = ("/.well-known/acme-challenge/",)


def _nginx_version() -> tuple:
    r = subprocess.run(["nginx", "-v"], capture_output=True, text=True)
    m = re.search(r"nginx/(\d+)\.(\d+)\.(\d+)", r.stderr + r.stdout)
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def _http2_for_this_nginx(site: str, modern: bool) -> str:
    """The http2 form this nginx understands - what the installer does too:
    1.25.1+ takes the standalone ``http2 on;``, older only ``listen … http2``."""
    if modern:
        return site
    site = re.sub(r"^\s*http2\s+on;\s*$", "", site, flags=re.M)
    return re.sub(r"(listen\s+\S+\s+ssl)(\s*;)", r"\1 http2\2", site)


#: A location's optional modifier: exact (=), regex (~, ~*) or ^~.
_MODIFIER = r"(?:(?:=|~\*?|\^~)\s+)?"


def _locations(text: str):
    """``(path, body)`` of each flat location block, any modifier dropped."""
    return re.findall(rf"location\s+{_MODIFIER}(\S+)\s*\{{([^{{}}]*)\}}", text)


#: Headers Django's middleware sends on its own (SecurityMiddleware and
#: XFrameOptionsMiddleware). An nginx config that adds one must drop the
#: upstream copy, or the browser gets two (#490).
DJANGO_SECURITY_HEADERS = (
    "Strict-Transport-Security",
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Cross-Origin-Opener-Policy",
)


def _server_level(text: str) -> str:
    text = re.sub(r"(?m)#.*$", "", text)
    return re.sub(rf"location\s+{_MODIFIER}\S+\s*\{{[^{{}}]*\}}", "", text)


def _edge_headers(text: str) -> dict[str, str]:
    """Security headers the config adds itself, with their values."""
    found = re.findall(r'add_header\s+([\w-]+)\s+"([^"]*)"', _server_level(text))
    return {k: v for k, v in found if k in DJANGO_SECURITY_HEADERS}


def _django_hsts() -> str:
    """The HSTS value settings.py sends when DANBYTE_HTTPS is on."""
    src = (ROOT / "danbyte/settings.py").read_text()
    block = src.split("if HTTPS_DEPLOYMENT:", 1)[1]
    seconds = re.search(r"SECURE_HSTS_SECONDS\s*=\s*(\d+)", block).group(1)
    value = f"max-age={seconds}"
    if re.search(r"SECURE_HSTS_INCLUDE_SUBDOMAINS\s*=\s*True", block):
        value += "; includeSubDomains"
    if re.search(r"SECURE_HSTS_PRELOAD\s*=\s*True", block):
        value += "; preload"
    return value


#: Mozilla's "intermediate" TLS 1.2 suites (#497), in its order.
INTERMEDIATE_CIPHERS = [
    "ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384", "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305", "ECDHE-RSA-CHACHA20-POLY1305",
]


class ConfigTextTests(SimpleTestCase):
    def test_sizes_use_units_nginx_accepts(self):
        # proxy_max_temp_file_size is a size: k or m, never g.
        for path in [*TEMPLATES, DOCKER]:
            with self.subTest(path=path.name):
                self.assertIsNone(
                    re.search(r"proxy_max_temp_file_size\s+\d+[gG]\s*;", path.read_text())
                )

    def test_every_django_block_forwards_the_scheme(self):
        for path in [*TEMPLATES, DOCKER]:
            for loc, body in _locations(path.read_text()):
                reaches_django = re.search(r"proxy_pass\s+http://(127\.0\.0\.1:8000|danbyte_backend)", body)
                if not reaches_django or loc in EXEMPT:
                    continue
                with self.subTest(path=path.name, location=loc):
                    self.assertIn("X-Forwarded-Proto", body)

    def test_hashed_assets_are_cached_for_good_from_disk(self):
        # #485: /assets/ comes off disk, with the .gz the build writes, and
        # the immutable header rides a map so the security headers stay.
        for path, root in ((TEMPLATES[1], "@@FRONTEND_ROOT@@"),
                           (DOCKER, "/usr/share/nginx/frontend")):
            text = path.read_text()
            with self.subTest(path=path.name):
                self.assertRegex(
                    text, r'~\^/assets/\s+"public, max-age=31536000, immutable";')
                self.assertRegex(text, r"(?m)^    add_header Cache-Control \$danbyte_asset_cache;$")
                blocks = dict(_locations(text))
                body = blocks["/assets/"]
                self.assertIn(f"root {root};", body)
                self.assertIn("try_files $uri @danbyte_frontend_assets;", body)
                self.assertIn("gzip_static on;", body)
                self.assertIn("gzip_vary on;", body)
                self.assertIn("gzip_min_length 1024;", body)
                # Its own add_header would drop the server's security headers.
                self.assertNotIn("add_header", body)
                self.assertIn("proxy_hide_header Cache-Control;",
                              blocks["@danbyte_frontend_assets"])
        # The dev template fronts the Vite dev server, which has no build.
        self.assertNotIn("/assets/", TEMPLATES[0].read_text())

    def test_dynamic_responses_keep_their_compression(self):
        # BREACH: nginx gzip stays off the server level and the proxied
        # blocks; Django's GZipMiddleware, which pads its output, keeps
        # compressing dynamic responses until that is decided on its own.
        for path in [*TEMPLATES, DOCKER]:
            text = re.sub(r"(?m)#.*$", "", path.read_text())
            server_level = re.sub(r"location\s+\S+\s*\{[^{}]*\}", "", text)
            with self.subTest(path=path.name):
                self.assertNotRegex(server_level, r"\bgzip\w*\s")
                for loc, body in _locations(text):
                    if "proxy_pass" in body:
                        with self.subTest(location=loc):
                            self.assertNotRegex(body, r"\bgzip\w*\s")
        self.assertIn("django.middleware.gzip.GZipMiddleware", settings.MIDDLEWARE)

    def test_each_security_header_has_one_owner(self):
        # #490: a header nginx adds is dropped from the upstream reply, at the
        # server level and again in any location that names its own hides.
        for path in [*TEMPLATES, DOCKER]:
            text = path.read_text()
            edge = _edge_headers(text)
            server_hides = set(re.findall(r"proxy_hide_header\s+([\w-]+);", _server_level(text)))
            with self.subTest(path=path.name):
                self.assertLessEqual(set(edge), server_hides)
            for loc, body in _locations(re.sub(r"(?m)#.*$", "", text)):
                hides = set(re.findall(r"proxy_hide_header\s+([\w-]+);", body))
                if "proxy_pass" in body and hides:
                    with self.subTest(path=path.name, location=loc):
                        self.assertLessEqual(set(edge), hides)

    def test_the_app_may_frame_itself(self):
        # The topology report draws saved views in a same-origin frame of the
        # map page; DENY or frame-ancestors 'none' leaves it drawing forever.
        for path in (TEMPLATES[1], DOCKER):
            edge = _edge_headers(path.read_text())
            with self.subTest(path=path.name):
                self.assertEqual(edge["X-Frame-Options"], "SAMEORIGIN")
                csp = edge.get("Content-Security-Policy", "")
                self.assertNotIn("frame-ancestors 'none'", csp)
                if "frame-ancestors" in csp:
                    self.assertIn("frame-ancestors 'self'", csp)

    def test_csp_allows_the_vector_basemap_and_nothing_wider(self):
        # #467: MapLibre fetches tiles over fetch (connect-src) from the
        # default vector host only, and runs its bundled worker; its style,
        # fonts and sprites ship with Danbyte, so no other map host appears.
        found = re.findall(r'add_header\s+Content-Security-Policy\s+"([^"]*)"',
                           _server_level(TEMPLATES[1].read_text()))
        self.assertEqual(len(found), 1)
        csp = {d.split()[0]: d.split()[1:] for d in found[0].split(";") if d.strip()}
        self.assertIn("https://vector.openstreetmap.org", csp["connect-src"])
        self.assertEqual(csp["worker-src"], ["'self'", "blob:"])
        self.assertNotIn("*", " ".join(csp["connect-src"]))
        self.assertNotIn("https:", csp["connect-src"])
        self.assertEqual(csp["script-src"], ["'self'", "'unsafe-inline'"])
        self.assertNotIn("'unsafe-eval'", found[0])
        from api.site_map_views import OSM_VECTOR_URL

        self.assertTrue(OSM_VECTOR_URL.startswith("https://vector.openstreetmap.org/"))

    def test_csp_allows_the_vulnerability_sources(self):
        # #451 browser mode: the admin's browser reads NVD, FIRST EPSS and OSV
        # by fetch (connect-src); the hosts are named, never a wildcard. The
        # Docker config sets no CSP, so it needs nothing.
        found = re.findall(r'add_header\s+Content-Security-Policy\s+"([^"]*)"',
                           _server_level(TEMPLATES[1].read_text()))
        csp = {d.split()[0]: d.split()[1:] for d in found[0].split(";") if d.strip()}
        from vulnerabilities import fetch

        for base in (fetch.NVD_BASE, fetch.EPSS_BASE, fetch.OSV_BASE):
            self.assertIn(base, csp["connect-src"])
        self.assertNotIn("https://www.cisa.gov", csp["connect-src"])
        self.assertNotIn("Content-Security-Policy", DOCKER.read_text())

    def test_edge_values_match_django(self):
        # Same value at both layers, so the answer does not depend on which
        # one a request went through.
        prod = _edge_headers(TEMPLATES[1].read_text())
        self.assertEqual(prod["Strict-Transport-Security"], _django_hsts())
        self.assertNotIn("preload", _django_hsts())
        for path in (TEMPLATES[1], DOCKER):
            edge = _edge_headers(path.read_text())
            with self.subTest(path=path.name):
                self.assertEqual(edge["X-Frame-Options"], settings.X_FRAME_OPTIONS)
                self.assertEqual(edge["Referrer-Policy"], settings.SECURE_REFERRER_POLICY)
                self.assertEqual(edge["X-Content-Type-Options"], "nosniff")
                self.assertTrue(settings.SECURE_CONTENT_TYPE_NOSNIFF)
        self.assertEqual(prod["Cross-Origin-Opener-Policy"],
                         settings.SECURE_CROSS_ORIGIN_OPENER_POLICY)
        # The Docker image has a self-signed certificate only; HSTS there is
        # the backend's, behind DANBYTE_HTTPS.
        self.assertNotIn("Strict-Transport-Security", _edge_headers(DOCKER.read_text()))

    def test_every_renderer_fills_every_placeholder(self):
        # A placeholder an installer does not know reaches nginx as @@X@@.
        names = set(re.findall(r"@@([A-Z0-9_]+)@@", TEMPLATES[1].read_text()))
        self.assertIn("FRONTEND_ROOT", names)
        for path in (ROOT / "scripts/host-sync.sh", ROOT / "Makefile",
                     ROOT / "core/tests_host_sync.py"):
            text = path.read_text()
            for name in sorted(names):
                with self.subTest(path=path.name, placeholder=name):
                    self.assertIn(f"@@{name}@@", text)

    def test_edge_rate_limits(self):
        # #499: zones at the http level the site is included in, keyed on
        # the client address; the sign-in endpoints and the CSP sink limited
        # before /api/, SSO callbacks never; refusals are JSON.
        text = re.sub(r"(?m)#.*$", "", TEMPLATES[1].read_text())
        zones = dict(re.findall(r"limit_req_zone\s+\$binary_remote_addr\s+zone=(\w+):10m\s+"
                                r"rate=([\w/]+);", text))
        self.assertEqual(zones, {"danbyte_auth": "1r/s", "danbyte_csp": "2r/s"})
        self.assertLess(text.index("limit_req_zone"), text.index("server {"))
        blocks = dict(_locations(text))
        auth = next(v for k, v in blocks.items() if k.startswith("^/api/auth/"))
        pattern = next(k for k in blocks if k.startswith("^/api/auth/"))
        self.assertIn("limit_req zone=danbyte_auth burst=5 nodelay;", auth)
        for path in ("login", "mfa/verify", "mfa/resend", "password-reset",
                     "password-reset/confirm", "set-password"):
            self.assertRegex(f"/api/auth/{path}/", pattern)
        for path in ("/api/auth/sso/okta/callback/", "/api/auth/sso/okta/acs/",
                     "/api/auth/login/x/", "/api/auth/logout/", "/api/auth/password/change/"):
            self.assertNotRegex(path, pattern)
        self.assertRegex(text, r"location\s+=\s+/api/csp-report/\s*\{")
        csp = blocks["/api/csp-report/"]
        self.assertIn("limit_req zone=danbyte_csp burst=20 nodelay;", csp)
        self.assertIn("client_max_body_size 16k;", csp)
        api_headers = set(re.findall(r"proxy_set_header[^;]+;", blocks["/api/"]))
        for body in (auth, csp):
            self.assertIn("limit_req_status 429;", body)
            self.assertEqual(set(re.findall(r"proxy_set_header[^;]+;", body)), api_headers)
            self.assertIn("proxy_pass http://127.0.0.1:8000;", body)
        self.assertRegex(_server_level(TEMPLATES[1].read_text()),
                         r"error_page 429 @danbyte_rate_limited;")
        self.assertRegex(text, r"location @danbyte_rate_limited \{\s+internal;\s+"
                               r"default_type application/json;\s+return 429 '\{\"detail\":")
        self.assertNotIn("proxy_intercept_errors", text)   # Django's own 429s pass through
        # The dev template fronts a dev server; the Docker image keys on
        # whatever address its port publishing leaves (docs: Hardening).
        for path in (TEMPLATES[0], DOCKER):
            self.assertNotIn("limit_req", path.read_text())

    def test_upstream_headers_get_a_little_room(self):
        # #503: 8k for an upstream's headers, set once for the server and
        # within what the default proxy_buffers allow (nginx -t checks that).
        level = _server_level(TEMPLATES[1].read_text())
        self.assertEqual(re.findall(r"proxy_buffer_size\s+(\S+);", level), ["8k"])
        self.assertNotIn("proxy_buffers ", TEMPLATES[1].read_text())

    def test_tls_is_mozilla_intermediate(self):
        # #497: every TLS server says which protocols and suites it takes,
        # rather than leaving it to the distro's nginx.conf: TLS 1.2 and 1.3,
        # and on 1.2 only forward-secret AEAD suites, for ECDSA and RSA keys.
        for path in [*TEMPLATES, DOCKER]:
            level = _server_level(path.read_text())
            with self.subTest(path=path.name):
                self.assertEqual(re.findall(r"ssl_protocols\s+([^;]+);", level), ["TLSv1.2 TLSv1.3"])
                ciphers = re.findall(r"ssl_ciphers\s+([^;]+);", level)
                self.assertEqual(len(ciphers), 1)
                self.assertEqual(ciphers[0].split(":"), INTERMEDIATE_CIPHERS)
                self.assertEqual(re.findall(r"ssl_prefer_server_ciphers\s+(\w+);", level), ["off"])
                self.assertEqual(re.findall(r"ssl_session_tickets\s+(\w+);", level), ["off"])
                self.assertEqual(re.findall(r"ssl_session_timeout\s+(\S+);", level), ["1d"])
                self.assertEqual(re.findall(r"ssl_session_cache\s+([^;]+);", level),
                                 ["shared:DanbyteSSL:10m"])

    def test_the_build_writes_the_gzip_copies(self):
        import json

        pkg = json.loads((ROOT / "frontend/package.json").read_text())
        self.assertIn("node scripts/precompress.mjs", pkg["scripts"]["build"])
        self.assertRegex((ROOT / "Makefile").read_text(),
                         r"(?m)^frontend-build:.*npm run build$")


#: What a distro's nginx.conf sets for every site, at the http level: the
#: Debian 12 and Ubuntu 22.04 packages ship these two lines. The site's own
#: TLS settings must win over them (#497).
DISTRO_HTTP_TLS = "    ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;\n    ssl_prefer_server_ciphers on;\n"


def _render(site: str, t: Path, ports: dict[int, int] | None = None, key: str = "rsa",
            http: str = "") -> Path:
    """The site rendered the way the installer does, on unprivileged ports
    with a fresh certificate (``key``: rsa or ec, the two kinds the site
    certificate can be), inside a minimal nginx.conf under ``t`` with
    ``http`` at the http level."""
    newkey = ["-newkey", "rsa:2048"] if key == "rsa" else [
        "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]
    subprocess.run(
        ["openssl", "req", "-x509", *newkey, "-nodes", "-days", "1",
         "-subj", "/CN=danbyte.test", "-keyout", t / "key.pem", "-out", t / "cert.pem"],
        check=True, capture_output=True,
    )
    modern = _nginx_version() >= (1, 25, 1)
    values = {
        "CERT": str(t / "cert.pem"), "KEY": str(t / "key.pem"),
        "SERVER_NAME": "danbyte.test", "NAME": "danbyte",
        "H2_LISTEN": "" if modern else " http2",
        "H2_DIRECTIVE": "    http2 on;" if modern else "",
        "MAINTENANCE_ROOT": str(t), "STATIC_ROOT": str(t),
        "FRONTEND_ROOT": str(t / "client"),
    }
    site = re.sub(r"@@([A-Z0-9_]+)@@", lambda m: values.get(m.group(1), str(t)), site)
    site = _http2_for_this_nginx(site, modern)
    ports = ports or {80: 18080, 443: 18443}
    site = re.sub(r"listen(\s+(?:\[::\]:)?)(80|443)\b",
                  lambda m: f"listen{m.group(1)}{ports[int(m.group(2))]}", site)
    site = re.sub(r"ssl_certificate\s+\S+;", f"ssl_certificate {t}/cert.pem;", site)
    site = re.sub(r"ssl_certificate_key\s+\S+;", f"ssl_certificate_key {t}/key.pem;", site)
    (t / "site.conf").write_text(site)
    temp = "\n".join(
        f"    {d}_temp_path {t}/{d};" for d in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi")
    )
    mime = "    include /etc/nginx/mime.types;\n" if Path("/etc/nginx/mime.types").exists() else ""
    (t / "nginx.conf").write_text(
        f"pid {t}/nginx.pid;\nerror_log {t}/error.log;\nevents {{}}\n"
        f"http {{\n{mime}{http}    access_log {t}/access.log;\n{temp}\n"
        f"    include {t}/site.conf;\n}}\n"
    )
    return t / "nginx.conf"


@skipUnless(shutil.which("nginx") and shutil.which("openssl"), "nginx and openssl needed")
class NginxAcceptsTests(SimpleTestCase):
    """``nginx -t`` on each config, rendered the way the installer does."""

    def _check(self, site: str):
        with tempfile.TemporaryDirectory() as tmp:
            conf = _render(site, Path(tmp))
            r = subprocess.run(["nginx", "-t", "-p", tmp, "-c", str(conf)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_templates(self):
        for path in TEMPLATES:
            with self.subTest(path=path.name):
                self._check(path.read_text())

    def test_docker_config(self):
        # The compose service names do not resolve here; the syntax is what
        # is under test.
        text = re.sub(r"server\s+[a-z]+:(\d+);", r"server 127.0.0.1:\1;", DOCKER.read_text())
        self._check(text)


def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@skipUnless(shutil.which("nginx") and shutil.which("openssl"), "nginx and openssl needed")
class NginxServesAssetsTests(SimpleTestCase):
    """The rendered production site, running: what a browser gets for a
    hashed asset (#485)."""

    def _get(self, port: int, path: str, gzip: bool):
        import http.client
        import ssl

        ctx = ssl._create_unverified_context()  # this run's own certificate
        c = http.client.HTTPSConnection("127.0.0.1", port, context=ctx, timeout=10)
        c.request("GET", path, headers={"Accept-Encoding": "gzip"} if gzip else {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, r.msg, body

    def test_an_asset_is_immutable_compressed_and_keeps_the_security_headers(self):
        import gzip as gz

        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            (t / "client/assets").mkdir(parents=True)
            js = b"export const x = 1;\n" * 200
            (t / "client/assets/app-abc123.js").write_bytes(js)
            (t / "client/assets/app-abc123.js.gz").write_bytes(gz.compress(js))
            https = _free_port()
            conf = _render(TEMPLATES[1].read_text(), t, {80: _free_port(), 443: https})
            r = subprocess.run(["nginx", "-p", tmp, "-c", str(conf)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            try:
                status, h, body = self._get(https, "/assets/app-abc123.js", gzip=True)
                self.assertEqual(status, 200)
                self.assertEqual(h.get_all("Cache-Control"),
                                 ["public, max-age=31536000, immutable"])
                self.assertEqual(h["Content-Encoding"], "gzip")
                self.assertEqual(h["Vary"], "Accept-Encoding")
                self.assertEqual(gz.decompress(body), js)
                self.assertEqual(h["X-Content-Type-Options"], "nosniff")
                self.assertIsNotNone(h["Strict-Transport-Security"])

                status, h, body = self._get(https, "/assets/app-abc123.js", gzip=False)
                self.assertEqual((status, body), (200, js))
                self.assertIsNone(h["Content-Encoding"])

                # Not on disk, and no frontend server here: never cached.
                status, h, _ = self._get(https, "/assets/missing-000.js", gzip=True)
                self.assertNotEqual(status, 200)
                self.assertIsNone(h["Cache-Control"])

                # Anything else gets no Cache-Control from nginx.
                _, h, _ = self._get(https, "/static/nothing.css", gzip=True)
                self.assertIsNone(h["Cache-Control"])
            finally:
                subprocess.run(["nginx", "-p", tmp, "-c", str(conf), "-s", "stop"],
                               capture_output=True)


class _DjangoLikeUpstream:
    """A stand-in backend that sends every Django security header with a
    value nginx does not use, so a copy that leaks through is visible."""

    HEADERS = {
        "Strict-Transport-Security": "max-age=1; preload",
        "X-Frame-Options": "SAMEORIGIN",
        "X-Content-Type-Options": "upstream",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Opener-Policy": "unsafe-none",
    }

    def __enter__(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        headers = self.HEADERS

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


@skipUnless(shutil.which("nginx") and shutil.which("openssl"), "nginx and openssl needed")
class NginxSendsEachHeaderOnceTests(SimpleTestCase):
    """The rendered production site, running in front of a backend that sends
    its own security headers: one copy each, nginx's (#490)."""

    def test_proxied_responses_carry_one_copy_of_each_header(self):
        import http.client
        import ssl

        with tempfile.TemporaryDirectory() as tmp, _DjangoLikeUpstream() as up:
            t = Path(tmp)
            (t / "client/assets").mkdir(parents=True)
            site = re.sub(r"127\.0\.0\.1:(8000|8001|3000)", f"127.0.0.1:{up.port}",
                          TEMPLATES[1].read_text())
            https = _free_port()
            conf = _render(site, t, {80: _free_port(), 443: https})
            r = subprocess.run(["nginx", "-p", tmp, "-c", str(conf)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            edge = _edge_headers(TEMPLATES[1].read_text())
            try:
                # A missing /assets/ file falls back to the frontend through
                # the location that names its own proxy_hide_header.
                for path in ("/api/me/", "/admin/", "/media/x", "/", "/docs/",
                             "/assets/missing-000.js"):
                    ctx = ssl._create_unverified_context()  # this run's own cert
                    c = http.client.HTTPSConnection("127.0.0.1", https, context=ctx,
                                                    timeout=10)
                    c.request("GET", path)
                    resp = c.getresponse()
                    resp.read()
                    c.close()
                    self.assertEqual(resp.status, 200, path)
                    for name in DJANGO_SECURITY_HEADERS:
                        with self.subTest(path=path, header=name):
                            self.assertEqual(resp.msg.get_all(name), [edge[name]])
            finally:
                subprocess.run(["nginx", "-p", tmp, "-c", str(conf), "-s", "stop"],
                               capture_output=True)




class _RunningSite:
    """The rendered production site, running unprivileged on free ports under
    a scratch prefix; ``https`` is its TLS port."""

    def __init__(self, site: str | None = None, **render):
        self.site = site if site is not None else TEMPLATES[1].read_text()
        self.render = render

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        (self.dir / "client/assets").mkdir(parents=True)
        self.https = _free_port()
        self.conf = _render(self.site, self.dir, {80: _free_port(), 443: self.https},
                            **self.render)
        r = subprocess.run(["nginx", "-p", str(self.dir), "-c", str(self.conf)],
                           capture_output=True, text=True)
        if r.returncode:
            self._tmp.cleanup()
            raise AssertionError(r.stderr)
        return self

    def __exit__(self, *exc):
        subprocess.run(["nginx", "-p", str(self.dir), "-c", str(self.conf), "-s", "stop"],
                       capture_output=True)
        self._tmp.cleanup()


def _handshake(port: int, *, version=None, ciphers: str | None = None):
    """``(protocol, suite)`` the server agreed to, or None when it refused.
    Raises SkipTest when this client cannot even offer what is asked."""
    import socket
    import ssl
    from unittest import SkipTest

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # this run's own certificate
    try:
        if version is not None:
            ctx.minimum_version = ctx.maximum_version = version
        # Level 0, so the client offers the weak suites the server must refuse.
        ctx.set_ciphers(f"{ciphers or 'ALL'}:@SECLEVEL=0")
    except (ValueError, ssl.SSLError) as exc:
        raise SkipTest(f"this OpenSSL cannot offer {version} {ciphers}: {exc}") from exc
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=10) as raw, \
                ctx.wrap_socket(raw) as tls:
            return tls.version(), tls.cipher()[0]
    except (ssl.SSLError, ConnectionResetError):
        return None


#: Accepted by a v0.19.0 site with the distro's defaults (#497); refused now.
WEAK_TLS12 = ("AES128-SHA", "AES256-SHA", "AES128-GCM-SHA256", "AES256-SHA256",
              "ECDHE-RSA-AES128-SHA", "ECDHE-RSA-AES256-SHA", "ECDHE-RSA-CAMELLIA128-SHA256")


@skipUnless(shutil.which("nginx") and shutil.which("openssl"), "nginx and openssl needed")
class NginxTlsTests(SimpleTestCase):
    """The rendered production site, running behind a distro's http-level TLS
    defaults: only TLS 1.2 and 1.3, and only AEAD suites with forward
    secrecy on 1.2, for RSA and ECDSA certificates (#497)."""

    def test_rsa_certificate(self):
        import ssl

        with _RunningSite(http=DISTRO_HTTP_TLS) as s:
            self.assertEqual(_handshake(s.https)[0], "TLSv1.3")
            for suite in ("ECDHE-RSA-AES128-GCM-SHA256", "ECDHE-RSA-AES256-GCM-SHA384",
                          "ECDHE-RSA-CHACHA20-POLY1305"):
                with self.subTest(suite=suite):
                    self.assertEqual(_handshake(s.https, version=ssl.TLSVersion.TLSv1_2,
                                                ciphers=suite), ("TLSv1.2", suite))
            for suite in WEAK_TLS12:
                with self.subTest(suite=suite):
                    self.assertIsNone(_handshake(s.https, version=ssl.TLSVersion.TLSv1_2,
                                                 ciphers=suite))
            for old in (ssl.TLSVersion.TLSv1, ssl.TLSVersion.TLSv1_1):
                with self.subTest(version=old):
                    self.assertIsNone(_handshake(s.https, version=old))

    def test_ecdsa_certificate(self):
        import ssl

        with _RunningSite(http=DISTRO_HTTP_TLS, key="ec") as s:
            self.assertEqual(_handshake(s.https)[0], "TLSv1.3")
            for suite in ("ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-ECDSA-AES256-GCM-SHA384",
                          "ECDHE-ECDSA-CHACHA20-POLY1305"):
                with self.subTest(suite=suite):
                    self.assertEqual(_handshake(s.https, version=ssl.TLSVersion.TLSv1_2,
                                                ciphers=suite), ("TLSv1.2", suite))
            for suite in ("ECDHE-ECDSA-AES128-SHA", "ECDHE-ECDSA-AES256-SHA384"):
                with self.subTest(suite=suite):
                    self.assertIsNone(_handshake(s.https, version=ssl.TLSVersion.TLSv1_2,
                                                 ciphers=suite))

    def test_the_weak_suites_are_offered_by_this_client(self):
        # Without the site's lines the same server takes a weak suite, so a
        # refusal above is the site's doing, not this client's.
        import ssl

        site = re.sub(r"(?m)^\s*ssl_(protocols|ciphers|prefer_server_ciphers)\s.*$", "",
                      TEMPLATES[1].read_text())
        with _RunningSite(site, http=DISTRO_HTTP_TLS) as s:
            self.assertEqual(_handshake(s.https, version=ssl.TLSVersion.TLSv1_2,
                                        ciphers="ECDHE-RSA-AES128-SHA"),
                             ("TLSv1.2", "ECDHE-RSA-AES128-SHA"))


class _CountingUpstream:
    """A stand-in backend: 200 for everything it is sent, except a 429 of
    its own on /api/own-429/, counting the requests that reach it."""

    def __enter__(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        seen = self.seen = []
        forwarded = self.forwarded = []

        class Handler(BaseHTTPRequestHandler):
            def _answer(self):
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    self.rfile.read(n)
                seen.append(self.path)
                forwarded.append(self.headers.get("X-Forwarded-For"))
                body = b'{"detail":"django says slow down"}' if self.path == "/api/own-429/" \
                    else b"{}"
                self.send_response(429 if self.path == "/api/own-429/" else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = _answer

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


@skipUnless(shutil.which("nginx") and shutil.which("openssl"), "nginx and openssl needed")
class NginxRateLimitTests(SimpleTestCase):
    """The rendered production site, running: what one client address gets
    when it floods the sign-in endpoints and the CSP sink (#499)."""

    def _send(self, port, method, path, body=b"", xff=None):
        import http.client
        import json
        import ssl

        ctx = ssl._create_unverified_context()  # this run's own certificate
        c = http.client.HTTPSConnection("127.0.0.1", port, context=ctx, timeout=10)
        headers = {"Content-Type": "application/json", **({"X-Forwarded-For": xff} if xff else {})}
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            data = json.loads(raw)
        except ValueError:
            data = raw
        return r.status, r.msg, data

    def test_one_address_is_held_to_the_limits(self):
        with _CountingUpstream() as up:
            site = re.sub(r"127\.0\.0\.1:(8000|8001|3000)", f"127.0.0.1:{up.port}",
                          TEMPLATES[1].read_text())
            with _RunningSite(site) as s:
                codes = [self._send(s.https, "POST", "/api/auth/login/", b"{}")[0]
                         for _ in range(10)]
                # burst=5 nodelay: six straight away, then about one a second
                self.assertEqual(codes[:6], [200] * 6, codes)
                self.assertGreaterEqual(codes.count(429), 3, codes)
                status, headers, data = self._send(s.https, "POST", "/api/auth/password-reset/",
                                                   b"{}")
                self.assertEqual(status, 429)       # one budget for every sign-in endpoint
                self.assertEqual(headers["Content-Type"], "application/json")
                self.assertIn("Too many attempts", data["detail"])
                self.assertIsNotNone(headers["Strict-Transport-Security"])
                # what is not a sign-in endpoint is not held back
                for path in ("/api/me/", "/api/auth/sso/okta/callback/", "/api/auth/logout/"):
                    with self.subTest(path=path):
                        self.assertEqual(self._send(s.https, "GET", path)[0], 200)
                # Django's own 429 passes through with its own body
                status, _, data = self._send(s.https, "GET", "/api/own-429/")
                self.assertEqual((status, data), (429, {"detail": "django says slow down"}))
                self.assertEqual(up.seen.count("/api/auth/login/"), codes.count(200))

                report = b'{"csp-report":{"blocked-uri":"x"}}'
                self.assertEqual(self._send(s.https, "POST", "/api/csp-report/",
                                            b"x" * 20000)[0], 413)
                codes = [self._send(s.https, "POST", "/api/csp-report/", report)[0]
                         for _ in range(30)]
                # the 413 above took one of the 21 (burst=20 nodelay)
                self.assertEqual(codes[:20], [200] * 20, codes)
                self.assertIn(429, codes[20:])

    def test_behind_a_proxy_real_ip_keys_on_the_client(self):
        # The documented http-level real_ip lines, with this test standing in
        # for the proxy at 127.0.0.1: each client gets its own budget, and
        # Django sees the client at the right of X-Forwarded-For, so a
        # DANBYTE_TRUSTED_PROXY_DEPTH of 1 or 2 finds it.
        real_ip = ("    set_real_ip_from 127.0.0.1;\n    real_ip_header X-Forwarded-For;\n"
                   "    real_ip_recursive on;\n")
        with _CountingUpstream() as up:
            site = re.sub(r"127\.0\.0\.1:(8000|8001|3000)", f"127.0.0.1:{up.port}",
                          TEMPLATES[1].read_text())
            with _RunningSite(site, http=real_ip) as s:
                a = [self._send(s.https, "POST", "/api/auth/login/", b"{}", xff="192.0.2.10")[0]
                     for _ in range(7)]
                self.assertEqual(a[:6], [200] * 6, a)
                self.assertEqual(a[6], 429, a)
                self.assertEqual(self._send(s.https, "POST", "/api/auth/login/", b"{}",
                                            xff="192.0.2.20")[0], 200)
                # a client that forges an address of its own is still itself
                self.assertEqual(self._send(s.https, "POST", "/api/auth/login/", b"{}",
                                            xff="198.51.100.1, 192.0.2.10")[0], 429)
                self.assertEqual(up.forwarded[0], "192.0.2.10, 192.0.2.10")
