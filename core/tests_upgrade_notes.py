"""Post-upgrade notices: which steps apply, who starts with them done, and
the endpoints and command that surface and acknowledge them."""
from __future__ import annotations

import tempfile
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from rest_framework.test import APITestCase

from core import upgrade_notes as un
from core.models import DeploymentSettings

A = un.UpgradeNote(id="1.0.0-a", version="1.0.0", title="A", body="a", platforms=("systemd",))
B = un.UpgradeNote(id="1.1.0-b", version="1.1.0", title="B", body="b")
C = un.UpgradeNote(id="1.1.0-c", version="1.1.0", title="C", body="c", check=lambda: True)
D = un.UpgradeNote(id="2.0.0-d", version="2.0.0", title="D", body="d")
NOTES = (D, C, B, A)


def _notes(test):
    p = patch.object(un, "NOTES", NOTES)
    p.start()
    test.addCleanup(p.stop)
    for target, value in (("core.upgrade_notes.system_version", {"version": "1.1.0", "commit": "x", "tag": ""}),
                          ("core.upgrade_notes.deployment_method", "systemd")):
        q = patch(target, return_value=value)
        q.start()
        test.addCleanup(q.stop)


class SelectionTests(APITestCase):
    def setUp(self):
        _notes(self)

    def test_applicable_filters_version_platform_and_check(self):
        self.assertEqual([n.id for n in un.applicable()], ["1.1.0-b", "1.0.0-a"])
        self.assertEqual([n.id for n in un.applicable(platform="docker")], ["1.1.0-b"])
        self.assertEqual([n.id for n in un.applicable(version="2.0.0")], ["2.0.0-d", "1.1.0-b", "1.0.0-a"])

    def test_pending_excludes_acknowledged(self):
        dep = DeploymentSettings.load()
        dep.upgrade_notes_done = ["1.0.0-a"]
        dep.save()
        self.assertEqual([n.id for n in un.pending(dep)], ["1.1.0-b"])
        self.assertEqual(un.acknowledge(dep, ["1.1.0-b", "nope"]), ["1.1.0-b"])
        self.assertEqual(un.pending(dep), [])
        self.assertEqual(DeploymentSettings.load().upgrade_notes_done, ["1.0.0-a", "1.1.0-b"])

    def test_fresh_row_starts_with_the_current_notes_done(self):
        DeploymentSettings.objects.all().delete()
        with patch("core.version.system_version", return_value={"version": "1.1.0", "commit": "", "tag": ""}):
            dep = DeploymentSettings.load()
        self.assertEqual(dep.upgrade_notes_done, ["1.1.0-c", "1.1.0-b", "1.0.0-a"])
        self.assertEqual(un.pending(dep), [])

    def test_upgraded_row_leaves_notes_pending(self):
        dep = DeploymentSettings.load()
        dep.upgrade_notes_done = []
        dep.save()
        self.assertEqual([n.id for n in un.pending(dep)], ["1.1.0-b", "1.0.0-a"])


class ApiTests(APITestCase):
    def setUp(self):
        _notes(self)
        self.admin = get_user_model().objects.create_superuser("admin", "a@e.com", "x")
        dep = DeploymentSettings.load()
        dep.upgrade_notes_done = []
        dep.save()

    def test_requires_deployment_admin(self):
        self.client.force_login(get_user_model().objects.create_user("u", "u@e.com", "x"))
        self.assertEqual(self.client.get("/api/system/upgrade-notes/").status_code, 403)
        self.assertEqual(self.client.post("/api/system/upgrade-notes/ack/", {"all": True}, format="json").status_code, 403)

    def test_get_and_ack(self):
        self.client.force_login(self.admin)
        r = self.client.get("/api/system/upgrade-notes/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["version"], "1.1.0")
        self.assertEqual(r.json()["deployment"], "systemd")
        self.assertEqual([n["id"] for n in r.json()["pending"]], ["1.1.0-b", "1.0.0-a"])
        self.assertEqual(r.json()["pending"][0]["platforms"], ["systemd", "docker"])
        r = self.client.post("/api/system/upgrade-notes/ack/", {"ids": ["1.0.0-a"]}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([n["id"] for n in r.json()["pending"]], ["1.1.0-b"])
        r = self.client.post("/api/system/upgrade-notes/ack/", {"all": True}, format="json")
        self.assertEqual(r.json()["pending"], [])
        self.assertEqual(sorted(r.json()["done"]), ["1.0.0-a", "1.1.0-b"])
        # read-only on the settings payload
        r = self.client.get("/api/deployment/email/")
        self.assertEqual(sorted(r.json()["upgrade_notes_done"]), ["1.0.0-a", "1.1.0-b"])
        r = self.client.put("/api/deployment/email/", {"upgrade_notes_done": []}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sorted(DeploymentSettings.load().upgrade_notes_done), ["1.0.0-a", "1.1.0-b"])

    def test_command_lists_then_acks(self):
        out = StringIO()
        call_command("upgrade_notes", stdout=out)
        self.assertIn("2 step(s)", out.getvalue())
        self.assertIn("[1.1.0] B", out.getvalue())
        out = StringIO()
        call_command("upgrade_notes", ack="all", stdout=out)
        self.assertIn("marked 2", out.getvalue())
        out = StringIO()
        call_command("upgrade_notes", stdout=out)
        self.assertIn("nothing to do", out.getvalue())


class RealNotesTests(APITestCase):
    def test_shipped_notes_are_well_formed(self):
        ids = [n.id for n in un.NOTES]
        self.assertEqual(len(ids), len(set(ids)))
        for n in un.NOTES:
            self.assertTrue(n.id.startswith(n.version), n.id)
            self.assertTrue(set(n.platforms) <= set(un.PLATFORMS), n.id)
            self.assertTrue(n.title and n.body, n.id)
        self.assertEqual([n.id for n in un.applicable(version="0.16.0", platform="docker")], [])
        # The tls-unit note checks the host for the unit file; the nginx ones
        # read the site config (unreadable here, so they stay up).
        with patch("core.site_tls.UNIT_FILE", Path("/nonexistent/danbyte-tls.path")), \
                patch("core.upgrade_notes._site_config", return_value=None):
            self.assertEqual([n.id for n in un.applicable(version="0.16.0", platform="systemd")],
                             ["0.16.0-tls-unit", "0.16.0-nginx-acme", "0.16.0-nginx-backups"])
        with patch("core.site_tls.UNIT_FILE", Path("/")), \
                patch("core.upgrade_notes._site_config", return_value=None):
            self.assertEqual([n.id for n in un.applicable(version="0.16.0", platform="systemd")],
                             ["0.16.0-nginx-acme", "0.16.0-nginx-backups"])
        self.assertEqual(un.applicable(version="0.15.1", platform="systemd"), [])

    def test_the_nginx_notes_hide_once_the_site_has_the_locations(self):
        site = (
            "server { listen 80;\n"
            "  location /.well-known/acme-challenge/ { proxy_pass http://127.0.0.1:8000; }\n}\n"
            "server { listen 443 ssl;\n"
            "  location ^~ /api/backups/ { proxy_pass http://127.0.0.1:8000; }\n}\n"
        )
        with patch("core.upgrade_notes._site_config", return_value=site):
            self.assertTrue(un._acme_proxied())
            self.assertTrue(un._backups_location())
        with patch("core.upgrade_notes._site_config", return_value="server { listen 443; }"):
            self.assertFalse(un._acme_proxied())
            self.assertFalse(un._backups_location())

    def test_the_certificate_unit_must_not_run_the_apps_own_script(self):
        from django.conf import settings

        with tempfile.TemporaryDirectory() as d:
            unit = Path(d) / "danbyte-tls.service"
            with patch.object(un, "TLS_SERVICE_FILE", str(unit)):
                self.assertTrue(un._tls_unit_runs_root_owned_script())   # none: 0.16.0 note
                unit.write_text(f"[Service]\nExecStart=/usr/bin/env bash "
                                f"{settings.BASE_DIR}/scripts/danbyte-tls-apply.sh\n")
                self.assertFalse(un._tls_unit_runs_root_owned_script())
                unit.write_text("[Service]\nExecStart=/usr/local/libexec/danbyte/danbyte-tls-apply.sh\n")
                self.assertTrue(un._tls_unit_runs_root_owned_script())

    def test_host_steps_lead_with_the_one_command(self):
        from django.conf import settings

        note = next(n for n in un.NOTES if n.id == "0.16.12-logrotate")
        snippet = note.as_dict()["snippet"]
        self.assertTrue(snippet.startswith(f"sudo make -C {settings.BASE_DIR} host-sync\n"))
        self.assertIn("deploy/logrotate/danbyte", snippet)
        wildcard = next(n for n in un.NOTES if n.id == "0.17.0-wildcard-access")
        self.assertNotIn("host-sync", wildcard.as_dict()["snippet"])
