---
icon: lucide/wrench
---

# Dev workflow

Everyday commands. All driven by the project `Makefile`; under the hood they call `systemctl --user` on services symlinked from `services/`.

## Services

| Service | Port | Notes |
|---|---|---|
| `danbyte-backend` | `:8000` | Django dev server |
| `danbyte-workers` | - | RQ worker (default + high + low queues) |
| `danbyte-fastlane` | - | The fast lane - sub-minute checks (`make fastlane-logs`) |
| `danbyte-mockups` | `:8080` | Static design mockup server (`design/`) |
| `danbyte-docs` | `:8001` | This documentation site (Zensical) |
| `danbyte-infra` | `:5432`/`:6379` | Postgres + Redis via `docker compose` (no-op if Docker isn't installed) |

## The most common loop

```bash
# Restart after a code change (Django dev server auto-reloads, so this is rarely needed)
make backend-restart

# Re-seed demo data after a model change
.venv/bin/python manage.py seed_demo --wipe

# Build the DC-TEST hall for exercising the 3D room view: ten rows of ten
# cabinets in hot/cold pairs, A/B vertical PDUs stamped from a rack type,
# photo-faceplate gear, ~1100 cables, power feeds and overhead tray.
.venv/bin/python manage.py seed_dc_test --wipe

# Tail backend logs
make backend-logs

# Status of all services
make status
```

## Reseeding from scratch

When the model changes in a way that's incompatible with the existing DB rows
(e.g. new non-null FK), wipe and start over:

```bash
sudo -u postgres psql -c "DROP DATABASE danbyte;" \
  && sudo -u postgres psql -c "CREATE DATABASE danbyte OWNER danbyte;"

rm -f api/migrations/0001_initial.py api/migrations/0002_initial.py core/migrations/0001_initial.py
DB_HOST=127.0.0.1 DB_USER=danbyte DB_PASSWORD=danbyte DB_NAME=danbyte \
  .venv/bin/python manage.py makemigrations core api
DB_HOST=127.0.0.1 DB_USER=danbyte DB_PASSWORD=danbyte DB_NAME=danbyte \
  .venv/bin/python manage.py migrate
DB_HOST=127.0.0.1 DB_USER=danbyte DB_PASSWORD=danbyte DB_NAME=danbyte \
  .venv/bin/python manage.py seed_demo
make backend-restart
```

## Releases that need an operator step

When a change needs something on the host that no migration can do (a
reverse-proxy location, a volume, a package), add an `UpgradeNote` to
`core/upgrade_notes.py` in the same change: id, version, title, a short
body, the snippet to paste, the docs anchor, and the platforms it applies
to. Admins see it after upgrading until they mark it done - see
[Upgrading → After an upgrade](upgrading.md#after-an-upgrade).

## Cutting a release

Pushing a `v*` tag runs `.github/workflows/release.yml`:

```text
test (tests.yml) ─┬─ bundle ─ smoke ─ publish   GitHub Release + offline bundle
                  └─ images (container.yml)      ghcr.io images
```

`tests.yml` is the one test gate: the backend suite, migrations and
`makemigrations --check`, the OpenAPI schema, and the frontend build,
typecheck and unit tests. Nothing publishes unless it passes, and it runs once
per tag. A manual run of the *Container images* workflow runs `tests.yml`
itself before it builds.

After the tag, on the branch for the next release, record the release's
migration state and commit it:

```bash
.venv/bin/python scripts/upgrade/migration_baseline.py vX.Y.Z
```

It rewrites `scripts/upgrade/migration_baseline.json`. The test
`api.tests_upgrade_db_defaults` then requires a `db_default` on every NOT NULL
column added to an existing table since that release, because the previous
release's processes keep inserting rows without it while an upgrade runs.
Use final releases only, not `-devN` tags. Skipping the step is safe but
stale: the gate keeps comparing with the older release.

## Docs while you work

```bash
make docs-up           # serves at http://localhost:8001
make docs-logs         # tail
make docs-restart      # if you edited zensical.toml
```

The docs hot-reload Markdown changes on save.
