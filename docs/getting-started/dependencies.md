---
icon: lucide/lock
---

# Dependencies and the scanner gate

Danbyte pins every Python package it runs, with a sha256 for each file, and
CI scans the pinned versions for known vulnerabilities. This page is for
people who change Danbyte's dependencies or cut a release. For the list of
what a release ships, see [Danbyte's SBOM](sbom.md).

## The two files

| File | What it is | Who edits it |
|---|---|---|
| `requirements.txt` | The direct dependencies and their floors (`Django>=5.2.17,<5.3`), plus security floors for packages they pull in | You, by hand |
| `requirements.lock` | `requirements.txt` resolved to one exact version of every package, direct or not, with the sha256 of each wheel and sdist on PyPI | `make lock` only |

The lock is resolved for Python 3.13 on x86_64 Linux, the platform of the
offline bundle. It carries the hashes of every file of each pinned version,
so the same lock also installs on arm64 Linux (a Docker build on an ARM
host).

The npm side already works this way: `frontend/package-lock.json` pins every
package with an integrity hash, and `npm ci` installs exactly that.

## What installs from the lock

| Install | How |
|---|---|
| Container image (`Dockerfile`) | `pip install --require-hashes -r requirements.lock` |
| Offline bundle build (`scripts/build-release.sh`) | `pip wheel --require-hashes -r requirements.lock`: every wheel or sdist it downloads must match a recorded hash. The build then checks that installing the wheelhouse gives exactly the lock's versions (`scripts/release/lockcheck.py --installed`) |
| Bundle install and bundle upgrade (`install.sh`, the upgrade stage) | From the bundle's wheelhouse, offline. Those wheels were downloaded hash-checked from the lock when the bundle was built; wheels built from an sdist there (python-ldap) have no PyPI hash, so these installs go by name from the wheelhouse, and the bundle as a whole is checked by its own `.sha256` |
| Git upgrade (in-app or `danbyte upgrade` on a git install) | `uv pip install --require-hashes -r requirements.lock`, or `pip` with the same flags when there is no uv. A target release without a lock (before 0.20) installs from its `requirements.txt` |
| CI (`ci.yml`, `tests.yml`) | `pip install --require-hashes -r requirements.lock`, so the tests run against what ships |
| A source checkout | `uv pip install --require-hashes -r requirements.lock` (see [Installation](installation.md)) |

Hash-checking mode does not cover the build tools pip fetches to build an
sdist (setuptools for python-ldap); pip does not hash-check those.

## Changing a dependency

1. Edit `requirements.txt`: add the package, or raise its floor. Floors are
   minimums; never lower a security floor.
2. Run `make lock`. It keeps every version already in the lock and resolves
   only what `requirements.txt` changed.
3. Commit both files together.

To move every package to its newest release, run `make lock-upgrade` and
review the diff before committing: it can bring new major versions.

`make lock` uses [uv](https://docs.astral.sh/uv/) and needs the package
index. On a machine without uv on `PATH`, pass it:
`make lock UV=~/.local/bin/uv`.

Two checks keep the lock honest:

- `core.tests_supply_chain`, offline, in the test suite: every requirement in
  `requirements.txt` is in the lock at a version that satisfies its floor,
  and every lock entry is pinned with `==` and has a hash.
- `make lock-check`, in CI: compiles the lock again into a temporary file and
  fails if it would differ from the committed one. It needs the index.

## The scanner gate

`.github/workflows/dependencies.yml` runs on every pull request, on pushes to
`main`, every Monday, and before a release builds its bundle
(`release.yml` waits for it). It has two jobs:

| Job | What it does |
|---|---|
| Lock matches requirements.txt | `lockcheck.py` and `make lock-check` |
| OSV scan | The official [OSV-Scanner](https://google.github.io/osv-scanner/) action, pinned by commit SHA, scans `requirements.lock` and `frontend/package-lock.json` against the OSV database; `scripts/release/osv_gate.py` then decides |

The gate fails on a **critical or high** finding in a **runtime** dependency:

- every package in `requirements.lock`;
- every npm package in `package-lock.json` that is not marked development
  only. A package that both the app and the tooling use counts as runtime.

A finding with no severity at all counts as high until someone triages it.
Lower severities, and findings in development-only npm packages (the build,
test and lint tooling: never shipped in the bundle or the image, never run by
an install), are listed in the job summary and do not fail it. A scan that
writes no results fails the gate.

Severity is the highest CVSS base score of the advisory and its aliases (9.0
and up is critical, 7.0 and up high), or the advisory database's own label
when that is higher.

The JSON report is kept as the run's `osv-results` artifact for 30 days.

## When the gate fails

Upgrade first. For a Python package, raise its floor in `requirements.txt`
to the first fixed release, then `make lock`. For npm, update the package
(or add an `overrides` entry in `frontend/package.json`) and commit the new
`package-lock.json`.

When there is no fix yet, or the vulnerable code is not reachable from
Danbyte, add an entry to `osv-scanner.toml` at the repository root:

```toml
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = 2027-01-31
reason = "Only reachable through X, which Danbyte does not call; fixed in Y, not released yet."
```

The rules for the allowlist:

- One entry per advisory id. The `[[PackageOverrides]]` form, which can
  silence a whole package, is refused.
- `reason` is required: why it is safe to ship, or why it cannot be fixed
  yet.
- `ignoreUntil` is required and at most 180 days ahead. On that date the
  scanner reports the finding again and the gate fails, so someone looks
  again.
- An entry that breaks a rule fails the gate before the scan is judged.

The allowlist is empty as of 0.20.
