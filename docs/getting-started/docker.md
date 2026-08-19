---
icon: lucide/container
---

# Deploy with Docker / Podman

Danbyte ships a production container stack - Postgres, Redis, the Django backend
(gunicorn), a separate WebSocket process (daphne), a background worker pool, and
nginx serving the built SPA. It runs the same way under **Docker** and
**Podman**. (Addresses [issue #19](https://github.com/danbyte-net/danbyte/issues/19).)

!!! note "Bare metal vs containers"
    For a single VM, the [Installation](installation.md) script (systemd units +
    host nginx) is still the smoothest path. Containers suit hosts where you
    already run Docker/Podman, or an orchestrator.

## Quick start

```bash
git clone https://github.com/danbyte-net/danbyte.git
cd danbyte
cp deploy/docker/.env.example .env
```

Edit `.env` - at minimum set the two secrets and the DB password. Generate each
secret with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(64))"
```

Then bring the stack up:

=== "Docker"

    ```bash
    docker compose -f docker-compose.prod.yml --env-file .env up -d --build
    ```

=== "Podman"

    ```bash
    podman-compose -f docker-compose.prod.yml --env-file .env up -d --build
    ```

The backend container runs migrations, the idempotent `bootstrap`, and
`collectstatic` on first start, then serves. When the `web` container is healthy,
open **http://localhost:8080** (the `HTTP_PORT` you set).

Create the first admin (or set the `DJANGO_SUPERUSER_*` vars in `.env` and the
matching lines in the compose file to have `bootstrap` do it):

=== "Docker"

    ```bash
    docker compose -f docker-compose.prod.yml exec backend python manage.py createsuperuser
    ```

=== "Podman"

    ```bash
    podman-compose -f docker-compose.prod.yml exec backend python manage.py createsuperuser
    ```

## What runs

| Service    | Image / stage        | Role                                             |
| ---------- | -------------------- | ------------------------------------------------ |
| `postgres` | `postgres:17`        | Database (named volume `postgres_data`)          |
| `redis`    | `redis:7`            | Queues + channels layer                          |
| `backend`  | app (`runtime`)      | gunicorn WSGI + one-time migrate/bootstrap/static |
| `ws`       | app (`runtime`)      | daphne ASGI - WebSockets only                    |
| `workers`  | app (`runtime`)      | `rqworker-pool` (`RQ_WORKERS` processes; ICMP-capable) |
| `scheduler`| app (`runtime`)      | the periodic beat - the container's systemd timers |
| `frontend` | node (`frontend`)    | the SPA server (`vite preview`) - SSR build      |
| `web`      | nginx (`web`)        | proxies the SPA + `/api` `/ws`, serves `/static` `/media`; HTTP :80 + HTTPS :443 |

WebSockets run as a **separate daphne process**, never channels-in-`runserver` -
putting ASGI in front of all HTTP wedges plain requests. The frontend is a
TanStack Start **SSR** build, so `web` proxies `/` to the `frontend` node server
rather than serving files. Collected static and uploaded media live on shared
volumes the backend writes and nginx serves.

### The scheduler

Nothing in Danbyte polls on its own: the checks, digests, discovery and
retention all have to be *triggered*. A bare-metal install gets that from
systemd timers; a container has no init, so the `scheduler` service runs one
process that reads the same table (`core/schedule.py`) and calls the same
management commands. **Without it the stack looks configured and measures
nothing** - assignments never expand into checks, so nothing ever dispatches and
every check sits there having never reported.

What it runs, at the same cadence as the timers:

| Cadence | Work |
| --- | --- |
| every minute | dispatch due checks, SNMP drift, Outpost work, alert escalation |
| every 5 min | materialise check assignments, discover subnets |
| every 15/30 min | prefix utilisation, hardware health |
| daily | ACME renewal, retention, stale-IP cleanup, link check, certificate expiry, digest |

`manage.py run_scheduler --list` prints the table. Auto-upgrade is the one timer
a container does **not** run: the image is the unit of upgrade, so you deploy a
new tag instead.

Occurrences are claimed in Redis, so restarting the container will not re-send
this morning's digest and a second replica cannot double-send it. Keep it to one
replica anyway - it buys nothing.

To run one pass by hand (a cron-driven install, or when debugging):

```bash
docker compose -f docker-compose.prod.yml exec scheduler python manage.py run_scheduler --once
```

### ICMP

The worker container sets `net.ipv4.ping_group_range` so the ICMP monitor's
unprivileged pings work - `icmplib` opens datagram sockets, which is cheaper
than running as root or granting `NET_RAW`. Podman honours the sysctl too.

!!! warning "Unprivileged LXC containers cannot set this"
    Inside an unprivileged LXC (Proxmox and friends), writing
    `net.ipv4.ping_group_range` fails with `EIO` even in the container's own
    network namespace, so Docker refuses to start the worker or the sysctl
    silently does not apply. ICMP checks then report **unknown** rather than
    up/down, because the socket cannot be opened at all. Run the Docker host in
    a privileged LXC or on a VM/bare metal, or use a TCP/HTTP check instead of
    ICMP for those targets.

`web` listens on **:80** (`HTTP_PORT`, default 8080) and **:443**
(`HTTPS_PORT`, default 8443) with a **self-signed** cert baked into the image -
so browsers that force HTTPS still connect (one-time cert warning). Put a real
TLS terminator in front for production and set `DANBYTE_HTTPS=True`.

## Environment

All configuration is in `.env` (see `deploy/docker/.env.example` for the full,
commented list). The essentials:

| Variable | Purpose |
| --- | --- |
| `DJANGO_SECRET_KEY` | Django secret; unique per deployment. |
| `MONITORING_SECRET_KEY` | Encrypts stored credentials; **required** with `DEBUG=False`, never change once secrets are stored. |
| `DB_PASSWORD` | Postgres password (db + app). |
| `ALLOWED_HOSTS` | Hosts/IPs served (no scheme/port). |
| `CSRF_TRUSTED_ORIGINS` | Origins allowed to POST (scheme + host [+ port]). |
| `DANBYTE_HTTPS` | `True` when TLS terminates in front - enables secure cookies + HSTS. |
| `HTTP_PORT` | Published host port (default `8080`). |
| `RQ_WORKERS` | Worker pool size. |

## TLS

The `web` container speaks plain HTTP on `:80` (published as `HTTP_PORT`).
Terminate TLS in front of it - a host reverse proxy, a cloud load balancer, or a
`caddy`/`traefik` sidecar - then set `DANBYTE_HTTPS=True` and add your external
URL to `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS`.

## Upgrading

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

The backend re-runs migrations on start; the named volumes keep your data.
`up -d` also creates services added since your last pull - check that
`scheduler` is among them, because a stack upgraded from before it existed has
never run any periodic work:

```bash
docker compose -f docker-compose.prod.yml ps scheduler
```

## Podman specifics

The stack is rootless-friendly and works with `podman-compose`. A few notes:

- **Rootless ports < 1024**: a non-root Podman can't bind `:80`/`:443`. Keep the
  default `HTTP_PORT=8080` (or higher) and front it with a host proxy.
- **SELinux volumes**: on SELinux hosts, if a bind mount is ever added, append
  `:Z`. The stack uses **named** volumes, which Podman labels automatically - no
  change needed.
- **`podman play kube`**: `podman-compose` is the simplest path; if you prefer
  Kubernetes YAML, generate it from the running pod with
  `podman generate kube`.

## Prebuilt images (ghcr.io)

Tagging a release (`v*`) publishes the three images to **GitHub Container
Registry** via `.github/workflows/container.yml`:

```
ghcr.io/danbyte-net/danbyte-app:<version>       # gunicorn / daphne / workers
ghcr.io/danbyte-net/danbyte-web:<version>       # nginx + TLS
ghcr.io/danbyte-net/danbyte-frontend:<version>  # vite preview (SSR)
```

To run from the registry instead of building locally, set the `image:` fields
in `docker-compose.prod.yml` to the ghcr paths (and drop the `build:` blocks),
or keep a small override file. `latest` tracks the newest release.

!!! info "Where to host"
    **ghcr.io** is the default - it ships with the GitHub repo, authenticates
    with the built-in `GITHUB_TOKEN`, and is free for public images (make the
    package public in the repo's *Packages* settings). Docker Hub, Quay, or a
    self-hosted **Harbor** work identically - change the `registry`/image
    prefix in the workflow. For fully **air-gapped** installs, prefer the
    offline tarball from the [release workflow](upgrading.md) over a registry.

## Development

For a lightweight dev backend (auto-reload, `DEBUG=True`, source bind-mounted,
no nginx/frontend container) use `docker-compose.dev.yml` instead - see the
[Dev workflow](dev-workflow.md).
