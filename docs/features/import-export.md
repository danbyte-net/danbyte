---
icon: lucide/arrow-down-up
---

# Import & export

Move data in and out of Danbyte with spreadsheets. Export to CSV or Excel, edit
in your spreadsheet tool, and re-upload — Danbyte handles each row on its own, so
one bad row never sinks the whole batch. You get a clear summary of what was
created, updated, and skipped.

!!! tip "Round-trip is the point"
    An exported sheet uses exactly the columns Danbyte expects, so you can
    export, tweak, and import the same file back with no reformatting.

## Import / Export — round-trip on every table

Every list page has an **Import / Export** button in its header, next to the
**Add** button; every detail page has it next to **Edit**. It's the round-trip
pair:

- **Export** → **CSV**, **Excel (.xlsx)**, or **JSON**. The file carries each
  row's `id` plus stable, human-readable keys for its links, tags, and custom
  fields — so it can be re-imported.
- **Import…** → upload an edited file. Danbyte first shows a **preview** (how many
  rows would be created vs updated, and any errors) before you **Apply**.

**Export only the rows you select:** tick rows in any table and the **bulk bar**
at the bottom gains an **Export** button that exports just the selection.

On a **prefix** page the Import / Export acts on the **IP addresses inside that
prefix** (the workflow that replaced the old "IPs" dropdown).

!!! note "Two buttons, two jobs — don't mix them up"
    **Import / Export** is the *editable* round-trip (ids + keys, re-importable).
    The separate **Download** button (in the table's column toolbar) is a *pretty*
    snapshot of the columns on screen — great to hand to a colleague, but **not**
    re-importable. See [Exporting tables](exporting-tables.md).

Rows are matched by **`id`** first; if the `id` is blank or gone, by the type's
**natural key** (a prefix by its `cidr`, an IP by its address, a VLAN by its
number, a device by name + site); otherwise a new row is **created**. You need
**add** permission to create rows and **change** to update them, and you can only
touch rows inside your own [scope](permissions.md) — importing a row outside it is
a clean per-row error, never a silent escalation.

!!! tip "Everything is human-readable"
    Links are written as the **name you'd recognise**, never an internal id — a
    prefix as `10.0.10.0/24`, a VLAN as its number, a VRF/site/device by name. So
    a spreadsheet is editable by hand. A **blank VRF cell means the global table**
    (you can also type `Global`); fill it in to place the row in a named VRF.
    The `id` column is the only opaque value — leave it as-is to update a row, or
    blank to create one.

Single objects are exportable too: a detail page (an IP, for example) has the
same **Import / Export** button, scoped to just that object.

## Exporting prefixes

On the **Prefixes** list, use the export options to download a **CSV** or
**Excel (.xlsx)** file. Whatever filters you have applied on screen carry into
the export, so the downloaded sheet matches what you're looking at.

The prefix and IP sheets below are just the most-used examples; the same
round-trip works for **every** table via its **Data** menu.

## The prefix spreadsheet

| Column | Required | Notes |
|---|---|---|
| `id` | No | Leave empty to create a new prefix. Filled in (from an export) to update that exact row. |
| `cidr` | **Yes** | The network, e.g. `10.0.10.0/24` or `2001:db8:1::/64`. |
| `status` | No | `active` (default), `reserved`, `container`, or `deprecated`. |
| `site` | No | Site name. Created automatically if it doesn't exist yet. |
| `vlan` | No | A VLAN number. Created automatically if it doesn't exist yet. |
| `gateway` | No | A gateway IP address. |
| `description` | No | Free text. |
| `tags` | No | Tag names separated by semicolons. Missing tags are created automatically. |
| `custom_fields` | No | Your [custom field](tags-and-custom-fields.md) values, as a small JSON object, e.g. `{"owner":"infra"}`. |

## Importing prefixes

1. Prepare a **.csv** or **.xlsx** file with the columns above (an export is the
   easiest starting point).
2. Open the prefix **import** page and upload your file.
3. Review the result summary.

For each row, Danbyte:

1. Checks the `cidr` is valid (an invalid one is skipped and reported).
2. Finds an existing prefix — by `id` if present, otherwise by `cidr`.
3. **Updates** it if found, or **creates** a new one if not.
4. Auto-creates any referenced site, VLAN, or tag that doesn't exist yet.

If a single row fails — a bad network, malformed custom-field JSON — the rows
around it still import, and the summary lists exactly which rows had problems.

## Importing IP addresses

IP imports belong to a **single prefix**, so the file is tied to the prefix you
export it from — you don't manage the parent on each row.

For each row, Danbyte confirms the address falls inside that prefix, then matches
it against existing IPs. If the address already exists, its status, role,
description, tags, and custom fields are updated in place — and it's **moved into
this prefix** if it was elsewhere. If it doesn't exist, it's created here.

!!! tip
    Because matching is by address (not by which prefix it's currently in),
    re-importing a freshly exported sheet always tidies its IPs back under the
    sheet's prefix.

## The Import hub (paste a big file)

For a large paste or a one-off load, the **Integrations → Import** hub imports any
type without leaving the page — the same round-trip engine as the per-table
button.

1. Go to **Integrations → Import**.
2. Pick the **object type** and the **format** (CSV or JSON).
3. **Upload** your file, or paste its contents.
4. Review the available columns — required ones are marked.
5. Click **Validate** to preview without saving anything.
6. Click **Import** — rows are matched by `id`/natural key, so existing rows
   **update** and new ones are created.

Results show how many rows were created vs updated, with a per-row table for any
errors.

| Detail | Behavior |
|---|---|
| Columns | Match object fields by name; unknown columns are ignored. |
| Links to other objects | Resolved by name, slug, or id within your active tenant. An unresolved link is a clean per-row error. |
| Validation | Each row is checked and saved on its own, so one bad row doesn't stop the rest. |
| **Validate** | A dry run — checks everything, writes nothing. |
| Limit | Up to 5000 rows per import. |

!!! note
    You can only import object types you have **add** permission for — see
    [Permissions & access](permissions.md).

## File formats

- **CSV**, **Excel (.xlsx)**, and **JSON** are detected by file extension.
- CSV files should be UTF-8 (a byte-order mark is tolerated).
- Excel files are read on the server, so no spreadsheet plugin is needed.

## Extending it (for developers / plugins)

Every registered, tenant-scoped model gets round-trip export/import automatically.
A model with special keys — or a model shipped by a **plugin app** — customises it
by subclassing `ModelIOHandler` and registering the handler from the app's
`io.py` (auto-imported at startup):

```python
# myplugin/io.py
from api.io import ModelIOHandler, register_io
from auth_api.object_types import register_object_type
from .models import Widget

class WidgetIO(ModelIOHandler):
    model = Widget
    natural_key = ["serial"]          # fallback match key when id is absent
    fk_keys = {"vendor": "name"}      # how each FK is rendered/looked up
    # override to_row / apply for full control

register_object_type("myplugin.Widget", "Widgets", "Plugins")  # RBAC + discovery
register_io(WidgetIO())
```

Add the app to `INSTALLED_APPS` and its `Widgets` type appears in the permission
picker and gains a **Data** menu wherever its table is shown — no core changes.

## Related

- [Exporting tables](exporting-tables.md) — quick export of any list.
- [Tags & custom fields](tags-and-custom-fields.md) — the `tags` and
  `custom_fields` columns.
- [Permissions & access](permissions.md) — who may import.
