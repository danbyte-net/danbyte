---
icon: lucide/map-pin
---

# Regions & locations

Regions and locations give your sites geographic and physical structure.
**Regions** sit *above* sites (a country, a city, an organizational area), and
**locations** sit *within* a site (building → floor → room).

Both nest into trees, so you can model exactly as deep as you need.

## Add a region

A region groups sites geographically or organizationally — and regions can nest
inside other regions.

1. Open **Organization → Regions** in the sidebar and click **Add region**.
2. Give it a **name** and a **slug** (a short URL-friendly identifier).
3. Optionally pick a **parent region** to nest it under, and add a description.
4. Save.

To put a site in a region, open the site's form and pick the **region** there.

## Add a location

A location is a place inside a single site — a building, a floor, a room — and
locations can nest inside other locations. A location's physical layout can be
drawn as a [floor plan](floor-plans.md) — a grid of tiles linked to the racks
and devices that live there.

1. Open **Organization → Locations** and click **Add location**.
2. Choose the **site** this location belongs to.
3. Give it a **name** and a **slug**.
4. Optionally pick a **parent location** (it must be in the same site), set a
   **status**, and add a description.
5. Save.

!!! note "Changing the site clears the parent"
    A location's parent must be in the same site, so if you switch the site on
    the form, the parent field resets.

### Location status

| Status | Meaning |
|---|---|
| **Active** | In use. |
| **Planned** | Not built or occupied yet. |
| **Decommissioning** | Being wound down. |
| **Retired** | No longer in use. |

!!! note "Nothing is pre-filled"
    Danbyte ships no sample regions or locations — you create exactly the ones
    your organization uses.

!!! warning "Nodes with children can't be deleted"
    You can't delete a region that still has sub-regions or sites, or a location
    that still has sub-locations. Move or remove the children first.

!!! tip "Address line vs. location tree"
    A site's free-text **location** field is just an address line. The structured
    building → floor → room tree is what you build with **locations**.

## Floor plans

A location can be drawn as a **[floor plan](floor-plans.md)** — a grid canvas
of tiles (racks, walls, cooling…) linked to real objects. The Location page's
**Floor plan** button opens the location's plan, or creates one if none
exists yet.

## Tags & custom fields

Need to track something extra on a location — a square footage, an access
note? Add a **custom field** for locations and it appears on every form. See
[Tags & custom fields](tags-and-custom-fields.md).
