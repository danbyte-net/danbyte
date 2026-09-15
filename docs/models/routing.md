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
| `BFDProfile` | catalog; `min_tx`, `min_rx` (ms, ≥ 1), `multiplier` (≥ 1), `echo` | `(tenant, name)` |
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

| `EIGRPInstance` | `device`, `vrf`, `asn` (1-65535), `name` (named mode), `router_id`, `k_values` (five 0-255, normalised), `variance`, `maximum_paths`, `passive_by_default`, `stub`, `bfd`, `status`, `description`, `extra`; redistribution rows | `(device, vrf, asn)` |
| `EIGRPInterface` | `instance`, `interface` (same device), `passive`, `split_horizon` (null = default), `hello_interval`, `hold_time`, `bandwidth_percent`, `summary_addresses` JSON (checked networks), `bfd`, `authentication` + `keychain` | `(instance, interface)` |

Every `_DeviceInstance`, `_IGPInterface` row and `_PeerKnobs` carrier has
`bfd_profile` (SET_NULL) beside `bfd`; `BGPSession.effective()` resolves it
session → group → instance.

`Redistribution` has exactly one parent - `bgp_af`, `ospf_instance`,
`isis_instance` or `eigrp_instance` (CheckConstraint); `source` gains
`eigrp`.

## Overlay

| Model | Fields | Unique |
|---|---|---|
| `api.L2VPN` (extended) | `vrf` FK, allowed on `EVPN_TYPES` only (`clean()`); `vtep_memberships` reverse | `(tenant, identifier)` for `type in VXLAN_TYPES` (`uniq_l2vpn_vxlan_vni`) |
| `VTEP` | `device` OneToOne, `source_interface` (same device), `source_ip`, `anycast_ip` (assigned to the device), `anycast_gateway_mac` (normalised lower-case), `arp_suppression`, `status` (`vtep`), `description`, `extra` | `device` |
| `VTEPMembership` | `vtep`, `l2vpn` (VXLAN type), `vlan` (at the device's site), `rd`, `ingress_replication`, `mcast_group`, `extra` | `(vtep, l2vpn)` |

`resolve_membership_vlan(m)` is the leaf's VLAN for a VNI: own `vlan`, else
the L2VPN's termination at the device's site, else its sole VLAN
termination. `FHRPGroup` gains the `anycast` protocol for the shared SVI
address. Migrations `api/0165` (L2VPN.vrf, VNI uniqueness, `l2vpn`
statuses) and `routing/0006`.

## Rendering

`routing/render.py:routing_context(device)` builds the `routing` block the
config renderer and the Ansible inventory carry - plain dicts, sorted, every
row with its `id`, never a secret. It is registered through
`api.export_templates.register_context_provider("routing", …)` from the app's
`ready()`, so `api` never imports `routing`.

## Registries

`auth_api/object_types.py` (group *Routing*; `routingkeychain` honours
`reveal`), `audit/apps.py`, `api/search_index.py`, `api/status_registry.py`
(`staticroute`, `bgpsession`, `routinginstance`, `l2vpn`, `vtep`),
`auth_api/site_paths.py` (device-bound rows → `device__site`, instance rows
→ `instance__device__site`, `vtepmembership` → `vtep__device__site`),
the router in `api/api_urls.py` under `routing/`.
