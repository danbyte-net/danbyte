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
| `make seed-demo` | Opt-in demo IPAM data (`seed_demo`, `seed_demo_172`); idempotent |
| `make seed-fabric` | Opt-in leaf/spine EVPN fabric for the routing pages (`seed_fabric`); idempotent |

## Root steps

These run files from the tree as root, or install them where root runs them:

| Target | What it does |
|---|---|
| `make host-sync` | What the installer does as root: logrotate, the nginx site (re-rendered only while it is still what Danbyte rendered) and the site-certificate unit, for the install in `APP`. `HOST=` names a new site; `ADOPT=1` takes the new render over a site edited by hand, keeping a backup |
| `make install-tls-unit` | The site-certificate unit alone, with a root-owned copy of its script in `/usr/local/libexec/danbyte/`, for the install in `APP` |
| `make proxy-install` / `proxy-reload` | The development reverse proxy, see [Reverse proxy](nginx-proxy.md) |

`APP` defaults to the tree itself, and `APP` and `HOST` count only on the
command line. Root runs only files root owns, so these targets refuse a tree
that is neither root's nor yours - such as a production install's app
directory, which the service account owns: a file changed there would run as
root. Run the root steps of such an install from the unpacked bundle of the
release it runs (`sudo ./install.sh --host-only`), or from a checkout root
made:

```bash
sudo make -C /root/danbyte-vX.Y.Z host-sync APP=/opt/danbyte/danbyte
```

See [Upgrading → After an upgrade](../getting-started/upgrading.md#after-an-upgrade).
