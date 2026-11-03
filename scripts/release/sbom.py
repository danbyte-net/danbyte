#!/usr/bin/env python3
"""Danbyte's own SBOM: one CycloneDX 1.6 JSON for a release.

    <venv>/bin/python scripts/release/sbom.py [--root DIR] [--version X] [--output FILE]

Run it with the interpreter of the environment the release runs on: the
Python components are the requirements.txt packages and everything they pull
in, read from that interpreter's installed metadata (exact versions, declared
licences, authors). The npm components are the runtime packages of
frontend/package-lock.json (no dev tooling, and only the optional native
packages for linux-x64-glibc, the release platform); licences and authors
come from the lockfile, then frontend/node_modules when it is there.

Offline, standard library only (``packaging`` from the environment is used
when present for exact marker evaluation). Output is deterministic apart from
the timestamp (SOURCE_DATE_EPOCH pins it) and the serial number. A licence
that is not declared is left out, never guessed; the count goes to stderr.
"""

from __future__ import annotations

import argparse
import base64
import importlib.metadata as md
import json
import os
import re
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

TOOL_NAME = "danbyte-sbom"
REPO_URL = "https://github.com/danbyte-net/danbyte"
# The release bundle's platform (scripts/build-release.sh) and the image's.
NPM_PLATFORM = {"os": "linux", "cpu": "x64", "libc": "glibc"}

# SPDX identifiers emitted as `license.id`; anything else that is declared
# goes out verbatim as `license.name` (or `expression` for an SPDX expression).
SPDX_IDS = frozenset(
    """
0BSD AFL-2.1 AGPL-3.0-only AGPL-3.0-or-later Apache-1.1 Apache-2.0 Artistic-2.0
BlueOak-1.0.0 BSD-1-Clause BSD-2-Clause BSD-3-Clause BSD-3-Clause-Clear BSL-1.0
CC-BY-3.0 CC-BY-4.0 CC0-1.0 CDDL-1.0 CNRI-Python EPL-1.0 EPL-2.0 GPL-2.0-only
GPL-2.0-or-later GPL-3.0-only GPL-3.0-or-later HPND ISC LGPL-2.0-only
LGPL-2.0-or-later LGPL-2.1-only LGPL-2.1-or-later LGPL-3.0-only
LGPL-3.0-or-later MIT MIT-0 MIT-CMU MPL-1.1 MPL-2.0 OFL-1.1 OpenSSL PSF-2.0
Python-2.0 TCL Unicode-3.0 Unicode-DFS-2016 Unlicense W3C WTFPL Zlib ZPL-2.1
""".split()
)
_SPDX_LOWER = {i.lower(): i for i in SPDX_IDS}
# Common spellings of the same licence. Only exact, unambiguous names: a bare
# "BSD" or "GPL" names no single licence and stays as declared.
_ALIASES = {
    "mit license": "MIT",
    "mit licence": "MIT",
    "the mit license": "MIT",
    "apache 2.0": "Apache-2.0",
    "apache-2": "Apache-2.0",
    "apache 2": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache license version 2.0": "Apache-2.0",
    "apache software license 2.0": "Apache-2.0",
    "isc license": "ISC",
    "mpl 2.0": "MPL-2.0",
    "mozilla public license 2.0": "MPL-2.0",
    "bsd 3-clause": "BSD-3-Clause",
    "bsd-3": "BSD-3-Clause",
    "new bsd license": "BSD-3-Clause",
    "bsd 2-clause": "BSD-2-Clause",
    "simplified bsd license": "BSD-2-Clause",
    "gnu lesser general public license v3.0": "LGPL-3.0-only",
    "python software foundation license": "PSF-2.0",
    "psf": "PSF-2.0",
    "apache software license": "Apache-2.0",
}
# Trove classifiers that name exactly one SPDX licence.
_CLASSIFIERS = {
    "MIT License": "MIT",
    "MIT No Attribution License (MIT-0)": "MIT-0",
    "ISC License (ISCL)": "ISC",
    "Apache Software License": "Apache-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Mozilla Public License 1.1 (MPL 1.1)": "MPL-1.1",
    "Python Software Foundation License": "PSF-2.0",
    "The Unlicense (Unlicense)": "Unlicense",
    "Zope Public License": "ZPL-2.1",
    "GNU Lesser General Public License v3 or later (LGPLv3+)": "LGPL-3.0-or-later",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "GNU Lesser General Public License v2 or later (LGPLv2+)": "LGPL-2.0-or-later",
    "GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
    "GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
    "Eclipse Public License 2.0 (EPL-2.0)": "EPL-2.0",
    "Boost Software License 1.0 (BSL-1.0)": "BSL-1.0",
    "Historical Permission Notice and Disclaimer (HPND)": "HPND",
}
_EXPR_TOKEN = re.compile(r"\(|\)|[A-Za-z0-9.+-]+")


# ── licences ────────────────────────────────────────────────────────────────
def _spdx_id(text: str) -> str | None:
    t = text.strip()
    return _SPDX_LOWER.get(t.lower()) or _ALIASES.get(t.lower())


def _expression(text: str) -> str | None:
    """``text`` when it is an SPDX expression over known ids, else None."""
    t = text.strip()
    if not re.search(r"\s(AND|OR|WITH)\s", t, re.I):
        return None
    tokens = _EXPR_TOKEN.findall(t)
    if "".join(tokens) != re.sub(r"\s+", "", t):
        return None
    for tok in tokens:
        if tok in "()" or tok.upper() in ("AND", "OR", "WITH"):
            continue
        if (
            tok not in SPDX_IDS
            and not tok.startswith("LicenseRef-")
            and not tok.endswith("-exception")
        ):
            return None
    return re.sub(r"\s+", " ", t)


def license_entries(text: str | None) -> list[dict]:
    """CycloneDX ``licenses`` for one declared licence string (may be empty)."""
    text = (text or "").strip()
    if text.startswith("(") and text.endswith(")") and text.count("(") == 1:
        text = text[1:-1].strip()  # npm's "(MIT OR Apache-2.0)"
    if not text or text.upper() in ("UNKNOWN", "UNLICENSED", "NONE"):
        return []
    if text.startswith("License ::"):  # a trove classifier in the License field
        text = text.split("::")[-1].strip()
        if text in _CLASSIFIERS:
            return [{"license": {"id": _CLASSIFIERS[text]}}]
    if lid := _spdx_id(text):
        return [{"license": {"id": lid}}]
    if expr := _expression(text):
        return [{"expression": expr}]
    # Declared but not an SPDX id: keep the words, not a full licence text.
    if "\n" in text or len(text) > 100:
        return []
    return [{"license": {"name": text}}]


def python_licenses(meta) -> list[dict]:
    if found := license_entries(meta.get("License-Expression")):
        return found
    if found := license_entries(meta.get("License")):
        return found
    out = []
    for c in meta.get_all("Classifier") or []:
        if not c.startswith("License ::"):
            continue
        tail = c.split("::")[-1].strip()
        if tail in ("OSI Approved", "Other/Proprietary License"):
            continue
        entry = (
            {"license": {"id": _CLASSIFIERS[tail]}}
            if tail in _CLASSIFIERS
            else {"license": {"name": tail}}
        )
        if entry not in out:
            out.append(entry)
    return out


def npm_licenses(pkg: dict) -> list[dict]:
    lic = pkg.get("license")
    if isinstance(lic, dict):
        lic = lic.get("type")
    if isinstance(lic, str):
        return license_entries(lic)
    out = []
    for item in pkg.get("licenses") or []:  # the old array form
        name = item.get("type") if isinstance(item, dict) else item
        for e in license_entries(name if isinstance(name, str) else None):
            if e not in out:
                out.append(e)
    return out


# ── suppliers ───────────────────────────────────────────────────────────────
def _person_name(text: str | None) -> str | None:
    """'Jane Doe <jane@x>' / '"Org" <a@b>, B <c@d>' -> the first name given."""
    if not text:
        return None
    first = text.split(",")[0].strip()
    name = re.sub(r"\s*[<(].*$", "", first).strip().strip('"').strip()
    if name:
        return name
    m = re.search(r"<?([^<>@\s]+@[^<>\s]+)>?", first)
    return m.group(1) if m else None


def python_supplier(meta) -> dict | None:
    for key in ("Maintainer", "Author", "Maintainer-email", "Author-email"):
        if name := _person_name(meta.get(key)):
            return {"name": name}
    return None


def npm_supplier(pkg: dict) -> dict | None:
    author = pkg.get("author")
    if isinstance(author, dict):
        author = author.get("name")
    if isinstance(author, str) and (name := _person_name(author)):
        return {"name": name}
    return None


# ── Python ──────────────────────────────────────────────────────────────────
def _canon(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _parse_req(line: str):
    """(name, extras, marker-callable) for a PEP 508 requirement line."""
    try:
        from packaging.requirements import Requirement

        req = Requirement(line)
        marker = req.marker
        return (
            req.name,
            set(req.extras),
            ((lambda extra: marker.evaluate({"extra": extra})) if marker else (lambda extra: True)),
        )
    except ImportError:  # pragma: no cover - packaging ships with the app
        pass
    except Exception:
        return None
    m = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?([^;]*)(?:;(.*))?$", line)
    if not m:
        return None
    extras = {e.strip() for e in (m.group(2) or "").split(",") if e.strip()}
    marker = m.group(4) or ""
    wanted = re.findall(r"extra\s*==\s*['\"]([^'\"]+)['\"]", marker)
    return m.group(1), extras, (lambda extra: (extra in wanted) if wanted else True)


def requirement_lines(path: Path) -> list[str]:
    out = []
    for raw in path.read_text().splitlines():
        line = raw.split(" #")[0].split("\t#")[0].strip()
        if not line or line.startswith(("#", "-")):
            continue
        out.append(line)
    return out


def python_components(requirements: Path, dists=None):
    """Components + dependency edges for requirements.txt and its closure.

    ``dists`` maps canonical name -> distribution (defaults to the running
    interpreter's environment); tests pass a fixture."""
    if dists is None:
        dists = {}
        for d in md.distributions():
            name = d.metadata.get("Name")
            if name:
                dists.setdefault(_canon(name), d)
    roots, missing = [], []
    queue: list[tuple[str, set[str]]] = []
    for line in requirement_lines(requirements):
        parsed = _parse_req(line)
        if not parsed:
            continue
        name, extras, applies = parsed
        if not applies(""):
            continue
        if _canon(name) not in dists:
            missing.append(name)
            continue
        roots.append(_canon(name))
        queue.append((_canon(name), extras))
    seen_extras: dict[str, set[str]] = {}
    edges: dict[str, set[str]] = {}
    while queue:
        key, extras = queue.pop()
        done = seen_extras.get(key)
        if done is not None and extras <= done:
            continue
        seen_extras[key] = (done or set()) | extras
        edges.setdefault(key, set())
        for line in dists[key].requires or []:
            parsed = _parse_req(line)
            if not parsed:
                continue
            dep, dep_extras, applies = parsed
            if not any(applies(e) for e in ({""} | seen_extras[key])):
                continue
            if _canon(dep) not in dists:
                continue  # a platform-only or uninstalled optional dependency
            edges[key].add(_canon(dep))
            queue.append((_canon(dep), dep_extras))
    components = {}
    for key in edges:
        meta = dists[key].metadata
        version = dists[key].version
        ref = f"pkg:pypi/{key}@{version}"
        comp = {"type": "library", "bom-ref": ref, "name": meta.get("Name"), "version": version}
        if sup := python_supplier(meta):
            comp["supplier"] = sup
        if lic := python_licenses(meta):
            comp["licenses"] = lic
        comp["purl"] = ref
        if home := _python_home(meta):
            comp["externalReferences"] = [{"type": "website", "url": home}]
        components[key] = comp
    deps = {
        components[k]["bom-ref"]: sorted(components[d]["bom-ref"] for d in v)
        for k, v in edges.items()
    }
    root_refs = sorted({components[k]["bom-ref"] for k in roots})
    return list(components.values()), deps, root_refs, missing


def _python_home(meta) -> str | None:
    urls = {}
    for item in meta.get_all("Project-URL") or []:
        label, _, url = item.partition(",")
        urls[label.strip().lower()] = url.strip()
    for label in ("homepage", "home", "source", "source code", "repository"):
        if urls.get(label, "").startswith("http"):
            return urls[label]
    home = (meta.get("Home-page") or "").strip()
    return home if home.startswith("http") else None


# ── npm ─────────────────────────────────────────────────────────────────────
def _platform_ok(pkg: dict) -> bool:
    for field, value in NPM_PLATFORM.items():
        allowed = pkg.get(field)
        if not allowed:
            continue
        allowed = [allowed] if isinstance(allowed, str) else allowed
        if f"!{value}" in allowed:
            return False
        positive = [a for a in allowed if not a.startswith("!")]
        if positive and value not in positive:
            return False
    return True


def _resolve(packages: dict, from_path: str, name: str) -> str | None:
    """Node's lookup: the nearest node_modules/<name> walking up from a path."""
    path = from_path
    while True:
        cand = f"{path}/node_modules/{name}" if path else f"node_modules/{name}"
        if cand in packages:
            return cand
        if not path:
            return None
        path = path.rsplit("/node_modules/", 1)[0] if "/node_modules/" in path else ""


def _npm_hash(integrity: str | None) -> list[dict]:
    for part in (integrity or "").split():
        algo, _, b64 = part.partition("-")
        if algo == "sha512":
            try:
                return [{"alg": "SHA-512", "content": base64.b64decode(b64).hex()}]
            except ValueError:
                return []
    return []


def npm_components(lockfile: Path, node_modules_root: Path | None = None):
    """Runtime packages of a v2/v3 package-lock.json, walked from the root's
    dependencies (devDependencies never followed)."""
    lock = json.loads(lockfile.read_text())
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        raise SystemExit(f"{lockfile}: lockfileVersion 2 or 3 required")
    root = packages.get("", {})

    def wanted(path: str) -> bool:
        pkg = packages[path]
        return not pkg.get("dev") and not pkg.get("link") and _platform_ok(pkg)

    def dep_names(pkg: dict) -> list[str]:
        names = [*(pkg.get("dependencies") or {}), *(pkg.get("optionalDependencies") or {})]
        names += list(pkg.get("peerDependencies") or {})
        return sorted(set(names))

    def resolve_all(path: str, pkg: dict) -> list[str]:
        out = []
        for name in dep_names(pkg):
            target = _resolve(packages, path, name)
            if target and wanted(target):
                out.append(target)
        return out

    direct = [
        t
        for t in (
            _resolve(packages, "", n)
            for n in sorted(
                {*(root.get("dependencies") or {}), *(root.get("optionalDependencies") or {})}
            )
        )
        if t and wanted(t)
    ]
    edges: dict[str, list[str]] = {}
    queue = list(direct)
    while queue:
        path = queue.pop()
        if path in edges:
            continue
        edges[path] = resolve_all(path, packages[path])
        queue.extend(edges[path])

    def meta(path: str) -> dict:
        pkg = dict(packages[path])
        if node_modules_root is not None:
            pj = node_modules_root / path / "package.json"
            if pj.is_file():
                try:
                    disk = json.loads(pj.read_text())
                except (OSError, ValueError):
                    disk = {}
                for key in ("license", "licenses", "author", "homepage", "name"):
                    if key not in pkg and key in disk:
                        pkg[key] = disk[key]
        return pkg

    ref_of: dict[str, str] = {}
    components: dict[str, dict] = {}
    for path in sorted(edges):
        pkg = meta(path)
        full = pkg.get("name") or path.rsplit("node_modules/", 1)[-1]
        version = pkg.get("version", "")
        group, _, name = full.rpartition("/")
        ref = f"pkg:npm/{quote(group, safe='') + '/' if group else ''}{name}@{version}"
        ref_of[path] = ref
        if ref in components:
            continue
        comp = {"type": "library", "bom-ref": ref}
        if group:
            comp["group"] = group
        comp.update(name=name, version=version)
        if sup := npm_supplier(pkg):
            comp["supplier"] = sup
        if lic := npm_licenses(pkg):
            comp["licenses"] = lic
        if hashes := _npm_hash(pkg.get("integrity")):
            comp["hashes"] = hashes
        comp["purl"] = ref
        refs = []
        if isinstance(pkg.get("homepage"), str) and pkg["homepage"].startswith("http"):
            refs.append({"type": "website", "url": pkg["homepage"]})
        if isinstance(pkg.get("resolved"), str) and pkg["resolved"].startswith("http"):
            refs.append({"type": "distribution", "url": pkg["resolved"]})
        if refs:
            comp["externalReferences"] = refs
        components[ref] = comp
    deps: dict[str, set[str]] = {}
    for path, targets in edges.items():
        deps.setdefault(ref_of[path], set()).update(ref_of[t] for t in targets)
    deps = {k: sorted(v - {k}) for k, v in deps.items()}
    return list(components.values()), deps, sorted({ref_of[p] for p in direct})


# ── the BOM ─────────────────────────────────────────────────────────────────
def danbyte_version(root: Path) -> str:
    text = (root / "danbyte" / "__init__.py").read_text()
    return re.search(r'__version__\s*=\s*"([^"]+)"', text).group(1)


def danbyte_license(root: Path) -> list[dict]:
    head = (
        " ".join((root / "LICENSE").read_text().split()[:12])
        if (root / "LICENSE").is_file()
        else ""
    )
    if "Apache License" in head and "Version 2.0" in head:
        return [{"license": {"id": "Apache-2.0"}}]
    return []


def _timestamp() -> str:
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    when = datetime.fromtimestamp(int(epoch), UTC) if epoch else datetime.now(UTC)
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def build_bom(
    root: Path, version: str | None = None, *, dists=None, node_modules: Path | None = None
) -> tuple[dict, dict]:
    """The BOM and a summary of what went into it."""
    version = version or danbyte_version(root)
    py, py_deps, py_roots, missing = python_components(root / "requirements.txt", dists)
    if node_modules is None and (root / "frontend" / "node_modules").is_dir():
        node_modules = root / "frontend"
    js, js_deps, js_roots = npm_components(root / "frontend" / "package-lock.json", node_modules)
    app_ref = f"pkg:github/danbyte-net/danbyte@v{version}"
    app = {
        "type": "application",
        "bom-ref": app_ref,
        "name": "danbyte",
        "version": version,
        "supplier": {"name": "Danbyte", "url": [REPO_URL]},
    }
    if lic := danbyte_license(root):
        app["licenses"] = lic
    app["purl"] = app_ref
    app["externalReferences"] = [{"type": "vcs", "url": REPO_URL}]
    components = sorted([*py, *js], key=lambda c: c["bom-ref"])
    dependencies = [{"ref": app_ref, "dependsOn": sorted({*py_roots, *js_roots})}]
    graph = {**py_deps, **js_deps}
    dependencies += [
        {"ref": ref, "dependsOn": graph.get(ref, [])} for ref in (c["bom-ref"] for c in components)
    ]
    bom = {
        "$schema": "http://cyclonedx.org/schema/bom-1.6.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": _timestamp(),
            "lifecycles": [{"phase": "build"}],
            "tools": {
                "components": [{"type": "application", "name": TOOL_NAME, "version": version}]
            },
            "component": app,
        },
        "components": components,
        "dependencies": dependencies,
    }
    summary = {
        "python": len(py),
        "npm": len(js),
        "no_licence": sorted(
            f"{c.get('group', '') + '/' if c.get('group') else ''}{c['name']}@{c['version']}"
            for c in components
            if not c.get("licenses")
        ),
        "missing": missing,
    }
    return bom, summary


def main(argv=None) -> int:
    here = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--root", type=Path, default=here, help="Danbyte source tree")
    p.add_argument("--version", help="release version (default: danbyte/__init__.py)")
    p.add_argument("--output", "-o", type=Path, help="write here instead of stdout")
    args = p.parse_args(argv)
    bom, summary = build_bom(args.root.resolve(), args.version)
    if summary["missing"]:
        print(
            "requirements not installed in this environment: " + ", ".join(summary["missing"]),
            file=sys.stderr,
        )
        return 1
    text = json.dumps(bom, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(text)
    else:
        sys.stdout.write(text)
    unknown = summary["no_licence"]
    print(
        f"sbom: {summary['python']} Python + {summary['npm']} npm components, "
        f"{len(unknown)} without a declared licence",
        file=sys.stderr,
    )
    for name in unknown:
        print(f"  no licence: {name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
