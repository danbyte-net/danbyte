"""scripts/host-sync.sh - the root steps of an install or upgrade - run for
real with the host's files under a scratch root (DANBYTE_HOST_ROOT) and
shims for nginx, systemctl, runuser, install and id.

What it must get right: a fresh site and certificate; a re-render only while
the live site is still what Danbyte rendered, keeping its certificate paths
and name; the previous site back when ``nginx -t`` refuses the new one; a
hand-edited site left alone with the new render beside it; and the
certificate unit running a root-owned copy of its script.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from django.conf import settings
from django.test import SimpleTestCase

REPO = Path(settings.BASE_DIR)
SITE = "etc/nginx/sites-available/danbyte.conf"

SHIMS = {
    "nginx": """#!/bin/sh
echo "nginx $*" >>"$FAKE_CALLS"
case "$1" in
  -v) echo "nginx version: nginx/${FAKE_NGINX_VERSION:-1.24.0}" >&2 ;;
  -t) grep -q BROKEN "$DANBYTE_HOST_ROOT/etc/nginx/sites-available/danbyte.conf" && exit 1 ;;
esac
exit 0
""",
    "systemctl": '#!/bin/sh\necho "systemctl $*" >>"$FAKE_CALLS"\n',
    "runuser": '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
    "id": '#!/bin/sh\n[ "$1" = -u ] && [ $# -eq 1 ] && { echo 0; exit 0; }\n[ "$1" = -u ] && { echo 1000; exit 0; }\nexec /usr/bin/id "$@"\n',
    "install": """#!/bin/sh
# root's owner and group are not ours to give in a test
set -- "$@"
n=$#; i=0
while [ $i -lt $n ]; do
  a="$1"; shift; i=$((i + 1))
  case "$a" in -o|-g) shift; i=$((i + 1)) ;; *) set -- "$@" "$a" ;; esac
done
exec /usr/bin/install "$@"
""",
}


class HostSyncTests(SimpleTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = self.tmp / "root"
        for d in ("etc/logrotate.d", "etc/nginx/sites-available", "etc/nginx/sites-enabled",
                  "etc/systemd/system", "usr/local/libexec", "var/lib"):
            (self.root / d).mkdir(parents=True)
        (self.root / "etc/nginx/sites-enabled/default").write_text("default\n")
        self.app = self.tmp / "danbyte"
        (self.app / "deploy/nginx/certs").mkdir(parents=True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, body in SHIMS.items():
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        self.calls = self.tmp / "calls"
        self.calls.write_text("")
        self.env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                    "DANBYTE_HOST_ROOT": str(self.root), "FAKE_CALLS": str(self.calls)}

    def sync(self, *args: str, env: dict | None = None):
        return subprocess.run(
            ["bash", str(REPO / "scripts" / "host-sync.sh"), "--app", str(self.app),
             "--user", "danbyte", "--log-dir", "/var/log/danbyte", *args],
            env={**self.env, **(env or {})}, capture_output=True, text=True, timeout=120)

    def site(self) -> str:
        return (self.root / SITE).read_text()

    def render(self, template: Path, host: str, crt: str, key: str) -> str:
        return (template.read_text()
                .replace("@@SERVER_NAME@@", host).replace("@@CERT@@", crt).replace("@@KEY@@", key)
                .replace("@@STATIC_ROOT@@", f"{self.app}/staticfiles")
                .replace("@@MEDIA_ROOT@@", f"{self.app}/media")
                .replace("@@MAINTENANCE_ROOT@@", f"{self.app}/deploy")
                .replace("@@H2_LISTEN@@", " http2").replace("@@H2_DIRECTIVE@@", ""))

    def test_a_fresh_host_gets_a_site_a_certificate_and_the_unit(self):
        r = self.sync("--fresh", "--host", "danbyte.example.test")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        site = self.site()
        self.assertIn("server_name danbyte.example.test;", site)
        self.assertIn("ssl_certificate     /etc/ssl/danbyte/danbyte.crt;", site)
        self.assertNotIn("@@", site)
        self.assertTrue((self.root / "etc/ssl/danbyte/danbyte.key").exists())
        self.assertIn("BEGIN CERTIFICATE", (self.app / "deploy/nginx/certs/danbyte.crt").read_text())
        self.assertFalse((self.app / "deploy/nginx/certs/danbyte.key").exists())
        self.assertTrue((self.root / "etc/nginx/sites-enabled/danbyte.conf").is_symlink())
        self.assertFalse((self.root / "etc/nginx/sites-enabled/default").exists())
        self.assertTrue((self.root / "etc/danbyte/nginx-site.sha256").exists())
        unit = (self.root / "etc/systemd/system/danbyte-tls.service").read_text()
        self.assertIn("ExecStart=/usr/local/libexec/danbyte/danbyte-tls-apply.sh", unit)
        self.assertIn(f"Environment=DANBYTE_DIR={self.app}", unit)
        self.assertIn("Environment=DANBYTE_USER=danbyte", unit)
        self.assertNotIn(str(self.app / "scripts"), unit)
        self.assertTrue((self.root / "usr/local/libexec/danbyte/danbyte-tls-apply.sh").exists())
        self.assertIn("/var/log/danbyte/*.log", (self.root / "etc/logrotate.d/danbyte").read_text())
        self.assertIn("systemctl enable --now danbyte-tls.path", self.calls.read_text())

    def test_an_untouched_site_is_re_rendered_with_its_live_certificate_and_name(self):
        self.sync("--fresh", "--host", "old.example.test")
        # The site's certificate came from Let's Encrypt since; Danbyte
        # rendered it that way (the stored hash says so).
        site = self.site().replace("/etc/ssl/danbyte/danbyte.crt", "/etc/letsencrypt/live/x/fullchain.pem")
        (self.root / SITE).write_text(site)
        subprocess.run(["sh", "-c", f"sha256sum {self.root / SITE} | cut -d' ' -f1 > "
                        f"{self.root / 'etc/danbyte/nginx-site.sha256'}"], check=True)
        (self.root / SITE).write_text(site.replace("client_max_body_size", "client_max_body_size"))
        r = self.sync(env={"FAKE_NGINX_VERSION": "1.26.0"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        new = self.site()
        self.assertIn("/etc/letsencrypt/live/x/fullchain.pem", new)
        self.assertIn("server_name old.example.test;", new)
        self.assertIn("http2 on;", new)                       # rendered for the nginx it has
        self.assertTrue(list((self.root / "etc/nginx/sites-available").glob("danbyte.conf.bak-*")))
        self.assertIn("systemctl reload nginx", self.calls.read_text())

    def test_a_site_from_before_0_17_counts_as_untouched_when_the_old_template_renders_it(self):
        old = self.tmp / "old.template"
        old.write_text((REPO / "deploy/nginx/danbyte.prod.conf.template").read_text()
                       .replace("client_max_body_size", "# marker-previous-release\n    client_max_body_size", 1))
        (self.root / SITE).write_text(self.render(old, "db.example.test", "/etc/ssl/a.crt", "/etc/ssl/a.key"))
        r = self.sync("--old-template", str(old))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("marker-previous-release", self.site())
        self.assertIn("ssl_certificate     /etc/ssl/a.crt;", self.site())

    def test_a_hand_edited_site_is_left_alone(self):
        self.sync("--fresh", "--host", "db.example.test")
        edited = self.site() + "\n# my own tile server in the CSP\n"
        (self.root / SITE).write_text(edited)
        r = self.sync()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.site(), edited)
        self.assertTrue((self.root / (SITE + ".new")).exists())
        self.assertIn("left alone", r.stderr)
        # ...unless the admin takes the new one
        r = self.sync("--adopt")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("my own tile server", self.site())

    def test_the_previous_site_comes_back_when_nginx_refuses_the_new_one(self):
        self.sync("--fresh", "--host", "db.example.test")
        before = self.site()
        bad = self.tmp / "tree"
        shutil.copytree(REPO / "scripts", bad / "scripts")
        shutil.copytree(REPO / "deploy", bad / "deploy")
        tpl = bad / "deploy/nginx/danbyte.prod.conf.template"
        tpl.write_text(tpl.read_text() + "\n# BROKEN\n")
        r = subprocess.run(
            ["bash", str(bad / "scripts/host-sync.sh"), "--app", str(self.app), "--user", "danbyte"],
            env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.site(), before)
        self.assertIn("nginx refused the new site", r.stderr)
