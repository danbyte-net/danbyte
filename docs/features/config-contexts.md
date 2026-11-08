---
icon: lucide/file-cog
---

# Config contexts

Config contexts let you keep environment-, role-, or region-specific data (DNS
servers, NTP, SNMP communities, VLANs, and so on) in **one place** and have it
apply automatically to the devices and virtual machines it should - instead of
copying the same values onto every object by hand.

Each context holds a block of JSON and a set of match rules. Danbyte merges
together every context that matches a given device or VM, so each object ends up
with one combined config context computed from the layers that apply to it.

You'll find config contexts under **Customize → Config contexts** in the sidebar.

## Create a config context

1. Go to **Customize → Config contexts** and click **Add config context**.
2. Fill in the form:

   | Field | What it does |
   |---|---|
   | **Name** | A label for the context. |
   | **Description** | Optional note. |
   | **Weight** | A number that decides who wins on conflicts. When two contexts set the same key, the higher weight wins. |
   | **Active** | Inactive contexts are ignored during the merge. |
   | **Data** | The JSON object this context contributes. Edit it in the built-in JSON editor. |
   | **Assignment criteria** | Which objects this context applies to - choose any number of regions, sites, device roles, platforms and tags. |

3. Save.

### How matching works

The assignment criteria decide which devices and VMs a context applies to:

- **Across dimensions, all must match (AND).** If you set both a site and a
  platform, an object must be in that site *and* run that platform.
- **Within one dimension, any matches (OR).** Listing three sites means an object
  in any one of them qualifies.
- **An empty dimension matches everything.** Leave platforms blank and the
  context applies regardless of platform.
- **Regions are inherited downward.** A context assigned to a parent region also
  applies to sites nested under it.
- **Tags match the object's own tags.** A context with tags applies to a device
  or VM that carries any one of them, together with the other dimensions. Only
  the tenant's own tags can be picked - not deployment-global ones, and never
  another tenant's (the API answers 400 on `tag_ids`). Use this when a few
  devices share a role with others but need extra values: tag them, and give
  the extra values a context that matches the tag.

A tag-matched context is an ordinary context in the merge: its weight places
it, like any other. Give it a higher weight than the role's context when its
values should win.

Merging one tag into another moves the contexts that matched the merged tag
onto the tag it was merged into. Deleting a tag removes it from the contexts
that matched on it; a context left with no tags no longer narrows on tags, so
check its other criteria first.

## How the merge works

For a given device or VM, Danbyte takes every *active* context that matches it
and deep-merges them in order of weight (and then name), so the highest-weight
context wins on any conflicting key. Within the merge:

- Nested objects are combined key by key.
- Plain values and lists are **replaced** wholesale, not concatenated.

The result is a single rendered config context for that object.

### Local context data {#local-context-data}

A device or VM can also carry its own **local context data** - a JSON object
set on its form under **Config context**. It is merged **last**, after every
matching context whatever its weight, so its keys always win. Use it for the
values that belong to one object only, such as a default route or NAT
settings, instead of a custom field the template checks.

The full order is: matching contexts by weight (then name), lowest first, then
the object's local context data.

!!! tip "Higher weight = last word"
    If a base context sets `ntp: ["10.0.0.1"]` (weight 10) and a more specific one
    sets `ntp: ["10.1.0.1"]` (weight 100), the object gets `["10.1.0.1"]` - the
    list is replaced by the higher-weight layer, not merged.

## The config-context page

Click a context's name in the list to open it. It has three tabs:

| Tab | What's on it |
|---|---|
| **Overview** | Weight, active flag, description, the number of top-level data keys, the assignment criteria - regions, sites, device roles, platforms and tags, each linking to the object it names - and the context's **Data** block, rendered as formatted JSON. A dimension with no entries reads **Any**, which is exactly how the merge treats it. |
| **Journal** | Your notes on this context. |
| **Change log** | Every create, edit, and delete of the context - see [Change log](change-log.md). |

Because a context's whole purpose is the data it contributes, the Data block is
on the Overview rather than behind a tab. Long blocks scroll inside their own
box, so a large context doesn't stretch the page.

## Bulk changes

Tick rows in **Customize → Config contexts** - with the `change` or `delete`
grant - to reveal the bulk bar:

- **Export** downloads the selected contexts as CSV, Excel or JSON.
- **Edit** sets **Active**, **Weight** or **Description** on every selected
  context. The data and the assignment criteria stay per context.
- **Delete** first shows what would happen, then deletes the contexts, each
  with a change-log entry.

| Endpoint | Needs |
|---|---|
| `POST /api/config-contexts/bulk-update/` | `configcontext.change`; `{ids, fields}` with `is_active`, `weight`, `description` |
| `GET /api/config-contexts/bulk-edit-fields/` | `configcontext.change` |
| `POST /api/config-contexts/bulk-delete/` | `configcontext.delete`; `{ids, dry_run}` |

## See it on a device or VM

Every device and virtual machine detail page has a **Config** tab. It shows the
final merged JSON for that object and lists, as chips in merge order, where it
came from: each matching context (a link to it), then **Local context data**
when the object has its own - so you can always see where a value came from.
The JSON sits in the shared [file viewer](export-templates.md#the-file-viewer):
line numbers, search, folding on each object and array, copy and download.

`GET /api/devices/{id}/config-context/` (and `/api/virtual-machines/{id}/config-context/`)
returns:

| Key | What it holds |
|---|---|
| `rendered` | The merged JSON - what templates see as `config_context` and the Ansible inventory serves as hostvars. |
| `applied` | The names of the matching contexts, in merge order. |
| `sources` | Every source in merge order: `{"kind": "context", "id", "name", "weight"}` per context, then `{"kind": "local", "name": "Local context data"}` when the object has local data. |

## API

`/api/config-contexts/` takes and returns the criteria as id lists -
`region_ids`, `site_ids`, `device_role_ids`, `platform_ids` and `tag_ids` - and
reads them back as `regions`, `sites`, `device_roles`, `platforms` and `tags`.
A device's or VM's own data is `local_context_data` on
`/api/devices/` and `/api/virtual-machines/`: a JSON object, or `null` for none
(an empty object is stored as `null`). It is in the CSV/Excel/JSON export and
import of devices and VMs as a JSON column, and its changes are in the object's
change log.

## Permissions and audit

Config contexts are managed by users with the **Customize** permission group, and
every create, edit, and delete is recorded in the [change log](change-log.md).
