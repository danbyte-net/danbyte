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

## Planned

Not done yet; tracked for a later release:

- **systemd sandboxing** of the app units (`ProtectSystem`, `PrivateTmp`,
  `NoNewPrivileges`, a system-call filter and friends), rolled out unit by
  unit.
- **A nonce-based Content-Security-Policy**, so `script-src` can drop
  `'unsafe-inline'`. The CSP report sink (`/api/csp-report/`) is already in
  place to watch for violations first.
