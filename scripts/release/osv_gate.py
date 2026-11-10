#!/usr/bin/env python3
"""The dependency gate: decide on an osv-scanner JSON report.

    python scripts/release/osv_gate.py --results osv-results.json \
        [--config osv-scanner.toml] [--package-lock frontend/package-lock.json]

Fails (exit 1) on a critical or high finding in a runtime dependency: every
package in requirements.lock, and the npm packages of package-lock.json that
are not development-only. A finding with no severity at all counts as high
until someone triages it. Development-only npm packages (build, test and
lint tooling, never shipped or run by an install) and lower severities are
listed but do not fail.

The allowlist is osv-scanner.toml, which the scanner itself applies: an
ignored finding is left out of the report until its ``ignoreUntil`` date,
then it is back and fails again. This script also refuses an allowlist entry
without a reason, without an expiry or with one more than 180 days ahead,
and the ``PackageOverrides`` form, which can silence a whole package with no
date (exit 2).

Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEVELS = ("low", "moderate", "high", "critical", "unknown")
BLOCKING = {"high", "critical", "unknown"}
# The longest an allowlist entry may run before someone looks again.
MAX_IGNORE_DAYS = 180


def config_problems(path: Path, today: dt.date | None = None) -> list[str]:
    if not path.exists():
        return []
    data = tomllib.loads(path.read_text())
    today = today or dt.date.today()
    problems = []
    for key in data:
        if key != "IgnoredVulns":
            problems.append(
                f"{path.name}: [{key}] is not allowed, ignore findings one by one "
                "under [[IgnoredVulns]]"
            )
    for i, entry in enumerate(data.get("IgnoredVulns", []), 1):
        label = entry.get("id") or f"entry {i}"
        if not str(entry.get("id", "")).strip():
            problems.append(f"{path.name}: {label} has no id")
        if not str(entry.get("reason", "")).strip():
            problems.append(f"{path.name}: {label} has no reason")
        until = entry.get("ignoreUntil")
        if isinstance(until, dt.datetime):
            until = until.date()
        if not isinstance(until, dt.date):
            problems.append(f"{path.name}: {label} has no ignoreUntil date")
        elif (until - today).days > MAX_IGNORE_DAYS:
            problems.append(
                f"{path.name}: {label} is ignored until {until}, more than "
                f"{MAX_IGNORE_DAYS} days ahead"
            )
    return problems


def dev_only_npm(package_lock: Path) -> set[tuple[str, str]]:
    """(name, version) of npm packages that only development installs pull in."""
    if not package_lock.exists():
        return set()
    packages = json.loads(package_lock.read_text()).get("packages", {})
    dev, runtime = set(), set()
    for path, pkg in packages.items():
        if not path or "version" not in pkg:
            continue
        key = (pkg.get("name") or path.rsplit("node_modules/", 1)[-1], pkg["version"])
        (dev if pkg.get("dev") else runtime).add(key)
    return dev - runtime


def _level(group: dict, vulns: dict[str, dict]) -> str:
    score = None
    try:
        score = float(group.get("max_severity") or "")
    except ValueError:
        pass
    labels = set()
    for vid in group.get("ids", []):
        label = (vulns.get(vid, {}).get("database_specific") or {}).get("severity")
        if isinstance(label, str):
            labels.add(label.lower())
    if (score is not None and score >= 9.0) or "critical" in labels:
        return "critical"
    if (score is not None and score >= 7.0) or "high" in labels:
        return "high"
    if (score is not None and score >= 4.0) or labels & {"moderate", "medium"}:
        return "moderate"
    if score is not None or "low" in labels:
        return "low"
    return "unknown"


def findings(report: dict, dev_npm: set[tuple[str, str]]) -> list[dict]:
    out = []
    for result in report.get("results") or []:
        source = (result.get("source") or {}).get("path", "")
        for entry in result.get("packages") or []:
            pkg = entry.get("package") or {}
            name, version = pkg.get("name", ""), pkg.get("version", "")
            ecosystem = pkg.get("ecosystem", "")
            vulns = {v.get("id"): v for v in entry.get("vulnerabilities") or []}
            groups = entry.get("groups") or [{"ids": [vid]} for vid in vulns]
            for group in groups:
                ids = group.get("ids") or []
                summary = next(
                    (vulns[i].get("summary") for i in ids if vulns.get(i, {}).get("summary")), ""
                )
                out.append(
                    {
                        "id": ids[0] if ids else "?",
                        "package": f"{ecosystem}:{name}@{version}",
                        "source": os.path.basename(source),
                        "level": _level(group, vulns),
                        "dev": ecosystem == "npm" and (name, version) in dev_npm,
                        "summary": summary,
                    }
                )
    return out


def render(found: list[dict]) -> str:
    if not found:
        return "No known vulnerabilities in requirements.lock or frontend/package-lock.json.\n"
    rows = ["| Blocks | Severity | Package | Advisory | Summary |", "|---|---|---|---|---|"]
    for f in sorted(found, key=lambda f: (not blocks(f), -LEVELS.index(f["level"]), f["package"])):
        scope = "dev only" if f["dev"] else "runtime"
        rows.append(
            f"| {'yes' if blocks(f) else 'no'} | {f['level']} ({scope}) | "
            f"`{f['package']}` | {f['id']} | {f['summary'].replace('|', '/')} |"
        )
    return "\n".join(rows) + "\n"


def blocks(f: dict) -> bool:
    return not f["dev"] and f["level"] in BLOCKING


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--results", type=Path, required=True)
    ap.add_argument("--config", type=Path, default=ROOT / "osv-scanner.toml")
    ap.add_argument("--package-lock", type=Path, default=ROOT / "frontend" / "package-lock.json")
    args = ap.parse_args(argv)

    problems = config_problems(args.config)
    for p in problems:
        print(p, file=sys.stderr)
    if problems:
        return 2
    try:
        report = json.loads(args.results.read_text())
    except (OSError, ValueError) as exc:
        # A scan that failed writes nothing; that is not a clean result.
        print(f"no scan results to judge ({exc})", file=sys.stderr)
        return 2

    found = findings(report, dev_only_npm(args.package_lock))
    text = render(found)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write("## Dependency scan\n\n" + text)
    blocking = [f for f in found if blocks(f)]
    if blocking:
        print(
            f"{len(blocking)} critical/high finding(s) in runtime dependencies. Upgrade the "
            "package (requirements.txt floor + `make lock`, or npm), or add a dated "
            "[[IgnoredVulns]] entry with a reason to osv-scanner.toml.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
