---
icon: lucide/calendar-x
---

# End-of-life data

Danbyte can read platform end-of-life dates from a public source -
[endoflife.date](https://endoflife.date) today - and show them where you work:
the platform page, the device and VM lists, and compliance rules.

It is **off by default** and deployment-wide. Nothing is mapped for you: the
fetched catalog is cached data, and a platform gets end-of-life dates only when
someone picks its product and cycle.

!!! note "Not the same as the lifecycle fields"
    The [lifecycle fields](lifecycle.md) on device types and platforms are dates
    you enter by hand. End-of-life data is fetched and kept separate; neither
    overwrites the other.

## Turn it on

A deployment admin (`users.manage`) opens **Settings → General → End-of-life
data**:

| Setting | Meaning |
|---|---|
| Enabled | Off by default. While off, nothing is fetched and every end-of-life field reads as off. |
| Source | Which sources a refresh fetches. endoflife.date is the only one built in. |
| Source URL | Blank uses the public service. A mirror or proxy goes here; it must be `https://`. |
| Warning window | Days before end of life that read as *Support ending*. Default 180. |

**Refresh now** fetches in the background. Every request goes through the
[SSRF guard](../reference/settings.md#outbound-requests-ssrf-guard), so a
mirror on a private address must be allow-listed first.

### Airgapped installs

Leave the source URL blank and use **Import file** instead. On a machine that
can reach the internet, save

```text
https://endoflife.date/api/v1/products/full
```

and upload it. The import fills the same catalog a refresh does and updates
every mapping at once. Nothing is fetched.

### Refresh schedule

The `danbyte-eol-refresh` timer (`manage.py eol_refresh`, daily at 05:35) fetches
each enabled source and updates every mapping from the catalog. While the
feature is off it does nothing. It appears under **Jobs → Scheduled tasks**.

A mapping is only written when its facts change, so the change log shows real
changes, not every refresh. A product or cycle that leaves the catalog keeps its
last known dates and is marked *Not in catalog*.

## Map a platform

On a platform's page, the **End of life** card shows the mapping. With
`platform.change`, **Map** opens a picker:

- **Product** - searchable over the cached catalog. Products that match the
  platform's name, slug or manufacturer are listed first as *Suggested*; a
  suggestion is never applied on its own.
- **Cycle** - the product's release cycles, with their end-of-life dates.
  Picking a suggested product preselects the cycle the platform's name points
  at ("Ubuntu 22.04" → 22.04).

Saving copies the cycle's facts onto the mapping:

| Fact | From |
|---|---|
| Released | the cycle's release date |
| Active support until | end of active support (bug fixes) |
| End of life | end of security support |
| Latest version | the newest release in the cycle |
| LTS | whether the cycle is long-term support |

**Remove** deletes the mapping. Mappings are scoped like the platform (one
tenant), and creating, changing or removing one is recorded in the
[change log](change-log.md).

## Status

| Status | When |
|---|---|
| Supported | End of life is beyond the warning window, or the source says the cycle is maintained and gives no date. |
| Support ending | End of life falls within the warning window. |
| End of life | The end-of-life date has passed, or the source says the cycle is end of life. |
| Unknown | No mapping, or the source gives no answer. |

The status is worked out when it is read, so *Support ending* moves with the
calendar without a refresh.

## Where it shows

- **Platform page** - the status badge in the header and the End of life card.
- **Platforms, Devices and Virtual machines lists** - an *End of life* column
  with a facet, from the platform's mapping. Shown only while the feature is
  on; the rows carry it in the same query, so a page of rows costs no extra
  queries.
- **API** - `eol` on platforms, and on the nested `platform` of devices and VMs
  (`null` while the feature is off). Filter lists with
  `?eol=supported|ending|eol|unknown` (comma-separated for several) on
  `/api/platforms/`, `/api/devices/` and `/api/virtual-machines/`.

## Compliance rules

A [compliance rule](compliance.md) with the **End-of-life status** check fails
a device or virtual machine on its platform's status:

| Fails on | Fails when the status is |
|---|---|
| End of life | End of life |
| Support ending or ended | Support ending or End of life |
| No end-of-life data | Unknown |

The failures show up as ordinary violations - the Compliance page, the
violation markers on the device list, and each device's compliance page. While
the feature is off these rules report nothing.

## API

| Endpoint | Who |
|---|---|
| `GET /api/eol/settings/` | Anyone signed in reads `enabled` and `warning_days`; deployment admins get everything |
| `PATCH /api/eol/settings/` | Deployment admin |
| `POST /api/eol/refresh/` | Deployment admin; queues the refresh |
| `POST /api/eol/import/` | Deployment admin; multipart `file` |
| `GET /api/eol/products/?q=&platform=&limit=` | `platform.view`; `platform` adds `suggestions` |
| `GET /api/eol/products/<source>/<name>/` | `platform.view`; the product's cycles |
| `GET /api/eol/platforms/<id>/` | `platform.view` on that platform |
| `PUT /api/eol/platforms/<id>/` | `platform.change`; body `{"product", "cycle"}` |
| `DELETE /api/eol/platforms/<id>/` | `platform.change` |

The tenant endpoints answer `404` while the feature is off.

## More sources

A source is a small class registered with
`compliance.eol_sources.register_source()`. It fetches through `core.ssrf` and
turns the payload into products with release cycles. A plugin can register its
own from its `danbyte_plugin.py`.
