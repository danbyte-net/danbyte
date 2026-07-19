---
icon: lucide/route
---

# Reverse proxy — everything on HTTPS / 443

By default the pieces of Danbyte run on separate dev ports:

| Service | Port | What |
|---|---|---|
| SPA (Vite dev server) | `3000` | The React app |
| Django + DRF | `8000` | API (`/api/`) + admin |
| Zensical docs | `8001` | This documentation site |

The optional **nginx reverse proxy** puts all of them behind **one HTTPS
origin** so users hit a single URL and the docs link in the sidebar resolves to
a clean same-origin `/docs/`:

```
https://<host>/          → SPA
https://<host>/api/      → Django API
https://<host>/admin/    → Django admin
https://<host>/docs/     → these docs
```

## Install

One command (needs `sudo` — it installs nginx, generates a self-signed cert,
writes the site config, and reloads nginx):

```bash
make proxy-install
```

Override the hostname/IP baked into the cert + `server_name`:

```bash
make proxy-install PROXY_HOST=danbyte.lan
```

Then make sure the upstreams are running:

```bash
make backend-up docs-up      # Django :8000 + Zensical :8001
make frontend-dev            # Vite :3000 (separate terminal)
```

Visit `https://<host>/`. The self-signed cert triggers a one-time browser
warning on the LAN — accept it. For a browser-trusted local cert, install
[`mkcert`](https://github.com/FiloSottile/mkcert) and point `CERT`/`KEY` at its
output, or drop a real cert in `/etc/ssl/danbyte/`.

## How it's wired

- Source of truth is the template `deploy/nginx/danbyte.conf.template`; the
  `@@SERVER_NAME@@` / `@@CERT@@` / `@@KEY@@` placeholders are substituted into
  `/etc/nginx/sites-available/danbyte.conf` at install time. **Edit the
  template, not the installed copy**, then `make proxy-reload`.
- `/docs/` proxies the Zensical server with the prefix stripped; the built docs
  use relative links, so they sit happily under the subpath.
- `/` proxies the Vite dev server **with websocket upgrade** so HMR keeps
  working. For a production deployment, point that `location /` at your built
  SPA / Django static host instead of `:3000`.

## Commands

| Command | Effect |
|---|---|
| `make proxy-install` | Install nginx (if missing) + cert + config, enable & reload. |
| `make proxy-reload` | Re-render the template and reload nginx (after edits). |
| `make proxy-uninstall` | Remove the danbyte site and reload nginx. |
| `make proxy-cert` | (Re)generate the self-signed cert into `deploy/nginx/certs/`. |

## Notes

- **HMR through the proxy**: Vite's hot-reload websocket assumes the dev port.
  If live-reload misbehaves behind 443, develop against `http://<host>:3000`
  directly — the proxy is for unified access, not required for development.
- The proxy is **opt-in**; nothing else depends on it. Without it, the docs link
  falls back to `http://<host>:8001/`.