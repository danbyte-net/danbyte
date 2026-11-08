"""Danbyte's own SBOM: the generator (scripts/release/sbom.py), how a release
ships it, and GET /api/system/sbom/."""

from __future__ import annotations

import importlib.metadata as md
import importlib.util
import json
import shutil
import tempfile
from pathlib import Path

import yaml
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APITestCase

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "release" / "sbom.py"


def _load_generator():
    spec = importlib.util.spec_from_file_location("danbyte_release_sbom", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _dist(site: Path, name: str, version: str, *headers: str) -> md.Distribution:
    info = site / f"{name.replace('-', '_')}-{version}.dist-info"
    info.mkdir(parents=True)
    lines = ["Metadata-Version: 2.4", f"Name: {name}", f"Version: {version}", *headers]
    (info / "METADATA").write_text("\n".join(lines) + "\n")
    return md.PathDistribution(info)


class GeneratorTests(SimpleTestCase):
    """The BOM's shape on a small fixture tree."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.gen = _load_generator()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        root = self.root = self.tmp / "src"
        (root / "danbyte").mkdir(parents=True)
        (root / "danbyte" / "__init__.py").write_text('__version__ = "9.8.7-dev1"\n')
        (root / "LICENSE").write_text(
            "\n                    Apache License\n            Version 2.0, January 2004\n"
        )
        (root / "requirements.txt").write_text(
            "# comment\n"
            "Django>=5.2   # the framework\n"
            "channels[daphne]>=4\n"
            "pywin32>=1 ; sys_platform == 'win32'\n"
            "-r other.txt\n"
        )
        site = self.tmp / "site"
        self.dists = {
            d.metadata["Name"].lower(): d
            for d in (
                _dist(
                    site,
                    "Django",
                    "5.2.1",
                    "License-Expression: BSD-3-Clause",
                    "Author-email: Django Software Foundation <foundation@djangoproject.com>",
                    "Requires-Dist: asgiref>=3.8",
                    "Requires-Dist: tzdata; sys_platform == 'win32'",
                    "Requires-Dist: argon2-cffi; extra == 'argon2'",
                ),
                _dist(
                    site,
                    "asgiref",
                    "3.8.1",
                    "License: BSD-3-Clause",
                    "Author: Django Software Foundation",
                ),
                _dist(
                    site,
                    "channels",
                    "4.2.0",
                    "Classifier: License :: OSI Approved :: BSD License",
                    "Requires-Dist: Django>=4.2",
                    "Requires-Dist: daphne>=4; extra == 'daphne'",
                ),
                _dist(site, "daphne", "4.1.2", "License: Some Custom Licence"),
                # Installed but not required: dev tooling stays out.
                _dist(site, "ruff", "0.9.0", "License-Expression: MIT"),
                # Required by an extra nobody asked for: stays out too.
                _dist(site, "argon2-cffi", "23.1.0", "License-Expression: MIT"),
            )
        }
        fe = root / "frontend"
        (fe / "node_modules" / "@scope" / "lib").mkdir(parents=True)
        (fe / "node_modules" / "@scope" / "lib" / "package.json").write_text(
            json.dumps({"name": "@scope/lib", "license": "ISC", "author": "Ann <a@b.c>"})
        )
        packages = {
            "": {
                "name": "frontend",
                "dependencies": {"react": "^19", "@scope/lib": "^1"},
                "devDependencies": {"vitest": "^3"},
            },
            "node_modules/react": {
                "version": "19.2.6",
                "license": "MIT",
                "integrity": "sha512-AAAA",
                "resolved": "https://registry.npmjs.org/react/-/react-19.2.6.tgz",
                "dependencies": {"scheduler": "^0.27"},
                "optionalDependencies": {"bin-linux": "1", "bin-darwin": "1"},
            },
            "node_modules/scheduler": {"version": "0.27.0", "license": "(MIT OR Apache-2.0)"},
            "node_modules/@scope/lib": {"version": "1.0.0", "dependencies": {"scheduler": "^0.26"}},
            "node_modules/@scope/lib/node_modules/scheduler": {"version": "0.26.0"},
            "node_modules/bin-linux": {
                "version": "1.0.0",
                "optional": True,
                "os": ["linux"],
                "cpu": ["x64"],
                "license": "MIT",
            },
            "node_modules/bin-darwin": {
                "version": "1.0.0",
                "optional": True,
                "os": ["darwin"],
                "license": "MIT",
            },
            "node_modules/vitest": {"version": "3.0.0", "dev": True, "license": "MIT"},
        }
        (fe / "package-lock.json").write_text(
            json.dumps({"lockfileVersion": 3, "packages": packages})
        )

    def build(self):
        return self.gen.build_bom(self.root, dists=self.dists)

    def test_document_shape(self):
        bom, _ = self.build()
        self.assertEqual(bom["bomFormat"], "CycloneDX")
        self.assertEqual(bom["specVersion"], "1.6")
        self.assertRegex(bom["serialNumber"], r"^urn:uuid:[0-9a-f-]{36}$")
        app = bom["metadata"]["component"]
        self.assertEqual(
            (app["name"], app["version"], app["type"]), ("danbyte", "9.8.7-dev1", "application")
        )
        self.assertEqual(app["licenses"], [{"license": {"id": "Apache-2.0"}}])

    def test_python_closure_follows_requirements_extras_and_markers(self):
        bom, summary = self.build()
        pypi = {c["name"]: c for c in bom["components"] if c["purl"].startswith("pkg:pypi/")}
        self.assertEqual(sorted(pypi), ["Django", "asgiref", "channels", "daphne"])
        self.assertEqual(pypi["Django"]["purl"], "pkg:pypi/django@5.2.1")
        self.assertEqual(pypi["Django"]["licenses"], [{"license": {"id": "BSD-3-Clause"}}])
        self.assertEqual(pypi["Django"]["supplier"], {"name": "Django Software Foundation"})
        self.assertEqual(pypi["channels"]["licenses"], [{"license": {"name": "BSD License"}}])
        self.assertEqual(pypi["daphne"]["licenses"], [{"license": {"name": "Some Custom Licence"}}])
        self.assertEqual(summary["missing"], [])

    def test_npm_runtime_only_with_platform_filter_and_nesting(self):
        bom, _ = self.build()
        npm = sorted(c["purl"] for c in bom["components"] if c["purl"].startswith("pkg:npm/"))
        self.assertEqual(
            npm,
            [
                "pkg:npm/%40scope/lib@1.0.0",
                "pkg:npm/bin-linux@1.0.0",
                "pkg:npm/react@19.2.6",
                "pkg:npm/scheduler@0.26.0",
                "pkg:npm/scheduler@0.27.0",
            ],
        )
        by = {c["purl"]: c for c in bom["components"]}
        lib = by["pkg:npm/%40scope/lib@1.0.0"]
        # Licence and author from node_modules when the lockfile has none.
        self.assertEqual((lib["group"], lib["name"]), ("@scope", "lib"))
        self.assertEqual(lib["licenses"], [{"license": {"id": "ISC"}}])
        self.assertEqual(lib["supplier"], {"name": "Ann"})
        self.assertEqual(
            by["pkg:npm/scheduler@0.27.0"]["licenses"], [{"expression": "MIT OR Apache-2.0"}]
        )
        self.assertEqual(by["pkg:npm/react@19.2.6"]["hashes"][0]["alg"], "SHA-512")

    def test_dependency_graph(self):
        bom, _ = self.build()
        deps = {d["ref"]: d["dependsOn"] for d in bom["dependencies"]}
        app = bom["metadata"]["component"]["bom-ref"]
        self.assertEqual(
            deps[app],
            [
                "pkg:npm/%40scope/lib@1.0.0",
                "pkg:npm/react@19.2.6",
                "pkg:pypi/channels@4.2.0",
                "pkg:pypi/django@5.2.1",
            ],
        )
        self.assertEqual(
            deps["pkg:pypi/channels@4.2.0"], ["pkg:pypi/daphne@4.1.2", "pkg:pypi/django@5.2.1"]
        )
        self.assertEqual(deps["pkg:npm/%40scope/lib@1.0.0"], ["pkg:npm/scheduler@0.26.0"])
        self.assertEqual(
            deps["pkg:npm/react@19.2.6"], ["pkg:npm/bin-linux@1.0.0", "pkg:npm/scheduler@0.27.0"]
        )
        # Every component has an entry, and every edge names a component.
        refs = {c["bom-ref"] for c in bom["components"]} | {app}
        self.assertEqual(set(deps), refs)
        for targets in deps.values():
            self.assertLessEqual(set(targets), refs)

    def test_unknown_licences_are_counted_not_guessed(self):
        bom, summary = self.build()
        self.assertEqual(summary["no_licence"], ["scheduler@0.26.0"])
        nested = next(c for c in bom["components"] if c["purl"] == "pkg:npm/scheduler@0.26.0")
        self.assertNotIn("licenses", nested)

    def test_deterministic_apart_from_serial_and_timestamp(self):
        def strip(bom):
            bom = json.loads(json.dumps(bom))
            bom.pop("serialNumber")
            bom["metadata"].pop("timestamp")
            return json.dumps(bom)

        self.assertEqual(strip(self.build()[0]), strip(self.build()[0]))

    def test_missing_requirement_is_reported(self):
        del self.dists["daphne"], self.dists["channels"]
        _, summary = self.build()
        self.assertEqual(summary["missing"], ["channels"])

    def test_licence_strings(self):
        le = self.gen.license_entries
        self.assertEqual(le("MIT License"), [{"license": {"id": "MIT"}}])
        self.assertEqual(
            le("Apache-2.0 AND CNRI-Python"), [{"expression": "Apache-2.0 AND CNRI-Python"}]
        )
        self.assertEqual(le("BSD"), [{"license": {"name": "BSD"}}])
        self.assertEqual(le("UNKNOWN"), [])
        self.assertEqual(le("Permission is hereby granted...\n" * 5), [])


class ReleaseShipsTheSbomTests(SimpleTestCase):
    """The bundle, the release assets and the image carry it."""

    def test_bundle_generates_it_from_the_build_venv_before_packing(self):
        text = (ROOT / "scripts" / "build-release.sh").read_text()
        self.assertIn('"$BUILD_VENV/bin/python" "$STAGE/scripts/release/sbom.py"', text)
        self.assertIn('--output "$STAGE/sbom.cdx.json"', text)
        self.assertIn('cp "$STAGE/sbom.cdx.json" "$OUT/danbyte-${VERSION}.cdx.json"', text)
        self.assertLess(text.index("scripts/release/sbom.py"), text.index('tar -czf "$OUT/'))
        # The build venv is still there when it runs.
        self.assertLess(text.index("scripts/release/sbom.py"), text.index('rm -rf "$(dirname'))

    def test_release_attaches_it_and_the_smoke_test_checks_it(self):
        wf = yaml.safe_load((ROOT / ".github" / "workflows" / "release.yml").read_text())
        publish = next(
            s for s in wf["jobs"]["publish"]["steps"] if "action-gh-release" in s.get("uses", "")
        )
        self.assertIn("dist/*.cdx.json", publish["with"]["files"].split())
        smoke = "\n".join(s.get("run", "") for s in wf["jobs"]["smoke"]["steps"])
        self.assertIn("sbom.cdx.json", smoke)

    def test_image_writes_it_to_the_app_directory(self):
        text = (ROOT / "Dockerfile").read_text()
        runtime = text[text.index("AS runtime") :]
        self.assertIn("python scripts/release/sbom.py --output /app/sbom.cdx.json", runtime)
        self.assertIn("from=frontend,source=/app/frontend/node_modules", runtime)
        # After the packages it describes are installed.
        self.assertLess(runtime.index("pip install"), runtime.index("sbom.py"))

    def test_a_local_sbom_is_never_committed(self):
        self.assertIn("/sbom.cdx.json", (ROOT / ".gitignore").read_text().split())


class SystemSbomApiTests(APITestCase):
    URL = "/api/system/sbom/"

    def setUp(self):
        self.admin = get_user_model().objects.create_superuser("admin", "a@acme.com", "pw")
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.path = self.tmp / "sbom.cdx.json"
        self.body = json.dumps({"bomFormat": "CycloneDX", "specVersion": "1.6"})
        self.path.write_text(self.body)

    def test_anonymous_is_refused(self):
        with override_settings(DANBYTE_SBOM_PATH=self.path):
            r = self.client.get(self.URL)
        self.assertIn(r.status_code, (401, 403))

    def test_requires_manage_like_system_info(self):
        user = get_user_model().objects.create_user("plain", password="pw")
        self.client.force_login(user)
        with override_settings(DANBYTE_SBOM_PATH=self.path):
            r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 403)

    def test_serves_the_shipped_file_as_a_download(self):
        from danbyte import __version__

        self.client.force_login(self.admin)
        with override_settings(DANBYTE_SBOM_PATH=self.path):
            r = self.client.get(self.URL)
            info = self.client.get("/api/system/info/").json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "application/vnd.cyclonedx+json")
        self.assertEqual(
            r["Content-Disposition"], f'attachment; filename="danbyte-{__version__}.cdx.json"'
        )
        self.assertEqual(r["Cache-Control"], "no-store")
        self.assertEqual(b"".join(r.streaming_content).decode(), self.body)
        self.assertTrue(info["sbom_available"])

    def test_missing_file_is_a_clear_404(self):
        self.client.force_login(self.admin)
        with override_settings(DANBYTE_SBOM_PATH=self.tmp / "absent.json"):
            r = self.client.get(self.URL)
            info = self.client.get("/api/system/info/").json()
        self.assertEqual(r.status_code, 404)
        self.assertIn("make sbom", r.json()["detail"])
        self.assertFalse(info["sbom_available"])
