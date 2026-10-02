"""danbyte-admin's tls commands read Danbyte's own nginx site and nothing
else: on a shared nginx another site's certificate, key or names are never
Danbyte's to install over or regenerate from (#279)."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase

from .tests_admin_upgrade import ADMIN, _run


class AdminTlsTests(SimpleTestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "sites-available").mkdir()
        (tmp / "sites-enabled").mkdir()
        self.site = tmp / "sites-available" / "danbyte.conf"
        self.site.write_text("")
        (tmp / "sites-enabled" / "danbyte.conf").symlink_to(self.site)
        self.ours = f"# configuration file {tmp / 'sites-enabled' / 'danbyte.conf'}:"
        self.dump = "\n".join([
            "# configuration file /etc/nginx/nginx.conf:",
            "http { include conf.d/*.conf; include sites-enabled/*; }",
            f"# configuration file {tmp / 'conf.d' / 'other.conf'}:",
            "server {",
            "    server_name other.example;",
            "    ssl_certificate     /etc/ssl/other.crt;",
            "    ssl_certificate_key /etc/ssl/other.key;",
            "}",
            self.ours,
            "server {",
            "    server_name danbyte.example;",
            "    ssl_certificate     /etc/ssl/danbyte/danbyte.crt;",
            "    ssl_certificate_key /etc/ssl/danbyte/danbyte.key;",
            "}",
        ])
        patcher = mock.patch.object(ADMIN, "NGINX_SITE", str(self.site))
        patcher.start()
        self.addCleanup(patcher.stop)

    def nginx(self, dump: str):
        return mock.patch.object(ADMIN, "sh", return_value=_run(out=dump))

    def test_the_pair_and_names_come_from_danbytes_site_alone(self):
        with self.nginx(self.dump):
            self.assertEqual(ADMIN._live_cert_pair(),
                             ("/etc/ssl/danbyte/danbyte.crt", "/etc/ssl/danbyte/danbyte.key"))
            self.assertEqual(ADMIN._live_cert_paths(), ["/etc/ssl/danbyte/danbyte.crt"])
            self.assertEqual(ADMIN.server_names(ADMIN.nginx_text()), ["danbyte.example"])

    def test_nothing_when_nginx_does_not_load_danbytes_site(self):
        with self.nginx(self.dump.split(self.ours)[0]):
            self.assertEqual(ADMIN._live_cert_pair(), ("", ""))

    def test_a_certificate_tools_links_are_not_installed_over(self):
        ctx = ADMIN.Ctx(app=self.site.parent, shape="systemd")
        calls = []

        def sh(argv, **kw):
            calls.append(argv)
            return _run(ok=argv[-2:] == ["-L", "/etc/letsencrypt/live/d/privkey.pem"])

        with mock.patch.object(ADMIN, "_live_cert_pair", return_value=(
                "/etc/letsencrypt/live/d/fullchain.pem", "/etc/letsencrypt/live/d/privkey.pem")), \
                mock.patch.object(ADMIN, "sh", side_effect=sh), \
                mock.patch.object(ADMIN, "bad") as bad:
            self.assertEqual(ADMIN._install_pair(ctx, Path("new.crt"), Path("new.key")), 1)
        self.assertIn("/etc/letsencrypt/live/d/privkey.pem", bad.call_args.args[0])
        self.assertFalse([a for a in calls if "install" in a or "mktemp" in a], calls)
