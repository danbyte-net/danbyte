---
icon: lucide/terminal
---

# Makefile

The control surface for the four user-level systemd services. Run `make` with
no arg to print all targets.

## Setup

| Target | What it does |
|---|---|
| `make install-services` | Symlink unit files in `services/` to `~/.config/systemd/user/`, then `daemon-reload` |
| `make uninstall-services` | Remove the symlinks |
| `make reload` | `systemctl --user daemon-reload` |
| `make linger` | `sudo loginctl enable-linger $USER` so services survive logout |

## Per-service control

For each of `mockups`, `infra`, `backend`, `workers`, `docs`:

```bash
make <service>-up        # start
make <service>-down      # stop
make <service>-restart   # restart
make <service>-logs      # tail journalctl
```

## Bulk control

| Target | What it does |
|---|---|
| `make up` | Start mockups + infra + backend + workers (+ docs) |
| `make down` | Stop them all |
| `make restart` | Restart them all |
| `make status` | `systemctl --user status` for all |
| `make logs` | Tail journalctl for all |
| `make logs-file` | Tail the on-disk logs in `$(LOG_DIR)` (prod; `/var/log/danbyte`) |

## Django shortcuts

These use the project venv automatically.

| Target | What it does |
|---|---|
| `make migrate` | `python manage.py migrate` |
| `make makemigrations` | `python manage.py makemigrations` |
| `make superuser` | `python manage.py createsuperuser` |
| `make shell` | `python manage.py shell` |
| `make test` | `python manage.py test` |
| `make check` | `python manage.py check` |
