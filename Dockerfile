#
# Production image for Danbyte, built in stages:
#   frontend  - Node builds the React SPA (frontend/dist)
#   web       - nginx serving that SPA + proxying api/ws/static/media
#   cad-tools - builds LibreDWG's dwg2dxf (DWG floor-plan drawings)
#   runtime   - Python app (gunicorn WSGI, daphne ASGI/WS, rq workers)
#
# `runtime` is last so a bare `docker build .` yields the app image; the compose
# files pick the stage per service via `target:`. See docs/getting-started/docker.md
# and docker-compose.prod.yml. The dev stack (docker-compose.dev.yml) reuses the
# `runtime` stage and just overrides the command to `runserver`.
#
# Base images come from ECR Public's copy of the Docker official images, not
# Docker Hub, which throttles anonymous pulls. BASE_IMAGE_REGISTRY points the
# build at another mirror (the compose files pass it through from .env).
# There is deliberately no `# syntax=` line: it makes BuildKit pull its
# Dockerfile frontend from Docker Hub.
ARG BASE_IMAGE_REGISTRY=public.ecr.aws/docker/library

# ─── 1. Build the SPA ────────────────────────────────────────────────────────
FROM ${BASE_IMAGE_REGISTRY}/node:22-slim AS frontend
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
FROM ${BASE_IMAGE_REGISTRY}/nginx:1.27.5-alpine AS web
RUN apk add --no-cache openssl \
    && mkdir -p /etc/nginx/tls \
    && openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout /etc/nginx/tls/key.pem -out /etc/nginx/tls/cert.pem \
        -subj "/CN=danbyte" >/dev/null 2>&1
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/maintenance.html /usr/share/nginx/maintenance/maintenance.html

# ─── 3. LibreDWG's dwg2dxf, the DWG converter for floor-plan drawings ────────
# Neither Debian trixie nor Ubuntu 26.04 packages LibreDWG, so it is built from
# the GNU release tarball, pinned by version and SHA-256 (the hash of the
# tarball whose GPG signature by the maintainer was checked when pinning).
# Only the library and dwg2dxf are built, statically, so the runtime stage
# copies one binary that needs nothing beyond libc. Same base as `runtime` so
# the glibc matches. LibreDWG is GPLv3; Danbyte runs it as a separate program
# (api/cad_render.py) and does not link it. See docs/features/floor-plans.md.
FROM ${BASE_IMAGE_REGISTRY}/python:3.13-slim AS cad-tools
ARG LIBREDWG_VERSION=0.14
ARG LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
# Any GNU mirror; the checksum still has to match.
ARG GNU_MIRROR=https://ftp.gnu.org/gnu
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config curl ca-certificates \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL -o libredwg.tar.xz \
        "${GNU_MIRROR}/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz" \
    && echo "${LIBREDWG_SHA256}  libredwg.tar.xz" | sha256sum -c - \
    && tar -xJf libredwg.tar.xz --strip-components=1 \
    && ./configure --disable-shared --enable-static --disable-bindings --disable-python \
        --disable-docs --disable-werror \
    && make -C src -j"$(nproc)" \
    && make -C programs dwg2dxf \
    && strip programs/dwg2dxf \
    && install -D -m 0755 programs/dwg2dxf /out/dwg2dxf \
    && install -D -m 0644 COPYING /out/LICENSE.libredwg

# ─── 4. Python application runtime ───────────────────────────────────────────
FROM ${BASE_IMAGE_REGISTRY}/python:3.13-slim AS runtime
# Marks this as the container deployment: in-app self-upgrade is refused here
# (a process in a container can't rebuild its image or recreate itself), and
# the Updates page points to `docker compose build` instead. See core/version.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DANBYTE_DEPLOYMENT=docker

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
# postgresql-client-17 (from PGDG, the distro's client is older) gives the
# in-app backup its pg_dump/pg_restore; pg_dump must be at least the server's
# major version, so bump it together with the postgres image in compose.
# bubblewrap adds namespaces around sandboxed scripts when the container's
# seccomp and AppArmor profiles allow user namespaces; otherwise scripts run
# under Landlock alone and their logs say so (docs/features/scripts.md).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential libpq-dev libldap2-dev libsasl2-dev libssl-dev \
        curl iputils-ping traceroute mtr-tiny dnsutils snmp fping \
        netcat-openbsd bubblewrap \
        libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
        libffi8 fonts-dejavu-core \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc]" \
        "https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=cad-tools /out/dwg2dxf /usr/local/bin/dwg2dxf
COPY --from=cad-tools /out/LICENSE.libredwg /usr/share/doc/libredwg/COPYING
ENV DANBYTE_CAD_CONVERTER=/usr/local/bin/dwg2dxf

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Non-root: run as an unprivileged user owning the app + the static/media dirs
# collectstatic and uploads write to (shared volumes in compose).
RUN useradd -m -u 10001 danbyte \
    && mkdir -p /app/staticfiles /app/media /app/backup-archives \
    && chown -R danbyte:danbyte /app
USER danbyte

ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
# Default = the HTTP/WSGI server; ws/workers override this in compose.
CMD ["gunicorn", "danbyte.wsgi:application", "--config", "deploy/gunicorn.conf.py"]
