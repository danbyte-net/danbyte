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
