---
icon: lucide/table
---

# Table columns

Every list in Danbyte lets you choose which columns to show and in what order.
Your layout is remembered per table, and an administrator can publish a shared
default for everyone.

## Customizing a table

1. On any list page, open the **Columns** menu in the toolbar.
2. Tick or untick columns to **show or hide** them.
3. Use the **↑ / ↓** buttons to **reorder** them.
4. Choose **Reset to default** to go back to the standard layout.

Your changes are saved automatically and apply the next time you open that table.

!!! note
    A few columns (like the row-select checkbox and the row-actions menu) always
    stay in place and can't be moved or hidden.

## Where your settings live

Manage all your saved table layouts in one place under **User → Preferences**,
where each table shows its current state with a **Reset** option.

## Shared defaults (administrators)

If you can manage users, you can publish a starting layout for your whole tenant
under **Admin → Settings**:

| Action | Effect |
|---|---|
| **Publish my layout** | Makes your current layout the tenant default for a table. |
| **Lock** | Forces that default — everyone uses it and can't change their own. |
| **Unlock** | Lets people customize again, starting from the default. |
| **Clear default** | Removes the tenant default entirely. |

!!! note "How a layout is chosen"
    Danbyte shows the most specific layout that applies: a **locked** tenant
    default wins over everything; otherwise **your own** saved layout; otherwise
    the tenant default; otherwise the table's natural order. When a table is
    locked, its column controls are disabled and a lock icon appears.

## Which tables remember layouts

Top-level lists — **prefixes, prefix IPs, VLANs, VRFs, route targets, sites, and
tenants** — remember your layout. Smaller tables embedded inside detail pages
(like a site's VLANs) stay on their standard layout.

## Related

- [Exporting tables](exporting-tables.md) — exports follow your visible columns.
