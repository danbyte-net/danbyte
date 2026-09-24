"""The shipped nginx configs load, and every block that reaches Danbyte
says which scheme the request came in on (#239, #240)."""
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


def _locations(text: str):
    """``(path, body)`` of each flat location block."""
    return re.findall(r"location\s+(\S+)\s*\{([^{}]*)\}", text)


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


@skipUnless(shutil.which("nginx") and shutil.which("openssl"), "nginx and openssl needed")
class NginxAcceptsTests(SimpleTestCase):
    """``nginx -t`` on each config, rendered the way the installer does."""

    def _check(self, site: str):
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            subprocess.run(
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                 "-subj", "/CN=danbyte.test", "-keyout", t / "key.pem", "-out", t / "cert.pem"],
                check=True, capture_output=True,
            )
            modern = _nginx_version() >= (1, 25, 1)
            values = {
                "CERT": str(t / "cert.pem"), "KEY": str(t / "key.pem"),
                "SERVER_NAME": "danbyte.test", "NAME": "danbyte",
                "H2_LISTEN": "" if modern else " http2",
                "H2_DIRECTIVE": "    http2 on;" if modern else "",
                "MAINTENANCE_ROOT": tmp, "STATIC_ROOT": tmp,
            }
            site = re.sub(r"@@([A-Z0-9_]+)@@", lambda m: values.get(m.group(1), tmp), site)
            site = _http2_for_this_nginx(site, modern)
            # Unprivileged: high ports, and this run's certificate pair.
            site = re.sub(r"listen(\s+(?:\[::\]:)?)(80|443)\b",
                          lambda m: f"listen{m.group(1)}{18000 + int(m.group(2))}", site)
            site = re.sub(r"ssl_certificate\s+\S+;", f"ssl_certificate {t}/cert.pem;", site)
            site = re.sub(r"ssl_certificate_key\s+\S+;",
                          f"ssl_certificate_key {t}/key.pem;", site)
            (t / "site.conf").write_text(site)
            temp = "\n".join(
                f"    {d}_temp_path {t}/{d};"
                for d in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi")
            )
            (t / "nginx.conf").write_text(
                f"pid {t}/nginx.pid;\nerror_log {t}/error.log;\nevents {{}}\n"
                f"http {{\n    access_log {t}/access.log;\n{temp}\n"
                f"    include {t}/site.conf;\n}}\n"
            )
            r = subprocess.run(
                ["nginx", "-t", "-p", tmp, "-c", str(t / "nginx.conf")],
                capture_output=True, text=True,
            )
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
