---
icon: lucide/route
---

# Routing

The `routing` app. Catalogs are tenant-wide and named; rule rows belong to
their list and carry no tenant of their own (they are scoped through it,
like an interface through its device); device-bound rows are site-scoped
through the device. Every model has a UUID primary key; catalogs and
device-bound rows carry `numid`, custom fields and tags.

## Catalogs

Shared shape: `tenant` FK, `name` char(128), `description` text, unique
`(tenant, name)`.

| Model | Own fields | Rules |
|---|---|---|
| `PrefixList` | `family` (`ipv4`/`ipv6`) | `PrefixListRule`: `sequence`, `action`, `prefix` (normalised CIDR), `prefix_obj` FK → `Prefix` (optional), `ge`, `le`, `description`; unique `(prefix_list, sequence)` |
| `Community` | `value` (unique per tenant), `kind` (`standard`/`large`/`extended`) | - |
| `CommunityList` | `kind` (`standard`/`expanded`/`large`/`extended`) | `CommunityListRule`: `sequence`, `action`, `communities` M2M, `regex`, `description` |
| `ASPathList` | - | `ASPathListRule`: `sequence`, `action`, `regex`, `description` |
| `RoutingPolicy` | - | `RoutingPolicyRule`: `sequence`, `action`, `description`; match: `match_prefix_lists`, `match_community_lists`, `match_as_path_lists` M2M, `match_next_hop` FK → `PrefixList`, `match_extra` JSON; set: `set_local_pref`, `set_med`, `set_weight`, `set_origin`, `set_next_hop`, `set_as_path_prepend`, `set_communities` M2M, `set_communities_additive`, `set_metric_type`, `set_extra` JSON; `continue_seq` |
| `RoutingKeychain` | `algorithm` (`md5`/`sha1`/`sha256`/`hmac-sha-256`); `SecretBackedPSK` - `psk_secret_provider`, `psk_secret_path` reference the key in the secret store | - |

## Static routes

`StaticRoute`

| Field | Type | Notes |
|---|---|---|
| `tenant` | FK → `Tenant` | |
| `device` | FK → `Device` | CASCADE |
| `vrf` | FK → `VRF` | null = global table |
| `prefix` | char(64) | normalised with `ip_network(strict=True)` |
| `prefix_obj` | FK → `Prefix` | optional, SET_NULL |
| `kind` | `nexthop` / `blackhole` / `reject` | |
| `next_hop` | char(64) | normalised address; blank for a blackhole/reject |
| `next_hop_interface` | FK → `Interface` | must be on `device` |
| `next_hop_vrf` | FK → `VRF` | route leaking |
| `distance`, `metric`, `tag` | int | nullable |
| `bfd` | bool | |
| `status` | FK → `Status` | scope `staticroute` |

Unique `(device, vrf, prefix, next_hop, next_hop_interface)` with
`nulls_distinct=False`, so the same path twice is refused while the same
prefix through another next hop (ECMP) is not.

## Rendering

`routing/render.py:routing_context(device)` builds the `routing` block the
config renderer and the Ansible inventory carry - plain dicts, sorted, every
row with its `id`, never a secret. It is registered through
`api.export_templates.register_context_provider("routing", …)` from the app's
`ready()`, so `api` never imports `routing`.

## Registries

`auth_api/object_types.py` (group *Routing*; `routingkeychain` honours
`reveal`), `audit/apps.py`, `api/search_index.py`, `api/status_registry.py`
(`staticroute`), `auth_api/site_paths.py` (`staticroute` → `device__site`),
the router in `api/api_urls.py` under `routing/`.
