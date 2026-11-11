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

## Planned

Not done yet; tracked for a later release:

- **systemd sandboxing** of the app units (`ProtectSystem`, `PrivateTmp`,
  `NoNewPrivileges`, a system-call filter and friends), rolled out unit by
  unit.
- **A nonce-based Content-Security-Policy**, so `script-src` can drop
  `'unsafe-inline'`. The CSP report sink (`/api/csp-report/`) is already in
  place to watch for violations first.
