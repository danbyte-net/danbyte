---
icon: lucide/list-checks
---

# Statuses & roles

Danbyte ships **no** statuses or roles - following the zero pre-filled data rule,
you define exactly the ones your network uses. Both live as small catalogs you
manage yourself, and both drive defaults and behaviour elsewhere in the app.

## Statuses

A **status** describes the operational state of an object - for example
*Active*, *Reserved*, or *Deprecated*. Each status has a name, a color (shown as
a badge wherever the status appears), and an optional description. The
statuses list shows the badge and, beside it, a **Color** column with the raw
hex value, sortable, so the exact value can be read or copied off the table.

Statuses are **shared across object types**: one *Active* row can be made
available to devices, prefixes, IP addresses, racks, … so it reads identically
(same color) everywhere. Each status picks which objects it applies to:

| Field | Effect |
|---|---|
| **Available to** | The object types this status can be used on (IP addresses, Devices, Prefixes, Racks, Clusters, VMs, Cables, Circuits, Power feeds, Wireless LANs, Tunnels, Locations, IP ranges, Inventory items, Maintenance & outage events). Only statuses available to an object show in its form. |
| **Default for** | Object types for which this status is applied on create. At most one default per (tenant, object type) - a subset of *Available to*. |

IP-specific flags still apply when a status is available to IP addresses:

| Flag | Effect |
|---|---|
| **Available** | Marks the status as "this address is free to use" (utilisation maths). |
| **Requires note** | Prompts for a note when an IP is set to this status. |

[Maintenance & outage events](maintenance.md) carry their workflow semantics
the same way - as flags on the row, so renaming a status never changes what it
does:

| Flag | Effect |
|---|---|
| **Suppresses alerts** | An event in this status silences monitoring alerts for its impacted devices. |
| **Closes the event** | An event in this status counts as finished and releases its silence. |

The built-in statuses your tenant had in use (Active, Reserved, …) are seeded
on upgrade and merged - so the *Active* you used on IPs becomes the *Active*
your devices and prefixes use too. Manage them all under **Statuses**.

!!! tip "Statuses can opt out of monitoring"
    The monitoring **skip** policy can name statuses whose addresses aren't
    checked - point it at *Reserved*, say, and reserved IPs won't be polled.

### Naming a monitoring check state

A check always ends in one of six states - *Up*, *Degraded*, *Down*,
*Unknown*, *Stale*, *Skipped*. Those are what alert rules, escalation and the
Outposts run on, and they never change. What you **call** them is yours: tick
**Speaks for a check state** on a status, pick the state, and that status's
name and colour replace the shipped ones everywhere monitoring is shown - the
Monitoring column and its split badge, the roll-up on a device or prefix, the
filter rail, and the charts on the Monitoring dashboard. Call *Down*
"Critical" in your own red and the whole product says Critical.

Two rules follow from what actually gets stored:

- **One status per state.** A check records the state, not the status, so a
  second claimant would be indistinguishable after the fact. The form says
  which status already has a state when you try to take it.
- **The state is still what travels.** Webhook payloads, the notification
  digest and the API keep sending `down` - the name is presentation, so a
  script you wrote against Danbyte doesn't break when somebody renames a
  status.

A status that speaks for a state also becomes pickable wherever a check state
is - mapping [Zabbix](../monitoring/zabbix.md) severities onto Danbyte
statuses, for one, which then reads in your vocabulary rather than ours.

## IP roles

An **IP role** describes the functional purpose of an address - for example
*Gateway*, *Loopback*, or *VIP*. Like statuses, each role has a name, a color, an
optional icon, and a description.

Roles carry their own flags:

| Flag | Effect |
|---|---|
| **Gateway role** | Marks this as *the* gateway role, which [gateway autospawn](gateway-autospawn.md) uses to create gateway addresses. At most one per tenant. |
| **Virtual** | Marks the role as virtual (e.g. a VIP rather than a physical interface address). |

## Finding a setting

**Settings** opens on a grid of every page you can reach, grouped by what a
setting is *about* - Identity & access, Integrations, Notifications, Your
data, Devices & polling, This install - rather than by which admin tier owns
it. Which tier a setting belongs to is a control on the page itself: a page
that exists at more than one scope, like Email or Directory, carries a
**Deployment / This tenant / This site** switch, and a card that is
inheriting shows the value it would fall back to.

The **search box** above the sidebar filters both the grid and the rail as
you type, and matches individual settings as well as pages: type "session
timeout" and the result is the **Sessions** card, not a list of pages to go
hunting through. Picking one opens its page scrolled to that card. It
matches a name, its description and its keywords, so "relay", "587" or
"starttls" all find the mail server.

The [global search](search-and-macs.md) reaches the same catalog, so you can
type "session timeout" from anywhere without opening Settings first.

Every page and card is declared once in
`frontend/src/lib/settings-catalog.json` - JSON because two languages read
it: the SPA builds both navigations and both searches from it, and the
assistant answers "where do I change X" from the same file. A page cannot
appear in one and be missing from another, and a test fails the build if a
card is renamed there without being renamed in the page that draws it.

## Managing the catalogs

Both catalogs work the same way: a list page (filterable by their flags), plus
create, edit, and delete. The form gives you a color picker, the flags above, and
a sort weight to control display order. When you delete a status or role that's
in use, Danbyte warns you how many addresses reference it first.

## Display preferences

Separately, your own **Preferences** page controls how Danbyte looks and
behaves for you. It is a set of small cards - *Appearance*, *Tables*, *Dates
and times*, *Navigation*, *Task emails*, *Space map* - each with its own
**Save** button; a card shows *Unsaved changes* until you press it. Only
*Appearance* applies as you change it: theme and link styling live in the
browser, not on your profile. Below the cards, *Table layouts* lists every
table grouped by area, with a filter, and a **Reset** per table to drop your
own column layout back to the tenant default.

| Setting | What it does |
|---|---|
| **Theme** | Light or dark - applied immediately. |
| **Table density** | Comfortable or compact rows. |
| **Page size** | How many rows per page in tables - 10 to 2000. |
| **Timestamps** | Relative ("3h ago") or absolute in tables - the exact form is always on hover. |
| **Date format** | How calendar dates render: ISO (`2026-01-31`), `31.01.2026`, `01/31/2026`, `31 Jan 2026`, … |
| **Clock** | 24-hour (`14:30`) or 12-hour (`2:30 PM`). Chart axes, time pickers and service hours follow it too. |
| **Timezone** | The IANA timezone times render in (e.g. `Europe/Copenhagen`). The list comes from the server's own timezone database, so every offered zone is one it accepts; renamed zones (`Europe/Kiev` → `Europe/Kyiv`) are converted on save. |
| **Landing page** | Where Danbyte opens right after you log in. |
| **One menu category open at a time** | Opening a sidebar category (or landing on one of its pages) closes the others, so only the section you are in is unfolded. Off by default: categories stay as you left them, and *Collapse all* / *Expand all* at the top of the menu still work either way. |
| **Striped rows** | Alternating row shading; on by default. |
| **Confirm before deleting** | Whether delete actions ask for confirmation. |

These are saved to your own profile, so they follow you and don't affect other
users. Each acts as a personal override on top of the tenant default.

Date format, clock, and timezone default to **Auto (tenant default)**: they
follow the *Date & time* card under **Settings → Tenant policy**, which in
turn inherits the deployment default (**Settings → Branding & identity →
Date & time**) until a tenant admin overrides it. Pick an explicit value to
override just for yourself; set it back to Auto to inherit again. Date pickers
across the app display dates in whatever format resolves for you (the value
stored is always ISO).

## See also

- [Gateway autospawn](gateway-autospawn.md) - how the gateway role is used.
- [VLANs, VRFs & route targets](ipam-objects.md) - the other IPAM catalogs.
- [Tags & custom fields](tags-and-custom-fields.md) - attach your own attributes.
