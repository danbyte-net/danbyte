---
icon: lucide/door-closed
---

# Rooms

A **room** is a room inside a [location](../features/regions-locations.md#add-a-location):
a comms room, a plant room, Room 210 on the second floor. The chain is
**Region → Site → Location → Room**. Devices, racks and cabinets name the
room they stand in, so "what is in Room 210?" is one tab, not a search.

A room belongs to exactly one location, and its site is that location's site.

## Add a room

1. Open **Organization → Rooms** and click **Add room** - or open a location,
   go to its **Rooms** tab and click **Add room** there, which fills in the
   site and location for you.
2. Give it a **name** and, if the door has one, a **code** (`210`, `B1-07`).
3. Pick the **site**, then the **location** in it.
4. Optionally set a **status**, a **colour**, a description, tags and custom
   fields.
5. Save.

Names are unique per location: two buildings can each have a "Room 210", one
building cannot have two. The slug is made from the name and only gets a
`-2` suffix when the location already has that slug.

The status catalog offers rooms the location vocabulary - *Active*, *Planned*,
*Decommissioning* and *Retired* - with *Active* the default. Edit or replace
them under **Settings → Statuses** like any other status.

A room renders as a badge in its own colour (a neutral badge without one) on
every list and page that names it.

## The room page

Overview (the room's details, custom fields and photos), then **Devices**,
**Racks** and **Cabinets** - everything that names the room - then **Journal**
and **Change log**. The location's page has a **Rooms** tab listing its rooms.

## Putting a device, rack or cabinet in a room

The device, rack and cabinet forms have a **Room** field under **Location**.
It lists the rooms of the chosen location and waits until a location is
picked; changing the location clears the room.

The rules are the same for the forms, the API, import and integrations:

- **A room alone sets the location.** Sending `room_id` without `location_id`
  gives the object the room's location.
- **A room elsewhere is refused.** A room in another location answers
  `room_id: "Pick a room in <location>."`; a room at another site,
  `room_id: "Pick a room at <site>."`. A room of another tenant, or at a site
  you cannot see, is not found.
- **Moving clears the room.** Moving the object to another location (or to
  none) clears a room left behind; the change log records the cleared room.
  [Moving a rack](racks.md#move-a-rack-to-another-site) to another site
  clears the room of the rack and of every device in it.
- **Never from placement.** Placing an object on a floor plan, in a rack or in
  a cabinet never sets its room; only a write that names the room does.

The device, rack and cabinet lists take `?room=<id>`, and their tables offer a
**Room** column (cabinets show it by default; on devices and racks it is in
the Columns menu).

## Deleting

- Deleting a room keeps what stood in it: each device, rack and cabinet keeps
  its location and loses the room.
- A location that still has rooms cannot be deleted - delete or move the
  rooms first.
- A room with devices, racks or cabinets in it cannot move to another
  location; move them out first. An empty room can move.

Rooms on the list can be bulk-edited (status, colour, description, tags and
custom fields) and bulk-deleted with the usual preview.

## Import and export

**Import / Export** on the Rooms list round-trips rooms as CSV, JSON or XLSX.
A row matches an existing room by its `id`, then by **location and name**;
the location is named by its name. The device, rack and cabinet files carry a
`room` column, resolved inside the row's location.

## Permissions and site scope

Rooms are the **Rooms** object type in the Organization group. A room's site
is its location's site, so a grant limited to sites covers the rooms at those
sites, and the [site roles](../access/site-separation.md) manage rooms at
their sites like locations. Setting a room on a device needs view on the
room as well as change on the device.

## API

| Call | What it does |
|---|---|
| `GET /api/rooms/` | List. Filters: `site`, `location` (with `include_descendants=1` the rooms of its sub-locations too), `status`, `tag` (slug, repeatable), `search` (name, code, description, custom fields); `picker=1` for the short rows a picker reads. |
| `POST /api/rooms/` | Create: `name`, `location_id`, optional `code`, `slug`, `status_id`, `color`, `description`, `tag_ids`, `custom_fields`. |
| `PATCH/DELETE /api/rooms/{id}/` | Edit or delete. |
| `POST /api/rooms/bulk-update/` | Bulk edit; `GET /api/rooms/bulk-edit-fields/` describes the fields. |
| `POST /api/rooms/bulk-delete/` | Safe bulk delete, with `dry_run`. |
| `GET/POST /api/rooms/{id}/images/` | Room photos. |

A device, rack or cabinet reads `room` as `{id, name, code, color}` and writes
`room_id`. A location reads `room_count`.
