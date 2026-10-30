---
icon: lucide/workflow
---

# Application flows

An application flow records traffic an [application](applications.md)
needs: from one end to another, on a protocol and ports - *web servers to
the database on TCP 5432*, *the office to the web tier on TCP 443*. Flows
are documentation, like [NAT rules](ipam-objects.md#nat-rules): nothing is
pushed to a firewall.

Flows live on their application. Its **Flows** tab lists them, and its
**Diagram** tab draws them on the [Application map](#application-map). Devices, virtual machines, IP addresses and
prefixes have a **Flows** tab too, listing the flows that touch them. A
[requirement](#requirements) writes flows for you from where an application
is installed.

Nothing ships pre-filled: no flows, no requirements. The three statuses below are seeded so
the status picker is not empty.

## The flow

| Field | |
|---|---|
| Application | The [application](applications.md) the traffic belongs to. Required. |
| Name | Required, unique within the application, e.g. `web to database`. With the application's slug, it is the import key. |
| Source | Exactly one of an **address**, a **range**, a **prefix** or **Any**. |
| Destination | The same choice. |
| Protocol | `TCP`, `UDP`, `TCP/UDP`, `ICMP` or `Any`, as on a NAT rule. |
| Ports | Ports and inclusive ranges, comma-separated: `443`, `80, 443`, `8000-8100`. Blank means every port. ICMP and Any take no ports. |
| Direction | **One way** (source to destination) or **Both ways**. |
| Status | From the [status catalog](catalogs-and-settings.md#statuses): **Active**, **Planned** and **Retired** are seeded for flows, Active the default. |
| Service | Optional: the [service](../dcim/devices.md#other-tabs) the destination answers on. When the destination is an address, the service must be on that address or on its device or VM. |
| Description, tags, custom fields | |

Deleting an address, range or prefix that a flow names as an end deletes the
flow with it. An application with flows or requirements cannot be deleted,
nor one another application's requirement names as *Hosts of*: the refusal
names them.

## Both ends

Each end is exactly one kind. Picking another kind in the dialog clears the
first; the API does the same when a write names one kind of an end and
leaves the others out. Two kinds at once, or none, is refused with a field
error on `source` or `destination`.

An address end shows the device or VM it is assigned to after the address
(*10.1.0.10 web-01*), and the diagram titles its card with that name.

## Where flows show

| Page | Flows tab lists |
|---|---|
| Application | Its flows. Overview shows the count. |
| Device, virtual machine | Flows with an end at one of its addresses, or at a prefix or range that holds one (in the same VRF). |
| IP address | Flows with this address at an end, or a prefix or range that holds it. |
| Prefix | Flows with this prefix at an end. |

The tab has the shared list: search, the columns menu (*Service* is in it),
**Add flow**, the row's edit and delete, and ticked rows deleted together.
Adding from an address or prefix starts the flow there as its source.

The **Applications** list has a **Flows** column.

## Requirements

A requirement says what an application needs without naming addresses:
*the hosts of WMS client to the hosts of Broker, TCP 5672*. Danbyte
documents it as ordinary flows, one per pair of addresses, and keeps them in
step: install the application on a host, or give a host an address, and its
flows appear; take it away and they go. The flows it makes are
**generated** and read like any other flow everywhere flows show.

Requirements live on the application's **Requirements** tab, after Flows.
Its Overview counts them.

| Field | |
|---|---|
| Name | Required, unique within the application. Generated flows are named `<requirement>: <source host> → <destination host>`, with the addresses added when one pair of hosts has several. |
| Source, Destination | **This application** (every host it is installed on), **Hosts of application** (another application's hosts), or a fixed **address**, **range**, **prefix** or **Any**. At least one end is *This application*; *Hosts of application* may not name the application itself. *This application* on both ends documents its hosts to each other (cluster peers) and never pairs a host with itself. |
| Protocol, Ports, Direction | As on a flow. |
| Status | The status the generated flows carry, from the flow statuses. Retired makes them read Retired. |
| Address (under More) | Which address a host end uses: **Primary address** (the default for *This application*: the host's primary address, or its only address), **Service address** (the default for *Hosts of application*: the address of the service its install names, else the primary; the flow's service is set to it), **Addresses with a role** (every address of the host with that [IP role](catalogs-and-settings.md), such as a VIP), or **Every address**. |
| Family (under More) | Any, IPv4 or IPv6, applied after the address pick. |
| Pairing (under More) | **Every host** (the default) pairs each host with every host of the other end; **Same site** pairs only hosts at one site - a WMS client with its own warehouse's broker. |

Child applications are not included: *Hosts of Broker* means hosts with
Broker itself installed. Hosts in any status count. Hand-made flows stay as
they are; nothing turns them into requirements.

### Preview and state

The dialog previews what saving documents before you save: *Documents 96
flows on 48 hosts; 2 hosts have no usable address*. Above 500 flows it
warns; above 5,000 it refuses, and the requirement reads **Unresolved**
until you narrow it with pairing or address, or raise the limit
(`FLOW_REQUIREMENT_WARN_PAIRS`, `FLOW_REQUIREMENT_MAX_PAIRS` in
[settings](../reference/settings.md#application-flow-requirements)).

| State | |
|---|---|
| Resolved | Every host has its flows. |
| Partial | Some hosts have no usable address ("no primary address", "no address with the role"). |
| Unresolved | The other application is not installed anywhere, or there are too many pairs. |
| Idle | This application is not installed anywhere yet. Not an error. |

A row opens its panel: its **Flows**, the hosts **Missing** an address (a
host you may not view is counted as "N more", never named), the
**Excluded** pairs with **Restore**, and its **Change log**. **Re-resolve**
runs it again now.

### What keeps them in step

The generated flows follow every change that moves an end, after the change
is saved:

- an install added, removed or moved to another host - including those an
  [application group](applications.md#application-groups) or a
  [device profile](device-profiles.md) makes;
- an address added, readdressed, reassigned, given another role or deleted;
- a device's or VM's primary address or site;
- a service's address, or the service an install names;
- the requirement itself saved or deleted.

Small changes resolve at once. A large one (more than about 250 pairs to
touch, such as editing a requirement across a fleet) runs as a background
job on the [Jobs](jobs.md) page; the job reads everything again by id, so a
requirement or tenant gone by then is skipped. A nightly sweep (the
`danbyte-cleanup` timer, `reconcile_flow_requirements`) resolves every
requirement again, healing writes made without the usual save.

### Generated flows

The flows tables' **Origin** column reads *Manual*, or a **Generated** badge
whose tooltip names the requirement and the installs behind it (*WMS client
4.2 is on wms-07*); filter on it with the facet.

- **Ends are the requirement's.** A generated flow's ends, name and
  application cannot be changed; its edit dialog shows them read-only.
  **Detach** makes it a hand-made flow at the same site and excludes its
  pair, so the requirement does not make it twice.
- **Edits are kept.** Changing its protocol, ports, direction, status or
  service marks it **Edited** (a warning badge) and the requirement leaves
  that field alone from then on. **Follow requirement** drops the edits.
  The description and tags are yours and never count as edits.
- **Deleting excludes.** Deleting a generated flow asks *Exclude this pair
  from WMS to Broker?*, records the exclusion and removes the flow; the
  pair stays out until you **Restore** it on the requirement. Ticked rows
  deleted together are excluded one by one.
- **When it stops applying.** A flow whose pair no longer applies (the
  host went, the address changed) is deleted - unless it was edited, then
  it stays as a hand-made flow with a journal note *Kept after requirement
  … stopped applying*. Deleting a requirement does the same with all its
  flows.

Each generated flow's change-log entry names the user who made the
triggering change and a [cause](change-log.md#cause): *Requirement 'WMS to
Broker': WMS client installed on wms-07*. The sweep writes as the system.

### The host's Flows tab

A device's or VM's **Flows** tab opens with the requirements that apply to
it through its installs: *WMS to Broker · WMS client → Broker · TCP 5672 ·
2 flows*, or a warning badge saying why it has none (*no primary address*,
*Broker is not installed anywhere*). Give the host an address and its flows
appear.

## Application map

**Maps → Application map** (`/application-map`) draws your applications
with the [topology](topology.md) Diagram's cards, row bands, lines and
export, in the app's light or dark theme. Two views, switched in the
header:

- **Tree** (default) - the application tree from **Parent**: one row band
  per depth, a card per application with its installs and flows
  (*2 installs · 1 flow*), a solid line from each parent to its children.
  Three levels are named *Domains*, *Processes* and *Applications*; one
  level is *Applications*; other depths are *Level 1*, *Level 2*… Each
  application has a colour: its first coloured tag's, else one picked
  from a palette of twelve by the application's id (the same on every
  load, readable in both themes). It shows as a thin bar on the card's
  left edge, on the application's host lines and beside its name in a
  host's panel. **Hosts** (the second bar) places the devices and VMs the
  applications are installed on:
    - **Row** (default) - one last *Hosts* row, each host under the mean
      position of its applications (a host with one application right
      under it). Its dashed lines run as elbows: each application's lines
      drop into a channel of their own in the gap above the row, so they
      travel as one bundle, and meet each host at the application's own
      point along its top edge, in the applications' order.
    - **Under applications** - a small copy of each host under every
      application it runs, showing the version installed, so there are no
      long lines; a host with four applications appears four times.
    - **Off** - applications only.

    The choice is in the URL (`hosts=row`, `hosts=under`, `hosts=0`). A
    VM's card is dashed.
- **Flows** - a row band per application, a card per flow end (an address
  titled with its device or VM, a range, a prefix, *Any*) laid out as the
  flows run, sources left of their destinations, and one line per pair of
  ends carrying the protocols and ports of all its flows (`TCP 443`; past
  three, a count). A line takes its flows' status colour - neutral when
  they differ - is dashed while they are all *Planned* and faded once all
  *Retired*. Arrowheads point the way the traffic runs; a flow *Both ways*
  has one at each end. A line leaves a card's side and enters the facing
  side through a channel of its own between the two columns; an end many
  flows meet sits at the top or bottom of its column.

In both views no line crosses a card it does not join: one that would - a
line spanning a column, a card dragged into its way - goes round the
cards as an elbow, and is planned again when a card is dropped. A
protocol label sits on its line clear of the cards and of other labels;
with no room anywhere it shows only while its line is hovered or
selected.

Hover or select a card to bring it forward with its lines and the cards
at their other ends - an application's hosts, a host's applications, a
flow end's peers - and fade the rest. In the Tree view focus follows the
hierarchy: an application also brings its whole subtree (every
descendant with its host lines and hosts) and its parents up to the
root, so hovering a parent with no installs of its own lights everything
under it; a host also brings its applications' parents. The lines up to
the parents stay plain rather than thickened. **Esc** or a click on the canvas
lets go. Hovering a host line names its application and version
(*Redis · 7.2*).

Click a card for its panel: an application's path, parent, counts and tags
with **Open application** and **Installs**; a host's installs; a flow
end's flows. Click a line for its flows - each with its status pill, ends,
service and direction and a **Flows tab** link - or a Flows row's title
for its application. Right-click a card for **Open**, **Focus**, **Flows
touching this host** and **Hide** (++h++).

**Filters** (header) take applications (several; the Tree keeps their
ancestors and children) and a host - the applications installed on it, or
in Flows the flows touching it, at its addresses or a prefix or range
holding one - and in Flows a status and a protocol. **Objects** opens the
maps' sidebar: search (non-matches fade), the cards by group with their
eyes; hidden cards are remembered per browser.

Cards drag freely. Each view's moved cards, the view, the filters and the
search are kept in the URL, so **Copy link** shares the map as arranged;
**Reset layout** puts the cards back. Saved views are the topology's own
and do not hold application maps yet.

**Export** writes PNG, SVG, PDF or draw.io, or prints - the
[topology's export](topology.md#pdf-export-api), with the same paper and
*Title and legend* choices, drawn from the map's data (every card, as
arranged, in the print theme). The PDF comes from `POST
/api/diagram/export/pdf/` with `"kind": "application-flows"`, which needs
`applicationflow.view`. The legend keys the cards, the lines (in the Tree,
*Line colour follows the application*) and, in Flows, the statuses
present. Exports carry the application colours and the lines as routed on
screen.

An empty map says how things get onto it: applications in the
[Applications](applications.md) list, installs on a device's or VM's
**Software** tab, flows on an application's **Flows** tab.

### The Diagram tab

An application's **Diagram** tab is the same map, embedded and filtered to
that application: **Flows** (its flows) or **Tree** (its ancestors,
children and, with **Hosts**, where it runs), the legend folded, the
panels, **Reset layout** and **Export** (named after the application's
slug). **Open in Application map** opens the full page on the same view
and application.

## Import & export

Flows are in [Import & export](import-export.md) as `applicationflow`,
matched by `application` (slug) and `name`. An address end is written by
address, a prefix by CIDR, a range by its id; a `*_any` column is `True` or
`False`.

```csv
application,name,source_ip,source_any,destination_prefix,destination_any,protocol,ports
shop,web to db,10.1.0.10,False,10.2.0.0/24,False,tcp,5432
shop,ping,,True,,True,icmp,
```

## Permissions

`applicationflow` is its own object type. A flow belongs to the site of
its first end that has one: the source address (its own site, else its
prefix's), the destination address, the source prefix, the destination
prefix, then the ranges' prefixes. A site editor records the flows of their
sites; a site viewer reads them. A flow between two *Any* ends has no site.
Every reference - application, addresses, ranges, prefixes, service,
status, tags - must be the active tenant's.

Requirements are `applicationflowrequirement`, a tenant-wide catalog like
applications: only a tenant-wide editor writes them, and the site roles read
them. Their generated flows are ordinary flows with the same site rule, so a
site editor may change a generated flow's status or description at their
sites and detach it, but not move its ends. A site editor's install may
still make flows that reach another site's hosts: they are derived from
an allowed change and carry its user in the change log. When a flow's first
end is another site's address (*Broker hosts → this application*), the flow
is that site's, as a hand-made one would be.

A reader who may read a flow but not one of its ends - a Site A viewer
reading a flow to a Site B address - sees that end as *Hidden*, and a
generated flow's name reads *Hidden* where it names that host: the table,
the Application map, the diagram and its PDF name no address, DNS name,
range, prefix, device or VM for it, and searching flows does not match on
it. An address end they may view still leaves out a device or VM they may
not. Editing such a flow keeps the hidden end unless you pick another.
A requirement's fixed end you may not view reads *Hidden* too, and its
missing hosts and preview count a host you may not view without naming it.

The masked name (*WMS to Broker: wms-1 → Hidden*) is the name everywhere
that reader meets the flow:

- the flow picker, the spreadsheet export (an export filter on `name` is
  refused for them), export templates (a flow whose name is masked is left
  out of the rows, as a label for one is refused), global search (it
  matches the masked name, not the stored one), and custom-field labels;
- the change log - the entry's object, its `name` diff and snapshots, a
  search of the log, and the agent's change history. The cause of a
  resolver's change reads just *Requirement 'WMS to Broker'*: the trigger
  behind it can name a host or flow at any site. The log is masked when
  read; the stored history is unchanged;
- a requirement's **Excluded** pairs and its journal notes (*Excluded the
  pair …*), whose label is the flow's name. A restored pair whose ends
  can no longer be told reads *Hidden* whole.

Saving a payload or an import row that repeats the masked name keeps the
stored one. A superuser, and a reader who may view both ends, read the
stored name.

## API

| Endpoint | |
|---|---|
| `/api/application-flows/` | CRUD, `?picker=1` (`{id, name, application}`), `POST bulk-update/` (`status_id`, `direction`, `description`, tags), `POST bulk-delete/`. |

Filters:

| Filter | |
|---|---|
| `?application=` | The application's flows. |
| `?ip=` | Flows with the address at either end, or a prefix or range holding it in the same VRF. |
| `?device=`, `?vm=` | The same for every address assigned to the device or VM. |
| `?prefix=`, `?range=` | Flows with the prefix or range at either end. |
| `?protocol=`, `?direction=`, `?status=`, `?service=` | Exact. |
| `?requirement=` | The requirement's generated flows. |
| `?generated=` | `true` for generated flows, `false` for hand-made ones. |
| `?search=` | Name (a generated flow's only while you may view both ends), description, application name, ports, and the end addresses and CIDRs you may view. |

A flow carries `application` (`{id, name, slug, path}`), `source` and
`destination` (`{kind, id, label, device, vm, hidden}` - `kind` is `ip`,
`range`, `prefix` or `any`), the ends' own references (`source_ip`,
`source_range`, `source_prefix`, `source_any`, and the `destination_*`
set), `protocol`, `ports`, `direction`, `status` and `service`. An end you
may not view comes back `{"kind": …, "id": null, "label": "Hidden",
"device": null, "vm": null, "hidden": true}` with its reference
(`destination_ip`, …) `null`, as is a `service` or an end's `device` or `vm`
you may not view. A write that leaves an end's keys out keeps that end. Write `application_id`,
`source_ip_id`, `source_range_id`, `source_prefix_id` or `source_any`, the
`destination_*` equivalents, `status_id` and `service_id`.

A flow also carries `requirement` (`{id, name}` or `null`), `generated`,
`overridden_fields` (the fields edited on a generated flow) and
`source_install` / `destination_install` (`{id, application, version,
host}`, `null` when you may not view the install). On a generated flow a
write that changes an end, the name or the application is a `400` *Generated
by a requirement - detach it first*; `POST <id>/detach/` makes it hand-made,
`POST <id>/follow/` drops its edits, and `DELETE` records an exclusion.

| Endpoint | |
|---|---|
| `/api/application-flow-requirements/` | CRUD and `POST bulk-delete/`. A create or edit answers the requirement with `resolution` (the counts, or `{job}`). |
| `POST /api/application-flow-requirements/preview/` | The payload of a create (or an edit, with `id`) without saving: `{pairs, hosts, state, detail, warn, refused, warn_at, max, gaps, hidden}`. |
| `POST …/<id>/resolve/` | Resolve now: `{created, updated, removed, released, gaps, state, pairs}`, or `{job}`. |
| `GET …/<id>/gaps/` | `{state, detail, gaps: [{side, host, reason}], hidden}`. |
| `GET`/`POST …/<id>/exclusions/`, `DELETE …/<id>/exclusions/<eid>/` | The excluded pairs; add one by `binding_key`; Restore one. |

Requirement filters: `?application=`, `?references=<application>` (whose
*Hosts of* end is that application), `?state=`, `?search=`, and `?device=`
or `?vm=` (the requirements applying to that host, each with `host:
{flows, reason, state}`). A requirement carries `source` and `destination`
(`{kind, id, label, application, address, address_role, hidden}`),
`state`, `state_detail`, `generated_count`, `gap_count`, `resolved_at` and
`exclusions`. Write `application_id`, `source_kind` (`self`, `app`, `ip`,
`range`, `prefix`, `any`), `source_application_id`, `source_ip_id`,
`source_range_id`, `source_prefix_id`, `source_address` (`primary`,
`service`, `role`, `all`), `source_address_role_id`, the `destination_*`
set, `family`, `pairing` (`all`, `same_site`), `protocol`, `ports`,
`direction`, `status_id`, `description`, `tag_ids` and `custom_fields`.

```bash
curl -X POST https://danbyte.example/api/application-flow-requirements/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id": "…", "name": "WMS to Broker",
       "source_kind": "self", "destination_kind": "app",
       "destination_application_id": "…", "pairing": "same_site",
       "protocol": "tcp", "ports": "5672"}'
```

```bash
curl -X POST https://danbyte.example/api/application-flows/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id": "…", "name": "web to db",
       "source_ip_id": "…", "destination_ip_id": "…",
       "protocol": "tcp", "ports": "5432"}'
```
