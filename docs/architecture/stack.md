---
icon: lucide/box
---

# Stack

The chosen pieces and why.

| Layer | Choice | Why |
|---|---|---|
| Language | Python **3.13** | Long support window (until Oct 2029), broad lib coverage |
| Web | Django **5.2 LTS** | Sec-supported until Apr 2028, mature, "boring" |
| DRF | **3.16** | DRF is the only sane way to ship a Django JSON API |
| DB | PostgreSQL **18** | Native `nulls_distinct=False` for the VRF/Prefix uniqueness, JSONB for `custom_fields`, mature `inet` type |
| Cache + queue | Redis **8** + RQ | Pure-Python jobs, no extra broker, simple to monitor |
| Static | Tailwind via CDN (mockups), build step for production | Mockups are fast to iterate; production switches to the Tailwind compiler |
| Frontend | Server-rendered Django templates (today) → React + Vite (Phase 3) | Ship UI fast, extract components when patterns are stable |
| Docs | **Zensical** | Material-style site generator; same UX language as MkDocs Material |

## Why not?

- **Existing IPAM/DCIM suites.** They solve a related problem but ship opinions (default device roles, types, statuses) Danbyte wants to *not* ship. Different bet.
- **Postgres extensions like `ipam` / `cidr` column type.** Worth it later; today we store CIDR as `CharField(43)` so we don't tie the migration plan to a specific PG version's ext list.
- **A JS framework today.** Locks in a React-shaped form factor before patterns stabilise. The mockups in `design/` are the source of truth until we extract components.
- **GraphQL.** DRF first, GraphQL if/when a real consumer asks for it.

## Python deps that earn their keep

| Package | What it gives us |
|---|---|
| `django-taggit` | Tag model with M2M-through; we subclass `TagBase` to add `color` |
| `django-rq` | Admin-visible queue UI; clean integration with Django settings |
| `django-cors-headers` | Permissive CORS for the (future) React frontend |
| `django-redis` | Drop-in cache backend pointing at the Redis service |
| `django-filter` | Filter backend for DRF (used once REST endpoints land) |
| `djangorestframework-simplejwt` | JWT auth (Phase 2 when we add real auth) |
| `openpyxl` | XLSX read + write for the round-trippable import/export |
| `zensical` | This doc site |
