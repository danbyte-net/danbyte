---
icon: lucide/file-text
---

# PDF reports

A **PDF report** prints devices, prefixes or IP addresses as clean tables,
in the [floor plan report](floor-plans.md#the-report)'s style: statuses,
roles and tags as square badges in their own colours, a table header that
repeats on every page, and the tenant, the date and the page number on each
page. You pick what goes in it.

## Where to start one

| From | Click | The report covers |
|---|---|---|
| A device, prefix or IP address page | **PDF report…** in the page actions | That object, on a page of sections |
| The Devices, Prefixes or IP addresses list | **Import / Export ▸ PDF report…** | Every row the list shows now (its search and filters) |
| The same lists, rows selected | **Export ▸ PDF report…** in the bulk bar | The selected rows |

**Print** opens the PDF in a new tab for the browser to print;
**Download** saves it.

## What you can choose

- **Title** - defaults to the object (*Device sw-a*) or *Devices report*.
- **Paper** - A4, Letter or A3, portrait or landscape.
- **List columns** (more than one object) - the same columns the list page
  offers, custom fields included. Tick a column to add it, drag its handle to
  order them.
- **Group by** - split the table by status, role, site and similar: one
  table per value.
- **Summary** - counts by status, role (or VRF) and site, each value as its
  badge.
- **One page per object** - after the table, a page for each object with
  the sections you tick. A single object always gets its page.
- **Show IPs** (prefixes) - each prefix in the table is followed by a small
  table of its IP addresses: address, status and role badges, DNS name and
  what it is assigned to. They are read like the IP list, so only the
  addresses you may view are shown, and they count towards the row limits.
  The per-object *IP addresses* section is separate.
- **Sections** - each with its own column picker:

| Type | Sections |
|---|---|
| Device | Overview (attributes and custom fields), Photo (the type's front and rear), Interfaces (type, status, LAG, VLANs, IPs, cable peer), IP addresses, Cables, Installed software (version, end of support, licence), Power ports, Console ports, Lifecycle (platform, software version, warranty, support coverage, next lifecycle date), Monitoring (each check's state), Journal, Change log |
| Prefix | Overview, Utilisation (a bar with the usable, used and free addresses), VLAN and VRF, Child prefixes, IP addresses (status and role badges, DNS names), IP ranges, Monitoring, Journal, Change log |
| IP address | Overview, Assignment (device or VM and interface, switch port, MAC), NAT, DNS records, Monitoring, Journal, Change log |

- **Journal and change log entries** - the latest N (20 until you change it,
  at most 200).

The dialog remembers your choices per type in this browser.

## Who sees what

A report reads exactly what the lists show you:

- An object you may not view - another site's under
  [site separation](permissions.md), or another tenant's - is left out, as
  the list leaves it out, and never named.
- A section whose objects you may not view (Interfaces without view on
  interfaces) is greyed out in the dialog and left out of the report with a
  note. Its rows are the rows its list would show you; a column the list
  shows (an interface's cable peer, say) prints as the list shows it.
- Nothing is written: a report is not recorded in the change log.

## Limits

| | |
|---|---|
| Objects in one report | 2,000 - more is refused with the limit; narrow the filters or select fewer rows |
| Objects with a page each | 50 |
| Rows in one section of one object | 500 (the report notes the rest) |
| Rows in all sections together | 20,000 |
| Columns in one table | 40 |
| Table cells in one report | about 12,800 (pages per object lower it) |

The PDF is made under the drawing PDFs' limits: one at a time per user, a few
across the server, and a 30-second render deadline. Rendering costs about
1.5 ms per table cell and 60 ms per object page, so before it renders a
report is estimated from its cells (rows times columns, Show IPs and
section tables included) and pages per object. One that would not finish in
about 70% of the deadline is refused at once (400) with what fits: how many
rows with these columns, how many columns for these rows, or to leave out
pages per object or Show IPs. For example, 2,000 IP addresses fit with six
list columns but not with the default nine; about 1,400 fit with nine.

A report that still runs past the deadline on a busy server is stopped and
answered with 503; try again later or with fewer rows or columns.

## API

`GET /api/devices/report/`, `/api/prefixes/report/` and `/api/ips/report/`
describe what a report can hold for the caller: `columns` and
`default_columns` (the list's column catalog, custom fields as `cf.<key>`),
`group_by`, `sections` (each `key`, `label`, `kind`, `available`, `note`,
`columns`, `default_columns`, `default`, `last`), `show_ips` (prefixes, with
view on IP addresses) and `limits` (`cells` is the estimate's table-cell
budget).

`POST` to the same path makes the PDF:

```json
{
  "ids": ["…"],
  "filters": {"search": "leaf", "site": "…"},
  "sections": ["overview", "interfaces", "journal"],
  "columns": {
    "list": ["name", "status", "role", "site", "cf.owner_team"],
    "interfaces": ["name", "type", "status", "link_peer"]
  },
  "options": {
    "title": "Leaf switches",
    "paper": "a4",
    "orientation": "landscape",
    "group_by": "site",
    "include_summary": true,
    "list_table": true,
    "per_object": false,
    "show_ips": false,
    "last": 20
  }
}
```

- `ids` - the objects; without it, every row `filters` matches.
- `filters` - the list endpoint's own query parameters (paging and picker
  parameters are ignored).
- `sections` and `columns` - unknown columns are dropped; a section missing
  from `columns` uses its defaults.
- `options.list_table` and `options.per_object` default to a table for many
  objects and a page for one.
- `options.show_ips` (prefixes) - each list row followed by its IP addresses.

The answer is the PDF as an attachment, or with `?print=1` `{url}`: a link
to it for five minutes, for the same user and tenant
(`GET /api/<type>/report/file/<token>/`, `?download=1` to save it). A 400
names the limit it hit, or what fits when the report is too large to render
in time; a 403 means no view on the type; a 503 means the render ran past
its deadline.

```bash
curl -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"filters": {"site": "…"}, "options": {"include_summary": true}}' \
  -o devices.pdf https://danbyte.example/api/devices/report/
```
