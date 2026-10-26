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

Nothing ships pre-filled: no applications, no groups, no installs.

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

The list opens in tree order: a parent, then its children under it, each
marked `└` and indented one step per level, with the path before the name
(*Payments › Checkout › checkout-api*). Sorting by *Name* keeps that order;
the picker reads the same. An application cannot be its own ancestor. Deleting a parent
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
it. **Flows** and **Diagram** show its [flows](application-flows.md) (the Diagram is the [Application map](application-flows.md#application-map)),
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
| Source | `manual`, `import`, `discovery` or `group`. Rows you add are manual, an import's are import, an [application group](#application-groups)'s are group. Discovery is kept for later. |
| Group | The application group whose assignment made the install, while it is its. Read-only. |
| Last seen | Kept for discovery; empty for now. |

The **Software** tab on device and VM pages lists the installs with their
version, service, *Group*, *End of life* status and lifetime bar (*Cycle*,
*Source* and *Last seen* are in the Columns menu). **Add software** and the
row's edit open the same dialog; tick rows to delete several at once.
**Assign group** assigns an [application group](#application-groups). The tab
label carries the count (`install_count` on `/api/devices/` and
`/api/virtual-machines/`, list and detail), and the page's **Overview** has a
**Software** card: the first eight installs, each with its version and
lifetime bar, then **View all N** to the tab.

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

## Application groups

**DCIM → Devices → Application groups** holds named sets of applications -
*RDS*, *SCADA*, *Web front end* - so a server is marked with everything it
runs in one step, and automation reads that from the
[Ansible inventory](#ansible-inventory) to set the host up.

A group has a **name**, a **slug** (the inventory key; a rename keeps it), a
description, tags and custom fields, and its **applications** in order, each
with an optional **version** its installs start at. Groups are tenant-wide,
like applications.

The group page has **Overview**, **Applications** (add, remove, reorder,
change a version), **Hosts** (the devices and VMs it is assigned to, with
**Assign** and **Unassign**), **Journal** and **Change log**. An application's
page lists the groups it is in.

Adding an application that has children offers **Include children** (on by
default): every application under it joins too, right after it in tree
order, skipping ones already in the group. Each stays its own member with its
own version - only the picked application gets the version you enter - so
removing or re-versioning one later leaves the others alone.

### Assigning a group

Assign a group from the **Software** tab of a device or VM (**Assign
group**), from the group's **Hosts** tab, or pick **Application groups** in
the device and VM forms - a new server then gets its groups with its first
save. The groups on a host show above its software as badges; the **×** on a
badge unassigns it.

| When | What happens to the installs |
|---|---|
| A group is assigned | One install per application, at its version, *Source* `group`, *Group* set. An application the host already records is left alone - no second install. |
| A group is unassigned | The installs it made are removed while **untouched**; **edited** ones stay, with *Group* cleared. |
| An application joins the group | It is installed on every host the group is assigned to. |
| An application leaves the group | Its installs from the group go as on unassign. |
| An application's version changes | The untouched installs follow the new version (unless the host already records it); edited ones keep theirs. |

An install is **untouched** while its version is the group's version for that
application, it names no service and its cycle was not set by hand. Anything
else counts as edited. When another group on the same host also has the
application, that group takes the install over instead.

A group that is assigned anywhere cannot be deleted (409): unassign it first.
Deleting a device or VM takes its assignments along.

!!! note "In device profiles"
    A [device profile](device-profiles.md) can name application groups:
    assigning the profile assigns them, as an ordinary group assignment. A
    group already on the host is left alone. A group says what a server runs;
    a profile says what a server is. A group a profile names cannot be
    deleted (409 naming the profiles).

### Ansible inventory

`/api/inventory/ansible/` gives every host's `danbyte` block two more keys,
and each assigned group becomes an inventory group `app_group_<slug>`:

```json
"danbyte": {
  "application_groups": ["rds"],
  "applications": [
    {"name": "Office", "slug": "office", "version": "365", "group": "rds"},
    {"name": "RD Session Host", "slug": "rdsh", "version": "2022", "group": "rds"}
  ]
}
```

`version` is `null` when none is recorded, `group` is `null` for an install
no group made. A play can target `hosts: app_group_rds`, or loop over
`danbyte.applications`. See [IaC runner](iac-runner.md) for the whole export.

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
  creates is marked `source=import`; `group` by slug.
- **Application groups** (`applicationgroup`) - matched by `slug`. Their
  applications are kept on the group page or through the API.
- **Application group assignments** (`applicationgroupassignment`) - export
  only: assigning records installs, which the API and the pages do.

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

`applicationgroup` is a tenant-wide catalog a site role reads, like
applications; its applications go with it, and changing them takes `change`
on the group. `applicationgroupassignment` belongs to its device's or VM's
site, like an install. Assigning takes `add` on the assignment and on
installed software at that site; unassigning takes `delete` on both, since
the installs are written as you.

## API

| Endpoint | |
|---|---|
| `/api/applications/` | CRUD. `?search=`, `?manufacturer=`, `?parent=` (an id, or `none` for the roots), `?ancestor=` (everything under an application, any depth), `?picker=1` (`{id, name, slug, path, depth, child_count}`). `POST bulk-delete/`. Delete answers `409` while installs, children or flows exist. |
| `/api/applications/<id>/eol/` | `GET`, `PUT {"product"}`, `DELETE`; `404` while end-of-life data is off. `GET` and `PUT` answer `{source, product, cycles, other_cycles, unmapped_installs, in_catalog, source_label, product_label, product_url}`; each cycle carries `install_count`, the installs you may view. |
| `/api/installed-software/` | CRUD. `?device=`, `?virtual_machine=`, `?application=`, `?service=`, `?group=`, `?cycle=` (`none` for the installs no cycle took), `?search=`. `POST bulk-delete/`. |
| `/api/application-groups/` | CRUD. `?search=`, `?application=`, `?device=`, `?virtual_machine=`, `?picker=1` (`{id, name, slug}`). `POST bulk-delete/`. Delete answers `409` while the group is assigned. |
| `/api/application-group-assignments/` | List, `POST` (assign), `DELETE` (unassign). `?group=`, `?device=`, `?virtual_machine=`. `POST set/` makes a host's groups exactly a list. |

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
`effective_release`, `effective_end`, `effective_source`, `source`,
`last_seen` and `group` (`{id, name, slug}` or `null`). Write `application_id`, `device_id` or `virtual_machine_id`,
`service_id` and `cycle` (blank to derive it). Every reference must be the
active tenant's; the service must be on the same device or VM.

```bash
curl -X POST https://danbyte.example/api/installed-software/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id": "…", "device_id": "…", "version": "16.4"}'
```

A group carries `members` (`[{id, application, version, position}]`, in
order), `member_count`, `host_count` and `install_count`. Write `members` as
the whole ordered list `[{"application_id", "version"}]`: applications left
out are removed, new ones added, and the installs on every assigned host
follow. An entry with `"include_children": true` also adds every application
under it (all depths, the ones you may view) right after it in tree order,
each with a blank version, skipping applications already in the list. An assignment carries `group`, `device` or `virtual_machine` and
`install_count` (the installs the group made there that are still its). Its
`DELETE` answers what became of them: `{"removed", "kept", "moved"}`.

```bash
# A new server gets the RDS group and its installs
curl -X POST https://danbyte.example/api/application-group-assignments/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"group_id": "…", "device_id": "…"}'

# Or set every group of a VM at once
curl -X POST https://danbyte.example/api/application-group-assignments/set/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"virtual_machine_id": "…", "group_ids": ["…", "…"]}'
```

Every reference must be the active tenant's: another tenant's application,
group, device or VM answers `400`.
