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
prefixes have a **Flows** tab too, listing the flows that touch them.

Nothing ships pre-filled: no flows. The three statuses below are seeded so
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
flow with it. An application with flows cannot be deleted: delete or move
its flows first.

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

## Application map

**Maps → Application map** (`/application-map`) draws your applications
with the [topology](topology.md) Diagram's cards, row bands, lines and
export, in the app's light or dark theme. Two views, switched in the
header:

- **Tree** (default) - the application tree from **Parent**: one row band
  per depth, a card per application with its installs and flows
  (*2 installs · 1 flow*), a solid line from each parent to its children.
  Three levels are named *Domains*, *Processes* and *Applications*; one
  level is *Applications*; other depths are *Level 1*, *Level 2*… With
  **Hosts** on (the second bar), the devices and VMs the applications are
  installed on sit in a last *Hosts* row, a dashed line to each of their
  applications. An application has no colour of its own: its card takes
  the colour of its first coloured tag, else it is neutral. A VM's card is
  dashed.
- **Flows** - a row band per application, a card per flow end (an address
  titled with its device or VM, a range, a prefix, *Any*) laid out as the
  flows run, sources left of their destinations, and one line per pair of
  ends carrying the protocols and ports of all its flows (`TCP 443`; past
  three, a count). A line takes its flows' status colour - neutral when
  they differ - is dashed while they are all *Planned* and faded once all
  *Retired*. Arrowheads point the way the traffic runs; a flow *Both ways*
  has one at each end.

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
`applicationflow.view`. The legend keys the cards, the lines and, in
Flows, the statuses present.

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
| `?search=` | Name, description, application name, ports, end addresses and CIDRs. |

A flow carries `application` (`{id, name, slug, path}`), `source` and
`destination` (`{kind, id, label, device, vm}` - `kind` is `ip`, `range`,
`prefix` or `any`), the ends' own references (`source_ip`, `source_range`,
`source_prefix`, `source_any`, and the `destination_*` set), `protocol`,
`ports`, `direction`, `status` and `service`. Write `application_id`,
`source_ip_id`, `source_range_id`, `source_prefix_id` or `source_any`, the
`destination_*` equivalents, `status_id` and `service_id`.

```bash
curl -X POST https://danbyte.example/api/application-flows/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id": "…", "name": "web to db",
       "source_ip_id": "…", "destination_ip_id": "…",
       "protocol": "tcp", "ports": "5432"}'
```
