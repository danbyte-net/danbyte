#!/usr/bin/env python3
"""Checks on requirements.lock, the hash-pinned closure of requirements.txt.

    python scripts/release/lockcheck.py [requirements.txt] [requirements.lock]
    <venv>/bin/python scripts/release/lockcheck.py --installed [...]

Without ``--installed`` it checks the lock against requirements.txt: every
requirement is pinned with ``==`` and satisfies its floor, and every entry
carries at least one sha256 hash. That catches a requirements.txt edit made
without ``make lock``. It cannot tell a lock that a fresh ``uv pip compile``
would resolve differently; CI runs ``make lock-check`` for that.

With ``--installed`` it also compares the running interpreter's packages
with the lock, both ways, by name and version. The release build runs it in
the environment the wheelhouse installs into, so the bundle ships the
versions the lock names and no others.

Standard library only; ``packaging`` is used when present.
"""

from __future__ import annotations

import argparse
import importlib.metadata as md
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Installer tooling a venv carries that is not a dependency of Danbyte.
TOOLING = {"pip", "setuptools", "wheel"}


def canon(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_lock(path: Path) -> dict[str, dict]:
    """canonical name -> {name, version, pinned, hashes, marker}."""
    entries: dict[str, dict] = {}
    current = None
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if raw[:1].isspace() or line.startswith("--"):
            if current is not None:
                current["hashes"] += re.findall(r"--hash=sha256:([0-9a-f]{64})", line)
            continue
        spec = line.rstrip("\\").strip()
        marker = ""
        if ";" in spec:
            spec, marker = (s.strip() for s in spec.split(";", 1))
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(==|===)?\s*(\S*)$", spec)
        if not m:
            raise ValueError(f"{path.name}: cannot read {raw!r}")
        current = {
            "name": m.group(1),
            "version": m.group(3),
            "pinned": bool(m.group(2)) and bool(m.group(3)),
            "hashes": re.findall(r"--hash=sha256:([0-9a-f]{64})", raw),
            "marker": marker,
        }
        entries[canon(m.group(1))] = current
    return entries


def requirements(path: Path) -> list[tuple[str, str, str]]:
    """(canonical name, specifier, original line) for each requirement."""
    out = []
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)", line)
        if not m:
            raise ValueError(f"{path.name}: cannot read {raw!r}")
        out.append((canon(m.group(1)), m.group(2).strip(), line))
    return out


def _satisfies(version: str, spec: str) -> bool | None:
    if not spec:
        return True
    try:
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version
    except ImportError:  # pragma: no cover - packaging ships with the app
        return None
    return SpecifierSet(spec).contains(Version(version), prereleases=True)


def lock_problems(requirements_txt: Path, lock_file: Path) -> list[str]:
    lock = parse_lock(lock_file)
    problems = []
    for name, spec, line in requirements(requirements_txt):
        entry = lock.get(name)
        if entry is None:
            problems.append(f"{line}: not in {lock_file.name}")
        elif entry["pinned"] and _satisfies(entry["version"], spec) is False:
            problems.append(f"{line}: {lock_file.name} pins {entry['version']}")
    for entry in lock.values():
        if not entry["pinned"]:
            problems.append(f"{entry['name']}: not pinned with == in {lock_file.name}")
        if not entry["hashes"]:
            problems.append(f"{entry['name']}: no sha256 hash in {lock_file.name}")
    return problems


def installed_problems(lock_file: Path, dists=None) -> list[str]:
    """The environment's packages against the lock, by name and version."""
    if dists is None:
        dists = {}
        for d in md.distributions():
            name = d.metadata.get("Name")
            if name:
                dists.setdefault(canon(name), d.version)
    lock = parse_lock(lock_file)
    problems = []
    for name, entry in sorted(lock.items()):
        have = dists.get(name)
        if have is None:
            problems.append(f"{entry['name']}=={entry['version']}: not installed")
        elif have != entry["version"]:
            problems.append(f"{entry['name']}: installed {have}, the lock pins {entry['version']}")
    for name in sorted(set(dists) - set(lock) - TOOLING):
        problems.append(f"{name}=={dists[name]}: installed but not in {lock_file.name}")
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("requirements", nargs="?", type=Path, default=ROOT / "requirements.txt")
    ap.add_argument("lock", nargs="?", type=Path, default=ROOT / "requirements.lock")
    ap.add_argument(
        "--installed",
        action="store_true",
        help="also compare this interpreter's packages with the lock",
    )
    args = ap.parse_args(argv)
    problems = lock_problems(args.requirements, args.lock)
    for p in problems:
        print(p, file=sys.stderr)
    if problems:
        print(f"{args.lock.name} is out of date: run `make lock`", file=sys.stderr)
        return 1
    if args.installed:
        problems = installed_problems(args.lock)
        for p in problems:
            print(p, file=sys.stderr)
        if problems:
            print(f"this environment is not what {args.lock.name} pins", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
