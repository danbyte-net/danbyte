---
icon: lucide/shield-check
---

# Hardening

What a production install does to narrow its attack surface, how an
upgraded install gets the same, and what is still planned. The
[security checklist](installation.md#security-checklist) covers the basics
(`DEBUG=False`, `.env` modes, Postgres and Redis on localhost).

## TLS

The nginx site rendered by the installer pins Mozilla's
["intermediate"](https://ssl-config.mozilla.org/) settings in its 443
server, rather than taking whatever the distro's `nginx.conf` offers:

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;
ssl_session_timeout 1d;
ssl_session_cache shared:DanbyteSSL:10m;
ssl_session_tickets off;
```

- TLS 1.0 and 1.1 are refused. On TLS 1.2 only forward-secret AEAD suites
  are left: no CBC, no SHA-1 MAC, no plain-RSA key exchange. TLS 1.3 is
  unchanged.
- Both certificate kinds work: the RSA key of the installer's self-signed
  certificate and the ECDSA P-256 key the [site
  certificate](../monitoring/certificates.md#the-sites-own-certificate)
  requests from an ACME CA.
- Browsers from roughly the last eight years connect. A client that only
  speaks TLS 1.0/1.1 or has no ECDHE - an old script, a legacy monitoring
  probe - stops connecting; update it, or change the lines in your site.
- These are server-level settings. When another site on the same nginx is
  the `default_server` for port 443, a client that sends no SNI gets that
  site's settings.

The Docker image's nginx and the development template carry the same lines.

**Upgrades.** A site still exactly as Danbyte rendered it gets the lines
from the release's root steps (`sudo ./install.sh --host-only`, see
[After an upgrade](upgrading.md#after-an-upgrade)). A site edited by hand
is left alone: the step *Pin modern TLS in nginx* shows the lines to add
and goes away once the site has `ssl_protocols` and `ssl_ciphers`.

## Edge rate limits

Danbyte counts failed sign-ins per account and per client in Django, and
those limits stay. But every attempt still holds a web worker for the
password hash, and a flood that changes the username each time never meets
the per-account limit, so one address could slow the app down for
everyone. The production nginx site therefore limits, per client address:

| Where | Limit | Over it |
|---|---|---|
| `/api/auth/login/`, `mfa/verify/`, `mfa/resend/`, `password-reset/`, `password-reset/confirm/`, `set-password/` - one budget for all of them | 1 a second, bursts of 5 | `429` with a JSON `detail` the sign-in page shows |
| `/api/csp-report/` (unauthenticated, logged) | 2 a second, bursts of 20; bodies up to 16 KB | `429`; a larger body `413` |

- 1 a second with a burst of 5 is 60 attempts a minute - plenty for people,
  but an office behind **one NAT address** shares it.
- Single sign-on callbacks (`/api/auth/sso/…`) are not limited: an identity
  provider's redirect must never fail at the edge. Nor is anything a
  signed-in user does.
- Only nginx's own refusals become the JSON 429; a 429 from Django passes
  through as it is.
- The development template and the Docker image carry no edge limits: the
  first fronts a dev server, and in the second the address nginx sees depends
  on how the container runtime publishes ports (rootless Podman and
  Docker's userland proxy show one address for everyone). Put the limits on
  the proxy in front of the stack instead.

**Behind another proxy or load balancer** nginx sees the proxy's address,
and every client would share one budget. Tell nginx which proxy to trust,
in a file of its own at the http level (Danbyte never renders it, so the
site stays re-renderable):

```nginx
# /etc/nginx/conf.d/danbyte-real-ip.conf
set_real_ip_from 192.0.2.5;       # the proxy (or its subnet); repeat per proxy
real_ip_header X-Forwarded-For;
real_ip_recursive on;
```

Then `nginx -t && systemctl reload nginx`. The limits key on the client,
and Django finds it too: nginx forwards it at the right of
`X-Forwarded-For`, so `DANBYTE_TRUSTED_PROXY_DEPTH` 1 or 2 both work. Only
name proxies you run: a trusted address can claim to be anyone.

**Upgrades.** A site still as Danbyte rendered it gets the limits from the
release's root steps; a site edited by hand shows the step *Rate-limit
sign-in at nginx* with the lines, until it has `limit_req zone=danbyte_auth`.

## Content-Security-Policy

Every page gets two policies, and the browser enforces both, so a script
must pass each:

| From | On | Governs |
|---|---|---|
| The frontend server (`danbyte-frontend-prod`) | each HTML page | scripts and workers: `script-src 'nonce-…' 'strict-dynamic' 'self' 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; report-uri /api/csp-report/` |
| nginx | every response | everything else: the same-origin default, the map tile, GitHub and vulnerability-data hosts, `style-src`, `frame-ancestors` (see [Security headers](../reference/settings.md#security-headers)) |

- **A nonce per page.** The frontend server draws 128 random bits for each
  page it renders and writes them on every script it puts in the page (the
  theme script, the hydration data, the entry module and its preloads).
  `'strict-dynamic'` then trusts what those scripts load, so the route
  chunks loaded later need no list. A script injected into the page - an
  inline `<script>` or an `onclick=` attribute - has no nonce and does not
  run.
- **Fallbacks.** `'self' 'unsafe-inline'` are only for browsers that know
  neither nonces nor `'strict-dynamic'`; a browser that does ignores them.
  nginx's own policy keeps `script-src 'self' 'unsafe-inline'` as the floor
  for the modes below.
- **Styles** keep `'unsafe-inline'`: charts write `<style>` blocks of their
  own. It cannot run code.
- **Not from the frontend:** the API, `/admin/`, `/static/`, `/media/`,
  `/docs/` and the hashed `/assets/` get nginx's policy alone. The
  maintenance page nginx shows while Danbyte restarts has its own: no
  script, only its inline style.
- **Caching.** A page carries `Cache-Control: private, no-cache`, so no
  shared cache hands one visitor's nonce to another. Nothing in the
  shipped path caches pages: nginx has no `proxy_cache`, and there is no
  service worker.
- **Docker.** The frontend container sends the same page policy. The
  image's nginx sends no policy of its own (a proxy in front can).

### Modes

`DANBYTE_CSP_MODE` in `.env` picks what the frontend server does:

| Value | Pages get |
|---|---|
| `enforce` (default) | the policy above, enforced |
| `report` | the same policy as `Content-Security-Policy-Report-Only`: a violation is reported, nothing is blocked |
| `off` | no page policy (nginx's stays) |

A value it does not know enforces, and the frontend logs a warning. The
frontend reads it at start, so restart it after a change:

```bash
# as the service user
echo 'DANBYTE_CSP_MODE=report' >> ~/danbyte/.env
systemctl --user restart danbyte-frontend-prod
```

In Docker, set it in the stack's `.env` and recreate the `frontend`
service. The Vite dev server (`make frontend-dev`) defaults to `off`: it
injects scripts of its own without a nonce.

### Reporting a violation

A browser posts each violation to `/api/csp-report/`, which logs it to the
`danbyte.csp` logger (in `journalctl --user -u danbyte-web`):

```
CSP violation: directive=script-src-elem blocked=inline document=https://danbyte.example.com/devices
```

If a page or feature stops working and the browser console says
*Refused to execute … because it violates the following Content Security
Policy directive*, set `DANBYTE_CSP_MODE=report` to get it working again,
and report the console line and the log line above as an issue, with the
page it happened on.

## Redis authentication

The installer takes `redis-server` from the distro and leaves its
configuration alone: Redis listens on localhost without a password, so any
other account on the host can reach Danbyte's cache, job queue and
WebSocket layer. On a host that runs nothing else that is the whole risk;
on a shared host, give Redis a password or a socket only Danbyte can open.

Danbyte reads one Redis setting for all of them - `REDIS_PASSWORD`
(and `REDIS_USERNAME` for an ACL user), a `rediss://` URL or a unix socket;
see [Settings → Redis](../reference/settings.md#redis-redis_url-redis_password-redis_socket).
With none of them set, nothing changes.

**Fresh install.** `install.sh --redis-password` gives the distro's Redis a
random password before anything connects: it writes
`/etc/redis/danbyte-auth.conf` (`requirepass …`, mode 640, root and the
`redis` group), adds one `include` line at the end of
`/etc/redis/redis.conf`, restarts Redis and puts the same password in
`.env` as `REDIS_PASSWORD`. A `redis.conf` that already sets a password or
ACL users is left alone and the install stops; leave the flag off and set
`REDIS_PASSWORD` yourself. The flag is opt-in because the installer does not
otherwise touch the distro's Redis, which other software on the host may
share.

**An existing install** keeps its Redis as it is: no upgrade turns a
password on. To do it yourself, pick a quiet moment - **Jobs** shows nothing
running. Queued jobs are kept (Redis saves them across its restart) and run
once the workers are back; a job running at that moment fails and can be
re-queued from **Jobs**.

```bash
# 1. as root: the password, in a file of its own, included at the end
pw=$(openssl rand -hex 32)
( umask 027; printf 'requirepass %s\n' "$pw" > /etc/redis/danbyte-auth.conf )
chgrp redis /etc/redis/danbyte-auth.conf
grep -qx 'include /etc/redis/danbyte-auth.conf' /etc/redis/redis.conf \
  || printf '\ninclude /etc/redis/danbyte-auth.conf\n' >> /etc/redis/redis.conf

# 2. the same password in Danbyte's .env (as the service user)
printf '\nREDIS_PASSWORD=%s\n' "$pw" | sudo -u danbyte tee -a /opt/danbyte/danbyte/.env >/dev/null

# 3. Redis, then every Danbyte unit, back to back
systemctl restart redis-server
danbyte services restart
REDISCLI_AUTH="$pw" redis-cli ping     # PONG; without the password: NOAUTH
```

Between steps 3's two restarts the running units cannot reach Redis for a
few seconds: requests fall back to the database, workers reconnect once
restarted. Anything else on the host that uses this Redis needs the
password too. Undo: remove the `include` line, `systemctl restart
redis-server`, delete `REDIS_PASSWORD` from `.env`, restart the units.

**A unix socket instead.** In `/etc/redis/redis.conf` set
`unixsocket /run/redis/redis-server.sock` and `unixsocketperm 770`, add the
service user to the `redis` group (`usermod -aG redis danbyte`), restart its
user manager so the group applies (`systemctl restart user@$(id -u
danbyte).service`, or reboot), then point `.env` at the socket and restart
the units:

```ini
REDIS_URL=unix:///run/redis/redis-server.sock?db=0
```

`port 0` in `redis.conf` then closes TCP altogether. A password and a
socket can be combined.

**Docker.** Set `REDIS_PASSWORD` in the stack's `.env` and run
`docker compose -f docker-compose.prod.yml up -d`: the redis service starts
with `--requirepass` and every Python service gets the same variable. Empty
(the default) is no password, as before.

Sandboxed [scripts](../features/scripts.md#what-a-sandboxed-script-cannot-do)
reach neither Redis's port nor any unix socket, password or not.

## systemd sandboxing

The app units run under sandboxing drop-ins. The install, every upgrade and
`make install-services` on a source checkout place them, as the service
user, in `~/.config/systemd/user/<unit>.d/`:

| File | What it is |
|---|---|
| `10-hardening.conf` | a link to `services/hardening/<group>.conf` in the app tree |
| `20-hardening-paths.conf` | the paths this install writes to, made from `.env` (only for units with the filesystem lines) |

`scripts/unit-hardening.sh` writes them. Before it links a group's file it
starts a throwaway unit under the same drop-ins. A file this host's systemd
refuses drops to `base.conf`, and a refused `base.conf` leaves the unit
without a drop-in, with a warning in the install or upgrade log. The log
also says whether the filesystem lines apply on this host:

```text
unit hardening: service workers base; filesystem confinement: not available, systemd skips those lines (no user namespace with mount rights)
```

### What each group gets

| Group | Units | Drop-in |
|---|---|---|
| web, websockets, frontend, docs | `danbyte-web`, `danbyte-ws`, `danbyte-frontend-prod`, `danbyte-docs` | `service.conf` |
| fast lane, periodic jobs | `danbyte-fastlane` and every timer's service except the two below | `service.conf` |
| workers | `danbyte-workers` | `workers.conf` |
| code-writing | `danbyte-auto-upgrade`, `danbyte-acme-renew` | `base.conf` |
| development | `danbyte-backend`, `danbyte-frontend`, `danbyte-mockups`, `danbyte-infra` | none |

- **`base.conf`**: `NoNewPrivileges`, `LockPersonality`, `RestrictRealtime`,
  `RestrictSUIDSGID`, `SystemCallArchitectures=native` and `UMask=0027`.
  Every app unit gets these.
- **`service.conf`**: the baseline, plus:
  - filesystem: `ProtectSystem=strict`, `PrivateTmp`,
    `ProtectKernelTunables`, `ProtectHostname` and the paths drop-in;
  - network: `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`;
  - system calls: `RestrictNamespaces`,
    `SystemCallFilter=@system-service`, with `SystemCallErrorNumber=EPERM`
    so a refused call fails instead of killing the process.
- **`workers.conf`**: the baseline, the same address families, and a
  system-call filter that keeps the calls bubblewrap needs (the mount calls,
  `pivot_root`, `sethostname`) and the ones Danbyte's own sandbox needs
  (Landlock, seccomp). The workers keep these out on purpose:
  - `RestrictNamespaces`, because sandboxed scripts and the DWG converter
    run inside bubblewrap, which makes its own namespaces;
  - the filesystem lines, because each puts a user unit in a user
    namespace of systemd's. On Ubuntu 24.04 and later AppArmor then holds
    the process to its `unprivileged_userns` profile, and bubblewrap cannot
    start there. Scripts would fall back to Landlock alone, and DWG uploads
    would be refused.
- **The code-writing units** get the baseline only. The upgrade itself
  runs as the transient `danbyte-upgrade.service`, which has no drop-in. It
  rewrites the code tree, the virtualenv and the unit links. The ACME
  renewal writes the certificate drop folder.
- **The development units** are never linked on a production host.

`UMask=0027` takes "other" off the files the units create, and the group
keeps read access. nginx reads static files, frontend builds and the
maintenance page as another user, but the upgrade writes those, not these
units, and with explicit modes. Uploaded media is served through Danbyte.

### What a user unit can apply

Danbyte's units are `systemctl --user` units, and a user manager has no
capabilities. What that means for each directive, measured on systemd 259
(Ubuntu 26.04), and per systemd.exec(5) for the other supported releases:

| Directive | Effect in a user unit |
|---|---|
| `NoNewPrivileges`, `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`, `SystemCallArchitectures`, `SystemCallFilter`, `RestrictAddressFamilies`, `RestrictNamespaces`, `UMask` | applies on every supported systemd (249 to 259). These are a prctl or a seccomp filter. |
| `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths`, `ReadOnlyPaths`, `InaccessiblePaths`, `ProtectKernelTunables`, `ProtectHostname` | need a mount namespace inside a user namespace. On 255 and later, systemd adds `PrivateUsers=` by itself (on 252 only when the unit sets it; on 249 not at all). On Ubuntu 24.04 and later, AppArmor gives that namespace no capabilities. systemd then skips the lines **without an error**, and `systemd-analyze security` still counts them. |
| `PrivateDevices`, `ProtectClock`, `ProtectKernelLogs`, `ProtectKernelModules`, `CapabilityBoundingSet` | these drop capabilities. On Ubuntu 26.04 the unit **does not start** (status 218/CAPABILITIES). Not shipped. |
| `PrivateUsers=identity`, `PrivatePIDs`, `ProtectControlGroups=strict` | the unit does not start (217/USER, 226/NAMESPACE). Not shipped. |
| `ProtectControlGroups`, `ProtectProc`, `ProcSubset` | "only available for system services" on every release: a no-op that only flatters the score. Not shipped. |

`CapabilityBoundingSet=` would add nothing anyway: a user unit has no
capabilities to drop. The filesystem lines are in `service.conf` for hosts
that grant the namespace, such as Debian 13. Where they apply, the
web, websocket, frontend, docs, fast-lane and job units cannot write the
system, the code tree, the virtualenv or the rest of the home directory.

### Scores

`systemd-analyze --user security`, on Ubuntu 26.04 with systemd 259:

| Unit | Before | After |
|---|---|---|
| `danbyte-web`, `danbyte-ws`, `danbyte-frontend-prod`, `danbyte-docs` | 9.8 UNSAFE | 5.9 MEDIUM |
| `danbyte-fastlane` and the periodic jobs | 9.8 UNSAFE | 5.9 MEDIUM |
| `danbyte-workers` | 9.8 UNSAFE | 7.5 EXPOSED |
| `danbyte-auto-upgrade`, `danbyte-acme-renew` | 9.8 UNSAFE | 9.1 UNSAFE |
| development units | 9.8 UNSAFE | 9.8 UNSAFE |

The score counts the filesystem lines even on a host that skips them, so
on Ubuntu 24.04 and later the real gain is the system-call, address-family
and privilege lines.

### Writable paths

`20-hardening-paths.conf` lists `media/`, `plugins_local/`
(`DANBYTE_PLUGIN_DIR`), the backup directory (`DANBYTE_BACKUP_DIR`,
default `danbyte-backups` beside the app), `DANBYTE_LOG_DIR` and the
fontconfig cache. Each unit gets only what it needs:

- **`danbyte-web` and `danbyte-prune`** also get the app directory itself,
  for the upgrade's status and lock files, the uploaded bundle,
  housekeeping and `deploy/nginx/certs`. Each code file and folder in it is
  made read-only again.
- **websockets** get the log directory only, and **the frontend** that and
  `frontend/node_modules/.vite-temp`, where `vite preview` compiles its config.
- **docs** gets `site/` and `.cache/` for Zensical.

To give the units another directory, such as a local backup target outside
the default one, list it in `.env` and apply the drop-ins again:

```bash
# as the service user
echo 'DANBYTE_UNIT_WRITABLE_PATHS=/srv/danbyte-backups /mnt/nas' >> ~/danbyte/.env
make -C ~/danbyte unit-hardening
systemctl --user restart danbyte-web danbyte-workers
make -C ~/danbyte unit-hardening-status
```

Or add a drop-in of your own with a later name. Your drop-in is never
touched, and a later name wins for single-value settings:

```ini
# ~/.config/systemd/user/danbyte-web.service.d/50-local.conf
[Service]
ReadWritePaths=/srv/exports
```

A target the web unit cannot write fails its test with "Read-only file
system", and the message says which setting to change.

### Opting out

Set `DANBYTE_UNIT_HARDENING` in `.env`, or in the environment of
`install.sh`:

- `auto` (the default) applies the drop-ins described above.
- `base` gives every unit `base.conf` only.
- `off` removes Danbyte's drop-ins.

Then run `make -C ~/danbyte unit-hardening` and restart the units. The next
upgrade keeps the setting. To loosen one unit, use a `50-local.conf`
instead, for example `ProtectSystem=no` or `SystemCallFilter=`.

### Upgrades and rollback

The upgrade's *swap* step keeps a copy of every `danbyte-*.service.d`
folder before it links the new units. A rollback puts those folders back
exactly, and an upgrade from a release without drop-ins comes back without
any. A unit that cannot start under its drop-in fails the *start* step in
the usual way: the web health check, or a unit that keeps restarting. That
triggers the rollback. A timer's job that fails is not caught there; the
throwaway unit run before linking is what guards those.

### Unit inventory

| Unit | Runs | Writes | Connects to |
|---|---|---|---|
| `danbyte-web` | gunicorn | media, plugins, the app directory's upgrade files, certificate drop folder, logs | Postgres, Redis, the user bus (`systemd-run --user` for restarts and upgrades), SMTP, LDAP, outbound HTTPS |
| `danbyte-ws` | daphne | logs | Postgres, Redis, devices over SSH (the terminal) |
| `danbyte-frontend-prod` | `vite preview` (node) | `frontend/node_modules/.vite-temp` | the web unit |
| `danbyte-docs` | `zensical serve` | `site/`, `.cache/` | nothing |
| `danbyte-workers` | the RQ worker pool | media, backups, plugins, logs, temporary files | everything checks reach: ICMP, SNMP, SSH, WinRM, HTTP(S), nmap (`--unprivileged`), backup targets (SFTP, S3); runs bubblewrap |
| `danbyte-fastlane` | sub-minute checks | logs | ICMP, TCP, HTTP |
| periodic jobs (31 timers) | `manage.py <job>` oneshots | media, backups, logs; `danbyte-prune` also the wheelhouse and old upgrade folders | Postgres, Redis, the integrations they sync |
| `danbyte-auto-upgrade` | starts `danbyte-upgrade.service` | the app directory | GitHub releases, the user bus |
| `danbyte-acme-renew` | ACME renewal | the certificate drop folder | the ACME server |

## Planned

Not done yet; tracked for a later release:

- **System units with `User=danbyte`** instead of `systemctl --user` units,
  so the filesystem part of the [sandbox](#systemd-sandboxing) applies on
  every host and the capability lines become possible.
