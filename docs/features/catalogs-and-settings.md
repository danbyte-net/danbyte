---
icon: lucide/list-checks
---

# Statuses & roles

Danbyte ships **no** statuses or roles — following the zero pre-filled data rule,
you define exactly the ones your network uses. Both live as small catalogs you
manage yourself, and both drive defaults and behaviour elsewhere in the app.

## Statuses

A **status** describes the operational state of an object — for example
*Active*, *Reserved*, or *Deprecated*. Each status has a name, a color (shown as
a badge wherever the status appears), and an optional description.

Statuses are **shared across object types**: one *Active* row can be made
available to devices, prefixes, IP addresses, racks, … so it reads identically
(same color) everywhere. Each status picks which objects it applies to:

| Field | Effect |
|---|---|
| **Available to** | The object types this status can be used on (IP addresses, Devices, Prefixes, Racks, Clusters, VMs, Cables, Circuits, Power feeds, Wireless LANs, Tunnels, Locations, IP ranges). Only statuses available to an object show in its form. |
| **Default for** | Object types for which this status is applied on create. At most one default per (tenant, object type) — a subset of *Available to*. |

IP-specific flags still apply when a status is available to IP addresses:

| Flag | Effect |
|---|---|
| **Available** | Marks the status as "this address is free to use" (utilisation maths). |
| **Requires note** | Prompts for a note when an IP is set to this status. |

The built-in statuses your tenant had in use (Active, Reserved, …) are seeded
on upgrade and merged — so the *Active* you used on IPs becomes the *Active*
your devices and prefixes use too. Manage them all under **Statuses**.

!!! tip "Statuses can opt out of monitoring"
    The monitoring **skip** policy can name statuses whose addresses aren't
    checked — point it at *Reserved*, say, and reserved IPs won't be polled.

## IP roles

An **IP role** describes the functional purpose of an address — for example
*Gateway*, *Loopback*, or *VIP*. Like statuses, each role has a name, a color, an
optional icon, and a description.

Roles carry their own flags:

| Flag | Effect |
|---|---|
| **Gateway role** | Marks this as *the* gateway role, which [gateway autospawn](gateway-autospawn.md) uses to create gateway addresses. At most one per tenant. |
| **Virtual** | Marks the role as virtual (e.g. a VIP rather than a physical interface address). |

## Managing the catalogs

Both catalogs work the same way: a list page (filterable by their flags), plus
create, edit, and delete. The form gives you a color picker, the flags above, and
a sort weight to control display order. When you delete a status or role that's
in use, Danbyte warns you how many addresses reference it first.

## Display preferences

Separately, your own **Preferences → Display** page controls how Danbyte looks
and behaves for you:

| Setting | What it does |
|---|---|
| **Theme** | Light or dark — applied immediately. |
| **Table density** | Comfortable or compact rows. |
| **Page size** | How many rows per page in tables. |
| **Timestamps** | Relative ("3h ago") or absolute in tables — the exact form is always on hover. |
| **Date format** | How calendar dates render: ISO (`2026-01-31`), `31.01.2026`, `01/31/2026`, `31 Jan 2026`, … |
| **Clock** | 24-hour (`14:30`) or 12-hour (`2:30 PM`). |
| **Timezone** | The IANA timezone times render in (e.g. `Europe/Copenhagen`). |
| **Striped rows** | Alternating row shading on/off. |
| **Confirm before deleting** | Whether delete actions ask for confirmation. |

These are saved to your own profile, so they follow you and don't affect other
users. Each acts as a personal override on top of the tenant default.

Date format, clock, and timezone default to **Auto (tenant default)**: they
follow the tenant's *Date & time* group under **Settings → This tenant**,
which in turn inherits the deployment default (**Settings → Deployment →
General**) until a tenant admin overrides it. Pick an explicit value to
override just for yourself; set it back to Auto to inherit again. Date pickers
across the app display dates in whatever format resolves for you (the value
stored is always ISO).

## See also

- [Gateway autospawn](gateway-autospawn.md) — how the gateway role is used.
- [VLANs, VRFs & route targets](ipam-objects.md) — the other IPAM catalogs.
- [Tags & custom fields](tags-and-custom-fields.md) — attach your own attributes.
