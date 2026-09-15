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

## Rendering a config

Every device's render context carries a `routing` block, alongside `device`,
`interfaces` and `ip_addresses` (see [export templates](export-templates.md#rendering-one-device)
for the address filters that turn an address into a mask or a length):

```
routing:
  vrfs:          [{name, rd, import_targets, export_targets, l3vni, description}]
  static_routes: [{vrf, prefix, kind, next_hop, next_hop_interface, next_hop_vrf,
                   distance, metric, tag, bfd, description}]
  policies:      {NAME: {rules: [{sequence, action, match: {...}, set: {...}, continue}]}}
  prefix_lists:  {NAME: {family, rules: [{sequence, action, prefix, ge, le}]}}
  community_lists: {NAME: {kind, rules: [...]}}
  as_path_lists: {NAME: {rules: [{sequence, action, regex}]}}
  communities:   [{value, kind, name}]
  keychains:     [{name, algorithm, key_set}]
```

`vrfs` is every table the device has to define - the VRFs its interfaces
and routes sit in. `policies` and the three list kinds hold only what the
device's protocols reference (nothing yet references them until BGP lands),
so a template prints what the box needs and no more. Every row carries its
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

Every list takes `?picker=1` for the compact row shape, `?search=`, and
supports CSV import/export and bulk delete like the rest of Danbyte.

## Permissions and audit

Each routing object is its own RBAC type under the **Routing** group; a
site-scoped grant on static routes covers the routes of that site's devices.
Every create, edit and delete - rule rows included - is in the
[change log](change-log.md).
