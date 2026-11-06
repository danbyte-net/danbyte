---
icon: lucide/shield
---

# Sensitivity labels

A **sensitivity label** says how a PDF report may be handled - *Public*,
*Internal*, *Confidential*, *Secret*, whatever your organisation uses. Pick
one in the [PDF report](reports.md#sensitivity-label) dialog and the report
carries it as a coloured marking at the top and bottom of every page and as
a badge on its cover.

Labels are an editable catalog per tenant, like
[statuses](catalogs-and-settings.md): **Customize → Sensitivity labels**.

## The catalog

| Field | |
|---|---|
| Name | What the marking says, in capitals on the PDF. Unique per tenant. |
| Color | The pill's colour; the text is black or white, picked for contrast as a status's is. No colour gives a neutral grey pill. |
| Icon | An optional Lucide icon in the pill (`shield`, `lock`, `eye-off`…). |
| Weight | Lower weights come first in the list and the report dialog. |
| Default for reports | New reports start with this label. One label per tenant: marking another takes it from the first. |
| Description | What the label means, for the people picking it. |

The list page has bulk edit (colour, icon, weight, description), bulk delete,
and [import and export](import-export.md) like any catalog; each label has a
page with its Journal and Change log. Deleting a label never touches a PDF
already made.

## The starter labels

A tenant starts with four labels, so the report dialog is useful on day one
instead of waiting for someone to invent the usual scheme:

| Label | Colour | Icon |
|---|---|---|
| Public | green | `globe` |
| Internal | blue | `building-2` |
| Confidential | amber | `shield` |
| Restricted | red | `shield-alert` |

They are ordinary rows - rename, recolour or delete them, or add your own.
They are created once per tenant: by the upgrade for the tenants you already
have, and when a tenant is created. A label you delete does not come back on
the next `bootstrap` or upgrade, and a label you already have under one of
these names keeps your edits. None of them is the default, so reports carry
no marking until you pick a default or a label in the dialog.

## Permissions

The object type is `sensitivitylabel` (**Customize → Sensitivity labels** in
the permission editor). A report may be marked only with a label the reader
may **view**; asking for another tenant's label, or one the reader may not
view, is refused. Site viewers and site editors read the tenant's labels
(they are a tenant-wide catalog, like statuses); only a tenant-wide editor
adds, changes or deletes them. See [permissions](permissions.md).

## API

`/api/sensitivity-labels/` - list, create, read, update and delete.
`?search=` matches the name and description; `?picker=1` lists the short form
the report dialog reads (`id`, `name`, `slug`, `color`, `text_color`, `icon`,
`is_default`). A report takes the label as `options.sensitivity_label` (its
id) - see the [reports API](reports.md#api).
