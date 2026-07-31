# syntax=docker/dockerfile:1
#
# Production image for Danbyte, built in stages:
#   frontend  — Node builds the React SPA (frontend/dist)
#   web       — nginx serving that SPA + proxying api/ws/static/media
#   runtime   — Python app (gunicorn WSGI, daphne ASGI/WS, rq workers)
#
# `runtime` is last so a bare `docker build .` yields the app image; the compose
# files pick the stage per service via `target:`. See docs/getting-started/docker.md
# and docker-compose.prod.yml. The dev stack (docker-compose.dev.yml) reuses the
# `runtime` stage and just overrides the command to `runserver`.

# ─── 1. Build the SPA ────────────────────────────────────────────────────────
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ─── 2. nginx serving the built SPA + reverse-proxying the backend ────────────
FROM nginx:1.27-alpine AS web
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend /app/frontend/dist /usr/share/nginx/html

# ─── 3. Python application runtime ───────────────────────────────────────────
FROM python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Build deps: libldap2/sasl/ssl build python-ldap (django-auth-ldap), libpq-dev
# builds psycopg2. Runtime network tools the monitoring engine + exec-check
# plugins lean on (assume nothing else is present): ping/traceroute/mtr for
# reachability, dnsutils for DNS checks, snmp clients for manual SNMP, fping,
# netcat for TCP probes, curl for the healthcheck. ICMP itself goes through
# icmplib's unprivileged datagram sockets — see the ping_group_range sysctl on
# the workers service in docker-compose.prod.yml.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential libpq-dev libldap2-dev libsasl2-dev libssl-dev \
        curl iputils-ping traceroute mtr-tiny dnsutils snmp fping \
        netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Non-root: run as an unprivileged user owning the app + the static/media dirs
# collectstatic and uploads write to (shared volumes in compose).
RUN useradd -m -u 10001 danbyte \
    && mkdir -p /app/staticfiles /app/media \
    && chown -R danbyte:danbyte /app
USER danbyte

ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
# Default = the HTTP/WSGI server; ws/workers override this in compose.
CMD ["gunicorn", "danbyte.wsgi:application", "--config", "deploy/gunicorn.conf.py"]
