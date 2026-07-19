---
icon: lucide/wrench
---

# Dev workflow

Everyday commands. All driven by the project `Makefile`; under the hood they call `systemctl --user` on services symlinked from `services/`.

## Services

| Service | Port | Notes |
|---|---|---|
| `danbyte-backend` | `:8000` | Django dev server |
| `danbyte-workers` | — | RQ worker (default + high + low queues) |
| `danbyte-mockups` | `:8080` | Static design mockup server (`design/`) |
| `danbyte-docs` | `:8001` | This documentation site (Zensical) |
| `danbyte-infra` | `:5432`/`:6379` | Postgres + Redis via `docker compose` (no-op if Docker isn't installed) |

## The most common loop

```bash
# Restart after a code change (Django dev server auto-reloads, so this is rarely needed)
make backend-restart

# Re-seed demo data after a model change
.venv/bin/python manage.py seed_demo --wipe

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

## Docs while you work

```bash
make docs-up           # serves at http://localhost:8001
make docs-logs         # tail
make docs-restart      # if you edited zensical.toml
```

The docs hot-reload Markdown changes on save.
