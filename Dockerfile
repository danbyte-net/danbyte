# syntax=docker/dockerfile:1
#
# Production image for Danbyte, built in stages:
#   frontend  - Node builds the React SPA (frontend/dist)
#   web       - nginx serving that SPA + proxying api/ws/static/media
#   runtime   - Python app (gunicorn WSGI, daphne ASGI/WS, rq workers)
#
# `runtime` is last so a bare `docker build .` yields the app image; the compose
# files pick the stage per service via `target:`. See docs/getting-started/docker.md
# and docker-compose.prod.yml. The dev stack (docker-compose.dev.yml) reuses the
# `runtime` stage and just overrides the command to `runserver`.

# ─── 1. Build the SPA ────────────────────────────────────────────────────────
FROM docker.io/library/node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ─── 2. nginx: reverse-proxy the SPA server + backend, with self-signed TLS ───
# The SPA is a TanStack Start SSR build (no static index.html), so nginx proxies
# `/` to the `frontend` service (vite preview) rather than serving files. A
# self-signed cert is baked in so browsers that force HTTPS still connect (they
# show a one-time warning); terminate real TLS in front for production.
FROM docker.io/library/nginx:1.27-alpine AS web
RUN apk add --no-cache openssl \
    && mkdir -p /etc/nginx/tls \
    && openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout /etc/nginx/tls/key.pem -out /etc/nginx/tls/cert.pem \
        -subj "/CN=danbyte" >/dev/null 2>&1
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf

# ─── 3. Python application runtime ───────────────────────────────────────────
FROM docker.io/library/python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Build deps: libldap2/sasl/ssl build python-ldap (django-auth-ldap), libpq-dev
# builds psycopg2. Runtime network tools the monitoring engine + exec-check
# plugins lean on (assume nothing else is present): ping/traceroute/mtr for
# reachability, dnsutils for DNS checks, snmp clients for manual SNMP, fping,
# netcat for TCP probes, curl for the healthcheck. ICMP itself goes through
# icmplib's unprivileged datagram sockets - see the ping_group_range sysctl on
# the workers service in docker-compose.prod.yml.
# WeasyPrint (label-template PDFs) renders via Pango/cairo/GDK-PixBuf - these are
# shared libraries, not pip-installable, so they must be baked into the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential libpq-dev libldap2-dev libsasl2-dev libssl-dev \
        curl iputils-ping traceroute mtr-tiny dnsutils snmp fping \
        netcat-openbsd \
        libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
        libffi8 fonts-dejavu-core \
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
