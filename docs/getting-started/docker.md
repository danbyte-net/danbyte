---
icon: lucide/container
---

# Deploy with Docker / Podman

Danbyte ships a production container stack — Postgres, Redis, the Django backend
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

Edit `.env` — at minimum set the two secrets and the DB password. Generate each
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
| `ws`       | app (`runtime`)      | daphne ASGI — WebSockets only                    |
| `workers`  | app (`runtime`)      | `rqworker-pool` (`RQ_WORKERS` processes; ICMP-capable) |
| `frontend` | node (`frontend`)    | the SPA server (`vite preview`) — SSR build      |
| `web`      | nginx (`web`)        | proxies the SPA + `/api` `/ws`, serves `/static` `/media`; HTTP :80 + HTTPS :443 |

WebSockets run as a **separate daphne process**, never channels-in-`runserver` —
putting ASGI in front of all HTTP wedges plain requests. The frontend is a
TanStack Start **SSR** build, so `web` proxies `/` to the `frontend` node server
rather than serving files. Collected static and uploaded media live on shared
volumes the backend writes and nginx serves. The worker container sets
`net.ipv4.ping_group_range` so the ICMP monitor's unprivileged pings work.

`web` listens on **:80** (`HTTP_PORT`, default 8080) and **:443**
(`HTTPS_PORT`, default 8443) with a **self-signed** cert baked into the image —
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
| `DANBYTE_HTTPS` | `True` when TLS terminates in front — enables secure cookies + HSTS. |
| `HTTP_PORT` | Published host port (default `8080`). |
| `RQ_WORKERS` | Worker pool size. |

## TLS

The `web` container speaks plain HTTP on `:80` (published as `HTTP_PORT`).
Terminate TLS in front of it — a host reverse proxy, a cloud load balancer, or a
`caddy`/`traefik` sidecar — then set `DANBYTE_HTTPS=True` and add your external
URL to `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS`.

## Upgrading

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

The backend re-runs migrations on start; the named volumes keep your data.

## Podman specifics

The stack is rootless-friendly and works with `podman-compose`. A few notes:

- **Rootless ports < 1024**: a non-root Podman can't bind `:80`/`:443`. Keep the
  default `HTTP_PORT=8080` (or higher) and front it with a host proxy.
- **SELinux volumes**: on SELinux hosts, if a bind mount is ever added, append
  `:Z`. The stack uses **named** volumes, which Podman labels automatically — no
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
    **ghcr.io** is the default — it ships with the GitHub repo, authenticates
    with the built-in `GITHUB_TOKEN`, and is free for public images (make the
    package public in the repo's *Packages* settings). Docker Hub, Quay, or a
    self-hosted **Harbor** work identically — change the `registry`/image
    prefix in the workflow. For fully **air-gapped** installs, prefer the
    offline tarball from the [release workflow](upgrading.md) over a registry.

## Development

For a lightweight dev backend (auto-reload, `DEBUG=True`, source bind-mounted,
no nginx/frontend container) use `docker-compose.dev.yml` instead — see the
[Dev workflow](dev-workflow.md).
