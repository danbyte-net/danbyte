---
icon: lucide/layers
---

# VLANs, VRFs & route targets

Alongside prefixes and IP addresses, Danbyte tracks the supporting IPAM objects
your network is built from. Each one has its own list (with a filter rail),
create form, detail page, and edit/delete — and each is scoped to your tenant.

This page is a tour of what each object is for.

## VRFs

A **VRF** is a routing and isolation domain. A prefix or IP inside one VRF is
completely independent of an identical address in another VRF — so overlapping
private (RFC 1918) space across customers or environments is fully supported,
not a workaround.

A VRF carries:

| Field | What it's for |
|---|---|
| **Name** | The VRF's label. |
| **Route distinguisher** | Optional RD value, e.g. `65001:100`. |
| **Enforce unique** | Reject duplicate addresses within this VRF. |
| **Color** | Shown as a colored badge wherever the VRF appears. |
| **Description, tags** | Free-form notes and labels. |

Prefixes and IPs that aren't in any VRF live in the **Global** table.

## Route targets

A **route target** is an import/export tag for MPLS L3VPN-style topologies. It's
a small object — a value such as `65000:100`, plus a description and tags — that
VRFs reference for their import/export policy. Because it's its own object, the
same route target can be shared across many VRFs.

## VLANs

A **VLAN** carries a VID (1–4094), a name, an optional site, an optional group, a
status, a description, tags, and any custom fields. Interfaces reference a VLAN
for access or trunk membership. The list filters by site, status, and group, and
supports **bulk edit** for changing many VLANs at once.

### VLAN groups

A **VLAN group** is a named grouping that scopes VID uniqueness and defines a
valid VID range:

- The same VID can exist in different groups; ungrouped VLANs stay unique across
  the tenant.
- Assigning a VLAN to a group checks that its VID falls inside the group's range.
- A group can optionally be bound to a site or cluster.

!!! warning "Delete order"
    You can't delete a VLAN group that still contains VLANs. Move or remove its
    VLANs first.

## IP ranges

An **IP range** is a contiguous, inclusive span of addresses (a start and an end
address) — handy for DHCP pools or carve-outs that don't line up to a clean CIDR
boundary the way a prefix does. A range carries a status (Active, Reserved, or
Deprecated), an optional role from your IP-role catalog, a description, tags, and
custom fields, and — like prefixes and IPs — it lives inside a VRF.

A range can optionally point at a **parent prefix**. Picking one sets and locks
the range's VRF to match the prefix. The range's detail page shows an
**available addresses** panel: the addresses inside the span that aren't yet
recorded as IPs, with used / available / total counts (very large ranges are
truncated so the page stays fast).

## RIRs & aggregates

A **RIR** is your catalog of the registries — or private spaces — that allocate
address blocks (ARIN, RIPE, RFC 1918, and so on), each flagged as public or
private.

An **aggregate** is a top-level block of address space allocated from a RIR.
Prefixes live *under* aggregates. For IPv4 aggregates, Danbyte rolls up how much
of the block is covered by child prefixes and shows it as a utilisation bar
(IPv6 spaces are too large to express as a percentage). A RIR's detail page lists
its aggregates.

!!! warning "Delete order"
    You can't delete a RIR that still has aggregates. Remove its aggregates
    first.

## ASNs

An **ASN** records an Autonomous System Number (a 32-bit value), optionally tied
to a RIR and associated with one or more sites, plus a description, tags, and
custom fields. ASNs are unique within your tenant. The list filters by RIR and
tags, and search matches the number or description.

## FHRP groups

An **FHRP group** models a First-Hop Redundancy Protocol group — VRRP, HSRP,
GLBP, or CARP. It carries a group ID (0–255), optional authentication, an
optional virtual IP, plus a description, tags, and custom fields.

Members are added as **assignments**: each binds the group to exactly one device
or VM interface, with an election priority. You manage members inline on the
group's detail page (add an interface and priority, or remove one). The list
filters by protocol and tags.

## IP statuses & IP roles

Following Danbyte's **zero pre-filled data** rule, no statuses or roles ship with
the product — you define exactly the ones your network uses:

- **IP status** — the operational state of an address (for example *Active*,
  *Reserved*, *Deprecated*), each with a color shown as a badge.
- **IP role** — the functional role of an address (for example *Gateway*,
  *Loopback*, *VIP*). One role can be marked the gateway role, which
  [gateway autospawn](gateway-autospawn.md) uses to pick the right address.

See [IP statuses & roles](catalogs-and-settings.md) for managing these catalogs,
and [Tags & custom fields](tags-and-custom-fields.md) for attaching your own
attributes to any of these objects.

## Service templates

A **service template** is a reusable service definition — a name plus a protocol
(TCP or UDP) and one or more ports — that you define once and reuse when adding
**Services** to devices and VMs. Following the **zero pre-filled data** rule, no
templates ship with the product: you create exactly the ones your network uses
(for example *HTTPS — TCP 443* or *DNS — UDP 53*).

Templates are tenant-scoped, carry an auto-generated slug (unique per tenant),
and require at least one valid port (1–65535). Like Services they support
custom fields and tags — a NetBox import carries both over. They are exposed at
`/api/service-templates/` (add `?picker=1` for a lightweight id/name/protocol/
ports list used by the service form).
