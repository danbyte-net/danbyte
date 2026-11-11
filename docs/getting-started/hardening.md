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

## Planned

Not done yet; tracked for a later release:

- **systemd sandboxing** of the app units (`ProtectSystem`, `PrivateTmp`,
  `NoNewPrivileges`, a system-call filter and friends), rolled out unit by
  unit.
- **A nonce-based Content-Security-Policy**, so `script-src` can drop
  `'unsafe-inline'`. The CSP report sink (`/api/csp-report/`) is already in
  place to watch for violations first.
