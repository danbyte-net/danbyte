---
icon: lucide/rocket
---

# First-time setup

On a brand-new install, Danbyte greets the first user with a short, skippable
**setup wizard** so an empty instance doesn't leave you staring at blank pages.
It walks you through creating the essentials, then gets out of the way.

## What it asks for

The wizard steps through, in order - each optional except the site:

1. **Site** - a physical location (a datacenter, office, or home rack).
2. **Location** - an area inside the site (a room, floor, or aisle).
3. **VLAN** - an ID + name (e.g. `10` / `servers`).
4. **Prefix** - an IP range in CIDR (e.g. `10.0.0.0/24`); it links to the VLAN
   above when you created one.
5. **Device** - a name, attached to the site, with an optional role.

Everything the wizard creates uses the normal APIs, so you can edit or delete it
afterwards like any other object. **Skip** any step, or **Skip setup** entirely -
nothing is forced.

## When it appears

The wizard opens automatically only for a **fresh tenant** - one that has been
neither completed nor skipped **and** has no sites yet. Once you finish or skip
it, the choice is remembered **per tenant**, so it never pops up again.

## Running it again

Need it later - for a new tenant, or just to add a few objects quickly? Open
**Settings → Tenant** and click **Re-run setup**. This re-opens the same wizard
on demand, even when the tenant already has data.
