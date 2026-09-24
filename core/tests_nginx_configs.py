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
            values = {
                "CERT": str(t / "cert.pem"), "KEY": str(t / "key.pem"),
                "SERVER_NAME": "danbyte.test", "NAME": "danbyte", "H2_LISTEN": "",
                "H2_DIRECTIVE": "", "MAINTENANCE_ROOT": tmp, "STATIC_ROOT": tmp,
            }
            site = re.sub(r"@@([A-Z0-9_]+)@@", lambda m: values.get(m.group(1), tmp), site)
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
