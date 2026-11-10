"""The app is wired into the shared registries: change log, migration guard,
and no outbound request on any path in this phase."""
from __future__ import annotations

import ast
from pathlib import Path

from django.test import SimpleTestCase

from audit.apps import AUDITED_MODELS
from core.tests_migration_safety import problems

APP = Path(__file__).resolve().parent


class RegistryTests(SimpleTestCase):
    def test_audited(self):
        self.assertIn("vulnerabilities.VulnerabilitySettings", AUDITED_MODELS)
        # Fetched public data is written in bulk and never change-logged.
        for label in ("vulnerabilities.Cve", "vulnerabilities.CveProduct",
                      "vulnerabilities.SyncRun"):
            self.assertNotIn(label, AUDITED_MODELS)

    def test_migrations_are_safe(self):
        self.assertEqual(problems(only_apps={"vulnerabilities"}), [])

    def test_no_outbound_client_is_imported(self):
        banned = {"requests", "urllib.request", "http.client", "httpx", "socket",
                  "core.ssrf"}
        found = []
        for path in APP.glob("*.py"):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names = [node.module]
                found += [f"{path.name}: {n}" for n in names if n in banned]
        self.assertEqual(found, [])
