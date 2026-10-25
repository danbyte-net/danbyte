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
**Diagram** tab draws them. Devices, virtual machines, IP addresses and
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

## Diagram and export

The application's **Diagram** tab draws its flows: a card per end, sources
on the left and destinations to their right (a flow back against that order
runs right to left), one band for the application, and one line per flow
with its protocol and ports in the middle (`TCP 443`). A one-way flow has an
arrowhead at the destination; a flow both ways has one at each end. The
layout is the same every time for the same flows.

**Export** writes the drawing as PNG, SVG, PDF or draw.io, or prints it -
the [topology's export](topology.md#pdf-export-api), with the same paper and
*Title and legend* choices. The PDF comes from `POST
/api/diagram/export/pdf/` with `"kind": "application-flows"`, which needs
`applicationflow.view`.

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
