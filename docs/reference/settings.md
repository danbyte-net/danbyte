---
icon: lucide/settings-2
---

# Settings

All settings live in `danbyte/settings.py`. Most are driven by env vars with
sensible dev defaults.

## Database (Postgres-only)

```python
DATABASES["default"] = {
    "ENGINE":   "django.db.backends.postgresql",
    "NAME":     os.getenv("DB_NAME", "danbyte"),
    "USER":     os.getenv("DB_USER", "danbyte"),
    "PASSWORD": os.getenv("DB_PASSWORD", "danbyte"),
    "HOST":     os.getenv("DB_HOST", "127.0.0.1"),
    "PORT":     os.getenv("DB_PORT", "5432"),
    "OPTIONS":  {"connect_timeout": 10, "options": "-c jit=off"},
}
```

SQLite is no longer supported. Postgres 15+ is required for the
`nulls_distinct=False` unique constraint that makes the VRF model work.

### JIT

Danbyte turns PostgreSQL's JIT compiler off for its own connections
(`-c jit=off` in the connection options). Its queries are short OLTP queries,
and JIT only costs time there: the full Devices list crossed `jit_above_cost`
and Postgres spent about 4 seconds compiling it on every request, against
0.15 s running it. The distro packages and the official `postgres` image both
ship with JIT on, so this applies to bundled, Docker and external databases
alike. Only Danbyte's sessions change; nothing is set on the server.

A connection pooler such as PgBouncer can refuse the `options` startup
parameter. Set `DB_JIT=on` in `.env` to leave it out (and the server's JIT
setting in force), or turn JIT off on the server instead:

```sql
ALTER DATABASE danbyte SET jit = off;
```

### Persistent connections

The gunicorn web app keeps each worker's database connection open for
`DB_CONN_MAX_AGE` seconds (default `60`) instead of opening and
authenticating a new one per request; on a small API call that was most of
the cost (p50 20 ms → 7 ms on a local database). `CONN_HEALTH_CHECKS` is on,
so a connection the server dropped is replaced before a request uses it.
`DB_CONN_MAX_AGE=0` restores a connection per request.

Only the WSGI app does this: `danbyte/wsgi.py` marks the process before
settings load. daphne (WebSockets), `runserver`, the RQ workers and
management commands keep `0`.

Size `max_connections` (Postgres default `100`) for every process that holds
one at a time:

```
gunicorn workers (WEB_CONCURRENCY, default ≤ 8)
+ RQ workers (danbyte-workers and danbyte-fastlane, one per worker process)
+ daphne (one per open request it serves)
+ timers and management commands running at the same moment
+ headroom for psql, backups and upgrades (10 or so)
```

A connection that stays open is idle between requests, so persistent
connections do not raise the peak: each gunicorn worker held one while it
served a request before too. With a pooler (PgBouncer in transaction mode)
in front, the pooler's own limits apply instead.

### Tuning PostgreSQL

The installer leaves the distribution's PostgreSQL defaults in place:
`shared_buffers = 128MB` and `work_mem = 4MB`, sized for a small shared
host. Danbyte runs on whatever the server is configured with, but a large
tenant (thousands of devices, tens of thousands of interfaces and addresses)
reads its lists and roll-ups faster with more memory. Nothing in Danbyte sets
these; they belong to the host, so set them in `postgresql.conf` (or a file in
`conf.d/`) and restart PostgreSQL.

A starting point for a host that runs Danbyte and its database together:

| Setting | Starting value | Why |
|---|---|---|
| `shared_buffers` | 25 % of RAM (e.g. `2GB` on 8 GB) | Keeps the hot tables and indexes in PostgreSQL's own cache |
| `effective_cache_size` | 50-75 % of RAM | Tells the planner how much the OS caches too; indexes are chosen more readily |
| `work_mem` | `16MB`-`32MB` | Per sort or hash per query; the natural-sort lists and facet counts sort in memory instead of on disk. Multiplied by concurrent queries, so stay modest |
| `maintenance_work_mem` | `256MB` | Faster `VACUUM`, index builds and upgrade migrations |
| `random_page_cost` | `1.1` on SSD/NVMe | The default `4` assumes spinning disks and steers the planner away from indexes |
| `max_connections` | see [Persistent connections](#persistent-connections) | Every web worker, RQ worker and daphne holds one |

Check what a running server uses with `SHOW shared_buffers;` (and so on) in
`psql`. On a container install, pass the settings as `command:` arguments to
the `postgres` service (`postgres -c shared_buffers=2GB -c work_mem=16MB`).

#### Finding slow queries with `pg_stat_statements`

`pg_stat_statements` records every statement's call count and time, which is
the quickest way to see what a slow page costs the database. It ships with
PostgreSQL (the `postgresql-contrib` package on older distributions) and needs
a restart to load:

```ini
# postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
```

Then create the extension as a superuser in the **`postgres`** database, not
in Danbyte's: it records statements from every database either way, and kept
out of Danbyte's database it never ends up in a Danbyte backup. A restore runs
as the `danbyte` role, which may not create the extension, so a backup that
carries it would fail to restore.

```bash
sudo -u postgres psql -d postgres
```

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- The ten Danbyte statements that took the most time in total.
SELECT round(total_exec_time) AS ms, calls, round(mean_exec_time, 1) AS mean_ms,
       left(query, 120) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'danbyte')
ORDER BY total_exec_time DESC
LIMIT 10;

-- Start a fresh measurement.
SELECT pg_stat_statements_reset();
```

The extension is optional: no migration creates or needs it. Its cost is
small (a few percent of CPU on a busy server); turn it off again by removing
it from `shared_preload_libraries`.

## CORS

```python
CORS_ALLOWED_ORIGINS = os.getenv(
    "CORS_ALLOWED_ORIGINS", "http://localhost:3000"
).split(",")
CORS_EXPOSE_HEADERS = ["X-Danbyte-Unknown-Params", "Warning"]
```

A cross-origin client can read the two headers a list sets for query
parameters it ignored ([REST API](api.md#unknown-query-parameters)).

## DRF

The API is **default-closed**: a view with no explicit `permission_classes`
requires authentication, so the next forgotten viewset isn't world-open.
Intentionally-public endpoints (the share-link resolve) opt in with `AllowAny`
explicitly. Authentication is session cookie (SPA) or a scoped API token; there
is no JWT (it was dead surface with weak defaults).

JSON responses go through `api.renderers.FastJSONRenderer`. It renders with
`orjson` when that package is installed and with DRF's own `JSONRenderer`
otherwise, and both write the same bytes (dates, decimals, UUIDs and IP
objects through DRF's encoder; `?indent=` and anything `orjson` refuses fall
back to the standard renderer). `orjson` is not a requirement yet, so a
normal install renders exactly as before.

```python
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "auth_api.token_auth.ApiTokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_PAGINATION_CLASS": "api.pagination.StandardResultsSetPagination",
    "PAGE_SIZE": API_PAGE_SIZE,  # 100
}
```

A list request without `?page_size=` answers one page of `API_PAGE_SIZE`
rows with a `next` link. A caller that wants more names it with
`?page_size=`, up to `API_MAX_PAGE_SIZE`; a larger value is cut to the cap,
so `?page_size=` can't force an amplified, memory-heavy response. The
default is small because serializing 10,000 rows held a gunicorn worker for
seconds, and the cap is 2,000 because a handful of 10,000-row pages still
held every worker (see [Pagination](api.md#pagination)).

A request whose `page_size` is above `API_LARGE_PAGE_THRESHOLD` (1,000, the
most the web app asks for in one request) is a large page. One user may have
`API_LARGE_PAGE_CONCURRENCY` of them in flight, counted across the session
and every API token they own, so more tokens buy no more large pages; the
next answers `429` with `Retry-After` until one finishes. Each
large page holds a slot in Redis (the cache) with a two-minute expiry and
gives it back when the response is built, so a worker killed mid-request
frees its slot anyway. If Redis can't be reached the guard lets requests
through rather than refusing them.

| Setting | Env var | Default | Purpose |
|---|---|---|---|
| `API_PAGE_SIZE` | `API_PAGE_SIZE` | `100` | Rows a list answers when the request names no `page_size`. A positive whole number. |
| `API_MAX_PAGE_SIZE` | `API_MAX_PAGE_SIZE` | `2000` | The most rows `?page_size=` can ask for in one response. A positive whole number, at least `API_PAGE_SIZE`; unset, it is 2,000 or `API_PAGE_SIZE` if that is larger. |
| `API_LARGE_PAGE_THRESHOLD` | `API_LARGE_PAGE_THRESHOLD` | `1000` | A request whose `page_size` is above this is a large page. A positive whole number between `API_PAGE_SIZE` and `API_MAX_PAGE_SIZE`; unset, it is 1,000 kept within those two. |
| `API_LARGE_PAGE_CONCURRENCY` | `API_LARGE_PAGE_CONCURRENCY` | `2` | Large pages one user, all of their tokens together, may have in flight at once. A positive whole number. |
| `API_MAX_TOKENS_PER_USER` | `API_MAX_TOKENS_PER_USER` | `25` | Unexpired API tokens one user may hold. Creating one more answers 400 until one is revoked or expires; tokens a script run mints don't count. A positive whole number. |
| `API_STRICT_QUERY_PARAMS` | `API_STRICT_QUERY_PARAMS` | off | A query parameter a list does not understand answers `400` instead of an `X-Danbyte-Unknown-Params` header. `1`/`true`/`yes`/`on` turns it on; a request can still send `?strict=0`. Off in 0.19; the default becomes on in 0.20 ([REST API](api.md#unknown-query-parameters)). |

A value that is not a positive whole number, a cap below the default page,
or a threshold outside the default page and the cap stops the service at start with an error naming the setting, rather than
serving something other than what was configured. Set them in the service
environment (`.env`, or the unit's `Environment=`) and restart the web
service.

The web app asks for what it needs: a table, picker or map that filters
in the browser walks the pages, 1,000 rows a request up to 10,000, so it
never asks for a large page (a read that is answered `429` is retried after
its `Retry-After`), and a
list page whose tenant holds more says so rather than looking complete (see
[Very long lists](../features/table-preferences.md#very-long-lists)).

## Application flow requirements

An [application flow requirement](../features/application-flows.md#requirements)
can mean thousands of generated flows. The requirement dialog's preview
warns above `FLOW_REQUIREMENT_WARN_PAIRS` flows, and a requirement that
resolves to more than `FLOW_REQUIREMENT_MAX_PAIRS` is refused: it reads
*Unresolved* and writes nothing until it is narrowed with pairing or
address, or this is raised.

| Setting | Env var | Default | Purpose |
|---|---|---|---|
| `FLOW_REQUIREMENT_WARN_PAIRS` | `FLOW_REQUIREMENT_WARN_PAIRS` | `500` | The preview warns above this many generated flows for one requirement. A positive whole number. |
| `FLOW_REQUIREMENT_MAX_PAIRS` | `FLOW_REQUIREMENT_MAX_PAIRS` | `5000` | A requirement resolving to more flows is refused. A positive whole number, at least the warning. |

A value that is not a positive whole number, or a cap below the warning,
stops the service at start with an error naming the setting. Set them in
the service environment (`.env`, or the unit's `Environment=`) and restart
the web service and the workers.

## DEBUG (default-closed)

`DEBUG` defaults to **`False`** - production must not accidentally run in debug
(tracebacks leak source/settings and `ALLOWED_HOSTS` is bypassed). Development
sets `DEBUG=True` explicitly in `.env`. With `DEBUG` off the app also refuses to
start on the shared dev `DJANGO_SECRET_KEY` or a missing `MONITORING_SECRET_KEY`
(see [Secrets](#secrets)).

`DEBUG` controls **only** debug behaviour (tracebacks, `ALLOWED_HOSTS`). It does
**not** decide whether cookies are TLS-only - that's `DANBYTE_HTTPS` below.

## TLS / transport hardening (`DANBYTE_HTTPS`)

```text
Environment=DANBYTE_HTTPS=True
```

Set this when the deployment really is served over **TLS**. It turns on the
app-level backstop: `Secure` session + CSRF cookies, HSTS, and an http→https
redirect. Defaults to **`False`**.

!!! warning "Don't enable it without TLS"
    A `Secure` cookie set over a plain-`http://` origin is **discarded by the
    browser**. The login POST succeeds, the session cookie is dropped, the next
    request is anonymous - so the app bounces straight back to the login form
    **with no error message**. If login silently loops, check this setting first.

This is deliberately independent of `DEBUG`: tying transport requirements to the
debug flag means changing the `DEBUG` default silently locks every plain-http
install out of login. `scripts/install.sh` configures nginx + TLS and writes
`DANBYTE_HTTPS=True` into `.env` (and backfills it on upgrade), so
installer-managed hosts stay hardened. Behind the shipped nginx, nginx sends
HSTS for every upstream and drops Django's copy (see
[Security headers](#security-headers)).

## Static

`STATICFILES_DIRS` includes `design/`, so the mockup `theme.js` and
`tokens.css` are served at `/static/theme.js` and `/static/tokens.css` - used
by `_shell.html`.

## Hosts

`ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS` are set in `.env` (see
`.env.example`), never in a unit file in the repo. The dev unit
`services/danbyte-backend.service` carries no hosts or credentials and
listens on `127.0.0.1:8000`; Vite on `:3000` proxies to it.

```text
ALLOWED_HOSTS=localhost,127.0.0.1,<your-vpn-fqdn>,<your-vpn-ip>
```

## Backups (`DANBYTE_BACKUP_DIR`, `DANBYTE_SKIP_BACKUP`)

`DANBYTE_BACKUP_DIR` is where the default local backup target and the
restore work directory live. Default: `<install>/../danbyte-backups` on
systemd installs, `/app/backups` in the container stack. The directory is
created on the first backup, mode `0700`.

`DANBYTE_SKIP_BACKUP=1` lets the upgrade scripts continue without the
**Before upgrade** backup (they stop otherwise when the backup fails or
`pg_dump` is missing). See [Backup and restore](../getting-started/backup-restore.md).

## Scripts (`DANBYTE_SCRIPT_SANDBOX`)

`DANBYTE_SCRIPT_SANDBOX` sets how sandboxed [scripts](../features/scripts.md)
are confined:

- `auto`, the default: bubblewrap namespaces around Landlock where `bwrap`
  works, Landlock alone where it does not. The run log says which.
- `bwrap`: bubblewrap around Landlock, and a run is refused when `bwrap`
  cannot run.
- `landlock`: Landlock alone, as in 0.17. Scripts keep the host network,
  so they can reach devices directly.
- `none`: unconfined, and each run log says so. Use it only on a host
  without Landlock, knowing a script author can then read what the service
  account can, including `.env`.

Every value except `none` refuses a run the host cannot Landlock. An
unknown value means `auto`. Under bubblewrap a script has no network but
the API. What each level blocks is in
[Scripts](../features/scripts.md#what-a-sandboxed-script-cannot-do).
Trusted scripts are never confined.

`DANBYTE_INTERNAL_URL` is where a script's SDK reaches the API. Default:
`http://127.0.0.1:8000`. When set, its host is added to `ALLOWED_HOSTS` so the
backend answers to it; WebSocket origins and the site's public name keep to
the `ALLOWED_HOSTS` you set. The Docker stack sets it to `http://backend:8000`.

## Device 3D models (`DEVICE_MODEL_MAX_BYTES`)

`DEVICE_MODEL_MAX_BYTES` is the largest
[3D model](../dcim/device-catalog.md#3d-models) a device type or device
takes, in bytes. The default is `26214400` (25 MB); a larger upload is
refused with the limit in the message. Keep it under the web server's
`client_max_body_size` (512 MB in the shipped nginx templates).

## Vulnerability data uploads (`DANBYTE_VULN_IMPORT_MAX_BYTES`)

`DANBYTE_VULN_IMPORT_MAX_BYTES` is the largest file a deployment admin may
upload as [vulnerability data](../features/vulnerabilities.md#upload-airgapped-installs)
(NVD feeds, OSV archives, Microsoft's monthly CVRF documents, KEV, EPSS), in bytes. The default is `536870912`
(512 MB), which is also the shipped nginx `client_max_body_size`; raise both
together. The unpacked-content, record and archive limits are fixed and listed
on the feature page. Uploads wait in `MEDIA_ROOT/vuln-imports/` until their
job has parsed them, then are deleted; the folder is not served under
`/media/`.

## PDF reports (`DANBYTE_REPORT_JOB_TIMEOUT`)

A [PDF report](../features/reports.md) too large to render within a request
renders in the background, as a job on the `low` queue.
`DANBYTE_REPORT_JOB_TIMEOUT` is that render's deadline in seconds (default
`300`); a report estimated past about 70% of it is refused.
`DANBYTE_REPORT_JOB_KEEP` is how long the finished PDF is kept for the user
who asked for it, in seconds (default `3600`).

## CAD drawings (`DANBYTE_CAD_CONVERTER`)

`DANBYTE_CAD_CONVERTER` is the absolute path of the program that turns a DWG
into DXF for [floor-plan CAD drawings](../features/floor-plans.md#cad-drawings).
DXF needs nothing.

Default (unset or empty): `vendor/cad/bin/dwg2dxf` in the app directory, the
static LibreDWG build the release bundle installs (or `make cad-tools`
builds), when it is there and executable. Without it, DWG uploads are refused
with the steps to save the drawing as DXF instead. An explicit path always
wins; `off` refuses DWG even with the bundled converter present. The value is
resolved when the services start, so restart them after adding a converter.

Two programs are accepted, by file name:

- `dwg2dxf` from LibreDWG (GPLv3; Debian and Ubuntu do not package it). The
  release bundle ships it, see
  [Installation](../getting-started/installation.md#dwg-converter); the Docker
  image builds the same and sets `DANBYTE_CAD_CONVERTER=/usr/local/bin/dwg2dxf`.
- `ODAFileConverter`, the ODA File Converter (free download from the Open
  Design Alliance; not redistributable, so never bundled). It runs with
  `QT_QPA_PLATFORM=offscreen`.

Anything else, a relative path, a missing or non-executable file, or one
writable by everyone is refused. The converter runs on the worker host only,
in the sandbox below, without a shell, with a scrubbed environment, a
5-minute timeout and memory and output-size limits; its DXF may be at most
256 MB. The setting is read from the environment only, never from the UI, and
is kept in a configuration backup.

### Converter sandbox (`DANBYTE_CAD_SANDBOX`)

The converter parses files anyone with change rights on a floor plan can
upload, so it runs in a [bubblewrap](https://github.com/containers/bubblewrap)
sandbox, the same one [scripts](../features/scripts.md#what-a-sandboxed-script-cannot-do)
use:

- its own user (`nobody` inside), pid, ipc, uts and network namespaces: no
  network at all, not even loopback to the database or Redis, and no other
  process to see or signal;
- a read-only root that holds only the converter, the uploaded DWG
  (read-only) and one output directory, the only place it can write. No
  Danbyte directory, `.env`, media, home directories, `/proc` or `/sys`;
- no capabilities, `no_new_privs`, and Danbyte's seccomp filter that refuses
  unix sockets.

The bundled `dwg2dxf` is static, so that is all it sees. A dynamically linked
converter also sees the system directories (`/usr`, `/lib`, name and font
configuration) and its own install directory, read-only; a converter whose
directory contains the Danbyte directory is refused. The ODA File Converter
additionally gets a `/proc` of its own sandbox and an empty private `/tmp`,
which Qt needs; Danbyte does not test ODA in the sandbox.

`DANBYTE_CAD_SANDBOX` takes two values:

- `bwrap`, the default: the converter always runs in the sandbox. A host
  where `bwrap` is missing or cannot create user namespaces (kernel, AppArmor,
  or a container's seccomp profile) refuses DWG uploads, and the upload form
  and `GET /api/floor-plans/drawing-support/` say why. DXF is unaffected.
- `off`: the converter runs without the sandbox, under the limits alone,
  with the service account's files and network. A hostile DWG that exploits
  a converter bug then runs with the rights of the worker that holds the
  database credentials and the secret keys. Set it only if you accept that,
  for example to run an operator-chosen converter that fails in the sandbox.

Any other value means `bwrap`. The ezdxf reader that renders the DXF is pure
Python and runs in its own process under the same limits, outside the
sandbox.

## Outbound requests (SSRF guard)

User-configured outbound URLs - webhooks, notification channels, automation
targets, device-type import URLs, virtualization sources (Proxmox, vCenter,
Cloud Director), Windows server connections, a public assistant provider, the
[end-of-life data](../features/end-of-life-data.md) source, the
[vulnerability data](../features/vulnerabilities.md#server-mode) services and
mirrors (NVD, OSV, Microsoft's MSRC CVRF API, CISA KEV, FIRST EPSS), and
**per-tenant** SMTP/LDAP hosts - are
validated before each request: the host is resolved and rejected if it points at
a loopback / RFC1918 / link-local / `169.254.0.0/16` (cloud metadata) / ULA /
reserved address. This stops a tenant admin pointing a webhook (or a tenant SMTP
relay) at internal services and reading the response back - critical for the
cloud-hosted, multi-tenant deployments.

The guard is **DNS-rebinding safe**: the resolved public IP is pinned for the
actual connection (with SNI/`Host` preserved for TLS), so a hostname that
resolves public on the first lookup can't be swapped to `169.254.169.254` on the
connect. Redirects are never followed: a `3xx` answer is an error, so a host
that passes the check cannot bounce the request to an internal address. When an
outbound proxy is set, `NO_PROXY` is matched against the configured hostname,
not the pinned IP. WinRM and the vCenter SOAP connection (host hardware) are
pinned the same way, with TLS verified against the configured hostname.
Operator-configured *deployment*-wide SMTP/LDAP hosts are trusted and
not guarded (an operator may legitimately point them at an internal relay); only
tenant-supplied hosts are checked. The SSO identity provider (OIDC issuer and
the endpoints its discovery document names, SAML metadata URL) is set by a
deployment admin and stays allowed on a private address, but each discovery
that resolves to one logs a warning on `danbyte.sso`; allow-listed addresses do
not warn.

If you *need* an internal target (e.g. an on-prem automation runner like the
[IaC runner](../features/iac-runner.md)), allow-list its address(es):

```text
Environment=DANBYTE_SSRF_ALLOWLIST=192.168.0.0/24,10.1.2.3
```

Comma-separated CIDRs/IPs whose resolved addresses are permitted. Empty by
default (all internal addresses blocked).

### Check-engine targets (central-runner SSRF)

The monitoring check engine runs both on remote **outpost agents** (deployed
inside a network to monitor internal hosts - reaching loopback/RFC1918 is the
point) and in the **central server** (where a tenant-defined check target of
`127.0.0.1` or an RFC1918 neighbour is an SSRF oracle onto internal services).
The cloud-metadata endpoint (`169.254.0.0/16`) and the unspecified address are
refused everywhere. To also refuse loopback / RFC1918 / reserved targets on the
central runner - the posture for a **cloud, multi-tenant** deployment - set:

```text
Environment=DANBYTE_CHECK_BLOCK_INTERNAL=True
```

Default `False`, so a self-hosted deployment that monitors its own LAN from the
central box is unaffected. `DANBYTE_SSRF_ALLOWLIST` (above) also exempts its
CIDRs from this block. Outpost agents keep the permissive default regardless.

## Discovery

[Built-in discovery](../features/discovery.md) logs in to a tenant's hosts
and reads their installed packages. It is off unless this deployment allows
it **and** a tenant admin turns the Discovery integration on. With
`DANBYTE_DISCOVERY_ENABLED` unset, a deployment admin allows it on the
Discovery card under Settings → Integrations (stored, change-logged, off by
default).

| Setting | Default | Purpose |
|---|---|---|
| `DANBYTE_DISCOVERY_ENABLED` | unset | Locks the deployment switch for discovery. Unset or empty: the switch is the stored setting on the Discovery card (off by default). `True` (`true`, `1`, `yes`, `on`): locked on. Any other value, `False` included: locked off, and nothing can enable it. Set it in the environment of the web, worker and timer units, then restart them. With the switch off nothing is contacted, the pages and API answer not found and package matches resolve. |
| `DANBYTE_DISCOVERY_WINRM_ALLOWED` | `True` | `False` (`0`, `no`, `off`) forbids discovery's WinRM transport for every tenant; the Discovery card shows *Forbidden by the deployment*. |
| `DANBYTE_DISCOVERY_WINRM_CA_BUNDLE` | system bundle | CA bundle (PEM file) WinRM server certificates are verified against. Point it at a bundle with your internal CA. |
| `DANBYTE_DISCOVERY_ALLOW_FIRST_USE_KEYS` | `True` | Whether **Run now** may offer *Accept new host keys* (trust a host's SSH key the first time it is seen). `False`, `0`, `no` or `off` hides the option everywhere and the API refuses it; scheduled runs never use it either way. |

Runs go to the RQ queue `discovery` (`RQ_QUEUES`, timeout 6 h); the shipped
`danbyte-workers` unit and compose file listen on it. The check-engine
target policy above (`DANBYTE_CHECK_BLOCK_INTERNAL`, `DANBYTE_SSRF_ALLOWLIST`)
applies to every host discovery logs in to from the server.

## Security headers

Response hardening is applied at the **nginx** edge (see
`deploy/nginx/danbyte.prod.conf.template`), so it covers the SPA, API, and docs
uniformly and survives an app restart:

- `server_tokens off` - no nginx version banner.
- **HSTS** - `max-age=31536000; includeSubDomains`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (also
  enforced by Django's `SECURE_CONTENT_TYPE_NOSNIFF` / `X_FRAME_OPTIONS`), and
  `frame-ancestors 'self'` in the CSP. Other sites can't frame Danbyte; the
  topology report draws each saved view in a hidden frame of the map page,
  which needs the same origin to be allowed. A site you manage yourself
  with `DENY` or `frame-ancestors 'none'` leaves that report at *Drawing…*.
- `Referrer-Policy: same-origin`, a restrictive `Permissions-Policy`, and
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`.
- An **enforced Content-Security-Policy** with `report-uri /api/csp-report/`.
  `connect-src` allows `raw.githubusercontent.com` and `api.github.com` so the
  device-type import's *Fetch with my browser* option works, and
  `vector.openstreetmap.org` for the Site map's default vector tiles
  (a different vector source in **Settings → Site map → Basemap** needs its
  host added here by hand). `worker-src 'self' blob:` lets MapLibre run its
  bundled tile worker. Everything else stays same-origin.
  The SPA loads only same-origin bundled assets (no external scripts/styles/
  fonts, no `eval`, one bundled web worker; the presence WebSocket is same-origin), so
  the policy doesn't block anything it serves. `'unsafe-inline'` is still
  permitted for the SSR hydration + chart `<style>` injection - the next
  hardening step is a nonce-based `script-src` (needs SSR nonce plumbing). Any
  real-browser violation is POSTed to `/api/csp-report/` and logged to the
  `danbyte.csp` logger, so tightening the policy later is observable rather than
  a silent breakage. The report endpoint is unauthenticated + CSRF-exempt (the
  browser sends no cookie/token) and only logs.

Django-side, `SECURE_REFERRER_POLICY`, `SECURE_CONTENT_TYPE_NOSNIFF`, and
`X_FRAME_OPTIONS` are set unconditionally (not gated on `DEBUG`) as defence in
depth for any path served without nginx in front, and `DANBYTE_HTTPS=True` adds
the same HSTS value for installs that terminate TLS somewhere else.

**One owner per header.** Behind the shipped nginx configs, nginx owns HSTS,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and
`Cross-Origin-Opener-Policy`: each location drops Django's copy with
`proxy_hide_header` and sends its own, so a browser gets one header with one
value. Without nginx, Django's copy is the only one. The Docker image's nginx
does the same for the headers it sets, and leaves HSTS to the backend
(`DANBYTE_HTTPS`), since it only has a self-signed certificate.

HSTS has no `preload` at either layer. Being on the browsers' preload list is
a decision for whoever owns the domain, and it is hard to undo; add it in your
own proxy if you want it.

**API responses aren't cached.** Every `/api/` response to a signed-in caller
(session or API token) carries `Cache-Control: private, no-store`, so a browser
keeps no copy on disk after sign-out and a shared proxy keeps none at all
(`core.middleware.ApiNoStoreMiddleware`). A view that sets its own
`Cache-Control` keeps it - file downloads, 3D models and thumbnails choose
their own. Anonymous API responses, `/media/`, `/static/` and the hashed
`/assets/` are left to their own headers.

!!! note "Your own nginx"
    A hand-written site that adds these headers needs the same
    `proxy_hide_header` lines in each proxied location (or once at the server
    level, repeated in any location that has its own `proxy_hide_header`).
    Otherwise every Django response carries two copies.

## Logging

Console logging is on by default (`django` at INFO, `rq.worker` at INFO).
Suitable for `journalctl --user -fu danbyte-backend`.

## Password reset (`PASSWORD_RESET_ENABLED`)

`PASSWORD_RESET_ENABLED=true` turns on self-service
[Forgot password?](../features/permissions.md#forgot-password-reset-by-email)
by email. Default: off. Even when on, it is offered only while deployment
email is enabled, the deployment has a mail server of its own (an SMTP host,
or a delivering `EMAIL_BACKEND`) and the public base URL is set: the link is
built from that URL, never from the request's `Host` header.

`PASSWORD_RESET_LINK_TIMEOUT` is how long a reset link works, in seconds
(default `3600`). Invite and administrator-sent links keep Django's
`PASSWORD_RESET_TIMEOUT` (three days); the two kinds of link are not
interchangeable.

The mail is sent by the RQ `default` queue, so it needs `danbyte-workers`
running. Changing your own password (Preferences → Password) needs no
setting.

## Secrets

| Setting | Where it lives | Dev default | Prod |
|---|---|---|---|
| `DJANGO_SECRET_KEY` | env | `dev-key-change-in-prod` | env var, rotated |
| `DB_PASSWORD` | env | `danbyte` | env var, rotated |
| Email creds | **DB (UI)** or env | console backend | Settings → Email (encrypted) |

The `EMAIL_*` env vars remain the fallback, but the SMTP server, credentials,
and outbound-delivery options are normally configured at runtime under
**Settings → Email** (`users.manage`). They live in the
deployment-wide singleton `core.DeploymentSettings`; the SMTP password is
Fernet-encrypted at rest. See
[Notifications](../features/monitoring.md#notifications).

### What the monitoring key protects

`MONITORING_SECRET_KEY` encrypts every `EncryptedJSONField` column - every
credential Danbyte keeps in its own database:

- monitoring: check-template and SNMP-profile secrets, Redfish endpoint
  credentials, monitoring-engine tokens and SSH credentials, the Outpost
  repository token, notification-channel secrets, certificate-issuer secrets,
  and the local secret store (device credentials, CSR/ACME private keys,
  FHRP auth keys);
- integrations: webhook signing secrets, automation-target tokens, NetBox
  import tokens, Windows Server and virtualization-source credentials;
- Zabbix, PRTG and Oxidized connection credentials, and PRTG credentials;
- backup-target credentials;
- the NVD API key for [vulnerability data](../features/vulnerabilities.md#rate-limits-and-retries);
- SSO and LDAP secrets (identity providers, user profiles), and the SMTP and
  LDAP passwords in deployment, tenant and site settings.

It is also the secret [backup archives](../getting-started/backup-restore.md#the-key-rule)
are encrypted under. `DJANGO_SECRET_KEY` (sessions, signed tokens) is separate.

### Rotating the monitoring key

`MONITORING_SECRET_KEY` takes a comma-separated list, newest first. New values
are always encrypted under the first key; every key in the list is tried on
read. To replace a key without losing a stored secret:

1. **Add the new key first** on every process that reads the database - the
   web service, the WebSocket service and every worker
   (`MONITORING_SECRET_KEY=<new>,<old>` in `.env` or the unit's
   `Environment=`) - and restart them all. A process without the new key
   cannot read values written under it, so do all of them before step 2.
2. **Re-encrypt** the stored values under the new key:

    ```bash
    .venv/bin/python manage.py rotate_monitoring_key --dry-run   # counts only
    .venv/bin/python manage.py rotate_monitoring_key
    ```

    `--dry-run` prints, per model and field, how many values would be
    re-encrypted and how many are already current. The real run works in
    batches (`--batch-size`, default 500), one transaction per batch, and
    skips values already under the new key, so it can be stopped and run
    again. It writes one change-log entry for the run (who, when, counts)
    rather than one per row, and never prints a value. A value no configured
    key can open is left as it is and named by model and primary key; the
    command then exits non-zero.
3. **Verify** nothing is left under an older key:

    ```bash
    .venv/bin/python manage.py rotate_monitoring_key --check
    ```

    It exits non-zero while any value still needs an older key.
4. **Remove the old key** from the list on every process and restart them
   again.

Backups made before the rotation are encrypted under the old key: keep a copy
of it for as long as you keep those archives, and put it back in the list
(after the current key) to restore one. **Settings → Security** shows how many
keys are configured, never the keys themselves. A custom
`MONITORING_SECRETS_BACKEND` without rotate support is refused by the command.

## Monitoring

Settings for the [Monitoring / check engine](../features/monitoring.md). All
have working defaults, so the feature runs with none of them set.

| Setting | Default | Purpose |
|---|---|---|
| `MONITORING_SECRET_KEY` | derived from `SECRET_KEY` in DEBUG; **required when `DEBUG=False`** | Encryption key for stored credentials at rest (Fernet) - see [What the monitoring key protects](#what-the-monitoring-key-protects). A dedicated key gives credential encryption an independent lifecycle: rotating `SECRET_KEY` doesn't void stored secrets, and a `SECRET_KEY` leak can't decrypt them. The app refuses to start in production without it. `scripts/install.sh` generates one (and backfills older installs *from* the existing `SECRET_KEY` so already-stored secrets stay decryptable). May be a **comma-separated list, newest first**: the first key encrypts, every key decrypts. An empty entry (a stray comma) or a key listed twice stops the service at start. **Never just replace it once secrets are stored** - old ciphertext becomes unreadable; [rotate it](#rotating-the-monitoring-key) instead. |
| `MONITORING_SECRETS_BACKEND` | empty (Fernet) | Dotted path to a factory returning a `SecretsBackend`. Swap in an external store (OpenBao/Vault) without touching models. |
| `MONITORING_CONCURRENCY` | `100` | Max concurrent check attempts in one worker job's asyncio loop. Raising it needs a matching `LimitNOFILE` bump on the worker unit. |
| `MONITORING_GLOBAL_INTERVAL_SECONDS` | `300` | Default schedule (seconds) for assignments in `follow_global` mode. |
| `MONITORING_GLOBAL_ENABLED` | `True` | Global on/off switch that `follow_global` assignments obey. |
| `MONITORING_SHARD_SIZE` | `2000` | Targets per ICMP multiping shard (one RQ job each). |
| `MONITORING_GENERIC_SHARD_SIZE` | `200` | Targets per TCP/HTTP/… shard. |
| `MONITORING_INFLIGHT_DEADLINE_SECONDS` | `600` | A check claimed (`in_flight`) longer than this is treated as orphaned by a dead/restarted worker and reclaimed by the dispatcher's reaper, so it re-runs instead of being stuck `unknown`. A healthy run clears `in_flight` within seconds. |
| `MONITORING_EXEC_ENABLED` | `False` | Master switch for `exec` (script/plugin) checks. Off by default - running local commands from the UI is privileged. Set `True` **and** `MONITORING_PLUGIN_DIR` to use them. See [Script / exec checks](../features/monitoring.md#check-types). |
| `MONITORING_PLUGIN_DIR` | empty | Directory of trusted Nagios-style plugins. An `exec` check may only run a plugin (by bare name, no path traversal) inside this dir; args are passed without a shell. |
| `MONITORING_WEBHOOK_TIMEOUT` | `5` | Per-channel webhook POST timeout (seconds). |
| `MONITORING_RESULT_RETENTION_DAYS` | `30` | Delete `CheckResult` rows older than this (daily prune). Raw results run ~600k rows/day on a busy install (~2.4 GB heap at 17 days) - raise only with the disk to match; the rolled-up state + transitions carry the long-term story. |
| `MONITORING_TRANSITION_RETENTION_DAYS` | `365` | Delete `StateTransition` rows older than this. Each check's newest change before the cutoff is kept, so a check that has not changed for longer still has its status. |
| `MONITORING_SNMP_SAMPLE_RETENTION_DAYS` | `3` | Delete SNMP interface counter samples (the utilisation sparklines) older than this; the sparklines read only this window. |
| `MONITORING_ROLLUP_HOURLY_RETENTION_DAYS` | `30` | Delete hourly check rollups older than this. Daily rollups are never pruned. See [Rollups](../features/monitoring.md#rollups). |
