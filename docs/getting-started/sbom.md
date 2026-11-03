---
icon: lucide/package-search
---

# Danbyte's SBOM

Every Danbyte release ships a software bill of materials (SBOM) for Danbyte
itself: each Python and npm package it runs on, with its exact version,
declared licence and supplier. Use it to show that the platform is built on
open-source components, to check licences, or to feed a vulnerability scanner.

This page covers Danbyte's own SBOM. It is not an export of the devices you
manage in Danbyte.

## Where to get it

| Where | What |
|---|---|
| GitHub release | `danbyte-<version>.cdx.json`, attached next to the bundle tarball |
| Offline bundle | `sbom.cdx.json` at the top of the bundle; the installer and in-app upgrades copy it to the app directory (`/opt/danbyte/sbom.cdx.json`) |
| Container image | `/app/sbom.cdx.json` in `danbyte-app` |
| In the app | **Settings → Updates → This install → Download SBOM** |

The in-app download is `GET /api/system/sbom/`. It needs the same permission
as the rest of **Settings → Updates**: a superuser or a global
`users.manage` grant. It returns the file the release shipped as
`danbyte-<version>.cdx.json` (`application/vnd.cyclonedx+json`).

A source (git) checkout has no SBOM until you generate one. There the
endpoint answers `404` with a message saying so, and the button is hidden.
Danbyte does not build an SBOM on request, so the file always describes the
release build rather than a tree that may have been changed since.

```bash
base=https://github.com/danbyte-net/danbyte/releases/download/v<version>
curl -fsSLO $base/danbyte-<version>.cdx.json
```

## What it covers

The file is [CycloneDX](https://cyclonedx.org/) 1.6 JSON.

- **Danbyte** is the top-level component (`metadata.component`): its version
  and the Apache-2.0 licence from the repository's `LICENSE`.
- **Python:** every package in `requirements.txt` and everything those
  packages pull in, at the version installed in the release environment
  (`pkg:pypi/...`). Licences come from each package's metadata
  (`License-Expression`, then `License`, then its licence classifiers).
  Suppliers come from the package's maintainer or author.
- **npm:** the runtime packages of `frontend/package-lock.json`
  (`pkg:npm/...`), meaning the packages the frontend server and the built
  SPA use. Development tooling such as the test runner, linters and type
  definitions is left out, as are native packages for platforms other than
  linux-x64. Licences come from the lockfile or the package's
  `package.json`. Each entry includes the registry tarball and its SHA-512.
- **dependencies:** which component depends on which, starting from
  Danbyte.

System packages (PostgreSQL, Redis, nginx, the OS) and the bundled Python and
Node runtimes are not listed. The bundle's `BUNDLE_INFO` names the Python,
Node and LibreDWG versions, and `vendor/cad` holds LibreDWG's licence and
source.

Only licences a package declares are listed. When a package declares none,
the SBOM leaves its licence empty and does not guess one. A licence that is
not a recognised SPDX identifier is kept as its declared name.

## Regenerate it

The generator is `scripts/release/sbom.py`. It uses only the standard library
and works offline. Run it with the Python of the environment you want to
describe:

```bash
make sbom                     # .venv + frontend/ -> sbom.cdx.json
# or, for another environment:
/path/to/venv/bin/python scripts/release/sbom.py --output sbom.cdx.json
```

On a source install, `make sbom` writes `sbom.cdx.json` in the app directory,
which is where `/api/system/sbom/` reads it. Run `npm ci` in `frontend/`
first so licences and suppliers can be read from `node_modules`; the
lockfile alone has a licence for only some packages.

The script prints how many Python and npm components it found and lists the
packages with no declared licence. Apart from `serialNumber` and
`metadata.timestamp`, the output is the same each time for the same lockfile
and environment. Set `SOURCE_DATE_EPOCH` to fix the timestamp.

Releases build the SBOM in `scripts/build-release.sh`, from the build
environment the wheelhouse is installed into, so it lists the same versions
as the bundle. The container image generates its own during
`docker build`, from the packages installed in the image.
