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
| `RoutingPolicy` | - | `RoutingPolicyRule`: `sequence`, `action`, `description`; match: `match_prefix_lists`, `match_community_lists`, `match_as_path_lists` M2M, `match_next_hop` FK → `PrefixList`, `match_rpki` (`valid`/`invalid`/`notfound`, blank = not matched; `db_default=""`), `match_extra` JSON; set: `set_local_pref`, `set_med`, `set_weight`, `set_origin`, `set_next_hop`, `set_as_path_prepend`, `set_communities` M2M, `set_communities_additive`, `set_metric_type`, `set_extra` JSON; `continue_seq` |
| `BFDProfile` | catalog; `min_tx`, `min_rx` (ms, ≥ 1), `multiplier` (≥ 1), `echo` | `(tenant, name)` |
| `RoutingKeychain` | `algorithm` (`md5`/`sha1`/`sha256`/`hmac-sha-256`); `SecretBackedPSK` - `psk_secret_provider`, `psk_secret_path` reference the key in the secret store. Also holds the MKA CAK for an interface's MACsec (`Interface.macsec_keychain`, see [Interface](interface.md#macsec)) | - |
| `RPKICache` | `address` (IP or hostname), `port` (default 3323, 1-65535), `transport` (`tcp`/`ssh`), `preference` (1-255), `ssh_username` (required for SSH), `ssh_host_key`; `SecretBackedPSK` under `routing-rpki-caches/<id>` holds the SSH private key (API `ssh_private_key`, write-only). TCP refuses the SSH fields | `(tenant, name)` |

`ROA` is not a named catalog: `tenant`, `prefix` (normalised CIDR, v4 or v6),
`max_length` (prefix length to 32/128), `origin_asn` FK → `ASN` (PROTECT),
`aggregate` FK → `Aggregate` (optional, SET_NULL; the prefix must sit inside
it), `description`, tags, custom fields, `numid`. Unique
`(tenant, prefix, max_length, origin_asn)`. `routing.viewsets.slurm_document`
turns a queryset into RFC 8416 SLURM (`GET /api/routing/roas/slurm/`).
Migration `routing/0020`.

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
| `table` | int | kernel table for policy routing; null = main or the VRF's. Exclusive with `vrf`; 0 and 253-255 refused |
| `distance`, `metric`, `tag` | int | nullable |
| `bfd` | bool | |
| `status` | FK → `Status` | scope `staticroute` |

Unique `(device, vrf, table, prefix, next_hop, next_hop_interface)` with
`nulls_distinct=False`, so the same path twice is refused while the same
prefix through another next hop (ECMP), or in another table, is not.

## Policy rules

`PolicyRule` - one `ip rule` on a device or VM.

| Field | Type | Notes |
|---|---|---|
| `tenant` | FK → `Tenant` | |
| `device` / `virtual_machine` | FK | exactly one (`policyrule_device_xor_vm`) |
| `family` | `ipv4` / `ipv6` | derived from the prefixes when given |
| `priority` | int | unique per (owner, family) |
| `action` | `lookup` / `blackhole` / `unreachable` / `prohibit` | |
| `table` | int | for `lookup`; exclusive with `vrf`; 0 and 253-255 refused |
| `vrf` | FK → `VRF` | for `lookup`: the VRF's table |
| `from_prefix`, `to_prefix` | char(64) | normalised CIDR; a host is its /32 or /128 |
| `iif`, `oif` | FK → `Interface` | on `device` |
| `vm_iif`, `vm_oif` | FK → `VMInterface` | on `virtual_machine` |
| `fwmark` | int | |
| `invert` | bool | `not` |
| `status` | FK → `Status` | the static-route statuses (scope `staticroute`) |

Site-scoped as `device__site|virtual_machine__site`; audited; RBAC type
`policyrule`.

## BGP

| Model | Fields | Unique |
|---|---|---|
| `BGPInstance` | `device`, `vrf` (null = global), `asn` FK → `ASN`, `router_id`, `cluster_id`, `graceful_restart`, `distance_ebgp`/`distance_ibgp`/`distance_local` (all three or none), `bestpath_multipath_relax`, MPLS L3VPN on a per-VRF instance: `vpn_export`, `vpn_import`, `vpn_label_export` (`auto` or a number), `vpn_nexthop_export`; `rpki_caches` M2M → `RPKICache`; `bfd`, `status` (scope `routinginstance`), `description`, `extra` JSON | `(device, vrf)`, nulls not distinct |
| `BGPAddressFamily` | `instance`, `afi_safi`, `networks` JSON [CIDR], `maximum_paths`, `maximum_paths_ibgp`, `import_policy`, `export_policy`, `extra` | `(instance, afi_safi)` |
| `Redistribution` | one parent (`bgp_af`; OSPF/IS-IS instances follow), `source`, `policy`, `metric`, `level` + `family` (IS-IS only; blank = the instance's level, IPv4), `extra` | - |
| `BGPPeerGroup` | catalog + the shared knobs; `remote_asn` int, `remote_asn_mode` (`asn`/`external`/`internal`), `local_asn` FK, `update_source` text | `(tenant, name)` |
| `BGPSession` | `instance`, `name`, `peer_group`, `remote_asn` (+ mode), `local_asn`, `local_address` FK → `IPAddress`, `remote_address` text **xor** `interface` FK, `remote_address_obj` (auto-linked), `peer_device`, `peer_session` one-to-one, the shared knobs (all nullable = inherit), `status` (scope `bgpsession`), `description` | `(instance, remote_address)` / `(instance, interface)` conditional |

The shared knobs (`_PeerKnobs`): `address_families` JSON list, `import_policy`,
`export_policy`, `bfd`, `ebgp_multihop`, `next_hop_self`,
`route_reflector_client`, `send_community`, `keepalive`, `hold_time`,
`keychain`, `default_originate` + `default_originate_policy`,
`capability_extended_nexthop` (RFC 5549), `ttl_security_hops` (GTSM), `extra`. `BGPSession.effective()` resolves session → group →
instance (`bfd`), merges `extra`, and derives `update_source` from the local
address's interface.

`BGPNeighborAF` - one address family of a neighbour, a session **or** a peer
group (`bgpneighboraf_one_parent`), unique per parent and `afi_safi`:
`activate` (off prints `no neighbor X activate`), `import_policy`,
`export_policy`, `prefix_list_in`, `prefix_list_out`, `default_originate` +
`default_originate_policy`, `next_hop_self`, `route_reflector_client`,
`soft_reconfiguration`, `as_override`, `remove_private_as`, `send_community`,
`allowas_in`, `maximum_prefix`, `extra`. Every knob is nullable: null
inherits. `routing.models.effective_afs(session)` resolves each family and
knob, most specific first: the session's row, the session's own field, the
peer group's row, the peer group's field. The family set is the session's
active rows when it has any, else the group's. Site-scoped through the
session's box; a peer group's rows are catalog rows. Audited.

The `address_families` JSON list on sessions and peer groups stays as the
v0.16 view of the rows - the families with `activate` on. Writing the list
reconciles the rows (a listed family gets a row with every knob null; a
dropped one is deleted, or switched off when it carries a knob), and writing
a row rewrites the list (`sync_af_rows` / `sync_af_mirror`, wired as
signals in `routing/apps.py`). Migration `routing/0018` backfilled one row
per listed family with every knob null, so no render changed. The list is
deprecated and goes no earlier than two releases on.

## OSPF and IS-IS

| Model | Fields | Unique |
|---|---|---|
| `OSPFArea` | catalog; `area_id` (normalised: a number stays a number, a quad is a quad), `kind` | `(tenant, name)` |
| `OSPFInstance` | `device`, `vrf`, `process_id` text, `version` 2/3, `router_id`, `reference_bandwidth`, `passive_by_default`, `default_originate`, `bfd`, `status` (`routinginstance`), `description`, `extra`; redistribution rows | `(device, vrf, version, process_id)` |
| `OSPFInterface` | `instance`, `interface` (same device), `area` FK, `cost`, `network_type`, `passive` (null = instance default), `priority`, `hello`, `dead`, `bfd`, `mtu_ignore`, `authentication` + `keychain` | `(instance, interface)` |
| `ISISInstance` | `device`, `vrf`, `process`, `net` (checked), `level`, `metric_style`, `bfd`, `authentication` + `keychain`, `lsp_gen_interval`, `spf_interval`, `lsp_mtu`, `spf_init_delay`/`spf_short_delay`/`spf_long_delay`/`spf_holddown`/`spf_time_to_learn` (`spf-delay-ietf`: all five or none), `log_adjacency_changes`, `default_originate_ipv4`/`_ipv6` (`""`/`on`/`always`), `status`, `description`, `extra`; redistribution rows | `(device, process)` |
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
| `VTEPMembership` | `vtep`, `l2vpn` (VXLAN type), `vlan` (at the device's site), `interface` (optional FK → `api.Interface` on the VTEP's device - the leaf's `vxlan` netdev; the VNI stays on the L2VPN), `rd`, `ingress_replication`, `mcast_group`, `extra` | `(vtep, l2vpn)` |

| `EthernetSegment` | catalog; `esi` (type 0, ten octets) **or** `es_id` + `sys_mac` (type 3, normalised), `df_preference` (the default for every member), `interfaces` M2M → `api.Interface` through `EthernetSegmentMember` - the LAG on each leaf that shares the segment, so the ports are on different devices by design | `(tenant, name)` |
| `EthernetSegmentMember` | the through row: `segment`, `interface`, `df_preference` (null = the segment's). It sits on the table the plain M2M created (`routing_ethernetsegment_interfaces`, adopted in `routing/0016` without a copy) and keeps that table's bigint `id` rather than a UUID, so the upgrade rewrites nothing. Site-scoped `interface__device__site`; audited | `(segment, interface)` |
| `api.Interface.evpn_mh_uplink` | `evpn mh uplink` on a fabric-facing port of a multihomed leaf | - |

## MPLS

| Model | Fields | Unique |
|---|---|---|
| `LDPInstance` | `device` (one per device; `vrf` must stay null - LDP labels the global table), `router_id`, `transport_address` (blank = the router id), `label_allocation` (`host-routes`/`all`), `interfaces` M2M (same device), `bfd`, `status`, `description`, `extra` | `device` |

The VPN side of an L3VPN sits on the per-VRF `BGPInstance` (`vpn_*`); the RD
and route targets come from the VRF.

`resolve_membership_vlan(m)` is the leaf's VLAN for a VNI: own `vlan`, else
the L2VPN's termination at the device's site, else its sole VLAN
termination. `FHRPGroup` gains the `anycast` protocol for the shared SVI
address. Migrations `api/0165` (L2VPN.vrf, VNI uniqueness, `l2vpn`
statuses) and `routing/0006`.

## Rendering

`routing/render.py:routing_context(device)` builds the `routing` block the
config renderer and the Ansible inventory carry - plain dicts, sorted, every
row with its `id`, never a secret. Derived keys a template would otherwise
compute for itself: `level_frr` on an IS-IS instance, interface row and
redistribution (`level-1` / `level-1-2` / `level-2-only`), `spf_delay_ietf`
as one object or `None`, `default_originate` as `{family: mode}`, a BGP
instance's `distance` as one object or `None`, a session's
`remote_asn_effective` (the number a running config shows - the local AS for
`internal`) and `route_reflector_client_from_group` (the group already says
it, so print it once), and `used_bfd_profiles` (only the profiles this device
names; `bfd_profiles` stays the whole catalog). Multihoming and MPLS:
`by_interface[<port>].es` (the segment this port is in, with every member
on every device; `df_preference` there is the port's effective value and
`segment_df_preference` the segment's), `by_interface[<port>].evpn_mh_uplink`,
`ethernet_segments` (with `local_df_preference`) + `es_count` per device, `ldp` (one block or `None`),
and a per-VRF BGP instance's `vpn` object or `None`. RPKI: `rpki_caches`
at the top (every cache the box's instances name, by preference, with
`key_set` and never the key), each instance's `rpki_caches` as names, and
`match.rpki` on a policy rule. `keychains[].placeholder`
is `<keychain:NAME>`, the contract form a push tool substitutes
(`routing.render.KEYCHAIN_PLACEHOLDER_RE`). It is registered through
`api.export_templates.register_context_provider("routing", …)` from the app's
`ready()`, so `api` never imports `routing`.

## Registries

`auth_api/object_types.py` (group *Routing*; `routingkeychain` and `rpkicache` honour
`reveal`), `audit/apps.py`, `api/search_index.py`, `api/status_registry.py`
(`staticroute`, `bgpsession`, `routinginstance`, `l2vpn`, `vtep`),
`auth_api/site_paths.py` (device-bound rows → `device__site`, instance rows
→ `instance__device__site`, `vtepmembership` → `vtep__device__site`,
`redistribution` → its BGP address family's or IGP instance's device or VM),
the router in `api/api_urls.py` under `routing/`.
