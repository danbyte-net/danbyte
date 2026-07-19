---
icon: lucide/layers
---

# Architecture overview

The 5-minute mental model of the running application.

## Runtime layers

```text
Browser
  React 19 + TanStack Start/Router/Query/Table + Tailwind 4
  frontend/src/routes/ and frontend/src/components/
                         |
                         v
nginx (one public origin)
  SPA/SSR | /api/ | /ws/ | /admin/ | static/media | docs
             |       |
             v       v
       gunicorn    daphne
             \       /
              Django 5.2 + DRF
              tenant/site RBAC, validation, audit
                         |
             PostgreSQL + Redis/RQ workers
```

The React application in `frontend/` is the only product frontend. Django owns
the JSON API, admin, background work, static/media handling, and WebSockets. It
does not provide a parallel server-rendered product UI. In development, Vite on
port 3000 is the user-facing server and proxies Django routes to port 8000.

Production deliberately separates normal HTTP traffic (gunicorn) from
WebSockets (daphne). nginx presents both, plus the frontend and documentation,
through one origin.

## Ownership boundaries

| Area | Primary code |
|---|---|
| React routes and page workflows | `frontend/src/routes/` |
| Shared UI and tables | `frontend/src/components/` |
| Typed frontend API boundary | `frontend/src/lib/api.ts` |
| IPAM, DCIM, connectivity, and topology | `api/` |
| Tenant settings and shared platform behavior | `core/` |
| Authentication, RBAC, API tokens, and LDAP | `auth_api/` |
| Checks, alerts, engines, and SNMP | `monitoring/` |
| Webhooks, automation, drift, and imports | `integrations/` |
| Change history and journal | `audit/` |
| Background execution | `jobs/` and RQ workers |

## Request lifecycle

For a typical list page:

1. TanStack Router mounts the route and TanStack Query requests `/api/...`.
2. Django resolves the authenticated user and active tenant.
3. The viewset scopes its base queryset to that tenant, then applies RBAC and
   site/constraint filters before any user-controlled identifier or filter.
4. DRF serializes the authorized rows and returns JSON.
5. TanStack Query owns the client cache; shared table and page-shell components
   render loading, error, empty, and populated states.

Tenant isolation is a server-side security boundary. Client-side route guards,
hidden controls, and picker filtering improve usability but never replace
queryset and relationship validation in Django.

## Data principles

Danbyte does not seed illustrative inventory. Example devices, sites, prefixes,
VLANs, and tags belong only in opt-in demo seeders. Minimal deterministic data
needed for invariants, access control, protocol constants, or a safe first run
may be created by bootstrap or forward data migrations. See the repository
agent guide for the complete seed classification rules.

PostgreSQL is required. Domain objects use UUID primary keys, and migrations
are forward-only because public-preview installations already hold real data.

## Repository layout

```text
danbyte/
  danbyte/                 # Django settings, URLs, WSGI, ASGI
  api/                     # IPAM/DCIM/connectivity API and models
  auth_api/                # authentication and RBAC
  core/                    # tenant settings and shared platform behavior
  monitoring/              # monitoring, alerts, engines, and SNMP
  integrations/            # external systems and automation
  audit/                   # change history and journal
  frontend/                # active React/TanStack application
  services/                # systemd user units and timers
  deploy/                  # production nginx and deployment templates
  docs/                    # documentation source
  reference/               # archived mockups and historical reference material
```

`frontend/src/routeTree.gen.ts` and build output are generated. Archived static
mockups under `reference/` are not runtime sources of truth.
