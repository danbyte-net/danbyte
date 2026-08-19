import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Dev: proxy /api/* and /auth/* to the Django backend so the React app hits
// DRF directly and reuses Django's session cookie + CSRF. DJANGO_URL overrides
// the target (default :8000) so a second instance on this box (e.g. a feature
// branch on its own DB/ports) proxies to ITS backend, not the primary one -
// `vite preview` inherits this proxy too.
const django = process.env.DJANGO_URL ?? "http://localhost:8000"
const djangoWs = django.replace(/^http/, "ws")

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
  // Vite is the single user-facing dev port (:3000). It proxies every
  // Django-served path to the backend in the background so the user
  // never has to think about two ports. Includes /admin so you can log
  // into Django without leaving the React URL.
  server: {
    // Bind every interface (not just loopback) so other LAN devices / a phone
    // can reach the dev server at http://<box-lan-ip>:3000. allowedHosts:true
    // accepts the LAN IP / VPN FQDN in the Host header (mirrors Django's
    // wildcard ALLOWED_HOSTS in DEBUG).
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": { target: django, changeOrigin: true },
      "/auth": { target: django, changeOrigin: true },
      "/admin": { target: django, changeOrigin: true },
      "/static": { target: django, changeOrigin: true },
      "/media": { target: django, changeOrigin: true },
      "/django-rq": { target: django, changeOrigin: true },
      // Channels presence WebSocket. `ws: true` forwards the upgrade to Django.
      "/ws": { target: djangoWs, ws: true, changeOrigin: true },
    },
  },
  // Production: `vite preview` serves the built SSR app (danbyte-frontend-prod).
  // Behind nginx the Host header is the public domain, so accept any host here -
  // real host allow-listing lives in Django's ALLOWED_HOSTS. nginx routes
  // /api, /ws, /static, /admin to Django; only app routes reach this server.
  preview: {
    host: true,
    port: 3000,
    allowedHosts: true,
  },
})

export default config
