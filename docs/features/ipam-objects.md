---
icon: lucide/layers
---

# VLANs, VRFs & route targets

Alongside prefixes and IP addresses, Danbyte tracks the supporting IPAM objects
your network is built from. Each one has its own list (with a filter rail),
create form, detail page, and edit/delete - and each is scoped to your tenant.

This page is a tour of what each object is for.

## VRFs

A **VRF** is a routing and isolation domain. A prefix or IP inside one VRF is
completely independent of an identical address in another VRF - so overlapping
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
a small object - a value such as `65000:100`, plus a description and tags - that
VRFs reference for their import/export policy. Because it's its own object, the
same route target can be shared across many VRFs.

## VLANs

A **VLAN** carries a VID (1–4094), a name, an optional site, an optional group, a
status, a description, tags, and any custom fields. Interfaces reference a VLAN
for access or trunk membership. The list filters by site, status, group and VRF,
and supports **bulk edit** for changing many VLANs at once.

The **status** says whether a VLAN is in use: *Active*, *Reserved* for a
coming rollout, or *Deprecated* and due for removal - or any status of your own
made available to VLANs under Statuses. A new VLAN starts in the default
(*Active*). VLANs created before 0.17 have no status; tick them in the list and
use **Edit** to set many at once. The status shows as a column on the list,
filters it, and sits on the VLAN's page.

A VLAN can also name the **VRF** its SVI lives in - the Layer 3 side of the
VLAN, documented before any prefix exists on it (a reserved or planned VLAN
has none yet). It is optional; a flat network leaves it empty. The VRF shows
on the VLAN's page and as a column and filter on the list, a VRF's page has
a **VLANs** tab with a count, and a prefix that sits on the VLAN but in a
different VRF gets a *VLAN is in another VRF* badge on its page, so a
mismatch is seen rather than assumed.

A VLAN also has an optional **colour** (set on its edit form) that paints its
badge everywhere VLANs appear - tables, the IP/prefix panes, and the virtual
network topology rails. Colour precedence: the VLAN's own colour, then its
zone's colour (zones stay firewall semantics - inside/outside/prod - never a
colour requirement), then a neutral badge / blue palette shade.

### Prefixes on a VLAN

The VLAN page's **Prefixes** tab lists the prefixes bridged onto it, and is
where you wire them up:

- **Assign prefix** pulls an *existing* prefix onto the VLAN - a searchable
  list, one click per prefix, several in a row. A prefix already on another
  VLAN shows which one, and picking it moves it.
- **Add prefix** creates a brand-new prefix with the VLAN pre-filled on the
  form.

Both respect your prefix permissions (*change* and *add* respectively).

### Where a VLAN ID has to be unique

A VLAN ID is an L2 namespace, and the namespace is a **group** or a **site** -
never the whole tenant. Kyiv VLAN 105 and Warsaw VLAN 105 are different
broadcast domains that happen to share a number, and both are valid.

- **Ungrouped:** the VID is unique **per site**. A VLAN with no site at all is
  not "every site" - it is one tenant-wide VLAN, and there can only be one of
  those per VID.
- **Grouped:** the group is the namespace, across every site it spans. That is
  what a group is for, so the same VID twice in one group is still refused.

!!! note "Reading a VID off a switch or a hypervisor"
    Because a bare VID no longer names one VLAN, SNMP sync, drift and
    virtualization sync resolve it **within the device's or cluster's site**:
    the site's own ungrouped VLAN first, then a group bound to that site or
    cluster, then a tenant-wide VLAN. Where two sites' VLANs are equally
    plausible, Danbyte assigns **nothing** rather than guess - a missing
    assignment reappears as drift on the next poll, a wrong one looks like the
    truth forever. SNMP creates a VLAN it has never seen **at the polled
    device's site**.

### VLAN groups

A **VLAN group** is a named grouping that scopes VID uniqueness and defines a
valid VID range:

- Assigning a VLAN to a group checks that its VID falls inside the group's range.
- A group can optionally be bound to a site or cluster - which is also what lets
  a synced VID resolve to it.

!!! warning "Delete order"
    You can't delete a VLAN group that still contains VLANs. Move or remove its
    VLANs first.

**Free addresses in the IPs tab.** For a prefix small enough to enumerate,
**Show available** in the filter rail interleaves the unregistered addresses
with the registered ones: a free address is click-to-add (so is its blue
**+ Add** button), opening the IP form at that address. **Compact** folds the
free rows into one - the first free address with "N more available" - when the
registered addresses are what you came to see.

## IP ranges

An **IP range** is a contiguous, inclusive span of addresses (a start and an end
address) - handy for DHCP pools or carve-outs that don't line up to a clean CIDR
boundary the way a prefix does. A range carries a status (Active, Reserved, or
Deprecated), an optional role from your IP-role catalog, a description, tags, and
custom fields, and - like prefixes and IPs - it lives inside a VRF.

A range can optionally point at a **parent prefix**. Picking one sets and locks
the range's VRF to match the prefix. The range's **Addresses** tab is the
ordinary IP table cut to the span: the registered addresses with every IP
column (status, role, tags, assignment…) interleaved with the free ones.
**Show available** toggles the free rows; a free address is click-to-add (so
is its blue **+ Add** button), opening the IP form with the subnet and address
filled in. **Compact** folds the free rows into one - the first free address
with "N more available" - for a range where the used addresses are what you
came to see. Free / used / total counts sit above the table (very large ranges
are capped so the page stays fast).

**Allocating from a range.** When you add an IP and the chosen subnet contains
ranges, a **Range** field appears - pick one to treat it as the pool: the form
shows how many addresses are free, offers the first free ones as one-click
picks with a **Next free** button, and nudges when the typed address falls
outside the span. Leave it on *Any address in the subnet* to allocate from the
whole prefix as before. The range stays a documentation object - the IP is
saved against the subnet, and the range's own page keeps the full free list.

**Allocate only from ranges.** A provider hands you `.61–.67` of a `/24` that
isn't yours: the `/24` is the right network to record, but Danbyte would still
treat all 254 hosts as free and suggest `.1` as the next available. Tick
**Allocate only from ranges** on the prefix and the ranges inside it become
its allocatable space:

- **Next available** (Subnet details) walks the ranges, not the network - so
  it works even in a prefix too large to enumerate.
- **Show available** in the IPs tab lists only the free addresses inside the
  ranges, and **Add pool** offers each range as a preset in place of *Whole
  prefix*; a pool straddling a range edge is cut to the range.
- **Utilisation** counts used against the ranges' size, and the Addressing
  card shows *Used 1 of 7 · Free 6*; Subnet details gain **Allocation**,
  **Managed addresses**, **Used** and **Available** rows under the subnet's
  theoretical capacity.
- The IP form requires a **Range** pick (a lone range is picked for you), and
  the API refuses a new address outside every range: *192.173.199.0/24
  allocates only from its ranges (192.173.199.61–192.173.199.67). Add a range
  covering this address, or turn off Allocate only from ranges on the prefix.*
  An address that was already registered outside the ranges keeps saving.
- Site gateway autospawn skips the prefix when the first/last usable address
  falls outside the ranges - that gateway is the provider's.

DHCP exclusion ranges never count as allocation ranges: they're space carved
*out* of a pool. With the option on and no ranges yet, the prefix reports no
free addresses and no utilisation until you add one.

Containment is surfaced both ways: the prefix IPs tab has a **Range** column
(the containing range's role chip), and an IP's own detail page shows a
**Range** row in its Network card - linked, with the range's role and, for
DHCP exclusions, the dashed **DHCP EXCL** badge.

## RIRs & aggregates

A **RIR** is your catalog of the registries - or private spaces - that allocate
address blocks (ARIN, RIPE, RFC 1918, and so on), each flagged as public or
private.

An **aggregate** is a top-level block of address space allocated from a RIR.
Prefixes live *under* aggregates. The aggregate page's **Prefixes tab** lists
every prefix carved inside the block, with the count in the tab title. For IPv4 aggregates, Danbyte rolls up how much
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

An **FHRP group** models a First-Hop Redundancy Protocol group - VRRP, HSRP,
GLBP, CARP, or an **EVPN anycast gateway** (the same address answered by
every leaf, see [the overlay](routing.md#overlay-evpn-and-vxlan)). It carries a group ID (0–255), optional authentication, an
optional virtual IP, plus a description, tags, and custom fields.

Members are added as **assignments**: each binds the group to exactly one device
or VM interface, with an election priority. You manage members inline on the
group's detail page (add an interface and priority, or remove one). The list
filters by protocol and tags.

## IP statuses & IP roles

Following Danbyte's **zero pre-filled data** rule, no statuses or roles ship with
the product - you define exactly the ones your network uses:

- **IP status** - the operational state of an address (for example *Active*,
  *Reserved*, *Deprecated*), each with a color shown as a badge.
- **IP role** - the functional role of an address (for example *Gateway*,
  *Loopback*, *VIP*). One role can be marked the gateway role, which
  [gateway autospawn](gateway-autospawn.md) uses to pick the right address.

See [IP statuses & roles](catalogs-and-settings.md) for managing these catalogs,
and [Tags & custom fields](tags-and-custom-fields.md) for attaching your own
attributes to any of these objects.

## NAT rules

A **NAT rule** records a translation your firewall performs - a port forward, a
1:1, a source NAT - so the next person can answer *"what is 203.0.113.10:443?"*
without reading a rule base they may not have access to.

!!! note "Documentation, not configuration"
    Danbyte writes nothing to any firewall. Deleting a rule here removes the
    record; the box keeps doing whatever it is doing.

A rule carries:

- a **name**, a **type** (*Destination NAT*, *Source NAT*, *Static (1:1)*,
  *Masquerade*) and a **protocol** (TCP, UDP, TCP/UDP, ICMP, Any);
- the **firewall** it runs on - an ordinary Device link, so a firewall's page
  can show everything it translates. Deleting the device leaves the rule: you
  replaced a box, the mapping did not stop existing;
- the **outside** end - an *external address* and *external port*;
- the **inside** end - an *internal address* and *internal port*;
- an optional **source restriction** - a prefix ("our office only") or a single
  address. Both blank means anyone;
- a **status** (*Active*, *Planned*, *Disabled*), a description, tags and
  custom fields.

Both address ends point at real **IP address** records wherever you have them,
so a public address's page shows what it forwards to and an internal server's
page shows what reaches it. Either end may be left blank - a masquerade rule
has no external address of its own, and an address you have not recorded yet
should not stop you writing the rule down.

### Ports

A port field takes **one port** (`443`) or an **inclusive range**
(`8000-8100`). Two rules the form enforces, because a record of a rule no
firewall could implement reads exactly like the truth:

- a protocol that carries no ports (ICMP, Any) may not have any;
- an external **range** needs an internal range of the **same size**, or no
  internal port at all - forwarding a range straight through keeps the port
  numbers.

Rules are listed under **Services → NAT rules**, are found by global search on
name, address or port, and carry the usual journal and change log.

## Service templates

A **service template** is a reusable service definition - a name plus its ports
- that you define once and reuse when adding **Services** to devices and VMs.

Ports are entered **per protocol**: a **TCP ports** field and a **UDP ports**
field, either of which may be left empty. Most services fill in one (*HTTPS -
TCP 443*), but a service that answers on both is one definition, not two:
*DNS - TCP 53 · UDP 53*. Each port is monitored with its own protocol. Following the **zero pre-filled data** rule, no
templates ship with the product: you create exactly the ones your network uses
(for example *HTTPS - TCP 443* or *DNS - UDP 53*).

Templates are tenant-scoped, carry an auto-generated slug (unique per tenant),
and require at least one valid port (1-65535) across the two fields. Like Services they support
custom fields and tags - a NetBox import carries both over. They are exposed at
`/api/service-templates/` (add `?picker=1` for a lightweight id/name/protocol/
ports list used by the service form).
