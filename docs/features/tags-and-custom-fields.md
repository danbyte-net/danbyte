---
icon: lucide/tags
---

# Tags & custom fields

Danbyte ships with no pre-filled data, so you tailor it to your network two ways:
**tags** for free-form labels you can stick on anything, and **custom fields**
for structured extra data that appears on object forms. Both live under the
sidebar's **Customize** section.

## Tags

Tags are short labels — `prod`, `core`, `monitored` — that you attach to objects
to group, filter, and find them. Tags are **shared across all tenants**.

### Managing tags

1. Go to **Customize → Tags** and click **Add tag**.
2. Give it a **name** and, optionally, a **colour**.
3. Save.

The Tags list shows how many objects use each tag, and you can filter by usage or
colour.

### Seeing where a tag is used

Open a tag to see its **Used by** table — every object in the **current tenant**
that carries it, with a link to each. (Tags are shared, but this view only shows
your active tenant's objects, so it never leaks another tenant's data.)

!!! tip
    To apply a tag, open the object you want to label and add the tag on its
    form. You can also create a tag on the fly from there.

## Custom fields

A custom field adds your own piece of data to an object — a warranty date, an
owner team, a maintenance window — and it shows up on that object's form and
overview. Custom fields are **tenant-scoped**: each tenant defines its own.

### Field types

| Type | Use for |
|---|---|
| **Text** / **Text area** | Short or long free text. |
| **Integer** / **Decimal** | Whole or fractional numbers. |
| **Boolean** | A yes/no checkbox. |
| **Date** | A calendar date. |
| **URL** | A link. |
| **Select** | One choice from a list you define. |
| **Multiselect** | Several choices from a list you define. |
| **Object reference** | One live object of a model you pick — a user, group, device, VLAN, rack, prefix, tenant… |

**Object reference** turns a custom field into a real dropdown of existing
objects: pick the *referenced model* on the field definition, and every form
carrying the field offers that model's instances through the **advanced
picker** (devices, racks, VLANs, prefixes and IPs get their full
filter-modal pickers; every other model — including users and groups — gets
a searchable picker automatically). Values are validated against live rows
(tenant-scoped where the model is), and detail pages render the object's
name as a link, resolved through the registry — a deleted target degrades
to its raw id, never an error.

### Which objects can have custom fields

Every model that carries the `custom_fields` mixin — the list is
**auto-derived**, so new models (and plugin models) appear in the
"Applies to" checklist without anyone maintaining a list. Targeting
**device types** and **device roles** lets you annotate the catalog itself —
for example a warranty date on a device type or a service tier on a device
role.

!!! note "For plugin developers"
    Two registration hooks in `customization/object_registry.py`:
    `register_customizable_model(slug, label)` adds your model to the
    "Applies to" list (models using `CustomFieldsMixin` are picked up
    automatically), and `register_reference_model(ReferenceModel(...))`
    makes it a valid **object-reference target** — endpoint, label field
    and detail route included, so the SPA's pickers and value rendering
    work with zero frontend changes. Call both from your
    `AppConfig.ready()`.

### Adding a custom field

1. Go to **Customize → Custom fields** and click **Add custom field**.
2. Set the **key** (the internal name, unique within your tenant) and a **label**
   (what people see).
3. Choose the **type**. For **Select** / **Multiselect**, add the list of
   **choices**.
4. Pick which objects it **applies to**.
5. (Optional) Mark it **required**, give a **default**, and add a **description**.
6. Save.

The field now appears on every matching object's form, with the right kind of
input for its type, and on the object's overview.

!!! note "Required and choice fields are enforced"
    When you save an object, Danbyte checks its custom fields: required fields
    must be filled in, and select/multiselect values must come from your list.
    Any problems are reported next to the field.

## Custom field groups

When a tenant has many custom fields, one flat list gets unwieldy. **Groups**
bucket related fields under a heading on forms and detail pages — e.g. a
*Monitoring* group holding `install_btop`, `enable_netdata`, and
`syslog_profile`.

1. Go to **Customize → Custom field groups → Add**.
2. Give it a **name** (the heading). Optionally set a **weight** (sections sort
   low → high), a **description**, and **Start collapsed** to fold the section by
   default on detail pages.
3. On each custom field, pick the **Group** in its form.

Fields with no group stay under the default **Custom fields** heading, so nothing
changes until you start grouping. Deleting a group simply un-groups its fields —
they're never lost.

!!! tip "Why a real group, not a label"
    Danbyte uses a first-class group **object** rather than a free-text group
    name: rename or reorder a group in one place, the picker
    is a dropdown so typos can't silently split a group, and a group can carry a
    description + a collapse default. Grouping is presentation only — the Ansible
    inventory's `danbyte.custom_fields` stays a flat `{name: value}` map, so
    [playbooks](cf-driven-playbook.md) are unaffected.

## Related

- [Change log](change-log.md) — custom-field definitions are themselves tracked.
- [Permissions & access](permissions.md) — who can manage these.
