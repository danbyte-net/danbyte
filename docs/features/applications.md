---
icon: lucide/app-window
---

# Applications & installed software

**DCIM → Devices → Applications** is the catalog of software your tenant
runs - PostgreSQL, nginx, a Java runtime, an in-house service. Each device
and virtual machine records what is installed on it, at which version, on its
**Software** tab. With [end-of-life data](end-of-life-data.md) on, each
install's version finds its release cycle, so software ends show up on the
[Lifecycle overview](lifecycle-overview.md), in the lists' *Next end of life*
column and, if you ask for it, in [compliance rules](compliance.md). An
application's [flows](application-flows.md) record the traffic it needs.

Nothing ships pre-filled: no applications, no installs.

## The catalog

An application has a **name**, a **slug** (its import key; a rename keeps
it), an optional **manufacturer**, a description, tags and
[custom fields](tags-and-custom-fields.md). Applications are tenant-wide, like
platforms; a site role reads them, so its editors can pick them on their
devices.

### The tree

**Parent** nests applications into a tree - a business domain, its
processes, their applications:

```
Payments
└── Checkout
    ├── checkout-api
    └── PostgreSQL
```

The list shows the path before the name (*Payments › Checkout ›
checkout-api*), indented one step per level, and sorts by it, so children
follow their parent; the picker reads the same. An application cannot be its own ancestor. Deleting a parent
is refused while it has children: move or delete them first.

The list shows each application's installs and
[flows](application-flows.md). Its **Columns** menu adds Parent,
Manufacturer, Children and the End-of-life product; the rail has Parent and
Manufacturer facets.

### The application page

**Overview** carries the attributes, the **Hierarchy** card and, while
end-of-life data is on, the **End of life** card (see
[End of life](#end-of-life)). **Hierarchy** shows the path to the root as
linked crumbs and the children three levels deep, each linked with its
install count; a deeper branch ends in *+N*, which opens that child's
**Child applications**. Overview counts the installs - the count opens the
[Lifecycle overview](lifecycle-overview.md) filtered to this application -
and the flows.

**Installed on** lists every install, with its *Cycle* and a *manual* chip
where the cycle was set by hand. `?cycle=8` narrows it to one cycle,
`?cycle=none` to the installs no cycle took; the chip above the table clears
it. **Flows** and **Diagram** show its [flows](application-flows.md),
**Child applications** the children, then **Journal** and **Change log**.

An application with installs, child applications or flows cannot be deleted
(409); remove them first. The list's bulk delete skips such rows and says
why.

## Installed software

An install is one application at one version on **exactly one** device or
virtual machine. The same version is recorded once per device or VM.

| Field | |
|---|---|
| Application | From the catalog. |
| Version | Free text, e.g. `16.4`. |
| Cycle | The end-of-life release cycle. Blank derives it from the version and the application's product (`16.4` → `16`); a value you set sticks until you clear it. |
| Service | Optional: the [service](../dcim/devices.md#other-tabs) it answers on - one of the same device's or VM's. |
| Released, End of support | Optional dates; each wins over the cycle's. |
| Description, tags, custom fields | |
| Source | `manual`, `import` or `discovery`. Rows you add are manual, an import's are import. Discovery is kept for later. |
| Last seen | Kept for discovery; empty for now. |

The **Software** tab on device and VM pages lists the installs with their
version, service, *End of life* status and lifetime bar (*Cycle*, *Source*
and *Last seen* are in the Columns menu). **Add software** and the row's edit
open the same dialog; tick rows to delete several at once.

Installs can also be added from the application: **Add** on its **Installed
on** tab opens the same dialog with the application fixed, where you choose
**Device** or **Virtual machine** and pick one.

### End of life

The application's product and an install's cycle together pick an
end-of-life mapping, shared by every install of that application on that
cycle and kept current by the daily refresh - see
[Map an application](end-of-life-data.md#map-an-application). An install's
end is its own *End of support* when entered, else its cycle's end of life;
the start the same way.

The **End of life** card on the application's Overview shows:

- **Source** - *endoflife.date*; for a deployment admin it links to
  Settings → General → End-of-life data.
- **Product** - its name, linked to the product's page on endoflife.date.
  A product missing from the cached catalog, or one none of the installs'
  versions match, says so in a line under the card.
- **Cycles** - each cycle the installs run, with its status, release date,
  end of life with the time left, latest version, LTS and the installs on
  it; the count opens **Installed on** filtered to that cycle. An
  *Unmapped* row counts the installs whose version matched no cycle.
  **All cycles** adds the product's other cycles, muted.

**Change product** opens the product picker; **Remove** clears it. A
deployment admin also gets **Refresh now**, which fetches the catalog as the
settings card does. To pin one install to another cycle, edit the install
and set its *Cycle*.

Elsewhere the status links back here: the *End of life* badge on a device's
or VM's **Software** tab and on **Installed on**, and the *End* date of a
software row on the Lifecycle overview.

## Service templates

A [service template](../dcim/devices.md#other-tabs) may name the
**application** behind it (*Postgres - TCP 5432* → PostgreSQL), so the
software and the endpoint are recorded together.

## Import & export

Both are in [Import & export](import-export.md):

- **Applications** (`application`) - matched by `slug`; `parent` by slug,
  `manufacturer` by name.
- **Installed software** (`installedsoftware`) - matched by `application`
  (slug), `device` or `virtual_machine` (name) and `version`. A row an import
  creates is marked `source=import`.

```csv
application,device,virtual_machine,version
postgresql,db-01,,16.4
openjdk,,app-vm-02,17.0.9
```

## Permissions

`application`, `installedsoftware` and `applicationflow` are their own
object types (flows: [Permissions](application-flows.md#permissions)). An install
belongs to its device's or VM's site: a site editor records software on the
devices and VMs of their sites, and a site role reads the applications. The
Lifecycle overview lists an install only to someone who may view both the
install and the device or VM it runs on.

## API

| Endpoint | |
|---|---|
| `/api/applications/` | CRUD. `?search=`, `?manufacturer=`, `?parent=` (an id, or `none` for the roots), `?picker=1` (`{id, name, slug, path, depth}`). `POST bulk-delete/`. Delete answers `409` while installs, children or flows exist. |
| `/api/applications/<id>/eol/` | `GET`, `PUT {"product"}`, `DELETE`; `404` while end-of-life data is off. `GET` and `PUT` answer `{source, product, cycles, other_cycles, unmapped_installs, in_catalog, source_label, product_label, product_url}`; each cycle carries `install_count`, the installs you may view. |
| `/api/installed-software/` | CRUD. `?device=`, `?virtual_machine=`, `?application=`, `?service=`, `?cycle=` (`none` for the installs no cycle took), `?search=`. `POST bulk-delete/`. |

An application carries `parent`, `path`, `depth`, `manufacturer`,
`eol_source`, `eol_product`, `eol` (`{source, product, cycles}`, `null` while
the feature is off), `install_count`, `child_count` and `flow_count`. The
detail adds `ancestors` (root first) and `children` (three levels deep), each
`{id, name, install_count}`, children with `child_count` and their own
`children`; the list leaves both empty. Write `parent_id` and
`manufacturer_id`.

An install carries `application` (`{id, name, slug, path}`), `device` or
`virtual_machine`, `version`, `cycle`, `cycle_manual`, `service`,
`release_date`, `end_of_support`, `eol` (the cycle's status and facts),
`effective_release`, `effective_end`, `effective_source`, `source` and
`last_seen`. Write `application_id`, `device_id` or `virtual_machine_id`,
`service_id` and `cycle` (blank to derive it). Every reference must be the
active tenant's; the service must be on the same device or VM.

```bash
curl -X POST https://danbyte.example/api/installed-software/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id": "…", "device_id": "…", "version": "16.4"}'
```
