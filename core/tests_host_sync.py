"""scripts/host-sync.sh - the root steps of an install or upgrade - and
scripts/install-host.sh, which runs them after install.sh's upgrade, run for
real with the host's files under a scratch root (DANBYTE_HOST_ROOT) and
shims for nginx, systemctl, runuser, install and id.

What host-sync must get right: a fresh site and certificate; a re-render only
while the live site is still what Danbyte rendered, keeping its certificate
paths and name; the previous site back when ``nginx -t`` refuses the new one;
a hand-edited site left alone with the new render beside it; the certificate
unit running a root-owned copy of its script; and a stamp of what it applied.
What install-host must: the root steps only once the upgrade ended done, the
installer's lock released, and a summary of how it went.
"""
from __future__ import annotations

import json
import os
import pwd
import re
import shutil
import subprocess
import tempfile
import time
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
  -T) cat "${FAKE_NGINX_T:-/dev/null}" ;;
esac
exit 0
""",
    # is-active answers from the file $FAKE_UNIT_STATE names (the upgrade unit)
    "systemctl": """#!/bin/sh
echo "systemctl $*" >>"$FAKE_CALLS"
for a; do
  [ "$a" = is-active ] || continue
  s=$(cat "${FAKE_UNIT_STATE:-/nonexistent}" 2>/dev/null || echo inactive)
  echo "$s"
  [ "$s" = active ]
  exit
done
exit 0
""",
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


class HostSandbox(SimpleTestCase):
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

    def stamp(self) -> dict:
        return json.loads((self.root / "etc/danbyte/host-sync.json").read_text())


class HostSyncTests(HostSandbox):
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

    def test_a_re_render_keeps_the_sites_mode(self):
        # 0.16's proxy-install wrote the site 0600; neither the re-render nor
        # the new render beside a hand-edited site may open it to everyone.
        self.sync("--fresh", "--host", "db.example.test")
        (self.root / SITE).chmod(0o600)
        r = self.sync(env={"FAKE_NGINX_VERSION": "1.26.0"})    # renders differently: http2 on
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("re-rendered", r.stdout)
        self.assertIn("http2 on;", self.site())
        self.assertEqual((self.root / SITE).stat().st_mode & 0o777, 0o600)
        (self.root / SITE).write_text(self.site() + "\n# my own tile server in the CSP\n")
        r = self.sync()
        self.assertIn("left alone", r.stderr)
        self.assertEqual((self.root / (SITE + ".new")).stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / SITE).stat().st_mode & 0o777, 0o600)

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
        # not applied: the after-upgrade step stays up
        self.assertEqual((self.stamp()["nginx"], self.stamp()["ok"]), ("refused", False))

    def test_the_stamp_says_what_was_applied_and_from_which_files(self):
        from core.upgrade_notes import HOST_SYNC_SOURCES, host_sources_digest

        r = self.sync("--fresh", "--host", "db.example.test")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        stamp = self.stamp()
        version = re.search(r'^__version__ = "([^"]+)"', (REPO / "danbyte/__init__.py").read_text(), re.M)
        self.assertEqual(stamp["version"], version.group(1))
        # the app hashes the same files, in the same order
        self.assertEqual(stamp["sources"], host_sources_digest(REPO))
        listed = subprocess.run(["bash", str(REPO / "scripts/host-sync.sh"), "--print-sources"],
                                capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(tuple(listed), HOST_SYNC_SOURCES)
        self.assertEqual((stamp["nginx"], stamp["ok"], stamp["certificate"]), ("fresh", True, "self-signed"))
        self.assertEqual((self.root / "etc/danbyte/host-sync.json").stat().st_mode & 0o777, 0o644)
        self.sync()
        self.assertEqual(self.stamp()["nginx"], "current")

    def test_an_install_without_nginx_stays_without_it(self):
        # make host-sync passes no --no-nginx; an install made with it must
        # not get a site, a certificate and the default site removed.
        r = self.sync("--fresh", "--no-nginx")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.stamp()["nginx"], "off")
        r = self.sync()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("left out, as at install", r.stdout)
        self.assertFalse((self.root / SITE).exists())
        self.assertTrue((self.root / "etc/nginx/sites-enabled/default").exists())
        self.assertTrue((self.root / "etc/logrotate.d/danbyte").exists())
        # --fresh still adds the site
        r = self.sync("--fresh", "--host", "db.example.test")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue((self.root / SITE).exists())


class InstallHostTests(HostSandbox):
    """scripts/install-host.sh: what install.sh hands the end of an upgrade to,
    as a root unit, so a dropped SSH session skips none of it."""

    def setUp(self):
        super().setUp()
        self.unit = self.tmp / "upgrade-unit-state"
        self.unit.write_text("inactive\n")
        self.runs = self.tmp / "installer"
        self.scratch = self.runs / "run"
        self.scratch.mkdir(parents=True)
        self.log = self.runs / "run.log"

    def finish(self, *args: str, env: dict | None = None, background: bool = False,
               script: Path | None = None):
        argv = ["/bin/sh", str(script or REPO / "scripts" / "install-host.sh"), "--app", str(self.app),
                "--user", "danbyte", "--version", "0.17.0-dev2", "--host", "db.example.test",
                "--log-dir", "/var/log/danbyte", *args]
        full = {**self.env, "FAKE_UNIT_STATE": str(self.unit), "DANBYTE_INSTALL_HOST_POLL": "0.1",
                "DANBYTE_INSTALL_HOST_GRACE": "5", **(env or {})}
        if background:
            return subprocess.Popen(argv, env=full, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True)
        return subprocess.run(argv, env=full, capture_output=True, text=True, timeout=120)

    def upgrade_args(self, owner: str = "installer-1") -> tuple[str, ...]:
        return ("--from", "0.17.0-dev1", "--wait-stage", "--lock-owner", owner, "--log", str(self.log),
                "--cleanup", str(self.scratch))

    def status(self, state: str, **extra) -> None:
        """The stage's status file, laid out as lib.sh writes it."""
        data = {"state": state, "step": "done" if state == "done" else "migrate", "pct": 100,
                "version_to": "0.17.0-dev2", "version_from": "0.17.0-dev1", "error": "",
                "stage_api": 1, "kind": "bundle", "trigger": "installer", **extra}
        data.setdefault("warnings", [])
        data["log"] = data.pop("log", str(self.app / ".upgrade.log"))
        (self.app / ".upgrade-status.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")

    def lock(self, owner: str) -> None:
        (self.app / ".upgrade.lock").write_text(json.dumps({"owner": owner, "phase": "launched"},
                                                           separators=(",", ":")))

    def test_after_the_upgrade_it_does_the_root_steps_and_says_how_it_went(self):
        self.sync("--fresh", "--host", "db.example.test")        # the install as it was
        (self.root / "etc/logrotate.d/danbyte").unlink()
        self.unit.write_text("active\n")
        self.status("running")
        self.lock("installer-1")
        proc = self.finish(*self.upgrade_args(), background=True)
        time.sleep(1)
        self.assertIsNone(proc.poll())                           # the stage still runs
        self.assertFalse((self.root / "etc/logrotate.d/danbyte").exists())
        self.status("done", warnings=["danbyte-backend is a development server and was running "
                                      "beside danbyte-web; it is now disabled"])
        self.unit.write_text("inactive\n")
        out, _ = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, out)
        text = self.log.read_text()
        self.assertIn("Danbyte upgraded 0.17.0-dev1 -> 0.17.0-dev2.", text)
        self.assertIn("URL:  https://db.example.test/", text)
        self.assertIn("logrotate: /etc/logrotate.d/danbyte", text)
        self.assertIn("nginx: ", text)
        self.assertIn("danbyte-backend is a development server", text)
        self.assertIn("The certificate is self-signed.", text)
        # an upgrade is not a fresh install
        for fresh in ("Danbyte is installed", "Password", "DJANGO_SUPERUSER_PASSWORD"):
            self.assertNotIn(fresh, text)
        self.assertIn("Danbyte upgraded", out)                   # the journal says it too
        self.assertEqual((self.runs / "run.log.rc").read_text().strip(), "0")
        self.assertTrue((self.root / "etc/logrotate.d/danbyte").exists())
        self.assertEqual(self.stamp()["nginx"], "current")
        self.assertFalse((self.app / ".upgrade.lock").exists())
        self.assertFalse(self.scratch.exists())

    def test_a_failed_upgrade_leaves_the_host_as_it_was(self):
        self.status("failed", error="manage.py check failed: boom - rolled back: the previous "
                                    "release runs again; the database was not changed.")
        self.lock("installer-1")
        r = self.finish(*self.upgrade_args())
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("The upgrade to 0.17.0-dev2 failed.", r.stdout)
        self.assertIn("manage.py check failed: boom", r.stdout)
        self.assertIn("left as they were", r.stdout)
        self.assertIn(f"log: {self.app / '.upgrade.log'}", r.stdout)
        self.assertFalse((self.root / "etc/logrotate.d/danbyte").exists())
        self.assertFalse((self.root / SITE).exists())
        self.assertNotIn("daemon-reload", self.calls.read_text())
        self.assertEqual((self.runs / "run.log.rc").read_text().strip(), "1")
        self.assertFalse((self.app / ".upgrade.lock").exists())   # its own lock goes all the same

    def test_it_waits_for_a_recovery_and_keeps_a_lock_that_is_not_its_own(self):
        self.sync("--fresh", "--host", "db.example.test")
        marker = self.tmp / ".danbyte-upgrade" / "active"           # beside the app
        marker.parent.mkdir()
        marker.write_text("WORK=/x\n")
        self.unit.write_text("failed\n")
        self.status("running")
        self.lock("someone-else")
        proc = self.finish(*self.upgrade_args(), background=True, env={"DANBYTE_INSTALL_HOST_GRACE": "3"})
        time.sleep(1.5)
        self.assertIsNone(proc.poll())        # long past the grace: the recovery may still finish it
        self.status("done")                    # it did, forward
        marker.unlink()
        out, _ = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, out)
        self.assertIn("waiting for its recovery", out)
        self.assertIn("Danbyte upgraded 0.17.0-dev1 -> 0.17.0-dev2.", out)
        self.assertTrue((self.app / ".upgrade.lock").exists())

    def test_a_stage_that_ended_without_saying_how_is_reported(self):
        self.status("running")
        r = self.finish(*self.upgrade_args(), env={"DANBYTE_INSTALL_HOST_GRACE": "3"})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("ended before it said how", r.stdout)
        self.assertIn("journalctl --user -u danbyte-upgrade", r.stdout)
        self.assertFalse((self.root / "etc/logrotate.d/danbyte").exists())

    def test_an_upgrade_that_never_ends_keeps_its_lock_and_says_what_to_run(self):
        self.unit.write_text("active\n")
        self.status("running")
        self.lock("installer-1")
        r = self.finish(*self.upgrade_args(), env={"DANBYTE_INSTALL_HOST_WAIT": "1"})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("still runs after a day of waiting", r.stdout)
        self.assertIn("sudo ./install.sh --host-only", r.stdout)
        self.assertTrue((self.app / ".upgrade.lock").exists())
        self.assertFalse((self.root / "etc/logrotate.d/danbyte").exists())

    def test_on_their_own_with_a_certificate_a_ca_issued(self):
        # install.sh --host-only: no stage to wait for. The site serves a
        # certificate a CA issued, so no self-signed hint; the steps the
        # release still lists are counted.
        self.sync("--fresh", "--host", "db.example.test")
        ca = self.tmp / "ca"
        ca.mkdir()
        for argv in (
            ["req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
             "-days", "2", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Test CA"],
            ["req", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
             "-keyout", "site.key", "-out", "site.csr", "-subj", "/CN=db.example.test"],
            ["x509", "-req", "-in", "site.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
             "-days", "2", "-out", "site.crt"],
        ):
            subprocess.run(["openssl", *argv], cwd=ca, check=True, capture_output=True)
        shutil.copy(ca / "site.crt", self.root / "etc/ssl/danbyte/danbyte.crt")
        (self.app / ".venv/bin").mkdir(parents=True)
        (self.app / ".venv/bin/python").write_text(
            '#!/bin/sh\n[ "$2" = upgrade_notes ] && printf "2 step(s) to do after this upgrade:\\n"\n')
        (self.app / ".venv/bin/python").chmod(0o755)
        r = self.finish()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("The root steps of Danbyte 0.17.0-dev2 are done.", r.stdout)
        self.assertEqual(self.stamp()["certificate"], "issued")
        self.assertNotIn("self-signed", r.stdout)
        self.assertIn("After-upgrade steps left: 2", r.stdout)

    def test_install_sh_hands_the_root_steps_of_an_upgrade_to_a_unit(self):
        text = (REPO / "scripts/install.sh").read_text()
        body = text[text.index("upgrade_existing() {"):text.index('\nif [ "$EXISTING" -eq 1 ]; then')]
        self.assertIn("systemd-run --unit danbyte-install-host", body)
        self.assertIn('/bin/sh "$hs/scripts/install-host.sh" "${hargs[@]}"', body)
        self.assertNotIn("host-sync.sh\" \"$@\"", body)
        self.assertIn('exit "$rc"', body)
        # The root-only copy holds all the unit runs: run it from just that.
        extra = re.search(r'cp --parents \$\(bash scripts/host-sync.sh --print-sources\) \\\n\s*(.*?) "\$hs/"',
                          body).group(1).split()
        self.assertEqual(extra, ["scripts/install-host.sh", "danbyte/__init__.py"])
        copy = self.tmp / "hs"
        copy.mkdir()
        files = subprocess.run(["bash", str(REPO / "scripts/host-sync.sh"), "--print-sources"],
                               capture_output=True, text=True, check=True).stdout.split()
        subprocess.run(["cp", "--parents", *files, *extra, str(copy)], cwd=REPO, check=True)
        self.sync("--fresh", "--host", "db.example.test")
        r = self.finish(script=copy / "scripts" / "install-host.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("nginx: ", r.stdout)


class TlsApplyTests(HostSandbox):
    """scripts/danbyte-tls-apply.sh, the root unit behind Settings → Site
    certificate: the uploaded pair goes where Danbyte's own site reads it,
    never where another site on the same nginx does (#279)."""

    def setUp(self):
        super().setUp()
        if os.geteuid() == 0:
            self.skipTest("the drop folder must not be root's")
        (self.bin / "logger").write_text("#!/bin/sh\nexit 0\n")
        (self.bin / "logger").chmod(0o755)
        (self.root / "etc/ssl").mkdir(parents=True)
        (self.root / "etc/nginx/conf.d").mkdir(parents=True)
        ssl = self.tmp / "ssl"
        ssl.mkdir()
        self.other = self.pair("other.example", ssl / "other")
        self.ours = self.pair("old.example", ssl / "danbyte")
        self.new = self.pair("new.example", self.app / "deploy/nginx/certs/danbyte")
        (self.root / "etc/nginx/conf.d/other.conf").write_text(self.server(*self.other))
        (self.root / SITE).write_text(self.server(*self.ours))
        (self.root / "etc/nginx/sites-enabled/danbyte.conf").symlink_to(self.root / SITE)
        self.before = {p: p.read_bytes() for p in (*self.other, *self.ours)}

    @staticmethod
    def pair(cn: str, stem: Path) -> tuple[Path, Path]:
        crt, key = stem.with_suffix(".crt"), stem.with_suffix(".key")
        subprocess.run(["openssl", "req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt",
                        "ec_paramgen_curve:prime256v1", "-days", "2", "-subj", f"/CN={cn}",
                        "-keyout", str(key), "-out", str(crt)], check=True, capture_output=True)
        return crt, key

    @staticmethod
    def server(crt: Path, key: Path) -> str:
        return (f"server {{\n    listen 443 ssl;\n    ssl_certificate     {crt};\n"
                f"    ssl_certificate_key {key};\n}}\n")

    def apply(self, *loaded: str) -> dict:
        """Drop the new pair and run the unit's script, with ``nginx -T``
        printing nginx.conf and then ``loaded`` (under the scratch root)."""
        dump = ["# configuration file /etc/nginx/nginx.conf:",
                "http { include conf.d/*.conf; include sites-enabled/*; }"]
        for rel in loaded:
            dump += [f"# configuration file {self.root / rel}:", (self.root / rel).read_text()]
        (self.tmp / "nginx-T").write_text("\n".join(dump) + "\n")
        (self.app / "deploy/nginx/certs/danbyte.apply").write_text("")
        subprocess.run(["bash", str(REPO / "scripts" / "danbyte-tls-apply.sh")], env={
            **self.env, "DANBYTE_DIR": str(self.app), "FAKE_NGINX_T": str(self.tmp / "nginx-T"),
            "DANBYTE_USER": pwd.getpwuid(os.getuid()).pw_name,
            "DANBYTE_TLS_STATE": str(self.tmp / "state")}, capture_output=True, timeout=60)
        return json.loads((self.tmp / "state/applied.json").read_text())

    def test_the_pair_goes_to_danbytes_site_when_another_site_comes_first(self):
        res = self.apply("etc/nginx/conf.d/other.conf", "etc/nginx/sites-enabled/danbyte.conf")
        self.assertEqual(res["outcome"], "applied", res)
        self.assertEqual(self.ours[0].read_bytes(), self.new[0].read_bytes())
        self.assertEqual(self.ours[1].read_bytes(), self.new[1].read_bytes())
        for p in self.other:
            self.assertEqual(p.read_bytes(), self.before[p], p)
        self.assertFalse((self.app / "deploy/nginx/certs/danbyte.apply").exists())

    def test_nothing_is_written_while_nginx_does_not_load_danbytes_site(self):
        res = self.apply("etc/nginx/conf.d/other.conf")
        self.assertEqual(res["outcome"], "failed", res)
        self.assertIn("does not load", res["detail"])
        for p, data in self.before.items():
            self.assertEqual(p.read_bytes(), data, p)

    def test_a_certificate_tools_links_are_left_to_it(self):
        live = self.tmp / "letsencrypt/live/danbyte"
        live.mkdir(parents=True)
        for name, target in (("fullchain.pem", self.ours[0]), ("privkey.pem", self.ours[1])):
            (live / name).symlink_to(target)
        (self.root / SITE).write_text(self.server(live / "fullchain.pem", live / "privkey.pem"))
        res = self.apply("etc/nginx/sites-enabled/danbyte.conf")
        self.assertEqual(res["outcome"], "failed", res)
        self.assertIn("certbot", res["detail"])
        self.assertTrue((live / "privkey.pem").is_symlink())
        for p, data in self.before.items():
            self.assertEqual(p.read_bytes(), data, p)

