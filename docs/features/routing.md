---
icon: lucide/route
---

# Routing

Routing is where you write down **how a device forwards** - the static routes
it carries, and the policy objects every routing protocol shares: prefix
lists, communities, community lists, AS-path lists, routing policies (route
maps) and the keychains sessions authenticate with. BGP, OSPF, IS-IS and the
EVPN/VXLAN overlay build on these and land in their own sections as they
ship.

Two ideas run through the whole module:

- **Catalogs are tenant-wide, instances are per device.** A prefix list or a
  policy is named once and used on every router; a static route, a BGP
  session or an OSPF interface belongs to one device and is scoped to its
  site like the device is.
- **Danbyte renders what is modelled; the template is yours.** Everything
  here reaches a device's [config template](export-templates.md#rendering-one-device)
  as a `routing` block, so one template renders the whole box - in whatever
  vendor's syntax you write it in.

## Prefix lists

**Routing → Prefix lists → Add prefix list.** A prefix list has a name, a
family (IPv4 or IPv6) and its rules, edited together on one page:

| Column | What it records |
|---|---|
| **Seq** | The sequence number - rules are evaluated in order. "Add rule" takes the last one plus ten. |
| **Action** | `permit` or `deny`. |
| **Prefix** | The network, in CIDR. Host bits set is an error - `10.0.0.1/8` means you meant `10.0.0.0/8`. |
| **ge** / **le** | The length range this line matches, as on the box (`10.0.0.0/8 ge 24 le 32`). Both must sit between the prefix's own length and 32 (128 for IPv6). |
| **Description** | Optional. |

Saving writes the rule set as a whole: a rule is matched by sequence and
rewritten, sequences you removed are deleted. The list page shows the rule
count; the list's own page shows the rules.

## Communities and community lists

A **community** is a BGP community value with a name, so `65000:100` reads
as `CUSTOMER-ROUTES` wherever it is set or matched. Standard, large and
extended communities are told apart by their kind; the value is unique per
tenant.

A **community list** matches communities. A `standard`, `large` or
`extended` list names the communities each rule matches; an `expanded` list
matches a pattern instead (`^65000:1..$`).

## AS-path lists

Patterns over the AS path a policy matches on - `^65010_` for "learned
from 65010", `_65020$` for "originated by 65020". One pattern per rule.

## Routing policies

A routing policy is a route map: ordered rules, each of which **matches**
and **sets**.

| Match | What it tests |
|---|---|
| Prefix lists | The route's prefix is permitted by any of them. |
| Community lists | The route carries a community any of them permits. |
| AS-path lists | The route's AS path matches any of them. |
| Next hop in | The next hop is in the named prefix list. |

| Set | What it changes |
|---|---|
| Local pref, MED, weight | The BGP attributes. |
| Origin | `igp`, `egp` or `incomplete`. |
| Next hop | Rewrite the next hop. |
| AS-path prepend | `65001 65001` - as many as you type. |
| Communities (+ additive) | Set, or add to, the route's communities. |
| Metric type | Type 1 or 2 for OSPF redistribution. |
| Continue | Jump to another sequence after this one matches. |

A vendor knob Danbyte does not model goes in the rule's `match_extra` /
`set_extra` JSON through the API; a template reads it as `rule.match.foo`.

## Keychains

**Routing → Keychains.** The one secret-bearing routing object: BGP sessions
and OSPF / IS-IS interfaces reference a keychain, and the key itself lives in
the deployment's [secret store](../architecture/tenant-settings.md), never in the row -
the same arrangement an SSID's or an IPsec profile's pre-shared key uses.
Without a store the key is refused rather than stored in the clear. A
keychain's page shows **Stored** with a reveal button (an audited action
behind the `reveal` grant on keychains) or **Not set**; the rendered config
never carries the key - it says `key_set` and the runner fetches the key
through `POST /api/routing/keychains/<id>/reveal-psk/`.

## Static routes

**Routing → Static routes**, or a device's **Routing** tab. One row is one
path on one device:

| Field | What it records |
|---|---|
| **Device** | The router. |
| **VRF** | The table the route sits in; blank is the global table. |
| **Prefix** | The destination, in CIDR, normalised the way the box prints it. |
| **IPAM prefix** | Optionally, the prefix object this route names, so the prefix's page can show who routes it. |
| **Kind** | Next hop, interface, blackhole or reject. |
| **Next hop** / **Interface** | For a next-hop route: an address, an interface on the same device, or both (`ip route 0.0.0.0/0 10.1.1.1 eth0`). An **interface** route points out of a port with no address - the point-to-point shape some platforms write (`ip route 10.30.0.0/16 Serial0/0`). |
| **Next hop VRF** | Route leaking - the table the next hop is looked up in. |
| **Distance**, **Metric**, **Tag**, **BFD** | As on the box; blank means the platform default. |
| **Status** | Your own status catalog; the built-ins are active, planned and disabled. |

The same prefix through two next hops is two rows (ECMP); the same path twice
is refused. A next-hop interface on another device is refused too.

## BGP

BGP is three objects: the **instance** (`router bgp` on a device, one per
table), its **address families**, and the **sessions** (neighbours), with
**peer groups** as the tenant-wide catalog a session inherits from.

### Instances and address families

A device's **Routing** tab → **Add instance**: the AS (from [ASNs](ipam-objects.md#asns)),
the VRF (blank = the global table), router ID, cluster ID, graceful
restart, and BFD as the default for its neighbours. Each instance carries
its **address families** - `ipv4-unicast`, `ipv6-unicast`, `vpnv4-unicast`,
`vpnv6-unicast`, `l2vpn-evpn`, `ipv4-labeled-unicast` - each with the
networks it originates, maximum paths, an import and export policy, and
what it **redistributes** (connected, static, OSPF, …, each through a
policy).

### Peer groups

**Routing → BGP peer groups.** The neighbour settings named once - remote AS
(a number, or *external* / *internal* for unnumbered fabrics), a local AS
override, an *update source* hint, address families, policies, BFD, eBGP
multihop TTL, next-hop self, route-reflector client, send-community,
timers, and the keychain. A group is not bound to a device: the same
`SPINES` group applies on every leaf.

### Sessions

**Routing → BGP sessions**, or the instance's **Add session**. A session
names its far end as an **address** or as an **interface** (unnumbered
peering - `neighbor swp1 interface remote-as external`), its local address
(whose interface is the update source), and optionally the peer device.
When the far address is in IPAM, the row is linked and the peer device is
filled in.

Whether a session is **iBGP or eBGP** is never typed in: the same AS on both
ends is internal, anything else external (an unnumbered *internal* /
*external* remote AS says so directly). It shows as a badge on the session,
filters the sessions list, and reaches a template as `session.kind`.

Every neighbour setting a session leaves on **Inherit** comes from its peer
group; what neither sets falls to the instance (BFD) or the platform
default. The session's page shows both: **Effective settings** - what the
box ends up with - and **Own values**. The API returns the same as
`effective`, and the render context carries only effective values, so a
template never repeats the resolution.

**Create the far end** on a session's page writes the mirror session on the
peer device - its instance in the same table, addresses swapped, the
effective settings copied - and links the two, so an iBGP pair is two
clicks. It needs the peer device, this side's local address and a far
address IPAM has on that device.

## OSPF

**OSPF areas** (Routing → OSPF areas) are a tenant catalog: the backbone and
the areas behind it, each with an ID (`0` or `0.0.0.0` - a plain number
stays a number, a dotted quad is normalised) and a kind (normal, stub,
totally stubby, NSSA, totally NSSA).

An **OSPF instance** lives on a device's Routing tab: the process (a number
on IOS, a name on NX-OS and FRR), the version (v2/v3), the VRF, router ID,
reference bandwidth, *passive by default*, default-originate, BFD, and what
it redistributes. One instance per device, table, version and process.

Interfaces **enrol** in an instance from its card - one row per port, with
the area, cost, network type, passive (blank = the instance's default),
priority, hello/dead timers, BFD, MTU-ignore, and authentication with a
keychain. A port enrols in an instance once; a port on another device is
refused.

## IS-IS

An **IS-IS instance** has a process name, the **NET** (checked to read like
one - `49.0001.0000.0000.0011.00`), the level (1, 2, 1-2), metric style,
BFD, area authentication with a keychain, and redistribution. One per
device and process.

Interfaces enrol with their **families** (`ipv4`, `ipv6` - FRR needs `ip
router isis` per family), a level override, metric (and an L2 metric when
the levels differ), network type, passive, hello interval and multiplier,
BFD, and hello authentication.

An interface's own page shows the OSPF and IS-IS rows it sits in, and any
unnumbered BGP session on it, under **Routing**.

## Rendering a config

Every device's render context carries a `routing` block, alongside `device`,
`interfaces` and `ip_addresses` (see [export templates](export-templates.md#rendering-one-device)
for the address filters that turn an address into a mask or a length):

```
routing:
  vrfs:          [{name, rd, import_targets, export_targets, l3vni, description}]
  static_routes: [{vrf, prefix, kind, next_hop, next_hop_interface, next_hop_vrf,
                   distance, metric, tag, bfd, description}]
  bgp:           [{vrf, asn, router_id, cluster_id, graceful_restart, bfd,
                   address_families: [{afi_safi, networks, maximum_paths, maximum_paths_ibgp,
                                       import_policy, export_policy, redistribute: [{source, policy, metric}]}],
                   sessions: [{name, peer_group, remote_asn, remote_asn_mode, kind, local_asn,
                               local_address: {address, cidr, interface}, remote_address, interface,
                               peer_device, address_families, import_policy, export_policy, bfd,
                               ebgp_multihop, update_source, next_hop_self, route_reflector_client,
                               send_community, keepalive, hold_time, keychain, extra}],
                   peer_groups: [{name, ...}]}]      # only the groups this instance's sessions use
  ospf:          [{vrf, process_id, version, router_id, reference_bandwidth, passive_by_default,
                   default_originate, bfd, redistribute: [...],
                   areas: [{area_id, name, kind}],
                   interfaces: [{interface, area, cost, network_type, passive, priority, hello, dead,
                                 bfd, mtu_ignore, authentication, keychain}]}]
  isis:          [{vrf, process, net, level, metric_style, bfd, authentication, keychain,
                   redistribute: [...],
                   interfaces: [{interface, families, level, metric, metric_l2, network_type, passive,
                                 hello_interval, hello_multiplier, bfd, authentication, keychain}]}]
  by_interface:  {NAME: {vrf, ospf: {process_id, version, area, cost, ...} | null,
                         isis: {process, families, level, metric, ...} | null}}
  policies:      {NAME: {rules: [{sequence, action, match: {...}, set: {...}, continue}]}}
  prefix_lists:  {NAME: {family, rules: [{sequence, action, prefix, ge, le}]}}
  community_lists: {NAME: {kind, rules: [...]}}
  as_path_lists: {NAME: {rules: [{sequence, action, regex}]}}
  communities:   [{value, kind, name}]
  keychains:     [{name, algorithm, key_set}]
```

`vrfs` is every table the device has to define - the VRFs its interfaces,
routes and instances sit in. `policies` and the three list kinds hold only
what the device's address families, sessions and peer groups reference, so
a template prints what the box needs and no more. Session values are the
effective ones; `remote_asn_mode` is `asn`, `external` or `internal`. Every row carries its
`id`; `vrf` is a name, `null` for the global table.

A static-routes fragment, IOS-style:

```jinja
{% for r in routing.static_routes %}
ip route {% if r.vrf %}vrf {{ r.vrf }} {% endif %}{{ r.prefix | host }} {{ r.prefix | netmask }} {{ r.next_hop or r.next_hop_interface }}{% if r.distance %} {{ r.distance }}{% endif %}
{% endfor %}
```

and FRR:

```jinja
{% for r in routing.static_routes %}
ip route {{ r.prefix }} {{ r.next_hop or r.next_hop_interface }}{% if r.vrf %} vrf {{ r.vrf }}{% endif %}{% if r.distance %} {{ r.distance }}{% endif %}
{% endfor %}
```

`by_interface` is what an interfaces loop reaches for - the IGP rows keyed
by port name, so `interface swp1` prints its `ip ospf area` line without a
nested search. An interface's `passive` is already resolved against the
instance default; an IS-IS row's `level` is the instance's when the row
left it blank.

An interfaces loop with the IGP lines, FRR-style:

```jinja
{% for i in interfaces %}
{% set r = routing.by_interface[i.name] %}
interface {{ i.name }}
{% for ip in ip_addresses if ip.assigned_interface_id == i.id %}
 ip address {{ ip | cidr }}
{% endfor %}
{% if r and r.ospf %}
 ip ospf area {{ r.ospf.area }}
{% if r.ospf.network_type %}
 ip ospf network {{ r.ospf.network_type }}
{% endif %}
{% if r.ospf.cost %}
 ip ospf cost {{ r.ospf.cost }}
{% endif %}
{% endif %}
{% if r and r.isis %}
{% for fam in r.isis.families %}
 {{ 'ip' if fam == 'ipv4' else 'ipv6' }} router isis {{ r.isis.process }}
{% endfor %}
{% if r.isis.network_type == 'point-to-point' %}
 isis network point-to-point
{% endif %}
{% endif %}
{% endfor %}
{% for o in routing.ospf %}
router ospf{% if o.vrf %} vrf {{ o.vrf }}{% endif %}

{% if o.router_id %}
 ospf router-id {{ o.router_id }}
{% endif %}
{% for iface in o.interfaces if iface.passive %}
 passive-interface {{ iface.interface }}
{% endfor %}
{% endfor %}
{% for s in routing.isis %}
router isis {{ s.process }}
 net {{ s.net }}
 is-type level-{{ s.level }}
 metric-style {{ s.metric_style }}
{% endfor %}
```

A BGP block, FRR-style, with the neighbours' effective values:

```jinja
{% for b in routing.bgp %}
router bgp {{ b.asn }}{% if b.vrf %} vrf {{ b.vrf }}{% endif %}

{% if b.router_id %}
 bgp router-id {{ b.router_id }}
{% endif %}
{% for s in b.sessions %}
{% set n = s.remote_address or s.interface %}
 neighbor {{ n }} {% if s.interface %}interface {% endif %}remote-as {{ s.remote_asn if s.remote_asn_mode == 'asn' else s.remote_asn_mode }}
{% if s.update_source %}
 neighbor {{ n }} update-source {{ s.update_source }}
{% endif %}
{% if s.bfd %}
 neighbor {{ n }} bfd
{% endif %}
{% endfor %}
{% for af in b.address_families %}
 address-family {{ af.afi_safi.replace('-', ' ') }}
{% for net in af.networks %}
  network {{ net }}
{% endfor %}
{% for s in b.sessions if af.afi_safi in s.address_families %}
  neighbor {{ s.remote_address or s.interface }} activate
{% if s.route_reflector_client %}
  neighbor {{ s.remote_address or s.interface }} route-reflector-client
{% endif %}
{% endfor %}
 exit-address-family
{% endfor %}
{% endfor %}
```

The same block rides the Ansible inventory as `danbyte.routing` - always on
a single host (`GET /api/devices/<id>/inventory/`), on the fleet export when
asked (`GET /api/inventory/ansible/?routing=1`), since most plays never read
it.

## API

| Endpoint | Purpose |
|---|---|
| `/api/routing/prefix-lists/`, `…/community-lists/`, `…/as-path-lists/`, `…/policies/` | The lists, rules nested; write `rules: [...]` to replace the set. |
| `…/prefix-list-rules/`, `…/community-list-rules/`, `…/as-path-list-rules/`, `…/policy-rules/` | Rule rows on their own, filtered by their list (`?prefix_list=`, `?policy=`, …). |
| `/api/routing/communities/` | Communities. |
| `/api/routing/keychains/` | Keychains; `psk` is write-only, `reveal-psk` is the audited read. |
| `/api/routing/static-routes/` | Static routes; filter by `device`, `vrf` (`global` for the global table), `kind`, `status`, `site`, `prefix_obj`. |
| `/api/routing/bgp-instances/` | Instances with their address families nested; filter by `device`, `vrf`, `asn`, `site`, `status`. |
| `/api/routing/bgp-address-families/`, `…/redistributions/` | The rows on their own (`?instance=`, `?bgp_af=`); an address family accepts `redistributions: [...]`. |
| `/api/routing/bgp-peer-groups/` | Peer groups. |
| `/api/routing/bgp-sessions/` | Sessions with `effective`; filter by `device`, `instance`, `site`, `asn`, `remote_asn`, `peer_group`, `peer_device`, `status`, `af`. `POST …/<id>/create-peer/` writes the mirror session. |
| `/api/routing/ospf-areas/` | Areas. |
| `/api/routing/ospf-instances/`, `…/isis-instances/` | Instances with their interfaces and redistributions nested; accept `redistributions: [...]`; filter by `device`, `vrf`, `site`, `status`. |
| `/api/routing/ospf-interfaces/`, `…/isis-interfaces/` | Enrolled interfaces (`?instance=`, `?interface=`, `?area=`). |

Every list takes `?picker=1` for the compact row shape, `?search=`, and
supports CSV import/export and bulk delete like the rest of Danbyte.

## Permissions and audit

Each routing object is its own RBAC type under the **Routing** group; a
site-scoped grant on static routes covers the routes of that site's devices.
Every create, edit and delete - rule rows included - is in the
[change log](change-log.md).
