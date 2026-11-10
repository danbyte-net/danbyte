"""Danbyte's own supply chain (#451): requirements.lock, the installers that
use it, and the dependency gate (scripts/release/osv_gate.py)."""

from __future__ import annotations

import contextlib
import datetime as dt
import importlib.util
import io
import json
import re
import tempfile
from pathlib import Path

import yaml
from django.test import SimpleTestCase

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    spec = importlib.util.spec_from_file_location(
        f"danbyte_release_{name}", ROOT / "scripts" / "release" / f"{name}.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


lockcheck = _load("lockcheck")
osv_gate = _load("osv_gate")


class LockFileTests(SimpleTestCase):
    """The committed lock against the committed requirements.txt. A cheap,
    offline stand-in for CI's `make lock-check`, which needs the index."""

    def test_the_lock_covers_requirements_txt(self):
        self.assertEqual(
            lockcheck.lock_problems(ROOT / "requirements.txt", ROOT / "requirements.lock"),
            [],
            "run `make lock`",
        )

    def test_every_entry_is_pinned_with_hashes(self):
        lock = lockcheck.parse_lock(ROOT / "requirements.lock")
        self.assertGreater(len(lock), len(lockcheck.requirements(ROOT / "requirements.txt")))
        for name, entry in lock.items():
            self.assertTrue(entry["pinned"], name)
            self.assertTrue(entry["hashes"], name)

    def test_the_lock_is_made_by_make_lock(self):
        header = (ROOT / "requirements.lock").read_text().splitlines()[:2]
        self.assertEqual(header[1].strip(), "#    make lock")
        makefile = (ROOT / "Makefile").read_text()
        self.assertIn(
            "--generate-hashes --python-version 3.13 --python-platform x86_64-manylinux_2_28",
            makefile,
        )

    def test_problems_are_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            req, lock = Path(tmp) / "requirements.txt", Path(tmp) / "requirements.lock"
            req.write_text("Django>=5.2  # web\nchannels[daphne]>=4.1\nnew-thing\n")
            lock.write_text(
                "django==5.1 \\\n    --hash=sha256:" + "a" * 64 + "\n"
                "channels==4.2\n"
                "    # via -r requirements.txt\n"
            )
            problems = lockcheck.lock_problems(req, lock)
        self.assertEqual(
            problems,
            [
                "Django>=5.2: requirements.lock pins 5.1",
                "new-thing: not in requirements.lock",
                "channels: no sha256 hash in requirements.lock",
            ],
        )

    def test_installed_packages_are_compared_both_ways(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "requirements.lock"
            lock.write_text(
                "django==5.2 \\\n    --hash=sha256:" + "a" * 64 + "\n"
                "rq==2.0 \\\n    --hash=sha256:" + "b" * 64 + "\n"
            )
            problems = lockcheck.installed_problems(
                lock, {"django": "5.2", "rq": "2.1", "six": "1.17.0", "pip": "25.0"}
            )
        self.assertEqual(
            problems,
            [
                "rq: installed 2.1, the lock pins 2.0",
                "six==1.17.0: installed but not in requirements.lock",
            ],
        )


class InstallersUseTheLockTests(SimpleTestCase):
    def test_the_image_installs_the_lock_with_hashes(self):
        self.assertRegex(
            (ROOT / "Dockerfile").read_text(),
            r"pip install --no-cache-dir --require-hashes -r requirements\.lock",
        )

    def test_the_bundle_wheelhouse_comes_from_the_lock(self):
        text = (ROOT / "scripts" / "build-release.sh").read_text()
        self.assertRegex(text, r'pip wheel --require-hashes -r "\$STAGE/requirements\.lock"')
        self.assertIn('lockcheck.py" --installed', text)

    def test_ci_installs_the_lock(self):
        for name in ("ci.yml", "tests.yml"):
            text = (ROOT / ".github" / "workflows" / name).read_text()
            self.assertNotRegex(text, r"pip install -r requirements\.txt", name)
            self.assertIn("pip install --require-hashes -r requirements.lock", text, name)


class GateWorkflowTests(SimpleTestCase):
    def test_the_scanner_is_pinned_by_commit(self):
        wf = yaml.safe_load((ROOT / ".github" / "workflows" / "dependencies.yml").read_text())
        steps = wf["jobs"]["scan"]["steps"]
        uses = [s["uses"] for s in steps if "osv-scanner" in s.get("uses", "")]
        self.assertEqual(len(uses), 1)
        self.assertRegex(uses[0], r"^google/osv-scanner-action/osv-scanner-action@[0-9a-f]{40}$")
        args = next(s for s in steps if "osv-scanner" in s.get("uses", ""))["with"]["scan-args"]
        self.assertIn("--lockfile=requirements.txt:requirements.lock", args)
        self.assertIn("--lockfile=frontend/package-lock.json", args)
        self.assertIn("--config=osv-scanner.toml", args)
        # PyYAML reads the bare `on` key as True.
        self.assertIn("schedule", wf[True])
        self.assertIn("workflow_call", wf[True])

    def test_the_release_waits_for_the_gate(self):
        wf = yaml.safe_load((ROOT / ".github" / "workflows" / "release.yml").read_text())
        self.assertEqual(wf["jobs"]["dependencies"]["uses"], "./.github/workflows/dependencies.yml")
        self.assertIn("dependencies", wf["jobs"]["bundle"]["needs"])

    def test_the_committed_allowlist_is_valid(self):
        self.assertEqual(osv_gate.config_problems(ROOT / "osv-scanner.toml"), [])


def _report(*packages):
    return {
        "results": [
            {"source": {"path": "/github/workspace/requirements.lock"}, "packages": list(packages)}
        ]
    }


def _pkg(name, version, ecosystem, vid, *, score=None, label=None):
    vuln = {"id": vid, "summary": f"{vid} summary"}
    if label:
        vuln["database_specific"] = {"severity": label}
    group = {"ids": [vid]}
    if score is not None:
        group["max_severity"] = str(score)
    return {
        "package": {"name": name, "version": version, "ecosystem": ecosystem},
        "vulnerabilities": [vuln],
        "groups": [group],
    }


class GateTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "package-lock.json").write_text(
            json.dumps(
                {
                    "packages": {
                        "": {"name": "frontend"},
                        "node_modules/react": {"version": "19.0.0"},
                        "node_modules/vitest": {"version": "3.0.0", "dev": True},
                        # one copy for the app, one for the tooling: the app's wins
                        "node_modules/ms": {"version": "2.1.3"},
                        "node_modules/x/node_modules/ms": {"version": "2.1.3", "dev": True},
                    }
                }
            )
        )
        self.config = self.dir / "osv-scanner.toml"
        self.config.write_text("")

    def run_gate(self, report) -> int:
        results = self.dir / "results.json"
        results.write_text(json.dumps(report))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return osv_gate.main(
                [
                    "--results",
                    str(results),
                    "--config",
                    str(self.config),
                    "--package-lock",
                    str(self.dir / "package-lock.json"),
                ]
            )

    def level(self, **kw):
        return osv_gate.findings(_report(_pkg("django", "5.2", "PyPI", "GHSA-1", **kw)), set())[0][
            "level"
        ]

    def test_levels(self):
        self.assertEqual(self.level(score=9.8), "critical")
        self.assertEqual(self.level(score=7.5), "high")
        self.assertEqual(self.level(label="HIGH"), "high")
        self.assertEqual(self.level(score=5.3, label="CRITICAL"), "critical")
        self.assertEqual(self.level(score=5.3), "moderate")
        self.assertEqual(self.level(label="MODERATE"), "moderate")
        self.assertEqual(self.level(score=2.0), "low")
        self.assertEqual(self.level(), "unknown")

    def test_a_clean_report_passes(self):
        self.assertEqual(self.run_gate({"results": []}), 0)

    def test_high_in_a_runtime_package_fails(self):
        self.assertEqual(self.run_gate(_report(_pkg("django", "5.2", "PyPI", "G-1", score=7.5))), 1)
        self.assertEqual(
            self.run_gate(_report(_pkg("react", "19.0.0", "npm", "G-2", score=9.1))), 1
        )
        self.assertEqual(self.run_gate(_report(_pkg("ms", "2.1.3", "npm", "G-3", label="HIGH"))), 1)

    def test_no_severity_counts_as_high(self):
        self.assertEqual(self.run_gate(_report(_pkg("django", "5.2", "PyPI", "PYSEC-1"))), 1)

    def test_dev_only_npm_and_lower_severities_are_reported_only(self):
        self.assertEqual(
            self.run_gate(
                _report(
                    _pkg("vitest", "3.0.0", "npm", "G-4", score=9.8),
                    _pkg("django", "5.2", "PyPI", "G-5", score=5.0),
                )
            ),
            0,
        )

    def test_a_missing_report_fails(self):
        with contextlib.redirect_stderr(io.StringIO()):
            rc = osv_gate.main(
                ["--results", str(self.dir / "nope.json"), "--config", str(self.config)]
            )
        self.assertEqual(rc, 2)

    def test_allowlist_entries_need_a_reason_and_a_near_expiry(self):
        today = dt.date(2026, 11, 10)
        self.config.write_text(
            '[[IgnoredVulns]]\nid = "GHSA-ok"\nignoreUntil = 2027-01-31\nreason = "not reachable"\n'
            '[[IgnoredVulns]]\nid = "GHSA-noreason"\nignoreUntil = 2027-01-31\n'
            '[[IgnoredVulns]]\nid = "GHSA-nodate"\nreason = "x"\n'
            '[[IgnoredVulns]]\nid = "GHSA-far"\nignoreUntil = 2028-01-01T00:00:00Z\nreason = "x"\n'
            '[[PackageOverrides]]\nname = "lodash"\nignore = true\n'
        )
        problems = osv_gate.config_problems(self.config, today)
        self.assertEqual(len(problems), 4, problems)
        for frag in (
            "[PackageOverrides] is not allowed",
            "GHSA-noreason has no reason",
            "GHSA-nodate has no ignoreUntil",
            "GHSA-far is ignored until 2028-01-01",
        ):
            self.assertTrue(any(frag in p for p in problems), (frag, problems))
        self.assertFalse(any("GHSA-ok" in p for p in problems))
        self.assertEqual(self.run_gate({"results": []}), 2)


class DocsTests(SimpleTestCase):
    def test_the_dependency_page_is_in_the_nav(self):
        self.assertTrue((ROOT / "docs" / "getting-started" / "dependencies.md").exists())
        self.assertRegex(
            (ROOT / "zensical.toml").read_text(), re.escape('"getting-started/dependencies.md"')
        )
