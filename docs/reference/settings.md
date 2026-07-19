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
}
```

SQLite is no longer supported. Postgres 15+ is required for the
`nulls_distinct=False` unique constraint that makes the VRF model work.

## CORS

```python
CORS_ALLOWED_ORIGINS = os.getenv(
    "CORS_ALLOWED_ORIGINS", "http://localhost:3000"
).split(",")
```

## DRF

The API is **default-closed**: a view with no explicit `permission_classes`
requires authentication, so the next forgotten viewset isn't world-open.
Intentionally-public endpoints (the share-link resolve) opt in with `AllowAny`
explicitly. Authentication is session cookie (SPA) or a scoped API token; there
is no JWT (it was dead surface with weak defaults).

```python
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "auth_api.token_auth.ApiTokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_PAGINATION_CLASS": "api.pagination.StandardResultsSetPagination",
    "PAGE_SIZE": 10000,
}
```

The SPA loads full result sets and filters client-side, so the page size is
high by design; it is capped (`max_page_size = 10000`) so `?page_size=` can't
be used to force an amplified, memory-heavy response.

## DEBUG (default-closed)

`DEBUG` defaults to **`False`** — production must not accidentally run in debug
(tracebacks leak source/settings and `ALLOWED_HOSTS` is bypassed). Development
sets `DEBUG=True` explicitly in `.env`. With `DEBUG` off the app also refuses to
start on the shared dev `DJANGO_SECRET_KEY` or a missing `MONITORING_SECRET_KEY`
(see [Secrets](#secrets)).

`DEBUG` controls **only** debug behaviour (tracebacks, `ALLOWED_HOSTS`). It does
**not** decide whether cookies are TLS-only — that's `DANBYTE_HTTPS` below.

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
    request is anonymous — so the app bounces straight back to the login form
    **with no error message**. If login silently loops, check this setting first.

This is deliberately independent of `DEBUG`: tying transport requirements to the
debug flag means changing the `DEBUG` default silently locks every plain-http
install out of login. `scripts/install.sh` configures nginx + TLS and writes
`DANBYTE_HTTPS=True` into `.env` (and backfills it on upgrade), so
installer-managed hosts stay hardened. nginx also sets HSTS at the edge for all
upstreams regardless (see [Security headers](#security-headers)).

## Static

`STATICFILES_DIRS` includes `design/`, so the mockup `theme.js` and
`tokens.css` are served at `/static/theme.js` and `/static/tokens.css` — used
by `_shell.html`.

## Hosts

`ALLOWED_HOSTS` should be set in the systemd service env (already done for
local + Netbird in `services/danbyte-backend.service`):

```text
Environment=ALLOWED_HOSTS=localhost,127.0.0.1,<your-vpn-fqdn>,<your-vpn-ip>
```

## Outbound requests (SSRF guard)

User-configured outbound URLs — webhooks, notification channels, automation
targets, device-type import URLs, and **per-tenant** SMTP/LDAP hosts — are
validated before each request: the host is resolved and rejected if it points at
a loopback / RFC1918 / link-local / `169.254.0.0/16` (cloud metadata) / ULA /
reserved address. This stops a tenant admin pointing a webhook (or a tenant SMTP
relay) at internal services and reading the response back — critical for the
cloud-hosted, multi-tenant deployments.

The guard is **DNS-rebinding safe**: the resolved public IP is pinned for the
actual connection (with SNI/`Host` preserved for TLS), so a hostname that
resolves public on the first lookup can't be swapped to `169.254.169.254` on the
connect. Operator-configured *deployment*-wide SMTP/LDAP hosts are trusted and
not guarded (an operator may legitimately point them at an internal relay); only
tenant-supplied hosts are checked.

If you *need* an internal target (e.g. an on-prem automation runner like the
[IaC runner](../features/iac-runner.md)), allow-list its address(es):

```text
Environment=DANBYTE_SSRF_ALLOWLIST=192.168.0.0/24,10.1.2.3
```

Comma-separated CIDRs/IPs whose resolved addresses are permitted. Empty by
default (all internal addresses blocked).

### Check-engine targets (central-runner SSRF)

The monitoring check engine runs both on remote **outpost agents** (deployed
inside a network to monitor internal hosts — reaching loopback/RFC1918 is the
point) and in the **central server** (where a tenant-defined check target of
`127.0.0.1` or an RFC1918 neighbour is an SSRF oracle onto internal services).
The cloud-metadata endpoint (`169.254.0.0/16`) and the unspecified address are
refused everywhere. To also refuse loopback / RFC1918 / reserved targets on the
central runner — the posture for a **cloud, multi-tenant** deployment — set:

```text
Environment=DANBYTE_CHECK_BLOCK_INTERNAL=True
```

Default `False`, so a self-hosted deployment that monitors its own LAN from the
central box is unaffected. `DANBYTE_SSRF_ALLOWLIST` (above) also exempts its
CIDRs from this block. Outpost agents keep the permissive default regardless.

## Security headers

Response hardening is applied at the **nginx** edge (see
`deploy/nginx/danbyte.prod.conf.template`), so it covers the SPA, API, and docs
uniformly and survives an app restart:

- `server_tokens off` — no nginx version banner.
- **HSTS** — `max-age=31536000; includeSubDomains`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (also enforced by
  Django's `SECURE_CONTENT_TYPE_NOSNIFF` / `X_FRAME_OPTIONS`).
- `Referrer-Policy: same-origin`, a restrictive `Permissions-Policy`, and
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`.
- An **enforced Content-Security-Policy** with `report-uri /api/csp-report/`.
  The SPA loads only same-origin bundled assets (no external scripts/styles/
  fonts, no `eval`, no web workers; the presence WebSocket is same-origin), so
  the policy doesn't block anything it serves. `'unsafe-inline'` is still
  permitted for the SSR hydration + chart `<style>` injection — the next
  hardening step is a nonce-based `script-src` (needs SSR nonce plumbing). Any
  real-browser violation is POSTed to `/api/csp-report/` and logged to the
  `danbyte.csp` logger, so tightening the policy later is observable rather than
  a silent breakage. The report endpoint is unauthenticated + CSRF-exempt (the
  browser sends no cookie/token) and only logs.

Django-side, `SECURE_REFERRER_POLICY`, `SECURE_CONTENT_TYPE_NOSNIFF`, and
`X_FRAME_OPTIONS` are set unconditionally (not gated on `DEBUG`) as defence in
depth for any path served without nginx in front.

## Logging

Console logging is on by default (`django` at INFO, `rq.worker` at INFO).
Suitable for `journalctl --user -fu danbyte-backend`.

## Secrets

| Setting | Where it lives | Dev default | Prod |
|---|---|---|---|
| `DJANGO_SECRET_KEY` | env | `dev-key-change-in-prod` | env var, rotated |
| `DB_PASSWORD` | env | `danbyte` | env var, rotated |
| Email creds | **DB (UI)** or env | console backend | Settings → Email & Delivery (encrypted) |

The `EMAIL_*` env vars remain the fallback, but the SMTP server, credentials,
and outbound-delivery options are normally configured at runtime under
**Settings → Email & Delivery** (`users.manage`). They live in the
deployment-wide singleton `core.DeploymentSettings`; the SMTP password is
Fernet-encrypted at rest. See
[Notifications](../features/monitoring.md#notifications).

## Monitoring

Settings for the [Monitoring / check engine](../features/monitoring.md). All
have working defaults, so the feature runs with none of them set.

| Setting | Default | Purpose |
|---|---|---|
| `MONITORING_SECRET_KEY` | derived from `SECRET_KEY` in DEBUG; **required when `DEBUG=False`** | Encryption key for SNMP/SSH/SMTP/LDAP credentials at rest (Fernet). A dedicated key gives credential encryption an independent lifecycle: rotating `SECRET_KEY` doesn't void stored secrets, and a `SECRET_KEY` leak can't decrypt them. The app refuses to start in production without it. `scripts/install.sh` generates one (and backfills older installs *from* the existing `SECRET_KEY` so already-stored secrets stay decryptable). **Never change it once secrets are stored** — old ciphertext becomes unreadable. |
| `MONITORING_SECRETS_BACKEND` | empty (Fernet) | Dotted path to a factory returning a `SecretsBackend`. Swap in an external store (OpenBao/Vault) without touching models. |
| `MONITORING_CONCURRENCY` | `100` | Max concurrent check attempts in one worker job's asyncio loop. Raising it needs a matching `LimitNOFILE` bump on the worker unit. |
| `MONITORING_GLOBAL_INTERVAL_SECONDS` | `300` | Default schedule (seconds) for assignments in `follow_global` mode. |
| `MONITORING_GLOBAL_ENABLED` | `True` | Global on/off switch that `follow_global` assignments obey. |
| `MONITORING_SHARD_SIZE` | `2000` | Targets per ICMP multiping shard (one RQ job each). |
| `MONITORING_GENERIC_SHARD_SIZE` | `200` | Targets per TCP/HTTP/… shard. |
| `MONITORING_INFLIGHT_DEADLINE_SECONDS` | `600` | A check claimed (`in_flight`) longer than this is treated as orphaned by a dead/restarted worker and reclaimed by the dispatcher's reaper, so it re-runs instead of being stuck `unknown`. A healthy run clears `in_flight` within seconds. |
| `MONITORING_EXEC_ENABLED` | `False` | Master switch for `exec` (script/plugin) checks. Off by default — running local commands from the UI is privileged. Set `True` **and** `MONITORING_PLUGIN_DIR` to use them. See [Script / exec checks](../features/monitoring.md#check-types). |
| `MONITORING_PLUGIN_DIR` | empty | Directory of trusted Nagios-style plugins. An `exec` check may only run a plugin (by bare name, no path traversal) inside this dir; args are passed without a shell. |
| `MONITORING_WEBHOOK_TIMEOUT` | `5` | Per-channel webhook POST timeout (seconds). |
| `MONITORING_RESULT_RETENTION_DAYS` | `30` | Delete `CheckResult` rows older than this (daily prune). Raw results run ~600k rows/day on a busy install (~2.4 GB heap at 17 days) — raise only with the disk to match; the rolled-up state + transitions carry the long-term story. |
| `MONITORING_TRANSITION_RETENTION_DAYS` | `365` | Delete `StateTransition` rows older than this. |
