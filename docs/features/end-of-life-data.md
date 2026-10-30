---
icon: lucide/calendar-x
---

# End-of-life data

Danbyte can read end-of-life dates for platforms and applications from a
public source -
[endoflife.date](https://endoflife.date) today - and show them where you work:
the platform and application pages, the device and VM lists, and compliance
rules. For a product the source does not know, a tenant enters its own
[custom product](#custom-products) with its cycles.

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

- **Product** - searchable over the cached catalog and the tenant's
  [custom products](#custom-products), marked *Custom*. Products that match
  the platform's name, slug or manufacturer are listed first as *Suggested*;
  a suggestion is never applied on its own.
- **Cycle** - the product's release cycles, with their end-of-life dates.
  Picking a suggested product preselects the cycle the platform's name points
  at ("Ubuntu 22.04" → 22.04).

Saving copies the cycle's facts onto the mapping:

| Fact | From |
|---|---|
| Released | the cycle's release date |
| Active support until | end of active support (bug fixes) |
| End of life | end of security support, else the source's *end of life* flag |
| Latest version | the newest release in the cycle |
| LTS | whether the cycle is long-term support |

**Remove** deletes the mapping. Mappings are scoped like the platform (one
tenant), and creating, changing or removing one is recorded in the
[change log](change-log.md).

## Map an application

[Applications](applications.md) map to a **product only**: on an
application's page, the **End of life** card's **Map** asks for the product
(suggestions first, as for a platform). The cycle comes from each
[install's](applications.md#installed-software) version - "16.4" picks the
cycle "16" - unless the install names its cycle by hand.

Installs of one application on one cycle share one mapping, made the first
time an install needs it and filled from the cached catalog; the card lists
each cycle with its status and end of life. A mapping goes when its last
install goes or moves to another cycle, and **Remove** clears the product and
every cycle with it. The daily refresh and an import update application
mappings like platform mappings. All of it is in the change log.

## Custom products

endoflife.date does not list every product - an in-house application, a niche
appliance, a vendor's own support matrix. **DCIM → End-of-life products**
holds the tenant's own products. They are picked like any fetched product,
marked *Custom*, on platforms and applications, and from then on every
reader - the status, the lists' *End of life* column and filter, the OS and
software lifetime bars, the [Lifecycle overview](lifecycle-overview.md)
and its Versions view, an install's cycle, compliance rules - takes their
cycles exactly like fetched ones.

A product has:

| Field | Meaning |
|---|---|
| Name | What people read. |
| Key | What applications and platforms name the product by. Made from the name; set once. |
| Link | Optional - the vendor's support page. The application's End of life card links to the product's page here. |
| Notes | Optional. |

Its page lists the **Cycles**; **Add cycle** and each row's edit and delete
open a dialog:

| Field | Meaning |
|---|---|
| Cycle | The version prefix an install's version is matched on: `3.2` takes `3.2.7`, `16` takes `16.4`. The longest matching cycle wins, as for a fetched product. |
| Released | The cycle's release date. |
| Active support until | End of active support (bug fixes). Not after end of life. |
| End of life | End of security support - what the status reads. |
| Extended support until | End of paid or extended support, where the vendor sells it. Not before end of life. |
| Latest version | The newest release in the cycle. |
| LTS | Long-term support. |
| End of life reached | For a cycle without an end-of-life date. A cycle with neither reads as *Supported*. |

Cycles are kept newest first. Saving a product or a cycle updates every
mapping on it at once - the facts of the platforms and application cycles
mapped to it, and the cycle of each install of an application on it (unless
the install's cycle was set by hand), so adding cycle `4.0` picks up the
installs running 4.0.x.

Custom products are **tenant-scoped**: another tenant never sees, picks or
reads them, and two tenants may use the same key. Like applications and
platforms they are tenant-wide, not local to a site. No refresh or import
touches them, and they are kept while the feature is off (nothing reads them
until it is on again). A product an application or a platform still names
cannot be deleted - map those to another product first.

Permissions are the **End-of-life products** object type (`eolproduct`, under
Governance): view, add, change and delete. Picking a custom product for a
platform or an application needs only that object's own change permission,
as for a fetched product. Creating, changing and deleting a product is
recorded in the [change log](change-log.md), and its page has a Journal and
Change log tab.

## Status

| Status | When |
|---|---|
| Supported | End of life is beyond the warning window, or the source says the cycle is maintained and gives no date (a custom cycle not marked *End of life reached*). |
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
- **OS lifetime bars** - where a platform has no entered *Released* or *End of
  support*, the cycle's dates fill them in: the platform's *OS lifecycle* card
  and column, and the *OS support* row on device and VM pages. Entered dates
  win; the bar's tooltip says *Entered*, *endoflife.date* or *Custom
  end-of-life product*. See
  [The effective OS date](lifecycle.md#the-effective-os-date).
- **Lifecycle overview** - the OS rows of the
  [lifecycle overview](lifecycle-overview.md) (`GET /api/lifecycle/`) read
  the same effective date, for devices and virtual machines alike, and its
  software rows read each install's cycle the same way.
- **Installed software** - the *End of life* column and lifetime bar of the
  device and VM **Software** tabs, and `eol` on `/api/installed-software/`.
- **API** - `eol` on platforms, and on the nested `platform` of devices and VMs
  (`null` while the feature is off), next to `effective_release`,
  `effective_end` and `effective_source`. Filter lists with
  `?eol=supported|ending|eol|unknown` (comma-separated for several) on
  `/api/platforms/`, `/api/devices/` and `/api/virtual-machines/`.

The *End of life* column, the filter and compliance rules read the mapping
alone; the bars read the effective date.

## Compliance rules

A [compliance rule](compliance.md) with the **End-of-life status** check fails
a device or virtual machine on its platform's status:

| Fails on | Fails when the status is |
|---|---|
| End of life | End of life |
| Support ending or ended | Support ending or End of life |
| No end-of-life data | Unknown |

**Include installed software** (off by default, and off on every rule made
before it) also fails the device or VM when any application installed on it
is past or ending by the same rule - an install's entered *End of support*,
else its cycle's end of life. It applies to *End of life* and *Support ending
or ended*; the violation names the installs.

A [scope](compliance.md#scope-and-conditions) narrows which objects the check
judges - "production servers must not be end of life" is the scope *Device
role is any of Server* and *Tags is any of production* with this check. One
rule can cover devices and virtual machines together.

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
| `GET /api/eol/products/?q=&source=&platform=&application=&limit=` | `platform.view` or `application.view`; the fetched catalog and the tenant's custom products, each with `custom`; `platform` or `application` adds `suggestions` |
| `GET /api/eol/products/<source>/<name>/` | `platform.view` or `application.view`; the product's cycles. `source` is `custom` for a custom product |
| `GET /api/eol/platforms/<id>/` | `platform.view` on that platform |
| `PUT /api/eol/platforms/<id>/` | `platform.change`; body `{"product", "cycle"}` and `source` (`endoflife_date` when left out, `custom` for a custom product) |
| `DELETE /api/eol/platforms/<id>/` | `platform.change` |
| `GET /api/applications/<id>/eol/` | `application.view`; `{source, product, cycles}` |
| `PUT /api/applications/<id>/eol/` | `application.change`; body `{"product"}` (and `source`) |
| `DELETE /api/applications/<id>/eol/` | `application.change` |
| `GET/POST /api/eol/custom-products/` | `eolproduct.view` / `eolproduct.add`; the tenant's custom products. `?search=` |
| `GET/PATCH/PUT/DELETE /api/eol/custom-products/<id>/` | `eolproduct.view` / `change` / `delete`; delete answers `409` while an application or platform names it |

The tenant endpoints answer `404` while the feature is off; the custom
products endpoint works either way.

A custom product carries `id`, `source` (`custom`), `name` (the key; written
on create only, made from `label` when blank), `label`, `link`, `notes`,
`releases`, `cycle_count`, `application_count` and `platform_count`. Write
`releases` as the whole list of cycles:

```json
{"name": "3.2", "release_date": "2023-02-01", "support_until": "2025-01-01",
 "eol_date": "2027-02-01", "extended_until": "2029-02-01", "eol": false,
 "lts": true, "latest": "3.2.7"}
```

Dates are `YYYY-MM-DD` or `null`. A read adds each cycle's `status`
(`supported`, `ending`, `eol` or `unknown`); a write ignores it. Fetched
products carry the same cycle fields, `extended_until` from endoflife.date's
end of extended support.

## More sources

A source is a small class registered with
`compliance.eol_sources.register_source()`. It fetches through `core.ssrf` and
turns the payload into products with release cycles. A plugin can register its
own from its `danbyte_plugin.py`. The key `custom` is reserved for custom
products.
