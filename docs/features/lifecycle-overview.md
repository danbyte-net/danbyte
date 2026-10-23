---
icon: lucide/calendar-clock
---

# Lifecycle overview

The lifecycle overview lists every device and virtual machine against the end
dates that matter to it, soonest first: the hardware's end of support, the
operating system's end of life and the end of the device's support coverage.
It answers "what goes out of support next, and where?" across the estate.

Nothing ships pre-filled. The dates come from what you enter on
[device types and platforms](lifecycle.md), the
[end-of-life data](end-of-life-data.md) you map platforms to, and your
[support contracts and warranties](support-coverage.md).

## Sources

Each object gets **one row per source**, so a device with a healthy chassis
and an operating system that ends next month sorts by the operating system,
and the chassis keeps its own row.

| Source | Start | End | Warning window |
|---|---|---|---|
| **Hardware** | the device type's *Released* | its *End of support* | the end-of-life warning window (180 days by default) |
| **OS** | the platform's [effective](lifecycle.md#the-effective-os-date) start | its effective end: *End of support* as entered, else its end-of-life cycle's end of life | the end-of-life warning window |
| **Coverage** | the start of the contract that sets the coverage end | the coverage end: the latest contract end or the warranty end | the tenant's coverage window (90 days by default) |

- Hardware and coverage rows are devices'; OS rows are devices' and virtual
  machines'. The OS is the object's own platform.
- An OS cycle's dates count only while end-of-life data is on; what you
  entered on the platform always wins.
- A coverage row names its contract, or *Warranty* when the warranty reaches
  further. A contract you may not view reads *Contract*, with no number and
  no start.

The **status** is each source's own: *Supported*, *Support ending*, *End of
life* or *Unknown* for hardware and OS (from the end and the end-of-life
warning window), *Covered*, *Expiring*, *Expired* or *Not covered* for
coverage.

## Windows

Every row falls in one fixed window, the same for every source, so sources
compare on one scale:

| Window | When |
|---|---|
| Past | The end has passed. An end of life counts from its day; a coverage end is the last covered day. A cycle its source marks end of life without a date is Past too. |
| ≤ 90 d | Ends within 90 days. |
| ≤ 180 d | Within 180 days. |
| ≤ 1 y | Within a year. |
| Later | Later than that - or never: an open-ended contract, or a cycle its source says is maintained without a date. |
| No date | No end and no state: no dates entered, nothing mapped, nothing covers the device. |

Rows with no date are counted but left out of the list unless you ask for
them.

## Permissions

The overview shows what you may view and nothing else:

- Devices and virtual machines are cut to your grants, site scope included.
  Without a grant on devices there are no hardware, coverage or device OS
  rows; without one on virtual machines no VM rows.
- A contract's number and start show only on a contract you may view.

## API

`GET /api/lifecycle/` - any signed-in user with an active tenant; the rows
follow the grants above.

| Parameter | |
|---|---|
| `source` | Comma-separated: `hardware`, `os`, `coverage`. Default: all. (`application` is reserved for installed software and lists nothing yet.) |
| `site` | A site id: only that site's devices and VMs. |
| `undated` | `1` also lists the rows with no date. |

```json
{
  "results": [
    {
      "object": {"id": "…", "name": "core-sw-01", "kind": "device"},
      "source": "os",
      "item": {"type": "platform", "id": "…", "name": "IOS XE 17.9",
               "date_source": "endoflife_date"},
      "status": "ending",
      "start": "2022-08-01",
      "end": "2026-11-30",
      "days_left": 39,
      "window": "d90",
      "site": {"id": "…", "name": "HQ"},
      "role": {"id": "…", "name": "Core", "color": "#2563eb"},
      "tenant": {"id": "…", "name": "Acme"},
      "manufacturer": {"id": "…", "name": "Cisco"},
      "tags": []
    }
  ],
  "counts": {"past": 3, "d90": 7, "d180": 4, "y1": 12, "later": 210, "none": 41},
  "windows": {"eol_warning_days": 180, "coverage_warning_days": 90},
  "eol_enabled": true
}
```

- `kind` is `device` or `virtualmachine`; `item.type` is `devicetype`,
  `platform`, `supportcontract` or `warranty`. `item.date_source` on an OS
  row is `entered` or the end-of-life source.
- `days_left` is negative once the end has passed; `end` and `days_left` are
  `null` without a date. `window` is `past`, `d90`, `d180`, `y1`, `later` or
  `none`.
- `counts` covers every row the request reaches, the undated ones included,
  whether or not they are listed.
- Rows come sorted by window, then days left.

The rows are read in a fixed number of queries however large the estate is,
and worked out when they are read, so a window moves with the calendar.
