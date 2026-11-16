"""The app is wired into the shared registries: change log, migration guard,
and outbound requests only from the server-mode fetch, through the SSRF
guard."""
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

    def test_only_the_fetch_module_makes_requests(self):
        banned = {"requests", "urllib.request", "http.client", "httpx", "socket",
                  "core.ssrf"}
        found = []
        allowed = {"fetch.py", "tests_fetch.py"}
        for path in APP.glob("*.py"):
            if path.name in allowed:
                continue
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names = [node.module]
                found += [f"{path.name}: {n}" for n in names if n in banned]
        self.assertEqual(found, [])

    def test_the_fetch_module_sends_only_through_the_guard(self):
        """``requests`` is there for its exception types; every request is
        made by ``core.ssrf.SafeSession`` (pinned address, no redirects)."""
        tree = ast.parse((APP / "fetch.py").read_text())
        direct = [
            ast.unparse(node.func) for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name) and node.func.value.id == "requests"
        ]
        self.assertEqual(direct, [])
        self.assertIn("SafeSession()", (APP / "fetch.py").read_text())
