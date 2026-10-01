---
icon: lucide/rows-4
---

# Cabinets

A **cabinet** is an enclosure whose gear sits on DIN rails rather than in rack
units: a control cabinet with PLCs and I/O, a distribution board, a small
industrial switch box on a factory wall. Positions in a cabinet are measured
in millimetres, so it is a model of its own next to [racks](racks.md), not a
rack of a different height.

## Add a cabinet

1. Open **DCIM → Cabinets** and click **Add cabinet**.
2. Name it and pick its **site**. Names are unique per site, like rack names.
3. Optionally pick a [**cabinet type**](#cabinet-types), a
   [**role**](#cabinet-roles), a **location** within the site, a **status**,
   tags and a **facility ID** (the label on the door, e.g. `=UH1+K1`).
4. Give the **mounting plate** size - the plate the rails are fixed to - and,
   if you know it, the **outer** width, height and depth of the box.

All sizes are whole millimetres. The plate has to fit in the box: an outer
width or height smaller than the plate is refused. A cabinet created with a
type takes the type's sizes; a size you enter, or clear, wins. Changing the
type of an existing cabinet leaves its sizes as they are.

A cabinet page has the usual tabs - Overview, Documents, Journal and Change
log - and cabinets list on their site's and location's pages. Cabinets carry
custom fields, tags, contacts, images and statuses like racks do; the status
catalog offers *Active*, *Planned*, *Reserved*, *Available* and *Deprecated*
for them, *Active* first.

### Cabinet types

A **cabinet type** is an enclosure *model* - "Rittal AE 1060.500" - with the
plate and box sizes every cabinet of that model has. Define them on **DCIM →
Cabinet types**. Picking a type on the cabinet form fills the sizes; each
stays editable, so the cabinet remains the source of truth. A type in use by
a cabinet cannot be deleted.

### Cabinet roles

A **cabinet role** says what a cabinet is for (*distribution*, *control*,
*metering*, …) with a colour, so cabinets group visually in lists and
pickers. Define them on the **Cabinet roles** page; none ship by default. A
role in use cannot be deleted.

## Rails

The mounting plate carries **DIN rails**. Each rail has a **label**, unique in
its cabinet, and a **profile** - *TS 35*, *TS 15* or *G 32* - which sets the
height of the band it takes on the plate (35, 15 or 32 mm). It is placed by
its **left end** and its **centreline**, measured from the plate's top-left
corner, and has a **length**, all in tenths of a millimetre.

A rail has to lie on the plate, and two rails may not overlap where they run
side by side. Rails that only touch are fine, so rails can sit end to end on
one line or band against band. A plate cannot shrink past its rails; move
them in the same save.

A cabinet type carries **rail templates** of the same shape. A new cabinet of
the type starts with its rails, unless rails are given with it. A change to a
cabinet's rails, or to a type's templates, is one entry on its change log,
listing the rails before and after.

### Sync from type

**Sync from type** compares a cabinet with its type: the sizes that differ,
the template rails it lacks (*add*), rails with a template's label that sit
elsewhere or have another profile (*update*), and its own rails no template
names (*extra*). Applying copies the sizes and adds or moves rails; it never
removes one. A sync whose result would not fit the plate is refused as a
whole.

## Permissions

Cabinets, cabinet types and cabinet roles are object types of their own in
permissions (`cabinet`, `cabinettype`, `cabinetrole`). A permission limited to
sites limits cabinets by their site, as it does racks. Types and roles are
shared by the whole tenant.

## API

| Endpoint | What |
|---|---|
| `/api/cabinets/` | Cabinets. Filters: `site`, `location`, `role`, `status`, `cabinet_type`, `search` (name, facility ID, description, custom fields). |
| `/api/cabinet-types/` | Cabinet types. Filters: `manufacturer`, `search`. |
| `/api/cabinet-roles/` | Cabinet roles. Filter: `search`. |

Sizes are `inner_width_mm` and `inner_height_mm` (the plate, required unless
the type gives them) and `outer_width_mm`, `outer_height_mm` and
`outer_depth_mm`. References are written as `site_id`, `location_id`,
`role_id`, `cabinet_type_id` and `status_id`, and read back as small objects.
`?picker=1` returns a short form of each list for pickers. Deleting a type or
role that cabinets use answers `409` with how many use it.

A cabinet's `rails`, and a type's `rail_templates`, are read and written with
it as a list of `{id, label, profile, x_mm, y_mm, length_mm}`. A write
replaces the whole set: an item with the `id` of one of its rails updates
that rail, an item without one is a new rail, and rails left out are
removed. Errors come back per rail, in the order sent.

`POST /api/cabinets/{id}/sync-from-type/` answers the difference
(`{"applied": false, "diff": …}`); with `{"apply": true}` it applies it, and
`sizes` and `rails` (both true by default) narrow what applies.
