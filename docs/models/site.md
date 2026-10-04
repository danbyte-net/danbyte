---
icon: lucide/map-pin
---

# Site

A physical location - DC, office, POP, edge.

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | |
| `tenant` | FK → `Tenant` | required | |
| `name` | char(255) | required | |
| `location` | char(255) | `""` | Free-form postal address (city, street, …). Labelled **Address** in the UI (to avoid clashing with the `Location` object). The API also exposes it read+write as `address`, an alias of this field - either name works; `location` is kept for backward compatibility. |
| `time_zone` | char(63) | `""` | IANA name (e.g. `Europe/Copenhagen`); validated against the zoneinfo set. The detail page shows the current local time so you can read the offset between sites. |
| `description` | text | `""` | |
| `gateway_policy` | choice | `first` | `first` · `last` · `none` |
| `vrfs` | M2M → `VRF` | empty | Documentation only - "VRFs operating at this site" |
| `tags` | M2M Tag | empty | |
| `custom_fields` | JSONB | `{}` | |

## Constraints

`unique_together = ("tenant", "name")`

## Gateway policy

When a new `Prefix` is created at a site and the prefix's `gateway` field is
empty:

- `first` → the first usable host (network + 1) becomes an `IPAddress(role=gateway)`
- `last` → the last usable host (broadcast − 1) becomes the gateway
- `none` → no autospawn

See [Gateway autospawn](../features/gateway-autospawn.md) for the full flow.

## Detail page

The site page tabs carry live counts (devices, prefixes, VLANs, circuits,
contacts). A **Circuits** tab lists the circuits terminating at the site - a
circuit's termination links to a site, so each site shows the WAN links landing
there, with the far end (another site or a provider network). `GET
/api/circuits/?site=<id>` powers that list.

The Sites list has **SLA** and **Availability** columns. A site's SLA is the
agreements [provided for it](../features/sla.md#the-parts-of-an-agreement),
with each agreement's whole figure; its availability is over the site's
devices. The Circuits tab shows each circuit's SLA and availability too.

## Racks and cabinets

A site's **Racks** tab lists its racks - name, role, status, width and units
used - and **Cabinets** its DIN-rail cabinets, wherever in the site they
stand; a location's tabs list only its own.

## The Capacity tab

How full the site's racks are, floor plan by floor plan. The tab shows when
the site has racks and you may view racks; it sits after **Cabinets**.

- **One card per floor plan** of the site: its name - which opens the
  [floor plan](../features/floor-plans.md) - and location, a thumbnail of its
  rack tiles (only those, each marked on its front edge), and its racks added
  up: **Racks**, **Devices**, **Space** (units used, with the share),
  **Power** (demand over supply, as the rack page reads it) and **Ports** /
  **Panel ports** (in use over counted). A plan with no racks says so.
- **Space · Power · Ports · Panel ports** above the cards picks what the
  thumbnails are coloured by, on the racks' one scale: green up to 80 %,
  amber above 80 %, red above 95 %, grey where there is nothing to measure
  (no supply, no ports). The choice stays in the URL (`?measure=power`).
- **Not on a floor plan**: the site's racks that no floor plan places, by
  name, with the same figures.
- The ports open **DCIM → Connections → Port utilization** filtered to the
  site (`/port-utilization?site=<id>`), for the per-device breakdown.
- Under **Power**, *PDU rating* and *No supply* count the racks whose supply
  is only their PDUs' inlet rating, or that have no supply figure at all -
  their demand still adds to the total.

A rack on a floor plan you cannot view is on no card - not on *Not on a
floor plan* either, as it does stand on one.

## Capacity

`GET /api/sites/{id}/capacity/` adds up the site's racks floor plan by floor
plan, for the site page's Capacity tab. The site's `rack_count` (on its own
`GET /api/sites/{id}/`) says whether it has any racks at all.

| Field | What it holds |
|---|---|
| `floor_plans` | One entry per [floor plan](../features/floor-plans.md) of the site: its `name`, `location`, `grid_width` / `grid_height`, the `racks` of the site that stand on it with their `totals`, and `tiles` - its rack tiles only (`rack_id`, `x`, `y`, `w`, `h`, `orientation`), enough to draw a thumbnail. |
| `unplaced` | The site's racks that stand on no floor plan, with their `totals`. |
| `totals` | Every rack of the site you can view. |
| `count_virtual` | Whether virtual interfaces were counted as ports. |

A rack carries its `role`, `status`, `u_height`, `u_used` and `u_pct` (units
in use, as a percentage), `power` (with `supply`: `feed`, `pdu_rating` or
null), `ports`, `panel_ports` and `device_count` - the figures its own
[rack page](../dcim/racks.md#api-a-floor-plans-racks-and-their-ports) gives
it. `totals` add these up, with the number of `racks` and `devices`; under
`power`, `pdu_rating` and `no_supply` count the racks whose supply is only
their PDUs' rating, or that have no supply figure at all.

It needs **view** on sites (another tenant's site, or one outside the sites
you are limited to, is a 404), and lists only the floor plans and racks you
can view. A rack on a floor plan you cannot see is in the site's `totals` but
on no card - it is not "on no floor plan". A rack's figures count every
device in it, as its units and power do. The answer costs about twenty
queries, whatever the site holds.

## Coming in Phase 4

`SiteMasterSubnet` - explicit CIDR blocks "owned" by a site, used to validate
new prefix creation at that site. Until then, a site can host any CIDR.
