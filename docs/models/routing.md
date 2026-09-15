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
| `kind` | `nexthop` / `interface` / `blackhole` / `reject` | an interface route needs `next_hop_interface` and no address |
| `next_hop` | char(64) | normalised address; blank for a blackhole/reject |
| `next_hop_interface` | FK → `Interface` | must be on `device` |
| `next_hop_vrf` | FK → `VRF` | route leaking |
| `distance`, `metric`, `tag` | int | nullable |
| `bfd` | bool | |
| `status` | FK → `Status` | scope `staticroute` |

Unique `(device, vrf, prefix, next_hop, next_hop_interface)` with
`nulls_distinct=False`, so the same path twice is refused while the same
prefix through another next hop (ECMP) is not.

## BGP

| Model | Fields | Unique |
|---|---|---|
| `BGPInstance` | `device`, `vrf` (null = global), `asn` FK → `ASN`, `router_id`, `cluster_id`, `graceful_restart`, `bfd`, `status` (scope `routinginstance`), `description`, `extra` JSON | `(device, vrf)`, nulls not distinct |
| `BGPAddressFamily` | `instance`, `afi_safi`, `networks` JSON [CIDR], `maximum_paths`, `maximum_paths_ibgp`, `import_policy`, `export_policy`, `extra` | `(instance, afi_safi)` |
| `Redistribution` | one parent (`bgp_af`; OSPF/IS-IS instances follow), `source`, `policy`, `metric`, `extra` | - |
| `BGPPeerGroup` | catalog + the shared knobs; `remote_asn` int, `remote_asn_mode` (`asn`/`external`/`internal`), `local_asn` FK, `update_source` text | `(tenant, name)` |
| `BGPSession` | `instance`, `name`, `peer_group`, `remote_asn` (+ mode), `local_asn`, `local_address` FK → `IPAddress`, `remote_address` text **xor** `interface` FK, `remote_address_obj` (auto-linked), `peer_device`, `peer_session` one-to-one, the shared knobs (all nullable = inherit), `status` (scope `bgpsession`), `description` | `(instance, remote_address)` / `(instance, interface)` conditional |

The shared knobs (`_PeerKnobs`): `address_families` JSON list, `import_policy`,
`export_policy`, `bfd`, `ebgp_multihop`, `next_hop_self`,
`route_reflector_client`, `send_community`, `keepalive`, `hold_time`,
`keychain`, `extra`. `BGPSession.effective()` resolves session → group →
instance (`bfd`), merges `extra`, and derives `update_source` from the local
address's interface.

## OSPF and IS-IS

| Model | Fields | Unique |
|---|---|---|
| `OSPFArea` | catalog; `area_id` (normalised: a number stays a number, a quad is a quad), `kind` | `(tenant, name)` |
| `OSPFInstance` | `device`, `vrf`, `process_id` text, `version` 2/3, `router_id`, `reference_bandwidth`, `passive_by_default`, `default_originate`, `bfd`, `status` (`routinginstance`), `description`, `extra`; redistribution rows | `(device, vrf, version, process_id)` |
| `OSPFInterface` | `instance`, `interface` (same device), `area` FK, `cost`, `network_type`, `passive` (null = instance default), `priority`, `hello`, `dead`, `bfd`, `mtu_ignore`, `authentication` + `keychain` | `(instance, interface)` |
| `ISISInstance` | `device`, `vrf`, `process`, `net` (checked), `level`, `metric_style`, `bfd`, `authentication` + `keychain`, `status`, `description`, `extra`; redistribution rows | `(device, process)` |
| `ISISInterface` | `instance`, `interface`, `families` JSON (`ipv4`/`ipv6`, defaults to ipv4), `level`, `metric`, `metric_l2`, `network_type`, `passive`, `hello_interval`, `hello_multiplier`, `bfd`, `authentication` + `keychain` | `(instance, interface)` |

`Redistribution` has exactly one parent - `bgp_af`, `ospf_instance` or
`isis_instance` (CheckConstraint).

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
