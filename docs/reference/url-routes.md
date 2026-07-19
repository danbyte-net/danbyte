---
icon: lucide/route
---

# URL routes

Defined in `api/urls.py`. Mounted at the project root by `danbyte/urls.py`.

## Prefix routes

| Method | Pattern | View | Name |
|---|---|---|---|
| GET | `/` | redirect → `/prefixes/` | — |
| GET | `/prefixes/` | `prefixes_list` | `api:prefixes` |
| GET, POST | `/prefixes/new/` | `prefix_create` | `api:prefix-create` |
| GET, POST | `/prefixes/import/` | `prefixes_import` | `api:prefixes-import` |
| GET | `/prefixes/export.csv` | `prefixes_export_csv` | `api:prefixes-export-csv` |
| GET | `/prefixes/export.xlsx` | `prefixes_export_xlsx` | `api:prefixes-export-xlsx` |
| GET | `/prefixes/<uuid:pk>/` | `prefix_detail` | `api:prefix-detail` |
| GET, POST | `/prefixes/<uuid:pk>/edit/` | `prefix_edit` | `api:prefix-edit` |
| GET, POST | `/prefixes/<uuid:prefix_pk>/ips/new/` | `ip_create` | `api:ip-create` |
| POST | `/ips/<uuid:pk>/role/` | `ip_set_role` | `api:ip-set-role` |

## Query params on `/prefixes/`

| Param | Type | Effect |
|---|---|---|
| `sort` | string | `cidr` (default, tree view) · `updated` · `created` · `status` · `site` |
| `status` | repeat | filter to these status values |
| `site` | repeat | filter by site name |
| `vrf` | repeat | filter by VRF id, or `global` for `vrf__isnull=True` |
| `family` | `4` \| `6` | filter by IP family |
| `q` | string | substring search on CIDR + description |
| `page` | int | pagination (flat sort only) |
| `per_page` | int | `25` (default) · `50` · `100` |

## Query params on `/prefixes/new/`

| Param | Effect |
|---|---|
| `parent=<uuid>` | Inherit site + VLAN + VRF from this prefix |
| `cidr=<x>` | Pre-fill CIDR. If `parent` isn't given, infer inheritance from the smallest existing containing prefix. |

## Query params on `/prefixes/<uuid>/`

| Param | Effect |
|---|---|
| `tab` | `ips` (default) · `children` · `map` |
| `status` | filter IPs in the IPs tab |
| `show_available=1` | (IPs tab) interleave free addresses as ghost rows |

## Other routes

| Pattern | View |
|---|---|
| `/admin/` | Django admin |
| `/django-rq/` | RQ queue monitoring |
| `/static/...` | Static files (served by Django in DEBUG; whitenoise / nginx in prod) |
